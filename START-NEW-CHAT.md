# BHQ War Room — handover at v3.342.0

Written for a fresh session. MW is bringing a NEW source of Shopee data, so the
Shopee section matters most — read it before touching anything there.

## Where things are

- Repo `MW-BHQ/AI-Reporting`, branch `main`, working dir `/home/claude/bkh/`.
- Auto-deploys to Cloud Run `ai-reporting-git`, `asia-southeast1`,
  project `ai-reporting-503911`. Live at `w.bkhos.co`.
- Current version **3.342.0**. Bump BOTH `package.json` and `CLIENT_BUILD` in
  `public/index.html`, and add a CONTEXT.md entry.
- MW supplies a session-scoped GitHub PAT. Ask for it; do not look for one.

### Before every push
```
ECOM_SHEET_ID=mock npm test                      # must exit 0
python3 test/print-overflow.py 900 <port>        # must exit 0
```
Mock server (dies between bash calls — start it in the SAME command):
```
WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ECOM_SHEET_ID=mock \
ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket PORT=8412 \
node --require ./test/mock-fetch.js server.js
```

## How MW works

- Terse. Reads the DEPLOYED output and catches naming and layout errors fast.
  When he says something is wrong, he is right — trace to root cause first.
- One block of issues per turn; work through them and push. No incremental
  approval requests.
- He deletes footnotes on sight. Explanations belong in code and CONTEXT.md.
- `/i-have-adhd` is usually on: lead with the next action, number the steps, no
  preamble, plain words. He will say so if a reply is too dense.
- Never show 0 for something that was not measured — dash plus a reason. The
  single most repeated correction in this project's history.

## SHOPEE — read this first (rewritten v3.337.0)

**Source:** MW's Google Sheet `SHOPEE_SHEET_ID`
(`17T21LhWMSxIkg8GWZKS6tFQ6Q1x0mssDXx5pLX7r-kg`), shared with
`715584769614-compute@developer.gserviceaccount.com`. Pasted Seller Centre and
Brand Portal exports. **Windsor Shopee was removed (v3.322.0)**; the mock fails
any request to it. Meta spend comes from Windsor `facebook`, accounts named
`*Shopee*`.

| Tab | Export | Grain | Notes |
|---|---|---|---|
| Sales | Seller Centre > Business Insights > Sales | daily | range-summary rows skipped; later paste of a day wins |
| Traffic | Seller Centre > Traffic | daily | rates weighted by visitors |
| Product Views | Seller Centre > Product | daily | search clicks live here |
| Off-Platform Traffic | Brand Portal > Off-platform Traffic > Campaign Performance | daily | Shopee-credited; channel, campaign, ad content |
| Off-Platform Products By Day | same > Product Performance | daily | package × channel × campaign |
| Shopee Ads | On-platform Ads > Performance Ads > Overall | daily | every day twice (All + TH): keep TH |
| Shop Ads | On-platform Ads > Shop Ads Performance, By Day | daily | `20250114` dates; PART of Shopee Ads |
| Shop Ads Keywords | same, By Keyword | monthly, col A `Month` | |
| Package Sales | Brand Portal > Product Analysis > Product Performance, Item Level | monthly, col A `Month` | whole shop per package |
| Package Ads | On-platform Ads > Product Ads Performance, By Product | monthly, col A `Month` | joined on Product ID |
| Buyer Gender / Buyer Age | Brand Portal > Consumer Insights > Buyer | monthly, `Date` col | `All` rows, not `TH` |
| Instructions | — | — | team guide; never read |

Each group is its own batchGet: **a tab listed in code but missing from the
sheet fails its whole batch**, so remove it from code BEFORE MW deletes it
(Campaign tab, v3.333.0).

**Rules that cost releases:** monthly tabs count only whole months inside the
range; `Month` is read in every form Sheets rewrites it to; one digit after a
dot is a tens month (`2025.1` = October); every Shopee-credited figure is
labelled credited (7-day, gross, any shop product); organic is an estimate
(null + flag when credits exceed sales, never negative); MoM/YoY only for
fully covered windows; the Shopee Ads split never adds to spend totals.

**Not available in any export:** recommendation-feed traffic, cart age,
per-shopper behaviour. Stop looking.

## LINE — complete, five steps

Overview funnel → Campaign tab → Pages (source row only) → LINE OA tab →
Monthly Report page. Reads two tabs of one Google Sheet
(`1pk5EA12P-DnkjHvhh9PvsVCFmvvKhk-exSDVP2V82Oc`): `Broadcast` and `friends`.
- `deliveredCount` = impressions, `open` = INTERACTIONS (not Engagement — that
  stage is GA4 engaged sessions and must stay a subset of visits).
- Clicks are ignored: the session is already counted at Visits.
- The `utm_camapgin` header is MISSPELLED in the sheet. Matched as written.
- One OA serves all four hospitals → group-scoped, stated everywhere.
- Windsor's LINE connector was removed in v3.316.0.

## Windsor connectors

**In use:** `google_my_business` (11 calls), `google_ads` (11), `facebook` (9),
`tiktok_organic` (4), `facebook_organic` (3), `shopee`, `lazada`.
**Disconnected/dead:** `line`, GA4, Search Console, YouTube — GA4 and GSC are on
the direct Google APIs, YouTube reads a Sheet.
**Lazada is catalogue-only** — Products table, no orders, no revenue. MW parked
it; nothing is built.

**ALWAYS call `get_fields` before writing any Windsor pull.** Most repeated
mistake on this project. MCP approval is per chat session.

## Open items

1. Verify v3.314–v3.320 on deployed data — MW has not reviewed them yet.
2. Shopee: live data for v3.321–v3.337 is being checked by MW.
3. Marketplace revenue is still OUTSIDE every headline revenue figure. Deliberate
   — decide explicitly before joining it.
4. PDF: campaign sheet has a ~6% blank tail. Residual is prep-vs-print text
   wrapping; closing it risks a second page. Left alone on purpose.

## Traps that have each cost a release

- **Verify Windsor field names with `get_fields` first.**
- **Ratios and snapshots cannot be summed** — impression share, bounce rate,
  scroll depth, follower counts. Difference two points, or divide once at the end.
- **GA4 reports must be paginated.** `rowCount` is the authority; a short page is
  NOT the end of the report (v3.293.0).
- **Empty months produce no GA4 row** — pad the range or a chart silently starts
  late (v3.294.0).
- **Declaration order**: a `const` used before definition throws.
- **Write a negative test for every guard.** Break it, watch it fail, revert.
  Dozens of assertions in this suite were decorative until this was done — the
  most common cause is a FIXTURE that cannot tell right from wrong, not a bad
  assertion.
- **The SVG twin is what prints**, not the canvas. `print-prep` must mirror any
  print rule that changes height (v3.290.0).
- **Backticks inside an HTML comment end a template literal** (`js:comment-backtick`).
- **`BRAND_KEYS` is server-side only** — using it in the client kills the whole
  report.
- **Every view that renders a Load button needs a `VIEW_LOADERS` entry**, or the
  button does nothing (`views:loader-registered`).
- **Colour thresholds live in the `RED` block**, checked by `thresholds:named`
  and `thresholds:units`. The block mixes fractions (0.70) with scaled values
  (10 = 10%).
