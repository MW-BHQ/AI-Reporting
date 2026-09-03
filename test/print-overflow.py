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
    # The two `pn` slides (GBP, Google reviews) print at DESKTOP styling and are
    # fitted to the sheet by `fitNativeSlides()` at print time. Measuring them
    # without it measures a page that is never produced.
    pg.evaluate("()=>{ try { fitNativeSlides(); } catch (e) {} }")
    pg.wait_for_timeout(400)
    pg.wait_for_timeout(300)
    pg.evaluate("()=>{try{resizeChartsForPrint()}catch(e){}}")
    pg.wait_for_timeout(600)

    rows = pg.evaluate("""() =>
      [...document.querySelectorAll('.slide:not(.slide-pages):not(.slide-flow),.lang-page,.clang-page')]
        .map(s => ({
          title: ((s.querySelector('.slide-title')||{}).textContent||'')
                   .trim().replace(/\\s+/g,' ').slice(0,40),
          over: s.scrollHeight - s.clientHeight,
          cols: [...new Set([...s.querySelectorAll('.grid')].map(g =>
                  [...g.classList].filter(c=>/^g-/.test(c)).join('') + ':' +
                  getComputedStyle(g).gridTemplateColumns.split(' ').length))].join(' ')
        }))""")
    # ---------------------------------------------------------- Better Club
    #
    # A SECOND VIEW, MEASURED THE SAME WAY. Better Club prints as its own deck
    # and shipped broken once already: its chart boxes were inline heights, so
    # the print rules could not resize them, and its canvases sat outside a
    # `.chart-wrap` — which print hides without building the SVG twin that
    # replaces it, so every chart printed blank. Both are invisible on screen.
    pg.emulate_media(media="screen")
    pg.evaluate("()=>{const n=[...document.querySelectorAll('.nav-item')]"
                ".find(x=>x.dataset.view==='bclub'); n&&n.click();}")
    pg.wait_for_timeout(600)
    pg.evaluate("()=>{const b=document.querySelector('[data-load=\"bclub\"]'); b&&b.click();}")
    pg.wait_for_timeout(6000)
    # MEASURED UNDER print-prep, WHICH IS PAGE WIDTH.
    #
    # The 900px viewport above is deliberate for the report deck: a collapsing
    # grid is what pushes a section over. But Better Club's page one is a
    # four-column score-card block, and at 900px g-4 collapses to two columns
    # and reads ~100px taller than it can ever print. Measuring the two-page
    # budget at 900px would fail a layout that is fine, which is the worst kind
    # of test. print-prep is what the export itself applies.
    pg.evaluate("()=>document.body.classList.add('print-prep')")
    pg.emulate_media(media="print")
    pg.evaluate("()=>{try{resizeChartsForPrint();fitNativeSlides();buildPrintSvgs()}catch(e){}}")
    pg.wait_for_timeout(900)

    bc = pg.evaluate("""() => {
      const slides = [...document.querySelectorAll('#viewRoot .slide')];
      return {
        slides: slides.map(s => ({
          title: ((s.querySelector('.slide-title')||{}).textContent||'')
                   .trim().replace(/\\s+/g,' ').slice(0,44),
          over: s.scrollHeight - s.clientHeight,
          flow: s.classList.contains('slide-flow'),
          logo: !!s.querySelector('.slide-logo'),
          range: !!s.querySelector('.slide-range'),
        })),
        printed: slides.filter(s => getComputedStyle(s).display !== 'none').length,
        // The two halves of page one, measured against a 7.5in sheet less its
        // 2px. 2.6in/1.5in came to 846px here and silently became a third page.
        pageOne: slides.filter(s => s.classList.contains('bc-pg1a')
                                 || s.classList.contains('bc-pg1b'))
                       .reduce((a, s) => a + s.getBoundingClientRect().height, 0),
        // The revenue chart has to stay OVER HALF the page (MW). Every pixel of
        // padding on page one was spent getting it there, so a future tweak
        // that reclaims some would quietly drop it back under.
        heroH: (document.querySelector('.bc-hero') || { getBoundingClientRect: () => ({ height: 0 }) })
                 .getBoundingClientRect().height,
        canvases: document.querySelectorAll('#viewRoot canvas').length,
        loose: [...document.querySelectorAll('#viewRoot canvas')]
                 .filter(c => !c.closest('.chart-wrap')).length,
        twins: [...document.querySelectorAll('#viewRoot .chart-svg')]
                 .filter(t => (t.innerHTML||'').length > 200).length,
      };
    }""")
    browser.close()

bad = [r for r in rows if r["over"] > 2]
for r in rows:
    flag = f"CLIP {r['over']}px" if r["over"] > 2 else "ok"
    print(f"{r['title'][:40]:<42}{flag:<14}{r['cols']}")
print(f"\n{len(rows)} sections, {len(bad)} clipping at {WIDTH}px")

print("\nBetter Club")
bcbad = []
for r in bc["slides"]:
    hdr = ("logo+range" if (r["logo"] and r["range"]) else "NO HEADER BITS")
    clip = f"CLIP {r['over']}px" if (r["over"] > 2 and not r["flow"]) else "ok"
    if clip != "ok" or hdr != "logo+range":
        bcbad.append(r["title"])
    print(f"  {r['title'][:44]:<46}{clip:<14}{hdr}")

# THE EXPORT IS TWO PAGES. Three slides print — the pair that shares page one
# and the month — and the pair has to FIT the sheet or it becomes three.
if bc["printed"] != 3:
    bcbad.append(f"{bc['printed']} slides print, expected 3")
    print(f"  !! {bc['printed']} slides would print, expected 3")
SHEET = 718   # 7.5in at 96dpi, less the 2px the slide gives back
if bc["pageOne"] > SHEET:
    bcbad.append(f"page one is {round(bc['pageOne'])}px over a {SHEET}px sheet")
    print(f"  !! page one measures {round(bc['pageOne'])}px against a {SHEET}px sheet "
          f"— it will spill to a third page")
else:
    print(f"  page one {round(bc['pageOne'])}px of {SHEET}px  ok")

# The chart must be more than half the page it shares.
AVAIL = SHEET - 40          # less the slide header
share = bc["heroH"] / AVAIL if AVAIL else 0
if share <= 0.5:
    bcbad.append(f"revenue chart is {round(share * 100)}% of the page, needs over 50%")
    print(f"  !! revenue chart is {round(share * 100)}% of the available height, "
          f"and has to be over half")
else:
    print(f"  revenue chart {round(bc['heroH'])}px, {round(share * 100)}% of the page  ok")

# Every chart box must be a `.chart-wrap` with a built twin, or it prints blank.
if bc["loose"]:
    bcbad.append(f"{bc['loose']} canvas(es) outside .chart-wrap")
    print(f"  !! {bc['loose']} canvas(es) outside a .chart-wrap — those print blank")
if bc["twins"] < bc["canvases"]:
    bcbad.append(f"{bc['canvases'] - bc['twins']} twin(s) missing")
    print(f"  !! {bc['canvases']} canvases but only {bc['twins']} SVG twins with content")
print(f"\n{len(bc['slides'])} Better Club slides, {bc['twins']}/{bc['canvases']} twins, "
      f"{len(bcbad)} problem(s)")

sys.exit(1 if (bad or bcbad) else 0)
