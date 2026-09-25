# BHQ War Room — handover at v3.329.0

Written for a fresh session. MW is bringing a NEW source of Shopee data, so the
Shopee section matters most — read it before touching anything there.

## Where things are

- Repo `MW-BHQ/AI-Reporting`, branch `main`, working dir `/home/claude/bkh/`.
- Auto-deploys to Cloud Run `ai-reporting-git`, `asia-southeast1`,
  project `ai-reporting-503911`. Live at `w.bkhos.co`.
- Current version **3.329.0**. Bump BOTH `package.json` and `CLIENT_BUILD` in
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

## SHOPEE — read this first

**Current state (v3.317–v3.320).** Own tab, `/api/shopee`, `requireTab("shopee")`,
nav under `Report > Channels > Shopee`. Windsor connector, account `250344218`
(`BangkokHospital_Official`), one shop.

**What the Windsor connector has:** orders, settlement, returns, wallet,
products. **No line items** — confirmed by asking `get_fields` for nine
spellings of item name/sku/quantity. **No traffic, views, cart or source/medium.**

**What is built:**
- Gross (cancelled excluded), AOV, cancellation rate
- Settlement: sold, escrow, fee breakdown, take rate (~8.56% on this shop —
  5.35% commission + 3.21% transaction fee)
- Repeat buyers from `order_buyer_username`
- Off-site ad spend joined from META accounts named `*Shopee*` — spend BESIDE
  orders, never attribution
- Cancellation by payment method, order value bands, hour/weekday (Bangkok)
- Catalogue: live SKUs, median discount, zero-discount listings, low stock
- **Seller Centre sheet (v3.321.0)** `SHOPEE_SHEET_ID` — funnel, traffic,
  off-platform channels/campaigns, products, promotions. Stock-movement units
  were REMOVED in favour of it.

**Traps that cost time here:**
- Orders, settlement and returns are SEPARATE tables. Fields from two of them in
  one Windsor call cross-join the rows.
- Cancelled orders keep their full amount and settle at ZERO escrow.
- Discounts arrive as a shop-level lump on a row with a NULL `order_id`.
- `order_create_time` is UTC — add 7h for Bangkok or the evening peak lands in
  the afternoon.
- A restock RAISES stock, so it cannot be read as a negative sale.

**If MW's new source has line items, order-level traffic, or Seller Centre
funnel data**, the honest move is to REPLACE the stock-movement reconstruction
rather than run both — a heuristic that outlives its replacement is a second
answer waiting to disagree with the first. That exact mistake was made with LINE
(`lineSameDay`) and cleaned up in v3.316.0.

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
2. Shopee is Seller Centre sheet + Meta only since v3.322.0. Windsor Shopee is
   GONE; the SHOPEE section below describing it is history.
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
