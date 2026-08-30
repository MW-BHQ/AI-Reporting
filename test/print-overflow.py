#!/usr/bin/env python3
"""
MEASURE WHAT THE PDF CLIPS.

The printed deck pins every section to one 7.5in page with `overflow:hidden`.
That is deliberate — see CONTEXT — but it means content that does not fit
DISAPPEARS WITH NO MARK ON THE PAGE. There is no CSS way to detect it, so a
table that grows a row next month silently loses that row from a submitted
report, and nobody finds out.

This is the detector. It renders the report in print media and reports, per
section, how many pixels fall off the bottom. It is not part of `npm test`
because it needs a browser; run it before shipping anything that changes a
report layout, and after any change to the data shape.

    (WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ECOM_SHEET_ID=mock \
     ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket PORT=8412 \
     node --require ./test/mock-fetch.js server.js &) ; sleep 4
    python3 test/print-overflow.py

The server dies between shells, so start it and run this in the SAME command.
Width defaults to 900 deliberately: the print layout can be narrower than the
window, and a wide render hides the grid-collapse class of bug entirely.
"""
import sys
from playwright.sync_api import sync_playwright

WIDTH = int(sys.argv[1]) if len(sys.argv) > 1 else 900
PORT = sys.argv[2] if len(sys.argv) > 2 else "8412"
IAP = "accounts.google.com:admin@bkh.test"

with sync_playwright() as p:
    browser = p.chromium.launch()
    # The IAP header must be a CONTEXT header, not per-request.
    ctx = browser.new_context(viewport={"width": WIDTH, "height": 900},
                              extra_http_headers={"X-Goog-Authenticated-User-Email": IAP})
    pg = ctx.new_page()
    pg.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2000)
    pg.evaluate("()=>{const n=[...document.querySelectorAll('.nav-item')]"
                ".find(x=>x.dataset.view==='report'); n&&n.click();}")
    pg.wait_for_timeout(800)
    pg.evaluate("()=>document.getElementById('loadBtn').click()")
    pg.wait_for_timeout(9000)
    pg.emulate_media(media="print")
    pg.wait_for_timeout(300)
    pg.evaluate("()=>{try{resizeChartsForPrint()}catch(e){}}")
    pg.wait_for_timeout(600)

    rows = pg.evaluate("""() =>
      [...document.querySelectorAll('.slide:not(.slide-pages),.lang-page,.clang-page')]
        .map(s => ({
          title: ((s.querySelector('.slide-title')||{}).textContent||'')
                   .trim().replace(/\\s+/g,' ').slice(0,40),
          over: s.scrollHeight - s.clientHeight,
          cols: [...new Set([...s.querySelectorAll('.grid')].map(g =>
                  [...g.classList].filter(c=>/^g-/.test(c)).join('') + ':' +
                  getComputedStyle(g).gridTemplateColumns.split(' ').length))].join(' ')
        }))""")
    browser.close()

bad = [r for r in rows if r["over"] > 2]
for r in rows:
    flag = f"CLIP {r['over']}px" if r["over"] > 2 else "ok"
    print(f"{r['title'][:40]:<42}{flag:<14}{r['cols']}")
print(f"\n{len(rows)} sections, {len(bad)} clipping at {WIDTH}px")
sys.exit(1 if bad else 0)
