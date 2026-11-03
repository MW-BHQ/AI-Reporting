#!/usr/bin/env python3
"""
VISUAL REGRESSION (v3.370.0). Catches a layout that moved, grew or clipped
before MW sees it on the deployed site — above all the printed deck, whose
one-page-per-slide design took many nights and is easy to break silently.

Two checks per screen and per printed slide, against `test/visual/`:
  1. GEOMETRY — every card, stat, slide and grid in #viewRoot, as rounded
     boxes. Exact: a card 30px taller or a grid that collapsed fails, with the
     element named.
  2. PIXELS — a 320px-wide grayscale thumbnail. Mean absolute difference over
     DIFF_MAX fails. Catches a wrong colour, a missing chart, an empty card.

Deterministic on purpose: fixed dates (July 2026, the smoke-test month),
reduced motion (no transitions or count-ups mid-frame), Chart.js animation
off, the status line and clocks outside #viewRoot.

    (WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ECOM_SHEET_ID=mock \\
     ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket PORT=8412 \\
     node --require ./test/mock-fetch.js server.js &) ; sleep 5
    python3 test/visual.py 8412            # compare, exit 1 on any change
    python3 test/visual.py 8412 --update   # accept the current render

A change you MEANT is accepted with --update and committed with the release,
so the diff in git shows which screens it touched.
"""
import io
import json
import os
import sys
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops, ImageStat

PORT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "8412"
UPDATE = "--update" in sys.argv
ONLY = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")), None)
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "visual")
IAP = "accounts.google.com:admin@bkh.test"
FROM, TO = "2026-07-01", "2026-07-31"
THUMB_W = 320
DIFF_MAX = 1.5          # mean |delta| on 0-255 grayscale
GEO_TOL = 3             # px; sub-pixel rounding moves boxes by 1-2

# (key, nav selector, extra setup JS). Views whose first screen is a prompt
# (campaigns) get the smoke-test code so the real layout is what is captured.
VIEWS = [
    ("overview", "overview", None), ("report-BGH", "report|BGH", None),
    ("callout", "callout", None), ("gbp", "gbp", None),
    ("campaigns", "campaigns", "async()=>{await loadCampaign('260701-08', true); render();}"),
    ("pages", "pages", None), ("benchmark", "benchmark", None), ("audiences", "audiences", None),
    ("audit", "audit", None), ("gads", "gads", None), ("gadsbench", "gadsbench", None),
    ("bclub", "bclub", None), ("bcengage", "bcengage", None), ("line", "line", None), ("ecom", "ecom", None),
    ("ecommonthly", "ecommonthly", None), ("ecomcampaigns", "ecomcampaigns", None),
    ("ecomchannels", "ecomchannels", None), ("shopee", "shopee", None), ("lazada", "lazada", None),
    ("ecomcentre", "ecomcentre", None), ("ecompackages", "ecompackages", None),
    ("ecomroas", "ecomroas", None), ("ecomchurn", "ecomchurn", None),
    ("ecommigration", "ecommigration", None), ("topics", "topics", None), ("users", "users", None),
]

GEOMETRY_JS = """() => {
  const root = document.getElementById('viewRoot'); if (!root) return [];
  const r0 = root.getBoundingClientRect();
  const sel = '.card, .stat, .slide, .grid, table, canvas, svg.print-svg, .stage';
  return [...root.querySelectorAll(sel)].filter(e => e.offsetParent !== null).slice(0, 400).map(e => {
    const r = e.getBoundingClientRect();
    const head = (e.querySelector('h2,.card-title,.slide-title,.lab') || {}).textContent || '';
    return [e.tagName.toLowerCase() + '.' + [...e.classList].slice(0, 2).join('.'),
            head.trim().replace(/\\s+/g, ' ').slice(0, 40),
            Math.round(r.left - r0.left), Math.round(r.top - r0.top), Math.round(r.width), Math.round(r.height)];
  });
}"""


def thumb(png_bytes):
    im = Image.open(io.BytesIO(png_bytes)).convert("L")
    h = max(1, round(im.height * THUMB_W / im.width))
    return im.resize((THUMB_W, h), Image.BILINEAR)


