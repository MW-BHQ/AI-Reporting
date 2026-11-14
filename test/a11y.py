"""
ACCESSIBILITY GATE (v3.424.0, MW: "accessibility pass over all views",
light mode only). Opens every view like clickpath.py, loads it, runs axe-core
(WCAG 2.1 A/AA rules) on #viewRoot plus the shell, and fails on any
SERIOUS or CRITICAL violation. Moderate/minor are listed, not failed.

Run: python3 test/a11y.py <port> [axe.min.js path]
axe-core is fetched by test/smoke.sh into /tmp; nothing is shipped to users.
"""
import sys, json
from playwright.sync_api import sync_playwright
PORT = sys.argv[1]
AXE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/axe/node_modules/axe-core/axe.min.js"
IAP = "accounts.google.com:admin@bkh.test"
src = open(AXE).read()
fails, notes = [], {}
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 900}, reduced_motion="reduce",
                        extra_http_headers={"X-Goog-Authenticated-User-Email": IAP})
    pg = ctx.new_page()
    pg.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    navs = pg.evaluate("() => [...document.querySelectorAll('.nav-item[data-view]')].map(n => [n.dataset.view, n.dataset.brand || ''])")
    for view, brand in navs:
        where = view + ("/" + brand if brand else "")
        pg.evaluate("""([v, b]) => [...document.querySelectorAll('.nav-item')]
            .find(x => x.dataset.view === v && (x.dataset.brand || '') === b).click()""", [view, brand])
        pg.wait_for_timeout(400)
        if view == "campaigns":
            pg.evaluate("async () => { await loadCampaign('260701-08', true); render(); }")
        else:
            pg.evaluate("() => { const b = document.getElementById('loadBtn'); if (b && b.offsetParent) b.click();"
                        " const v = document.querySelector('#viewRoot [data-load]'); if (v) v.click(); }")
        try: pg.wait_for_load_state("networkidle", timeout=20000)
        except Exception: pass
        pg.wait_for_timeout(700)
        pg.evaluate(src)
        res = pg.evaluate("""async () => {
          const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] },
            resultTypes: ['violations'] });
          return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help,
            nodes: v.nodes.slice(0, 4).map(n => (n.target || []).join(' ') + ' :: ' + (n.failureSummary || '').split('\\n').slice(1,2).join(''))
            , count: v.nodes.length }));
        }""")
        for v in res:
            key = f"{v['id']} ({v['impact']})"
            if v["impact"] in ("serious", "critical"):
                fails.append((where, key, v["count"], v["nodes"]))
            else:
                notes.setdefault(key, set()).add(where)
    b.close()
for k, vs in sorted(notes.items()):
    print(f"  note {k:40} {len(vs)} view(s)")
seen = {}
for where, key, n, nodes in fails:
    seen.setdefault(key, []).append((where, n, nodes))
for key, rows in seen.items():
    print(f"  FAIL {key} in {len(rows)} view(s)")
    for where, n, nodes in rows[:6]:
        print(f"       {where}: {n} node(s) · {nodes[0][:170] if nodes else ''}")
print(f"\n{len(navs)} views, {len(fails)} serious/critical finding(s)")
sys.exit(1 if fails else 0)
