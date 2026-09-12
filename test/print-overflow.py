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
import re
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
          cover: s.classList.contains('cover'),
        })),
        printed: slides.filter(s => getComputedStyle(s).display !== 'none'
                                 && !s.classList.contains('cover')).length,
        covers: slides.filter(s => s.classList.contains('cover')).length,
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
    # ------------------------------------------------------- Campaign funnel
    #
    # TWO THINGS THAT HAVE BOTH SHIPPED BROKEN AND NEITHER OF WHICH SHOWS ON
    # SCREEN.
    #
    # The funnel is the deck's only horizontal chart, so it is the only one
    # whose twin comes from `hBarToSvg`. If that twin is missing the funnel
    # prints BLANK, because the fill rule gives its wrapper a zero height and
    # nothing redraws the canvas — the exact failure that got v3.258 reverted.
    # And if the wrapper stops filling, the card goes back to a fixed-height
    # chart floating above a stretched card with a wedge of blank under the
    # note.
    #
    # Measured under the REAL export path (`sizeForPrint`, then print media),
    # not an emulation of it: the fill rule exists twice, once per medium, and
    # only the real path exercises both.
    pg.emulate_media(media="screen")
    # A DESKTOP WIDTH, NOT THE 900px THE DECK IS MEASURED AT.
    #
    # `print-prep` sets `.main` to 12.493in to make the screen measure like a
    # page, but the responsive breakpoints still see the WINDOW — at 900px
    # `@media(max-width:1080px)` collapses the grids, so the prep pass measures
    # a two-column layout that never prints and sizes the sheet a third too
    # tall. 900px is deliberate for the report deck (it exposes grid collapse);
    # for a measure-then-size export it just measures the wrong document.
    pg.set_viewport_size({"width": 1440, "height": 900})
    pg.wait_for_timeout(300)
    pg.evaluate("()=>{const n=[...document.querySelectorAll('[data-view]')]"
                ".find(x=>x.dataset.view==='campaigns'); n&&n.click();}")
    pg.wait_for_timeout(700)
    cf, cbad, pageRule, prepHidden = None, [], "", 0
    adjacency = None
    try:
        pg.fill("#campInput", "260701-08", timeout=15000)
        pg.click("#campGo")
        pg.wait_for_timeout(7000)
        pg.evaluate("()=>sizeForPrint()")
        pg.wait_for_timeout(1500)
        pageRule = pg.evaluate("()=>{const s=document.getElementById('printPageSize');"
                               "return s ? s.textContent : ''}")
        # Collapsed rows STILL PRINT (`.slide.pn tbody tr{display:table-row}`),
        # so any row hidden during the prep pass is content the sheet was not
        # sized for. Counted here, on screen, because that is the pass that gets
        # it wrong.
        prepHidden = pg.evaluate("""() => [...document.querySelectorAll('#viewRoot .slide.pn tbody tr')]
          .filter(t => getComputedStyle(t).display === 'none').length""")
        # ------------------------------------------- ad row opens its OWN row
        #
        # The campaign detail table is ONE ROW PER utm_campaign + SOURCE, so the
        # same code appears once per source. The expander used to look its ad
        # row up by code, and `querySelector` returns the FIRST match — so every
        # variant of a code opened the first variant's ad list (MW: clicking
        # google/cpc expanded facebook/paid). It is adjacency now: the ad row is
        # emitted directly after its own `<tr>`.
        #
        # Asserted on screen, before print media reveals every row anyway.
        adjacency = pg.evaluate("""() => {
          const tds = [...document.querySelectorAll('#campBody [data-adrow]')];
          const out = { cells: tds.length, opened: 0, wrong: 0 };
          for (const td of tds) {
            const own = td.closest('tr').nextElementSibling;
            if (!own || !own.classList.contains('adrow')) { out.wrong++; continue; }
            const before = [...document.querySelectorAll('#campBody tr.adrow')]
              .filter(r => !r.hidden);
            td.click();
            const after = [...document.querySelectorAll('#campBody tr.adrow')]
              .filter(r => !r.hidden);
            const changed = after.filter(r => !before.includes(r));
            // Exactly one row may change, and it must be this cell's own.
            if (changed.length !== 1 || changed[0] !== own) out.wrong++;
            else out.opened++;
            td.click();
          }
          // THE KEYS ARE UNIQUE TOO, belt and braces. The handler no longer
          // reads them, but they identified a row by CODE ALONE and the table
          // has one row per code + SOURCE, so they collided. Now code::source.
          const keys = [...document.querySelectorAll('#campBody tr.adrow')]
            .map(r => r.getAttribute('data-adfor') || '');
          out.keys = keys.length;
          out.distinct = new Set(keys).size;
          return out;
        }""")
        pg.emulate_media(media="print")
        pg.wait_for_timeout(600)
        cf = pg.evaluate("""() => {
          const w = document.querySelector('.funnel-wrap');
          if (!w) return null;
          const card = w.closest('.card');
          const note = card && card.querySelector('.note');
          const svg = w.querySelector('.chart-svg svg');
          return {
            wrapClass: w.className,
            wrapH: Math.round(w.getBoundingClientRect().height),
            cardH: card ? Math.round(card.getBoundingClientRect().height) : 0,
            // blank between the last thing in the card and the card's own bottom
            slack: (card && note)
              ? Math.round(card.getBoundingClientRect().bottom
                           - note.getBoundingClientRect().bottom)
              : -1,
            bars: svg ? svg.querySelectorAll('rect[rx]').length : 0,
            canvasHidden: getComputedStyle(w.querySelector('canvas')).display === 'none',
            /**
             * THE WHOLE VIEW, measured in PRINT media. `onePageIfAsked` sizes
             * `@page` from a measurement taken on SCREEN under `print-prep`,
             * and the two disagree whenever a print-only rule changes the
             * layout — the `.adrow` reveal was worth 143px per collapsed row.
             * Anything the estimate misses spills onto a second sheet.
             *
             * MEASURED FROM `#viewRoot`, NOT FROM `w.closest('.slide')`. It used
             * to walk up from the funnel to its slide and return 0 when there
             * was not one — and there was not one, because a stray `</div>` in
             * the campaign template had been closing the slide after three
             * children. So this reported 0 on every run, `printed > sheet` was
             * never true, and the check could not fail. Two decorative
             * assertions were found this way in v3.284; this was a third.
             */
            printed: (() => {
              const root = document.getElementById('viewRoot');
              if (!root) return 0;
              const rt = root.getBoundingClientRect().top;
              let deepest = 0;
              for (const el of root.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                if (r.height < 1 || r.width < 1) continue;
                const b = r.bottom - rt;
                if (b > deepest) deepest = b;
              }
              return Math.round(deepest);
            })(),
            /**
             * EVERY SECTION INSIDE THE SLIDE. `#campBody` holds exactly one
             * element — the `slideShell` wrapper — and everything else is
             * nested in it. A stray closing tag pops the later sections out as
             * SIBLINGS, where they still render on screen and still print, but
             * the one-page sizer cannot see them.
             */
            /**
             * THE HEADLINE QUALITY CARD, read off the RENDERED page. The
             * payload assertions in smoke.sh prove the server computes
             * `quality.engagement`; they cannot prove the card renders it, and
             * that gap is exactly how v3.284 removed a working scroll figure
             * from the page while every payload check stayed green.
             */
            qualityCard: (() => {
              const labs = [...document.querySelectorAll('.stat.card .lab')]
                .map((l) => l.textContent.trim());
              return labs.find((l) => /engaged page views|scroll/i.test(l)) || null;
            })(),
            bodyKids: (() => {
              const cb = document.getElementById('campBody');
              if (!cb) return null;
              const kids = [...cb.children];
              return {
                n: kids.length,
                firstIsSlide: !!(kids[0] && kids[0].classList.contains('slide')),
                strays: kids.slice(1).map((k) => k.tagName + '.' + String(k.className).slice(0, 30)),
              };
            })(),
          };
        }""")
    except Exception as e:                                    # noqa: BLE001
        cbad.append(f"could not load a campaign: {str(e)[:60]}")
    browser.close()

