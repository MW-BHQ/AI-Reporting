# BHQ War Room — handover at v3.410.0

NEXT JOB (open): Campaign detail table under-counts — its rows add to ~68.8K while the
header says 102.4K for 261001-05 (Oct), and the SEM ad-campaign sub-list shows ~8 of 16
with old names ("THB 10,798.71"). Header total is correct. Trace the row spend split
(the "~" visit-share split) and the ad-campaign sub-list cap. Re-check now that Meta
(B+ x ADA, ~345K to 6 Nov) is in.

## This session in one screen (v3.388 → v3.410)
- Google Profile tab (`gbp`) rebuilt — details in CONTEXT.md v3.388–v3.406. Per listing
  (6 incl. Dental/JMS): performance, search terms (latest PUBLISHED month; Google lags
  1–2 weeks), reviews (12-month stack + Reviews by month, bar labels at the foot, nodes),
  Customers Voices, AI Review sentiment / watch list / themes (Claude; tags in GCS by
  review id; Thai/English shown as written, others translated with original beneath;
  evidence = reviewer + date + listing reviews link — Google has no per-review link).
- PDF (gbp): reviews page first, pages 1–2 16:9, pages 3+ auto height (`gbpAutoPages` +
  `gbp-measure`, keep in step with `.slide.pn` print rules), waits for Claude, file name
  "<listing> Google Review - <range>". Twin (`chartToSvg`) shares `chartLabelTxt`.
- Ratings are CUT, never rounded (`rateTxt`/`rateAuto`/`starsHtml`), Monthly Report too.
- Security v3.407–v3.409: IAP token cache bound to the signed email (closed a replay →
  admin escalation); IAP_AUDIENCE set live (audienceChecked:true); range guard on every
  /api (real dates, in order, ≤6 years; themes ≤400 days); error scrubbing; HSTS;
  CSP ENFORCED (inline script by SHA-256, no inline handlers — a test fails if one
  appears; kill switch CSP_MODE=report|off; violations logged `csp_violation`).
- Meta "B+ x ADA" connected in Windsor (MW, 6 Nov) and mapped as a SHARED account.
- Another session works on Better Club (apps-script/, bq/) — always `git fetch` and
  rebase before pushing.

## Open
1. Campaign detail under-count (above).
2. L01 BHQ Meta Traffic (261001-05) spent 24.2K vs 14,725 in its name — MW asking ADA.
3. Monthly Report keyword-rankings card still reads the sheet MW is retiring.
4. visual.py: 5 table screens fail by sandbox font drift (same on untouched v3.387).
5. Check Cloud Logging for `csp_violation` once.

## Where things are

- Repo `MW-BHQ/AI-Reporting`, branch `main`, working dir `/home/claude/bkh/`.
- Auto-deploys to Cloud Run `ai-reporting-git`, `asia-southeast1`,
  project `ai-reporting-503911`. Live at `w.bkhos.co`.
- Current version **3.387.0**. Bump BOTH `package.json` and `CLIENT_BUILD` in
  `public/index.html`, and add a CONTEXT.md entry.
- MW supplies a session-scoped GitHub PAT. Ask for it; do not look for one.

### Before every push
```
ECOM_SHEET_ID=mock npm test                      # must exit 0
python3 test/print-overflow.py 900 <port>        # must exit 0
python3 test/visual.py <port>                    # must exit 0 (~2 min); --update to accept a meant change
python3 test/clickpath.py <port>                 # must exit 0 (~1 min): every button, no page errors
```
Mock server (dies between bash calls — start it in the SAME command):
```
WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ECOM_SHEET_ID=mock \
ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket PORT=8412 \
node --require ./test/mock-fetch.js server.js
```

## Google Profile — starting point (next job)

- Source: Windsor `google_my_business` (the most-used connector, 11 calls). Server
  jobs in `server.js` around `jobs.gbp`, `gbpDaily`/`gbpDailyPrev`, `gbpKeywords`,
  `gbpReviews`, `gbpLifetime` (~line 2410). Location names per hospital in the
  BRAND map (`gbp: [...]`, ~line 900; BGH incl. Dental Center, JMS listed separately).
