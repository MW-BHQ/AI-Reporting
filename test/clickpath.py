#!/usr/bin/env python3
"""
CLICK-PATH AUDIT (v3.373.0, skill pack item 4, ecc-click-path-audit).

Opens every view, loads it, then presses every visible button, tab, pill and
toggle in #viewRoot one at a time and fails on anything the page throws:
uncaught errors, rejected promises, console.error. This is the class of bug
that has shipped before — a Load button with no VIEW_LOADERS entry, a const
used before its declaration — where each function works alone and the click
path between them does not.

    (WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ECOM_SHEET_ID=mock \\
     ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket PORT=8412 \\
     node --require ./test/mock-fetch.js server.js &) ; sleep 5
    python3 test/clickpath.py 8412

Skipped on purpose: the PDF button (opens the print dialog), downloads,
links leaving the page, and anything that writes (Save / Delete / Send /
access-list edits) — those have their own tests.
"""
import sys
from playwright.sync_api import sync_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8412"
IAP = "accounts.google.com:admin@bkh.test"
SKIP_TEXT = ("pdf", "export", "download", "delete", "remove", "save", "send", "email", "sign out",
             "revoke", "grant", "invite", "upload", "choose", "open in", "copy")
# Console noise the app emits by design (a failed optional source is logged).
ALLOWED = ("Failed to load resource", "favicon")


def main():
    problems = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1400, "height": 900}, reduced_motion="reduce",
                            extra_http_headers={"X-Goog-Authenticated-User-Email": IAP})
        ctx.add_init_script("window.print = () => {}; window.open = () => null;")
        pg = ctx.new_page()
        current = {"where": "boot"}
        pg.on("pageerror", lambda e: problems.append(f"{current['where']}: THROW {e}"))
        pg.on("console", lambda m: m.type == "error" and not any(a in m.text for a in ALLOWED)
              and problems.append(f"{current['where']}: console.error {m.text[:160]}"))
        pg.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2500)
        navs = pg.evaluate("() => [...document.querySelectorAll('.nav-item[data-view]')]"
                           ".map(n => [n.dataset.view, n.dataset.brand || ''])")
        clicked = 0
        for view, brand in navs:
            current["where"] = f"{view}{'/' + brand if brand else ''}"
            pg.evaluate("""([v, b]) => [...document.querySelectorAll('.nav-item')]
                .find(x => x.dataset.view === v && (x.dataset.brand || '') === b).click()""", [view, brand])
            pg.wait_for_timeout(500)
            if view == "campaigns":
                pg.evaluate("async () => { await loadCampaign('260701-08', true); render(); }")
            else:
                # The header Load AND an in-view "Ready to load" button, so the
                # loaded layout (where most controls live) is what gets clicked.
                pg.evaluate("() => { const b = document.getElementById('loadBtn'); if (b && b.offsetParent) b.click();"
                            " const v = document.querySelector('#viewRoot [data-load]'); if (v) v.click(); }")
            try:
                pg.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            pg.wait_for_timeout(800)
            # Re-query after every click: a click may re-render the view.
            seen = set()
            for _ in range(120):
                target = pg.evaluate("""(args) => {
                  const SEL = ['button','[role=tab]','summary','[data-sort]','th[data-k]','.pill[data-k]',
                    '[data-xtab]','[data-m]','[data-load]','[data-d]','[data-gbtab]','[data-mix]','[data-window]',
                    'td[data-code]','.u-chip'].map(x => '#viewRoot ' + x).join(',');
                  const [skip, seen] = args;
                  const els = [...document.querySelectorAll(SEL)]
                    .filter(e => e.offsetParent !== null && !e.disabled
                      && !e.closest('[data-del],[data-save],[data-regen],[data-unbullet],[data-unimg]'));
                  for (const [i, e] of els.entries()) {
                    const label = (e.textContent || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g,' ').slice(0, 40);
                    const key = label + '#' + i;
                    if (seen.includes(key)) continue;
                    if (skip.some(s => label.toLowerCase().includes(s))) { seen.push(key); continue; }
                    e.setAttribute('data-cp-target', '1');
                    return key;
                  }
                  return null;
                }""", [list(SKIP_TEXT), list(seen)])
                if not target:
                    break
                seen.add(target)
                current["where"] = f"{view}{'/' + brand if brand else ''} [{target.split('#')[0]}]"
                try:
                    pg.click("[data-cp-target='1']", timeout=3000)
                    clicked += 1
                except Exception:
                    pass
                pg.evaluate("() => document.querySelectorAll('[data-cp-target]').forEach(e => e.removeAttribute('data-cp-target'))")
                try:
                    pg.wait_for_load_state("networkidle", timeout=8000)
                except Exception:
                    pass
                pg.wait_for_timeout(150)
            try:
                pg.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
        b.close()
    for x in problems:
        print("  FAIL", x)
    print(f"\n{len(navs)} views, {clicked} clicks, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