bad = [r for r in rows if r["over"] > 2]
for r in rows:
    flag = f"CLIP {r['over']}px" if r["over"] > 2 else "ok"
    print(f"{r['title'][:40]:<42}{flag:<14}{r['cols']}")
print(f"\n{len(rows)} sections, {len(bad)} clipping at {WIDTH}px")

print("\nBetter Club")
bcbad = []
for r in bc["slides"]:
    # A cover has no slide header by design — it IS the header.
    if r.get("cover"):
        print(f"  {r['title'][:44]:<46}{'ok':<14}cover")
        continue
    hdr = ("logo+range" if (r["logo"] and r["range"]) else "NO HEADER BITS")
    clip = f"CLIP {r['over']}px" if (r["over"] > 2 and not r["flow"]) else "ok"
    if clip != "ok" or hdr != "logo+range":
        bcbad.append(r["title"])
    print(f"  {r['title'][:44]:<46}{clip:<14}{hdr}")

# THE EXPORT IS TWO PAGES. Three slides print — the pair that shares page one
# and the month — and the pair has to FIT the sheet or it becomes three.
# The section cover is printed too, but it is not one of the two content pages
# the budget is about — counted separately or it reads as a regression.
if bc["printed"] != 3:
    bcbad.append(f"{bc['printed']} content slides print, expected 3")
    print(f"  !! {bc['printed']} content slides would print, expected 3")