- **Call `get_fields` on `google_my_business` before writing any new pull.**
- Client view id `gbp` (`S.charts.gbpChart`). Confirm the goal with MW before coding;
  he will say what the team needs from the tab.

## Better Club (v3.377 → v3.387) — BigQuery, complete

- Dataset `ai-reporting-503911.better_club` (asia-southeast1). Code `bq/better_club/`
  (README there). `build.js` generates setup/ingest/views/import SQL from one TABS
  config; `40_import_dev.sql` is hand-written (dev DB exports). MCP BigQuery calls must
  start `SET @@location = 'asia-southeast1';` and cannot read Sheets (no Drive scope).
- Daily: scheduled query `better_club_daily` = `CALL better_club.ingest()`, **00:00 UTC
  = 07:00 Bangkok**, runs as the compute SA. raw_* append-only (row hash), views dedupe
  on the business key, `_ingest_log` per tab per run, `_customer_seen` for removed members.
- Backfilled Sep 2024 → now from the dev: all_event 218k, read_post +148k, click_cta +30k,
  quiz +19.8k (questions joined from his quiz list). Imports logged `import:<tab>:<label>`.
  Known small gaps (MW: leave them): 2 quiz ids missing; clicks dip late Jun–mid Aug 2026
  in the dev's own data.
- **MAU = the team's definition**: earned B points at least once in the month — all_event
  DAILY_LOGIN (= the daily CHECK-IN claim, not a login log), READ_POST (reward reads),
  ANSWER_QUIZ. Logins come only from customers.last_login changes, from 2 Nov 2026.
- Tabs (nav order): **Performance** (`bcengage`), **Quiz Insight** (`bcquiz`),
  **Rev Attribution** (`bclub`). Performance = freshness strip, MAU growth accounting
  (new / retained / reactivated / lost, identity asserted in smoke), What to do next
  (sized plays + CSV target export, logged), group table (counts), cohorts (6-month
  window), daily actives (new vs existing, by activity), topics, buttons, points &
  rewards, badges vs last month, sign-up channel / campaign activation, reward articles,
  hour of day, streaks, points → patients (months of points BEFORE first visit vs
  Has HN, revenue). Footnotes everywhere on Performance — MW asked; exception to the
  no-footnotes rule for this tab only.
- Rev Attribution: registrations, member total and mix from BigQuery; HN-based figures
  stay on the roster sheet; roster fallback if BigQuery is down.
- Parked for later: "logged in, didn't check in" card (needs 2–3 weeks of logins).
- Test notes: visual.py takes ~3 min — run detached (`setsid`) or the 300 s tool limit
  kills it. `pkill -f mock-fetch.js` inside a bash command kills that command itself.

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

## Session v3.321 → v3.356 in one screen (read before touching e-commerce)

**Shopee** (own tab): Seller Centre + Brand Portal sheet, 12 tabs (table above).
Windsor Shopee REMOVED. Funnel, traffic, Shopee Ads (+ Shop Ads split, keywords),
CPAS (Meta vs Shopee referees), all-ads ROAS, where-sales-came-from (THB) + how
shoppers arrived (clicks), outside channels/campaigns/placements, website →
Shopee handoff (GA4 link clicks by utm_content), packages whole shop, "What to do
next" synthesis (`SHOPEE_SYN`: 2×2 ad money, leaks, search demand gaps, other
hospitals' names), price bands, buyer gender/age, MoM/YoY (fully covered windows
only), labelled bars (`labelledBars`, 9.5px).

**Lazada** (own tab): sheet `LAZADA_SHEET_ID` = `1_WnGf7NOIDOL9xrF5_JTpIBSobgv7SY-CR-wXjCRL8I`.
Tabs: Traffic Source, Key Metrics (daily), Product (monthly, SKU rows skipped),
Customer Insight (new/existing), External Daily / Links / Sold (daily). Meta on
Lazada from Windsor `*Lazada*` accounts. Colour PINK `#E4127A` everywhere.
Lazada platform ad spend = UNMEASURED (Sponsored Media empty) — dash, open question.