def settle(pg, ms=1500):
    try:
        pg.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    pg.wait_for_timeout(ms)


def capture(pg):
    out = {}
    pg.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded", timeout=60000)
    settle(pg, 2000)
    pg.add_style_tag(content="*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}")
    pg.evaluate("()=>{ if (window.Chart) Chart.defaults.animation = false; }")
    for key, nav, setup in VIEWS:
        if ONLY and ONLY != key:
            continue
        view, _, brand = nav.partition("|")
        pg.evaluate("""([v, b]) => { const n = [...document.querySelectorAll('.nav-item')]
            .find(x => x.dataset.view === v && (!b || x.dataset.brand === b)); n && n.click(); }""", [view, brand])
        settle(pg, 600)
        pg.evaluate(f"()=>{{ const f=document.getElementById('from'), t=document.getElementById('to');"
                    f" if (f && t) {{ f.value='{FROM}'; t.value='{TO}'; try {{ syncDateLabel(); }} catch(e) {{}} }} }}")
        if setup:
            pg.evaluate(setup)
        else:
            pg.evaluate("()=>{ const b=document.getElementById('loadBtn'); if (b && b.offsetParent) b.click(); }")
        settle(pg, 2500)
        root = pg.query_selector("#viewRoot")
        if not root:
            continue
        out[key] = {"geo": pg.evaluate(GEOMETRY_JS), "img": thumb(root.screenshot())}
        if key == "report-BGH":
            pg.emulate_media(media="print", reduced_motion="reduce")
            pg.evaluate("()=>{ try { fitNativeSlides(); } catch (e) {} try { resizeChartsForPrint(); } catch (e) {} }")
            pg.wait_for_timeout(1200)
            for i, s in enumerate(pg.query_selector_all(".slide:not(.slide-pages):not(.slide-flow)")):
                if not s.is_visible():
                    continue
                out[f"print-{i:02d}"] = {"geo": [], "img": thumb(s.screenshot())}
            pg.emulate_media(media="screen", reduced_motion="reduce")
            settle(pg, 800)
    return out


def main():
    os.makedirs(HERE, exist_ok=True)
    geo_path = os.path.join(HERE, "geometry.json")
    base_geo = json.load(open(geo_path)) if os.path.exists(geo_path) else {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1400, "height": 900}, reduced_motion="reduce",
                            extra_http_headers={"X-Goog-Authenticated-User-Email": IAP})
        shots = capture(ctx.new_page())
        b.close()
    if UPDATE:
        for k, v in shots.items():
            v["img"].save(os.path.join(HERE, f"{k}.png"), optimize=True)
            base_geo[k] = v["geo"]
        json.dump(base_geo, open(geo_path, "w"), ensure_ascii=False, indent=0)
        print(f"updated {len(shots)} baselines")
        return 0
    problems = 0
    for k, v in shots.items():
        bp = os.path.join(HERE, f"{k}.png")
        if not os.path.exists(bp):
            print(f"  NEW   {k:16} no baseline (run --update)"); problems += 1; continue
        base = Image.open(bp).convert("L")
        msg = []
        if base.size != v["img"].size:
            msg.append(f"height {base.size[1]} -> {v['img'].size[1]} (thumb px)")
            base = base.resize(v["img"].size)
        d = ImageStat.Stat(ImageChops.difference(base, v["img"])).mean[0]
        if d > DIFF_MAX:
            msg.append(f"pixels differ {d:.2f} > {DIFF_MAX}")
        bg = base_geo.get(k, [])
        if len(bg) != len(v["geo"]):
            msg.append(f"{len(bg)} -> {len(v['geo'])} boxes")
        else:
            for a, c in zip(bg, v["geo"]):
                if a[:2] != c[:2] or any(abs(x - y) > GEO_TOL for x, y in zip(a[2:], c[2:])):
                    msg.append(f"{c[0]} '{c[1]}' {a[2:]} -> {c[2:]}"); break
        if msg:
            problems += 1
            print(f"  FAIL  {k:16} " + "; ".join(msg))
            v["img"].save(os.path.join("/tmp", f"visual-{k}.png"))
        else:
            print(f"  ok    {k:16} {d:.2f}")
    print(f"\n{len(shots)} screens, {problems} changed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