if bc["covers"] != 1:
    bcbad.append(f"{bc['covers']} covers, expected 1")
    print(f"  !! {bc['covers']} covers, expected 1")
else:
    print("  1 section cover, print-only  ok")
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

print("\nCampaign funnel")
if not cf:
    cbad.append("no .funnel-wrap on the printed campaign")
    print("  !! no funnel found — the campaign did not render")
else:
    if "chart-wrap" not in cf["wrapClass"]:
        cbad.append("funnel is not a .chart-wrap, so no twin is built for it")
        print("  !! funnel wrapper is not a .chart-wrap — it will print its canvas")
    else:
        print("  funnel is a .chart-wrap  ok")
    # `rect[rx]` counts the rounded bars only, so the twin's background rect and
    # its label plates cannot pad the number into looking healthy.
    if cf["bars"] < 3:
        cbad.append(f"twin has {cf['bars']} bars — the funnel will print blank or short")
        print(f"  !! twin drew {cf['bars']} bars, expected one per funnel stage")
    else:
        print(f"  twin drew {cf['bars']} bars  ok")
    if not cf["canvasHidden"]:
        cbad.append("canvas still visible in print — the twin is not what prints")
        print("  !! the canvas is still displayed in print media")
    # 40px is a card's padding plus a little. More than that is the wedge of
    # blank this check exists to catch.
    if cf["slack"] > 40:
        cbad.append(f"{cf['slack']}px of blank under the funnel note")
        print(f"  !! {cf['slack']}px of blank between the note and the card's bottom "
              f"— the chart is not filling")
    else:
        print(f"  chart fills its card, {cf['slack']}px of padding left  ok")
    print(f"  funnel {cf['wrapH']}px in a {cf['cardH']}px card")

    # ---------------------------------------------------- one page, not two
    #
    # THE INVARIANT THAT MATTERS, and the one no constant can guarantee: the
    # sheet `onePageIfAsked` sized must be at least as tall as the content that
    # actually prints. It is measured on SCREEN under `print-prep`, so every
    # print-only rule that changes the layout is a chance for the estimate to
    # come in short — and a short estimate is a second, near-empty page. The
    # slack was raised four times (8 -> 24 -> 48 -> 72px) chasing this; the
    # shortfall scaled with the campaign's row count, so it never closed.
    #
    # Asserted end to end rather than per rule: whatever the next unmirrored
    # print rule turns out to be, this catches it.
    if not adjacency or not adjacency["cells"]:
        print("  no expandable ad rows in this fixture — adjacency unproven")
    elif adjacency["wrong"]:
        cbad.append(f"{adjacency['wrong']} ad row(s) opened the wrong variant")
        print(f"  !! {adjacency['wrong']} of {adjacency['cells']} ad cells opened a row "
              f"that was not their own")
    elif adjacency.get("distinct", 0) != adjacency.get("keys", 0):
        cbad.append("ad row keys collide across variants of one code")
        print(f"  !! {adjacency['keys']} ad rows share only "
              f"{adjacency['distinct']} distinct keys")
    else:
        print(f"  all {adjacency['opened']} ad row(s) opened their own variant, "
              f"{adjacency['distinct']} distinct key(s)  ok")
        if adjacency["cells"] < 2:
            # HONEST LIMIT. Ad names attach per platform to one traffic row
            # each, so a code needs a Meta-matching AND a Google-matching
            # source before two rows are expandable. This fixture has one
            # platform-matching source, so the check proves the mechanism, not
            # the collision MW hit. Adding `google` to the fixture's source
            # list DOES produce two — and breaks `sa excludes x-network`, which
            # is guarding something else. Not worth trading one guard for
            # another.
            print("  note: only 1 expandable row here — multi-source case unproven")

    if prepHidden:
        cbad.append(f"{prepHidden} table row(s) hidden while the sheet was measured")
        print(f"  !! {prepHidden} row(s) were collapsed during the prep pass but print "
              f"anyway — the sheet is sized short by all of them")
    else:
        print("  every printed row was visible to the measurement  ok")

    qc = cf.get("qualityCard")
    if qc != "Engaged page views":
        cbad.append(f"quality headline card reads {qc!r}, not 'Engaged page views'")
        print(f"  !! the quality card renders {qc!r} — the engagement figure is "
              f"on the payload but not on the page")
    else:
        print("  quality card shows engaged page views  ok")

    bk = cf.get("bodyKids")
    if not bk:
        cbad.append("no #campBody to measure")
    elif bk["n"] != 1 or not bk["firstIsSlide"]:
        cbad.append(f"campBody has {bk['n']} children — sections outside the slide")
        print(f"  !! campBody holds {bk['n']} elements, not 1 — "
              f"{', '.join(bk['strays'][:4])} sit OUTSIDE the slide, so the "
              f"one-page sizer cannot see them")
    else:
        print("  every section is inside the slide  ok")

    m = re.search(r"size:[\d.]+in\s+([\d.]+)in", pageRule or "")
    if not m:
        cbad.append("no @page size rule was written for the campaign export")
        print("  !! no @page size rule — the export will paginate to 13.333x7.5in sheets")
    else:
        sheet = float(m.group(1)) * 96          # CSS px to the inch
        printed = cf["printed"]
        if printed <= 0:
            cbad.append("printed height measured 0 — the check is asserting nothing")
            print("  !! printed height came back 0; this check cannot fail")
        elif printed > sheet:
            cbad.append(f"content is {round(printed - sheet)}px taller than the sized sheet")
            print(f"  !! content prints {round(printed)}px against a {round(sheet)}px sheet "
                  f"— {round(printed - sheet)}px spills onto a second page")
        else:
            tail = (sheet - printed) / sheet * 100
            # THE TAIL IS THE COMPLAINT, not just the spill (MW: "pdf document
            # height ... too much blank space at the bottom"). The estimate is
            # taken on screen and cannot be exact, so this is a ceiling, not a
            # target — but an unbounded tail is how a 7-page export hid.
            if tail > 30:
                cbad.append(f"{round(tail)}% of the sheet is blank")
                print(f"  !! content {round(printed)}px on a {round(sheet)}px sheet "
                      f"— {round(tail)}% blank tail, the sheet is over-sized")
            else:
                print(f"  content {round(printed)}px on a {round(sheet)}px sheet, "
                      f"{round(tail)}% blank tail  ok")

print(f"\n{len(cbad)} campaign funnel problem(s)")

sys.exit(1 if (bad or bcbad or cbad) else 0)