**Cross-shop:** E-commerce > E-commerce Campaigns (`/api/ecommerce/campaigns`):
one row per campaign code joining Shopee, Lazada, website clicks, Meta spend.
E-commerce > Overview: "Marketplaces side by side" card.
Reporting > Overview: both shops in every funnel stage via `totalsAll` +
`marketplace` (`totals` stays web-only for Monthly Report); in Off-site reach &
action; E-commerce block = Website | Shopee | Lazada | Total. No month-end
forecast (removed: shop sheets land after month close). No B+ pills, no
"(all branches)", no footnotes — MW's calls.

**House rules settled this session:** one card-heading style (`.card h2` =
`.card-title`; `.sec-h` only for section labels between cards); house green
#2E9E6F / red #D9534F for verdicts; every tab opens on LM (Churn/Migration keep
long range); date picker is custom (no library), pending until Apply.

**Infra:** `sheetBatchGet` retries 429/5xx twice; results with `sheetErrors`
cached 1 minute. Each sheet group is its own batchGet — remove a tab from code
BEFORE MW deletes it.

**Apps Script (NOT in this repo):** "e-commerce normalised data" sheet,
normaliser v2.11.0 — step 3 `reapplyMapping` rewritten (9 columns, 10k-row
blocks, writes only changed blocks, resumes by timer at 4½ min). MW holds the
full .gs; ask him for it before editing.

## Open items

1. MW's team is back-filling the Shopee and Lazada sheets to the present; then
   check Overview, Shopee, Lazada and E-commerce Campaigns on a month both cover.
2. Call out tab (v3.360.0): first real run on October data — check Claude's
   picks, the red-number rate, and the .docx in Google Docs.
3. TikTok GA4 match: TikTok ads show in Campaigns, but visits need the TikTok
   `utm_campaign` to start with the campaign code. Ask MW for one landing URL.
4. Campaign detail parent row: THB/visit is a website number; on a Message
   campaign it should be the campaign's own cost per result. Offered, not done.
5. Colour tokens round 2: ~22x `#4C5878` (= --ink-2) and ~17x `#4B8DF8`
   (= --blue) still hand-typed. Same method as v3.375.0.
6. Lazada: who funds the Sponsored Discovery/Max visitors (ask Lazada AM).
7. PDF: campaign sheet ~6% blank tail, left alone on purpose.
8. Older wishlist: PDF date stamp, better month-end forecast, topic ideas.

## Session v3.357 → v3.376 in one screen

- **Monthly Report** (all 4 hospitals): Digital Marketing Performance cover →
  Overview page (shared `funnelCard(d)` + 4 scorecards: Total Visibility,
  Total Visits, Total Contact Us incl. Google Ads calls, Total Direction
  requests; BHQ) → Website Performance cover. MoM/YoY only like-for-like
  (`overviewScorecards`), else dash + "<source> not comparable" printed.
- **Campaigns**: ad rows judged by their objective (`adResultRow`; Meta goal =
  spend-weighted `adsset_optimization_goal`). TikTok Ads (`tiktok`, live
  names `TT14_260918-02_...`, matched by `adNameMatchesCode` — code token
  needs its dash so PO numbers never match; TikTok `results` reads 0 live,
  traffic uses destination clicks). TikTok organic matched by link or code in
  caption. Spend fallback never lands on a row another platform owns.
  PDF file name `[code] - [range]`.
- **E-commerce Channels**: "What moved between the two halves" removed.
- **Skill pack items**: `test/visual.py` (screens + printed slides vs
  `test/visual/`), motion (entrance, bar wipe, count-up; never in print),
  Node zlib compression (index 778→183KB, ETag), `test/clickpath.py` (109
  clicks), IAP signed header ENFORCED on Cloud Run (`jwt` in /api/me;
  kill switch env `IAP_ENFORCE_JWT=0`), `--good/--bad` + `HOUSE` tokens with
  `colours:house` lint.
- **Appointments block source** (MW asked): Initiates = GA4 `appointments`
  event; the rest = sheet `1Yt_4NknQdLQogZKwtZoG9dGAe99HlF0UuilebMxt95Q`
  (Realtime, Non Realtime, Total Amounts). ฿0 revenue = month missing from
  Total Amounts — should be a dash; offered, not done.

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
