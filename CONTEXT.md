# CONTEXT — read this before changing anything

Handoff document for **BHQ War Room** (formerly "BHQ Signal Room", originally
"Cross-Channel Control Room").

Everything below was **verified against the live APIs**, not inferred from
documentation. Several entries exist specifically because the obvious approach
failed; those are marked **DEAD END** and should not be re-attempted without new
information. Re-discovering them costs days.

---

## 0. Current state — read before anything else

**Version 3.142.0.** Sections 1–9 were written around v3.17 and remain accurate
on the APIs, but the product has more than doubled since. The dated entries
under "Recent (August 2026)" further down are **newest-first** and are the real
changelog — read those before the numbered sections.

**Tabs now.** Overview · **Monthly Reports (BGH / BIH / BHT / WSH)** ·
Google Profile · Campaigns · Pages · Meta Ads (Benchmarks, Audiences, Tagging
audit) · Google Ads (Overview) · E-commerce (Overview, Report, Centers,
Channels, ROAS, Churn, Migration) · Topic Explorer · Users.

**Monthly Reports is where the current work is.** It replaces a Looker Studio
deck, is one nav section with a tab per hospital, and prints to 16:9 slides.
Order is MW's; anything not yet reviewed sits below a marked divider in the
template.

**Vocabulary, and it matters.** **BHQ** = the four hospitals combined.
**B+ / "group"** = the 27-branch GA4 property. **BGH / BIH / BHT / WSH** =
individual hospitals. Using one word for two of these is how a board deck
overstates by a factor of seven.

**Data sources.** GA4 goes direct to the **Data API** and Search Console direct
to its own API — Windsor silently ignores `filters` on its GA4 connector, which
made server-side branch filtering impossible. Windsor still serves Meta Ads,
Google Ads, Google Business Profile, Facebook organic and TikTok organic. A
Google Sheet holds ~85,500 normalised e-commerce coupon orders.

**Performance.** `/api/report` makes ~35 upstream calls behind an 8-slot
concurrency gate, cached in GCS keyed by build version, with an upstream memo
below that. Before adding data, read the request-budget note (v3.87.1): derive
from a pull already in flight, then one group-wide pull bucketed in JS, and only
then per-brand requests.

**Testing is four layers**, all on `npm test` — see §10. `boot.js` now renders
the full report against a fixture, because parsing a template is not executing
it and five render bugs shipped before it did.

**The recurring failure is silence, not errors.** A filter that matches nothing,
a job whose rejection becomes null, a metric summed that should not be, a cache
that outlives its schema — all return 200 with plausible-looking numbers. Check
the output, not the status code.

---

## 1. What this is

A single Node/Express service on Cloud Run that serves a one-page dashboard and
pulls marketing data live from Windsor.ai. There is **no database and no data
warehouse** — that is deliberate. An earlier BigQuery-based design was rejected
by the owner because it added nodes and staleness.

**Owner / primary user:** MW (mongkhon.oo@bangkokhospital.com), Marketing
Division. Prefers concise answers, dislikes long explanations, and reads
critically — flagging assumptions and stating uncertainty is valued, hedging is not.

### Architecture

```
Browser (IAP-authenticated)
   → Cloud Run: server.js
        ├─ connectors.windsor.ai   (REST, direct — no LLM in this path)
        ├─ sheets.googleapis.com   (two internal sheets, service-account read)
        ├─ storage.googleapis.com  (access list + benchmark cache)
        └─ api.anthropic.com       (Topic Explorer ONLY)
```

**The LLM is never on the data-refresh path.** v1 routed every refresh through an
agent call and timed out at 60s+. Claude is used only for multilingual term
expansion and query clustering in Topic Explorer.

### Tabs

| Tab | Endpoint | Source |
|---|---|---|
| Overview | `/api/overview` | GA4 + Meta + GSC + GMB + organic + LINE |
| Campaigns | `/api/campaign`, `/api/campaigns` | GA4 + Meta + sheets |
| Google Profile | `/api/gbp` | GMB reviews |
| Benchmarks | `/api/benchmark` | GA4 + Meta, 12 complete months |
| Tagging audit | `/api/untagged` | GA4 + Meta |
| Topic Explorer | `/api/topic` | GSC + Anthropic |
| Users | `/api/users`, `/api/me` | GCS |

---

## 2. Deployment facts

| Item | Value |
|---|---|
| GCP project | `ai-reporting-503911` |
| Project number | `715584769614` |
| Runtime service account | `715584769614-compute@developer.gserviceaccount.com` |
| Cloud Run service | `ai-reporting-git`, region `asia-southeast1` |
| URL | `https://ai-reporting-git-715584769614.asia-southeast1.run.app` |
| Source | GitHub `MW-BHQ/AI-Reporting`, auto-deploy on commit |
| Secrets | `windsor-api-key`, `anthropic-api-key` (Secret Manager) |

### Environment variables

| Var | Purpose |
|---|---|
| `ECOM_SHEET_ID` | the normalised e-commerce sheet; **all E-commerce tabs need it** |
| `ECOM_TAB` | defaults to `Orders` |
| `LINE_ENABLED` | `1` re-enables LINE; default off since Aug 2026 |
| `ACCESS_BUCKET` | `ai-reporting-access`, persists the user list across deploys |
| `BENCHMARK_BUCKET` | benchmark snapshots |
| `GA4_ACCOUNT` | defaults to `484633959` |

The Sheets read uses the runtime service account, so the sheet must be shared
with it as Viewer and the **Sheets API enabled** on the project.

### Roles that were needed and are easy to miss

- `roles/secretmanager.secretAccessor` — else the revision fails to start
- `roles/developerconnect.readTokenAccessor` — **else GitHub builds fail at
  FETCHSOURCE**. Not granted by the console; documented but obscure.
- `roles/iap.httpsResourceAccessor` — per user. **Project Owner does NOT imply
  this**; the owner locked himself out until it was granted explicitly.
- Storage Object Admin on the bucket — for the access list

### Gotchas

- **Domain-restricted sharing is ON.** `--member="domain:bangkokhospital.com"`
  is rejected; users must be added individually.
- **Memory must be ≥ 1 GiB.** At 512 MiB the container was OOM-killed during
  Topic Explorer, surfacing as a bare Cloud Run **503** (a JSON error means the
  app is alive; a bare 503 usually means the container died).
- `ACCESS_BUCKET` is configured as of v3.15.0 (bucket `ai-reporting-access`) —
  user permissions persist in GCS. Before v3.15 they reset on cold start.
- Cloud Run scales to zero, so the in-memory cache empties on cold start.
  `--min-instances=1` keeps it warm.

### Environment variables

| Var | Purpose |
|---|---|
| `WINDSOR_API_KEY`, `ANTHROPIC_API_KEY` | secrets |
| `GA4_ACCOUNT` | defaults to `484633959` (Group property) |
| `ACCESS_BUCKET` | GCS bucket for user permissions **(not yet set)** |
| `BENCHMARK_BUCKET` | falls back to `ACCESS_BUCKET` |
| `ADMIN_EMAILS` | permanent admins; **deliberately not editable in the UI** so a bad edit can't lock everyone out |
| `DEFAULT_TABS` | what an IAP user with no entry sees (default `overview`) |
| `MODEL_ARMOR_LOCATION`, `MODEL_ARMOR_TEMPLATE` | optional prompt screening |
| `CACHE_TTL_MS` | default 600000 |

---

## 3. Windsor.ai

```
https://connectors.windsor.ai/{connector}
  ?api_key=…&fields=a,b,c&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
  [&accounts=…][&filters=JSON][&<connector options>]
```

- **Filter operator is `eq`, not `equals`.** `equals` returns
  `Invalid operator: 'equals'`. Also supports `gt`. Format:
  `[["field","eq","value"]]`.
- **DEAD END — `filters` does nothing on `googleanalytics4`.** Verified
  21 Aug 2026. One day, `landing_page,date,sessions`, account 484633959, run
  four ways: no filter; the object form `[{field,operation,value}]`; the
  documented array form `[["landing_page","eq",…]]`; and a filter on a field
  that **does not exist**. All four returned HTTP 200 and **byte-identical**
  bodies — 1,799,637 bytes, 16,887 rows, 11,072 distinct landing pages. Windsor
  parses the parameter, never rejects it, and discards it. A month is 482,355
  rows. **Do not build anything on Windsor-side GA4 filtering.** The Pages tab
  now uses the GA4 Data API directly (§4a).
- Treat the same suspicion as the default for other connectors. `buildRoas`
  passes an `account_id` filter to `facebook`; its client-side
  `if (!acc) continue` guard is what actually limits ROAS to three accounts,
  and removing it would silently fold in all 15.
- **Filters apply per row**, not to the aggregate — `spend > 8000` matches no
  daily row even when the campaign total is far higher.
- **Rate limits are real** and were hit repeatedly during development, LINE
  worst of all. The cache exists partly for this.
- A failed call must be treated as **unavailable, not zero** (see §7).

### Connected connectors (plan limit: 7)

`facebook` (Meta Ads, 15 ad accounts) · `facebook_organic` · `googleanalytics4` ·
`line` · `searchconsole` · `tiktok_organic` · `google_my_business`

### NOT connected — needs a plan upgrade

`google_ads` ← **biggest measurement gap; connect first** · `tiktok` (ads) ·
`line_ads` · `shortio` · `googlesheets`

Adding a platform means one line in `AD_PLATFORMS` plus a `utm_source` pattern in
`PLATFORM_SOURCE_HINTS`. Nothing else changes.

---

## 4. GA4 — verified

**Property in use: `484633959` (Bangkok Hospital Group).** Others exist
(314404119 HQ, 314423591 Heart, 314434411 Wattanosoth, 285317903 BIH) but the
Group property is the configured single source.

### The 10-metric limit

**GA4 rejects any request with more than 10 metrics** (HTTP 400). This broke two
endpoints in production. All field lists now go through
`ga4Fields(dimensions, metrics)`, which throws at build time if exceeded. **Use
it for every new GA4 call.** Splitting into two calls and merging is the fix.

### Fields that matter

| Field | Note |
|---|---|
| `session_manual_campaign_name` | = utm_campaign |
| `session_manual_source` / `_medium` | = utm_source / utm_medium |
| `session_default_channel_group` | channel for the funnel |
| `sessions`, `screen_page_views`, `engaged_sessions` | `engaged_users` does **not** exist |
| `conversions_*` | one per key event (see below) |
| `items_viewed`, `add_to_carts`, `ecommerce_purchases`, `purchase_revenue`, `transactions` | e-commerce |
| `item_name`, `item_view_events`, `items_added_to_cart`, `items_purchased`, `item_revenue` | item level |
| `landing_page`, `page_path` | locale detection |
| `event_name` + `event_count` | needed for non-key custom events |

### Key events (7 in use)

`add_to_cart`, `appointments`, `contact_us`, `find_doctors`, `view_cart`,
`view_item`, `purchase`. `conversions_login` exists but is deliberately excluded.

Only events **starred as key events in GA4** get a `conversions_<name>` field.
Everything else must be counted via `event_name` + `event_count` with a filter.

### DEAD END — `advertiser_ad_*` for Google Ads

`advertiser_ad_impressions`, `_clicks`, `_cost` return **zero for all 57
campaigns**. They populate from Google Ads *auto-tagging*; this account tags
manually with utm parameters. Google Ads spend can only come from the
`google_ads` connector.

### DEAD END — the custom `engagement` event

A custom (non-key) `engagement` event exists and returns ~1.08M/month. It was
wired in, then removed: it's an **event count**, so it exceeded the visit count
above it in the funnel and looked like a bug. `engaged_sessions` is used instead
because it's a strict subset of sessions and the funnel narrows properly.

---

## 4a. GA4 Data API — the one non-Windsor path (v3.60.0)

**Two endpoints use this**, and no others: `/api/page` (all reports) and
`/api/campaign` (the `ga4Landing` top-landing-pages report only — the rest of
that endpoint is still Windsor). Everything else goes through Windsor.
This is a deliberate exception to the single-source rule in §1, taken because
Windsor cannot filter GA4 at all (§3) and both of those pulls are keyed on a
dimension that must be filtered to stay a sane size.

**The test for whether a pull belongs here:** does it filter on a
high-cardinality dimension — `landing_page` (44,463 values) or a campaign name
— and discard most of what comes back? If so it must be filtered server-side,
which means the Data API. Pulls keyed only on campaign name without
`landing_page` are bounded by campaign count (hundreds) and are fine on Windsor.

| Item | Value |
|---|---|
| Endpoint | `analyticsdata.googleapis.com/v1beta/properties/484633959:runReport` |
| Scope | `https://www.googleapis.com/auth/analytics.readonly` |
| Auth | runtime service account, same `GoogleAuth` pattern as Sheets |
| Requires | Analytics Data API enabled **and** the service account granted Viewer on the GA4 property |
| Overrides | `GA4_API_BASE`, `GA4_LANDING_DIM` (default `landingPagePlusQueryString`) |

Four differences from Windsor's field names, each of which is a silent wrong
answer rather than an error if missed:

1. **Dates are `YYYYMMDD`**, not `YYYY-MM-DD`. `slice(0,7)` for a month key
   gives `2026072` on raw values — normalise with `ga4Date()` first.
2. **camelCase metrics** — `engagedSessions`, not `engaged_sessions`.
3. **`(not set)`, not empty string**, for untagged source/medium/campaign. Left
   raw it renders as a source literally called "(not set)" and counts as a
   tagged campaign. `ga4Val()` normalises it back.
4. **No `conversions_<event>` columns.** Per-key-event counts need dimension
   `eventName` + metric `keyEvents`, filtered to the seven names and summed.
   The bare `keyEvents` metric **includes `login`**, which §4 deliberately
   excludes, so using it alone inflates every figure on the tab.

Sessions and key events therefore come from **paired reports merged by key** —
adding `eventName` to the sessions report would multiply sessions across events.
Ten small filtered reports replace five property-wide pulls.

The server-side filter is `BEGINS_WITH` on the path, deliberately broader than
needed; the existing `match()` still narrows to the page and its children, so a
sibling like `/th/x/foo-2` is fetched but not counted.

---

## 5. Meta Ads (`facebook`) — verified

### `clicks` is not link clicks

`clicks` is Meta's **"clicks (all)"** — reactions, photo expands, profile taps.
On a sampled campaign: **842 clicks vs 544 link clicks vs 432 landing page
views.** Using `clicks` overstated CTR by roughly 55%.

| Field | Meaning |
|---|---|
| `actions_link_click` | the actual link click — use for CTR and CPC |
| `actions_landing_page_view` | browser rendered the destination — **the only fair comparison to a GA4 session** |
| `actions_lead` | leads (currently **0 on every campaign** — no lead-objective campaigns are running) |
| `actions_onsite_conversion_messaging_conversation_started_7d` | conversations |
| `campaign_objective`, `objective` | authoritative; **prefer over parsing names** |
| `campaign`, `account_name` | |

### Campaign names ≠ utm values

Meta: `260605-01_BIH_DAA_5JUN2026_5JUL2026_2604149558_Traffic_THB8344.46`
GA4:  `260605-01_bih_tra`

They share **only the `YYMMDD-NN` prefix**. An early version tried to merge them
by exact name, failed, and invented phantom zero-visit rows. They are now joined
by code prefix, and spend is attributed to utm variants via `utm_source`.

---

## 6. Other connectors

### Search Console

Fields: `query`, `page`, `country`, `clicks`, `impressions`, `position`, `date`,
`device`.

**`query × page × country` in one call OOM-killed the container.** It is split
into two narrower calls (`query+page`, `query+country`) and merged.

### Google Ads (`google_ads`) — connected Aug 2026

Campaign names use the **same `YYMMDD-NN` convention as Meta**, so they join
campaign analysis with no new matching logic. Registered in `AD_PLATFORMS`
alongside facebook.

**The platforms cannot share a field list.** Google Ads has no
`campaign_objective` and none of the `actions_*` metrics, and requesting them
makes the whole call fail rather than returning nulls — each platform declares
its own `extra` fields. Useful fields: `adgroup`, `campaign_type`,
`conversions`.

Because Google reports no in-platform result, a Google campaign without a utm
has genuinely lost its outcome, where a Meta lead-form campaign has not.

### LINE — disconnected Aug 2026, code retained

Removed from Windsor and replaced by Google Ads. Every call site routes through
`lineWindsor()`, which resolves `null` unless `LINE_ENABLED=1`; all consumers
already treated null as "unavailable". Kept rather than deleted because the
request-ID join and same-day broadcast heuristic took real work. The test mock
returns HTTP 400 for any LINE request, so a reintroduced call fails the suite.

### LINE — DEAD END for per-message metrics

**Works** (the delivery table): `message__broadcast`, `message__targeting`,
`message__api_broadcast`, `_api_narrowcast`, `_api_multicast`, `_api_push`,
`followers__followers`, `followers__targeted_reaches`.

**Always returns zero**: `message_delivered`, `message_unique_impression`,
`message_unique_click`. These need the connector option `message_request_ids`,
and LINE only issues a request ID (`x-line-request-id`) for messages sent via the
**Messaging API**. This team sends via the **OA Manager UI**, which never produces
one. **This data is permanently unreachable.** Do not retry.

The code already reads LINE request-ID UUIDs from UTM Builder columns N–P if they
ever start being logged, and will light up automatically.

### TikTok organic — field names verified Aug 2026 (v3.100.0)

Checked against the connector, not guessed. **There is no `reach` field.**

| Wanted | Field | Table |
|---|---|---|
| Views | `video_views` | Account |
| Reach | **`unique_video_views`** ("daily reached audience") | Account |
| Profile views | `profile_views` | Account |
| Link / phone clicks | `bio_link_clicks` / `phone_number_clicks` | Account |
| Per-video views | **`video_views_count`** | Video |
| Per-video engagement | `video_likes`, `video_comments`, `video_shares`, `video_favorites` | Video |
| Per-video media | `video_thumbnail_url`, `video_caption`, `video_share_url`, `video_reach` | Video |

- **Account and Video are separate tables and need separate pulls.**
  `video_views` (account total) and `video_views_count` (per video) are easy to
  conflate and would double count.
- `unique_video_views` is a DAILY figure. Summing it over a month counts a
  repeat viewer twice — an upper bound on unique reach, never "unique reach".
- No rate fields exist; like/comment/share/favourite rates are ours to define.
- No website-click field: `bio_link_clicks` and `phone_number_clicks` are the
  only profile actions exposed.

### Google Business Profile — 6 listings

| Key | Exact `location_title` | Reviews | Rating |
|---|---|---|---|
| BGH | `Bangkok Hospital` | 8,492 | 4.7 |
| BIH | `Bangkok International Hospital (Brain x Bone)` | 2,784 | 4.9 |
| BHT | `Bangkok Heart Hospital` | 539 | 4.9 |
| WSH | `Bangkok Cancer Hospital Wattanosoth` | 409 | 4.9 |
| Dental | `Dental Center | Bangkok Hospital` | 180 | **4.2** |
| JMS | `Japanese Medical Services (JMS) バンコク病院日本人専門クリニック` | 125 | 5.0 |

- `review_star_rating` is a **TEXT enum** (`ONE`…`FIVE`), not a number.
- `review_total_count` / `review_average_rating_total` = **all-time**;
  `review_count` / `review_average_rating` = **in range**.
- Bucket by `review_create_time`, not `date`.
- Google publishes the all-time average **rounded to one decimal**, which is why
  the running-rating opening balance carries slight imprecision.

---

## 6a. The e-commerce pipeline — a second data source

E-commerce does **not** come from Windsor. It comes from a Google Sheet the
marketing team maintains, fed by an Apps Script normaliser.

**Monthly workflow.** The e-com team exports `report_order-*.xlsx` from the
hospital's order system → it is imported to a tab named `Insert` → menu
**กดตรงนี้ 👆🏻 ▸ Normalise Insert sheet** → clean rows are appended to `Orders`
and `Insert` is deleted.

**Sheet tabs, and what depends on them**

| Tab | Role | Safe to delete? |
|---|---|---|
| `Orders` | 35 columns, one row per coupon. The dashboard reads this. | **No** |
| `Package_Name` | the team's package master; resolves SKU, centre, order set | **No** |
| `Package_Map` | crosswalk of export name + price → SKU, the team edits it | **No** |
| `Load_Log` | audit trail of imports | rebuildable |
| `Validation` | output of the validator | yes |

**What the normaliser handles**, each because the raw export required it:
merged multi-package orders split to one row per coupon; Buddhist-era dates
(2569 → 2026); a grand-total footer row that would otherwise become data; order
level fees allocated pro-rata by price; de-duplication on coupon number so a
re-upload appends nothing; and **PII replaced with HMAC keys** — names, phones
and emails never reach `Orders`, only `email_key` / `phone_key`, salted with a
pepper in Script Properties that must never be regenerated.

**Verified scale.** 85,528 rows, Jan 2024 → Jul 2026, 0 duplicates, 31 channels
all classified, 98.5% carrying a customer key. Pre-2026 rows have no SKU at all,
so **centre analysis is only meaningful inside 2026**; channel, migration,
customer and package-name analysis work across all 31 months.

**Channel taxonomy** lives in `CHANNEL_TYPE` (server) and `KNOWN_CHANNELS`
(Apps Script) and must stay in step: Online 7 · Offline 11 · B2B 6 ·
Special Campaign 3 · Complementary 3 · Extra 1. Three B2B/Special orders were
₿8.3M of one month, which is why every e-commerce view defaults to Online only.

---

## 7. Conventions

### Campaign codes

`YYMMDD-NN_brand_objective` — e.g. `260605-01_bih_tra`.
Brands: `bgh`, `bih`, `bht`, `wsh`, `bcm`. Objectives: `tra`, `vdo`, …

- The first six digits are the **launch date**, decoded by `codeLaunchDate()` so
  an empty result can say "this campaign started before your date range".
- **Casing is inconsistent** (`260601-02_BIH_tra` vs `bih`) — all matching is
  case-insensitive.
- Some campaigns don't follow it at all (`12th-checkup`,
  `rightchoice-google-reserve`). These are valid campaigns, not errors, but can't
  be searched or dated.
- Matching is **prefix-based**, so `260501`, `260501-11` and `260501-11_bgh` all
  work at different levels of roll-up.

### Site locales (10)

`/th/ /en/ /zh/ /ja/ /ar/ /de/ /my/ /vn/ /km/ /id/` (`/vi/` also maps to `vn`).

**Language must come from the URL path, never the query script.** EN, DE, VN and
ID all use Latin characters and cannot be told apart by characters alone.
`scriptGuess()` deliberately returns `null` rather than guessing "en".

### Internal sheets

Both have monthly tabs `Jan`…`Dec`, read with the runtime service account
(`spreadsheets.readonly`). They are **confidential — do not publish to web.**

| Sheet | ID | Layout |
|---|---|---|
| UTM Builder 2026 | `13QuzSmYP-XA1kFX9_voVFB492x6327RGJIu4kvrTGwE` | L = utm_campaign, M = short link (`bkhos.co/…`), N–P scanned for LINE request UUIDs |
| Content Plan 2026 | `1ClBR81GbG-QSKuj4f24-8M_4Gjmoz3i2gPZfd1mpjok` | A = Launch Date, B = Campaign Code, C = Topic (human name) |

`/api/sheets-check` walks each step and returns the specific fix on failure.

### Organic attribution — the link bridge

Organic posts carry no campaign tag. The bridge is: **UTM Builder gives the short
links for a code → search `post_message` in `facebook_organic` for those links →
that post's impressions and engagement belong to the campaign.** Matching ignores
scheme and trailing slash. Only Facebook works this way; LINE and EDM expose no
message content.

---

## 8. Design decisions and why

**Null is not zero.** A failed source returns `null` and renders `—` with an
"unavailable" banner. This came from a real incident: a rate-limited LINE call
was displayed as a confident `0`. A dashboard that fabricates certainty is worse
than one that admits ignorance.

**Window ratios come from summed totals, not averaged monthly ratios.** Tested:
two months at ฿50/contact plus one tiny month at ฿200 gives ฿100 as an
average-of-ratios but ฿50 from totals — a 99% distortion.

**Benchmarks use complete calendar months only.** Comparing three days of August
against a full-month average would flatter everything.

**Efficiency is judged per objective.** Cost per visit is meaningless for a lead
form that never sends anyone to the site. `GOAL_DEFS` maps each objective to its
own result metric and records whether the count comes from Meta or GA4.

**Media and traffic are separate then rejoined by code** (see §5).

**Green means favourable, not upward.** A fall in cost per contact is green; a
fall in results per ฿1,000 is red.

**Funnel uses a logarithmic axis** — 2.5K key events beside 344.8K impressions is
one pixel on a linear scale.

**Chart.js is self-hosted; fonts come from Google Fonts CDN.** Brave Shields
blocks `cdnjs.cloudflare.com`, which broke the page with "Chart is not defined".
Fonts degrade harmlessly to a system font, so the CDN is acceptable there.
**Do not move Chart.js back to a CDN.**

**HTML is served `no-cache`.** A deploy once left users on a stale page showing an
already-fixed error.

**Permissions are enforced server-side**, not just by hiding tabs. `ADMIN_EMAILS`
is deployment config so a bad edit can't lock everyone out.

---

## 9. Dead ends — do not retry

1. **GA4 `advertiser_ad_*`** for Google Ads spend — zero everywhere (§4)
2. **LINE per-message delivery/opens** — needs request IDs that OA Manager never
   issues (§6)
3. **Publishing the sheets to web** — confidential; use the service account
4. **Chart.js from a CDN** — blocked by Brave Shields
5. **Windsor `equals` operator** — it's `eq`
6. **`domain:` IAM grants** — blocked by org policy
7. **Merging Meta campaigns to utm variants by exact name** — different strings

---

## 10. Testing — four layers, all on `npm test`

| File | Catches |
|---|---|
| `test/boot.js` | client parses and boots in jsdom; date range initialises |
| `test/audit.js` | field lists by content, tab wiring, route guards, cache keys, table alignment, attribute escaping, palette, build stamp, release documented |
| `test/smoke.sh` | every endpoint returns 200, plus ~60 field assertions |
| `test/mock-fetch.js` | stubs Windsor, GA4, Sheets; returns 400 for LINE |

### Three silent-failure classes that have each bitten more than once

**1. A find-and-replace that matches nothing.** Python `str.replace` and
`str_replace` fail silently when the anchor has drifted. Symptoms range from a
missing legend to a whole tab shipping broken. **Always verify the edit landed**
— grep for the new string, and for markup edits re-parse the client. Never chain
a mutation behind `grep -c`: it exits 1 on zero matches and `&&` swallows the
rest of the line.

**2. Partial deploy.** `package.json` and `server.js` land, `public/index.html`
does not. The badge shows the new version while the page is old, and the
symptoms look like random bugs. `CLIENT_BUILD` in index.html is compared to
`/api/version` on boot and shows an amber banner on mismatch; the audit asserts
the stamp matches package.json.

**3. Per-row counters on Windsor.** The facebook connector returns one row per
campaign × ad set × date. Counting rows gave "42 days live" for a campaign that
ran 7 days across 6 ad sets. Use a `Set` of dates.

**4. A mock that answers the same however it is asked.** `windsorRows()` returns
one row per field-set regardless of `filters`, so no test layer could tell a
working filter from a discarded one. v3.59 shipped believing it filtered GA4
server-side, pulled the whole property on every request, OOM-killed the
container — and all four layers stayed green for two weeks, because the numbers
were right. The output was correct; only the volume was insane.

**The same bug, a second time, in the GCS stub (found v3.100.0).** It answered
every read with the access list whatever object was requested, so `/api/report`
served the users array with a 200 and `buildBenchmark` never ran at all —
concealing a temporal dead zone error that would throw on any cold cache in
production. Both stubs are now routed by what they were asked for.

The rule: **a stub must be able to fail.** `ga4Report()` in `test/mock-fetch.js`
reads the `dimensionFilter` it is sent and honours it, and its fixture includes
a sibling page and a `login` event specifically so that dropping the filter,
the `match()` narrowing, or the event list changes the numbers. If a mock
cannot distinguish right from wrong behaviour, a green suite means nothing.

Note also that `google-auth-library` exports `GoogleAuth` as a **read-only
getter** — a plain assignment to stub it fails silently. Use
`Object.defineProperty` and assert the swap took.

### Original notes

```bash
npm install && npm test        # bash test/smoke.sh
```

Boots the server with all outbound HTTP stubbed, executes **every** endpoint, and
fails on any 5xx. Also re-runs two endpoints with a connector forced to fail, to
confirm graceful degradation.

**`node -c` is not sufficient.** It only proves the file parses. A v3.12.1 change
shipped `Cannot access 'adLeads' before initialization` — a temporal dead zone
error — straight to production because syntax checking passed. The smoke test
reproduces that class of bug in two seconds. **Run it before every deploy.**

---

## 11. Open issues

**~~Live blocker~~ — RESOLVED 21 Aug 2026 (v3.60.0).** The 503s were **the
application**, and the reasoning that said otherwise is worth recording because
it was wrong in an instructive way. "Boots clean, `/healthz` answers 200" only
proves startup works; it says nothing about a request handler that allocates
hundreds of MB. And the cache was never the problem — the memory went on a
*transient* GA4 payload.

What the logs actually said: `latestCreated == latestReady`, 100% traffic, so
nothing was stranded and the build was fine. Every 503 was the same request,
`/api/page` for one campaign URL, one month, dying after 27–218s. Revision
00073 logged `Memory limit of 512 MiB exceeded with 616 MiB used`; later
revisions logged `Uncaught signal: 6` (SIGABRT), which is V8 aborting on heap
exhaustion before Cloud Run's monitor reports it cleanly. Both are the same
event. **A bare 503 with no JSON body means the container died** — §2 already
said so.

Root cause: Windsor silently ignores GA4 filters (§3), so `buildPage` was
pulling all 482,355 rows of the property five times concurrently. Fixed by
moving `/api/page` to the GA4 Data API (§4a).

Two things were also true and both needed doing: memory had regressed to
**512 MiB** despite §2 requiring ≥1 GiB, and is now **2 GiB**. Because deploys
are managed by `gcp-cloud-build-deploy-cloud-run`, **re-check
`resources.limits` after the next auto-deploy** — if it resets, pin memory in
the build trigger rather than by hand, or this returns looking like a new bug.

**Package_Map.** ~1,183 rows keyed on export name + price. Centre is ~98%
filled (521 inferred by Claude and marked `GUESSED by Claude` in
`center_source`, agreement measured at 86% against the team's own labels,
81% excluding BIH which no package name can reveal). **SKU still needs the
e-com team**, and only 2025–2026 packages matter.

**Chat Bubble click source.** ~~Unresolved~~ — RESOLVED 28 Aug 2026 (v3.133.0).
MW chose the GTM ten-channel figure; the slide explains the gap with Looker.

**Short links.** `bkhos.co/…` hides its destination, so ads using them cannot be
classified in ROAS. A ฿15.6k Surgery campaign is affected. The short-link
mapping would fix it.

**Campaign attribution for e-commerce.** Every order row carries the campaign
name "Annual campaign", so marketplace revenue cannot be tied to specific
marketing activity. Needs a change at source.

**Two zero-price rows** and one 2024 order where the payment total is 10× the
sum of its coupon lines (`20240000251`, cancelled, Partnership) — both known,
both harmless, both flagged by the validator.

**Redemption and discount are computed but hidden.** Coupon status is not
real-time and the SKU master has no reliable list price, so leading with either
would imply a decision nobody can make. They return cheaply if the source
improves.

## 12. Requested but not built

- **YOUTUBE ANALYTICS DIRECT FROM THE API — DEAD END, do not retry (v3.129.0).**
  Every route is closed and the code has been removed rather than left dormant:
  a **service account** cannot read a channel (Google supports that flow for
  Content Partners only); an **"Internal" OAuth client** needs Workspace and
  `bangkokhospital.com` is not Workspace; **External + Testing** kills refresh
  tokens after 7 days; **External + Production** was tried in v3.128.0 on the
  documented theory that a Brand Account may authorise a project's client if a
  test user manages it — MW does manage it, the consent was granted, and the
  calls still failed. **Windsor's own connector** sends an unsupported query
  (`day` + `video` + `creatorContentType` with annotation, card and Red metrics
  in one report) and returns `400 The query is not supported`.
  The Apps Script sheet is the answer, because it runs as a human rather than as
  an app. Reopening this needs NEW information — a channel ownership change, or
  a fixed Windsor connector — not another attempt at consent.

- **APPLY THE REM TYPE SCALE TO EVERY TAB** (MW, backlogged v3.117.0). The scale
  lives in `:root` and Monthly Reports uses it; the app chrome and the other
  tabs still carry roughly 80 hard-coded px sizes. The `type:scale` audit rule
  is ALLOWLIST-scoped to the migrated components, so extending it is the
  checklist: add a selector to `SCOPED`, run the audit, convert what it flags.
  Do it per tab rather than in one pass — every one of those sizes is a
  potential layout shift on a screen nobody is currently looking at.

- **Audience-set performance ranking** — which audience works for which campaign
  type. Meta's adset dimension should support it.
- **Short.io** — clicks per short link across LINE, Facebook and EDM; the only
  realistic substitute for LINE engagement data. Needs a connector slot.
- Page-level SEO mapping in Topic Explorer; scheduled weekly digest;
  true keyword discovery beyond own rankings (needs SEMrush or similar).

---

## 13. Version history

### Recent (August 2026)

**v3.142.0 — frozen first column on the centre × channel cross-tab (MW).**

The table is wider than the viewport, so scrolling to a right-hand channel lost
the centre name and left a row of percentages belonging to nobody.

**`left:22px`, not `left:0`.** Sticky offsets are measured from the scrollport,
and `.tscroll` runs `margin:0 -22px; padding:0 22px` to bleed to the card edge.
At `left:0` the frozen column parks 22px outside the text column, under the
card's rounded corner. 22px pins it exactly where it already sits unscrolled, so
nothing shifts until scrolling starts.

**The background has to be opaque.** `--glass` is `rgba(255,255,255,.72)`, so
cells sliding underneath would read straight through the centre name.

Scoped to `.xtab`, which only this table uses.

---

**E-COMMERCE CENTRE MAPPING IS COMPLETE (28 Aug 2026).** `COUNTIF(Orders!P2:P,"")`
returns **0** against 85,528 rows — every order carries a centre, and the
`(unmapped)` bucket is gone from the Centres tab. 17 centres, ฿10.0M for July.

The route there, because the shape of the problem was not obvious:

- **Package_Map is only written during import**, at the moment a package is first
  seen. Nothing ever re-checked, so a map row deleted or lost to a half-finished
  import orphaned that package permanently: Orders kept the sales, no menu item
  noticed. 27 packages and 3,603 order rows were in that state, one carrying
  3,175 orders on its own. Fixed by `rebuildPackageMap` in normaliser v2.9.0.
- **The dashboard never reads Package_Map.** It takes `center` and `sku` straight
  from Orders columns, so map edits reach the report only after
  "Re-apply Package_Map to Orders". That step is what took centre coverage from
  40% to 100%.
- **"Refreshed 0 rows" is misleading** — `reapplyMapping` counts only SKU and
  status changes, so it reports 0 while writing centre on tens of thousands of
  rows. It also times out on the final tidy-up after the data is already saved.

**SKU IS DELIBERATELY NOT DONE, and does not block anything.** 1,023 of 1,183
packages have no SKU. It affects only the English package name and the
full-price/discount columns — not centre, not revenue, not any total. MW's call:
2026 first, 2025 nice-to-have. Scoped, that is **324 packages covering ฿154m of
2026 revenue, of which the top 40 carry 80%** — the existing
`prioritisePackageMap` with a `2026-01-01` cutoff ranks exactly those.

**Every other e-commerce tab was always safe**: revenue, orders, channels, AOV,
ROAS, monthly, churn and migration read neither centre nor SKU.

**v3.141.0 — Off-site reach & action sorted by volume (MW); tables and pills
join the type scale (5 of 5 CSS groups).**

**SORTED BY VOLUME.** Both the reach rows and the "action without site visits"
rows were in the order they happened to be written, so the biggest number could
sit at the bottom. A NULL is not zero and does not sort as one — it means the
source was unavailable, so it sinks below a real 0; `row()` drops nulls entirely
rather than showing them as rows.

The fixture now lists both sets SMALLEST-FIRST with one null, so an unsorted
render fails. Verified by removing the sort.

**A TEST MISTAKE WORTH RECORDING:** the first order check searched the whole page
and failed on correct output, because "YouTube" and "TikTok" also appear in the
TOFU note far above the card. Position checks must be scoped to the block being
asserted.

**TABLES AND PILLS MIGRATED**, 17 selectors: `th`, `tr.grp td`,
`table.sortable thead th::after`, `.legend div`, `.legend .lg`, `.ihint`,
`.afhead`, `.afrow`, `.afshare`, `.afpkg`, `.pill`, `.all-four`, `.tag`,
`.qtag`, `.gap-tag`, `.hcode`, `.hcode-sm`. **Every one is exact or DOWN** —
column widths respond to type size, and shrinking cannot cause a wrap.

**THE MIGRATION IS NOT DONE, and the audit will now claim it is.** 44 hard-coded
sizes remain: roughly 27 in `<style>` (`.u-*` users tab, `.ra-*`, `.stalebar`,
`#tip`, `.search`, `.state .big`, `.warnbox`, `.acct-tab`, `.pg-input`,
`.cluster h3`, `.qec-cell`, `.dlt`, plus print `@media` which is deliberate) and
the rest INLINE in JS template literals, which `type:scale` cannot see at all.
Naming this again because a green `type:scale` now covers five migrated groups
and says nothing about those.

**v3.140.0 — YouTube joins Overview as AWARENESS (MW).**

**It is in the TOFU impressions bar and its total, and NOT in the session
funnel.** YouTube views never become a GA4 session, and the sessions YouTube DOES
drive are already counted under Organic Social — putting views in the funnel
would double-count the ones that converted and invent the ones that did not.
`smoke.sh` asserts YouTube is absent from `funnel` for exactly that reason.

**IT HAD TO GO INTO `totals.impressions`, not just the bar.** The segments are
drawn as a share of that total, so a source in the bar but missing from the total
makes every percentage overstate and the widths sum past 100%. Asserted.

**THE SCOPE MISMATCH IS REAL AND IS STATED ON THE SLIDE.** Everything else in
Overview is filtered to the four hospitals; the YouTube channel is a single
corporate channel that cannot be split by branch. So the awareness row carries
"one corporate channel, so NOT branch-scoped like the rest of this view", the
TOFU note repeats it, and `boot.js` asserts the caveat renders. The alternative
was leaving a million views a month out of a slide captioned "everything that put
us in front of someone" — but an unlabelled group-level number inside a
BHQ-scoped view is the one conflation this project refuses everywhere else, so it
gets a label rather than silence.

**Views are NULL, never 0, when the export has no rows** for the range. The sheet
starts 2025-01-01, so an earlier window legitimately has nothing; `days === 0`
means "not in the sheet", which is a different claim from "nobody watched". The
row then reads "no rows in the export sheet for this range".

**TWO MISTAKES WORTH RECORDING.** `impressionsBySource` is an explicit
whitelist, so adding a key to the internal `impressions` object was NOT enough —
the payload silently lacked `youtube` and only the smoke assertion caught it.
And the TOFU stage-note ENUMERATES what is in the bar, so adding a source
without editing that prose would have left the note quietly lying about its own
chart. Anything added to that bar needs all four touched: `impressions`,
`totals.impressions`, `impressionsBySource`, and the note.

One extra Sheets read per overview pull, wrapped by `runJobs`, so an unavailable
sheet nulls the row rather than failing the pull.

**v3.139.0 — Overview finally has a real fixture, and the failure that hid two
bugs is now impossible to hide.**

**THE ROOT CAUSE OF THE WHOLE EPISODE: an unhandled rejection.** The auto-load's
`.catch()` covered the FETCH failing. It did NOT cover `render()` itself
throwing — and that is the failure that actually happened. The out-of-scope `n0`
threw inside the renderer, the rejection went unhandled, and the tab was left
BLANK: no error state, no status line, no retry, only a console error. From the
outside that is indistinguishable from "the dashboard didn't load", which is
exactly how MW described it. Both `renderOverview` and `renderReport` now catch a
render throw and turn it into a named error state.

**A COMPLETE `/api/overview` FIXTURE**, so the normal render path is exercised
rather than only the degraded branch. Deliberately awkward where the real payload
is: `paid.cpc` null and `topAccounts` EMPTY (a Meta pull that failed while GA4
succeeded — `runJobs` nulls a source and still returns 200, so this is the common
case); a funnel channel with ZERO key events; a `trend` spanning both chart axes
to exercise the conditional `y1`; and **9 `topProducts` rows against a
`.slice(0, 8)`**, with the 9th named "Ninth row past the cap" so an off-by-one
shows up as a phrase rather than as one uncounted row.

Assertions check that the DATA reached the markup, not that cards exist —
counting cards proves nothing, since `n0` threw for months inside a section that
was in the DOM the whole time. **Verified by putting the `n0` bug back**: the
suite now reports `FAIL overview renders — The overview failed while drawing: n0
is not defined`. Before this release the same bug produced a hard process crash
with no labelled assertion; before v3.138.0 it produced nothing at all.

**ORDERING IN `boot.js` IS LOAD-BEARING, and it cost a debugging round.** Both
Overview's auto-load and the report click re-render `#viewRoot` in a MICROTASK.
The first version of these assertions read `textContent` immediately, got `""`,
and would have PASSED on exactly the white screen it was written to catch; the
second read the REPORT's markup and blamed Overview. Overview now asserts at 0ms
and the report click is deferred behind it at 1ms. An emptiness check is also
explicit, so `""` fails loudly.

**`renderReport` GOT THE SAME GUARD** — `reportLoading` for at-most-one-in-flight,
`reportError` to stop the retry cycle, both registered in `VIEW_LOADERS` so their
Retry buttons route through the shared handler.

**A NOTE ON PROCESS.** Two of the fixes in this release were mine to make and one
of the test needles was a careless guess (`"Messages"` for a label that reads
`Direction requests`, wrapped in a ternary whose branches were identical). The
fixture is worth more than the assertions built on it — check needles against the
source, not against what the field is called.

**v3.138.0 — Overview auto-loads for last month, and doing so exposed TWO real
bugs that had shipped for months.**

MW asked for auto-load "similar to Monthly report" and reported that Overview
"sometimes fails to load". Both turned out to be the same story.

**BUG 1: `n0` WAS DECLARED IN THE WRONG FUNCTION.** It was a local `const`
inside `renderReport`, while its **only 15 callers are in `renderOverview`** — so
that function's impressions-by-source section threw
`ReferenceError: n0 is not defined` every time it ran. Moved to module scope
beside `num()`. (`num()` FORMATS and shows null as an em dash; `n0()` is for
arithmetic. Use `num()` to display a missing value, `n0()` to add one.)

**BUG 2: A DEGRADED PULL WHITE-SCREENED THE TAB.** `runJobs` uses
`Promise.allSettled` and nulls a failed source, so a partial pull returns **200
with sections missing**. `renderOverview` read `d.totals.impressions` directly
and threw `TypeError` — an EMPTY tab, no error state, no status line. That is the
best candidate for MW's intermittent failure, and it is the worst kind: a success
response rendering nothing, with the cause invisible. Shape is now checked before
it is read, and a partial payload names what is missing and offers Retry.

**WHY NEITHER WAS CAUGHT: `boot.js` NEVER EXECUTED `renderOverview`.** Overview
waited for a click and the suite never clicked, so the entire function was
unexercised — the comment above `VIEW_LOADERS` had claimed since it was written
that "Overview is the one exception, because that is where the dashboard opens",
but the code showed "Ready to pull". The stated intent and the code disagreed,
and the code won for months.

**THE AUTO-LOAD GUARD IS THE REAL WORK, not the auto-load.** `render()` runs on
far more than arrival — scope changes, hashchange, every load settling. With
`S.overview` still null after a failure, a bare `if (!d) load()` refires on
EVERY later render, so one failed pull becomes a stream of them against six
sources at once. `overviewLoading` keeps it at-most-one-in-flight;
`overviewError` STOPS the cycle and waits for a person. The `[data-load]` handler
now clears the stored error first, or a retry re-renders the old error on its way
through and the button looks dead.

**A 120s CLIENT DEADLINE went in with it.** `fetch` has no default timeout. While
the tab waited for a click, a hung request meant a stuck button; auto-loading
turns the same stall into a permanent "Pulling…" with no Retry to press. Above
any healthy pull, below Cloud Run's timeout.

**STILL OUTSTANDING, and it is the important one:** `boot.js` now asserts only the
DEGRADED overview branch. **The normal render path — including the very section
where `n0` was broken — is still untested**, because the fetch stub answers
`/api/overview` with the generic identity object. Overview needs a real fixture
(`funnel`, `totals`, `impressionsBySource`, `offsiteActions`) the way the monthly
report has one. Two bugs surfaced the moment that function ran once; nobody
should assume it holds no more.

**`renderReport` HAS THE SAME BARE PATTERN** and the same latent retry loop. Left
alone deliberately rather than changed as a drive-by, but it should get the same
guard.

**v3.137.0 — assistant marks are one size; `.mr-*` joins the type scale (4 of 5).**

**ASSISTANT ICONS (MW spotted it).** The AI table sized marks two ways —
16px for ChatGPT, Gemini and Claude, 26px for Copilot and Perplexity — so the
larger marks read as the more important rows: Perplexity at 80 sessions looked
heavier than ChatGPT at 3.1K. The per-caller `size` argument is what allowed the
drift, so `ASSISTANT_MARK_PX = 18` decides it once and callers no longer pass a
size. **If an asset looks small at 18px, recrop the asset** — that file has
whitespace baked into its canvas. Scaling one mark up is what caused this.

New audit rule `icons:assistant-size` fails when `assistantLogo` uses more than
one size; verified by putting `26` back on Copilot.

**`.mr-*` MIGRATED**, 11 selectors. Two ties broke DOWN: `.mr-title` 27px sits
exactly between 24 and 30, and `.mr-sub` 17px between 16 and 18 — both sit on one
masthead line with a scope pill on a fixed 13.333in print canvas, so the wrap
risk decides it. Only `.mr-kpi-v` moves up (23px → 24px); everything else is
exact or smaller. `.mr-yoy-l` at 9px landed exactly on the `--text-4xs` step added
in v3.136.0.

**A CORRECTION TO THE SCOPE OF THIS MIGRATION.** The "81 selectors" figure came
from scanning the `<style>` block only. The real remaining count is **165: 61 in
`<style>` and 104 INLINE in JS template literals** — and `type:scale` cannot see
inline styles at all. So finishing the last CSS group would leave the audit
reporting full compliance over 104 hard-coded sizes.

This is the same shape as the 400 days of zeros: a green check measuring the
wrong thing. Before this migration can be called done, `type:scale` needs to read
inline `style="..."` attributes too — and that is a bigger job than the group it
was scoped inside, because inline sizes carry no selector to allowlist.

**REMAINING:** tables and pills in `<style>` (`th`, `tr.grp td`, `.pill`,
`.legend`, `.af*`) → then the inline sweep, which needs its own decision from MW
about whether the audit should cover inline styles.

**v3.136.0 — funnel/stages join the type scale (3 of 5 groups).**

Migrated `.card h2`, `.stage-name`, `.stage-val`, `.stage-val.na`, `.seg-val`,
`.stage.minor .seg-val`, `.stage-note`, `.stage.minor .stage-name`,
`.stage.minor .stage-val`.

**Added `--text-4xs: .5625rem` (9px) for ONE selector, and on purpose.**
`.stage.minor .seg-val` is white `nowrap` text absolutely positioned INSIDE a
narrow bar segment. It is the only size in this group where rounding UP could
push text out of a thin minor segment — so the step was added rather than the
design bent to a scale that stopped above it. That is now twice the scale has
grown downward for real needs (10px for the rail in v3.134.0), which suggests the
original scale was drawn for content areas and never for overlay or chrome type.

**`.na` follows the established pattern: one step below its own normal value.**
`.stat .val` is 3xl and `.stat .val.na` is 2xl, so `.stage-val` (base) puts its
`.na` at sm — 13px → 14px. Everything else in the group rounds DOWN, which is the
safe direction for absolutely-positioned and `nowrap` text.

**THREE INLINE `font-size:10px` STAGE LABELS WERE ALSO MIGRATED, and they are the
lesson.** They live in JS template literals, and `type:scale` only reads the
`<style>` block — so they would have survived every group of this migration and
still been hard-coded at the end of it, with the audit reporting full compliance.
Worth checking for more inline sizes before declaring the migration done.

Print `@media` keeps `.card h2` at 10.5px and `.note,.stage-note` at 9px in px
deliberately: print is an absolute medium, and the audit skips `@media` by brace
depth.

Rule verified by reintroducing both `16px` on `.stage-val` and `9px` on
`.stage.minor .seg-val` — both caught.

**REMAINING:** Monthly Reports leftovers (`.mr-*`) → tables and pills
(`th`, `tr.grp td`, `.pill`, `.legend`, `.af*`). Tables last: column widths
respond to type size, so they are the group that can actually break a layout.

**v3.135.0 — Chat Bubble footnote removed; header/controls join the type scale
(2 of 5 groups).**

**The click-source note added in v3.133.0 is gone at MW's request.** Asserted as
an ABSENCE rather than quietly deleted: the decision behind the number still
stands and is still in the changelog, so a future session could reasonably
re-add the note from reading it. It was not wanted on the slide.

**Header/controls migrated:** `h1`, `.subtitle`, `.dates input`, `.btn`,
`.status`, `.seg button`.

Two sizes move visibly — `h1` 25px → 24px and `.subtitle` 13px → 14px. 13 sits
exactly between two steps and the token comment calls 14px "secondary copy",
which is what a subtitle is, so it went up for readability. **Side effect worth
an eyeball:** the h1/subtitle gap narrows from 12px to 10px, so the heading
hierarchy is slightly flatter than before. The three controls all round DOWN by
half a pixel, which is the safe direction for buttons and inputs.

The print `@media` keeps `h1{font-size:20px}` in px deliberately — print is an
absolute medium and the audit skips `@media` blocks by brace depth.

**A REGEX MISTAKE WORTH RECORDING.** Adding `seg` to the `type:scale` allowlist
also matched `.seg-val`, because `\b` treats a HYPHEN as a word boundary —
so the build failed on a selector belonging to the NEXT migration group, which
had not been touched. Anchored to `seg(?![\w-])`. Any future group added to that
list needs the same care: `stage` would capture `.stage-name`, `card` would
capture `.card-title`.

Rule verified by reintroducing `font-size:25px` on `h1` and confirming failure.

**REMAINING GROUPS** (tables last, they are the ones that can break a layout):
funnel/stages (`.stage-*`, `.seg-val`, `.card h2`) → Monthly Reports leftovers
(`.mr-*`) → tables and pills (`th`, `tr.grp td`, `.pill`, `.legend`, `.af*`).

**v3.134.0 — app chrome joins the rem type scale (1 of 5 groups).**

Deliberately ONE group, not all 81 selectors. Each hard-coded size is a possible
layout shift, and if the header moves 2px after a single 81-change release there
is no way to know which change did it.

**WHY THE CHROME WAS NEVER MIGRATED: the scale had no bottom step.** The rail
genuinely uses 10px micro-labels and the scale stopped at 11px, so there was
nothing to migrate TO — the previous pass quietly skipped it rather than round
every label up. Added `--text-3xs: .625rem` (10px), and the eight selectors went
over cleanly.

Migrated: `.brand-name`, `.brand-sub`, `.nav-label`, `.nav-group`, `.nav-item`,
`.ai-badge`, `.rail-foot .k`, `.rail-foot .v`.

**Snapping moves five sizes by half a pixel** — brand-name, brand-sub and
nav-group down; nav-item and ai-badge up. Inside the fixed-width rail the choice
was to prefer rounding DOWN, since the failure mode there is a wrapped label. The
tight case is "Topic Explorer" plus the AI badge: ~130px of content in ~152px of
space, so ~22px of headroom against a change worth ~4px.

`type:scale` now enforces these selectors. Verified by reintroducing
`font-size:10px` on `.nav-label` and confirming the rule fails — the rail is the
one place a stray px is least likely to be caught by eye, so the rule needed to
be known to bite rather than assumed to.

**REMAINING GROUPS, in the order agreed with MW** (tables last, they are the ones
that can actually break a layout): header/controls (`h1`, `.subtitle`,
`.seg button`, `.dates input`, `.btn`, `.status`) → funnel/stages (`.stage-*`,
`.seg-val`, `.card h2`) → Monthly Reports leftovers (`.mr-*`) → tables and pills
(`th`, `tr.grp td`, `.pill`, `.legend`, `.af*`).

**v3.133.0 — Chat Bubble click source RESOLVED (MW): the ten-channel figure.**

MW: "there's 10 channels — so I'd choose 10 channels report, of course." That is
what the dashboard already showed, so **no number changed**. What was missing was
the explanation, and that was the actual risk.

**The two events do not measure the same thing.** GTM's `click_chat_bubble` fires
on the bubble's own buttons and sees all ten channels. GA4 **enhanced
measurement**'s `click` fires on every outbound `<a>` on the page, so it counts
links that are not chat AND cannot see Webchat or WeChat, which are not links.
That is why it reports a BIGGER number and FEWER channels at once — the two
symptoms have one cause, and either alone looks like the opposite fault.

The slide now carries a note naming the Looker figure, written out in full
(`2,414`, not `num()`'s `2.4K`) because it exists to be matched against a
specific number on a report the executives already have. Without it, "the
dashboard is lower than Looker" invites the conclusion that the dashboard is
broken.

**Test lesson worth keeping:** the first assertion failed on rendered, correct
markup because the note wraps across source lines and `textContent` carries a
newline mid-phrase. Boot assertions against prose now collapse whitespace first —
a test that breaks on reformatting teaches people to reformat around the test.

This closes the discrepancy open since v3.114.0.

**v3.132.0 — the phantom right-hand axis is gone (MW spotted it on YouTube).**

`drawChart` declared `y1` unconditionally. Chart.js renders an axis with no
dataset assigned to it and, having nothing to scale against, labels it **0.0 to
1.0** — so every single-series chart carried an empty right-hand scale that
reads to an executive as missing data. **Four of the eleven charts** were
affected, not just YouTube.

It shipped for weeks because nothing throws: no error, no console warning, and
the chart itself is correct. Only the axis is a lie.

`y1` is now spread in only when a series names it. A useful side effect: a typo
in `axis` collapses that series onto the LEFT axis where it is visibly wrong,
instead of onto a phantom scale where it is not.

**New audit rule `charts:no-phantom-axis`**, and it is static on purpose —
Chart.js is unavailable under jsdom, so `drawChart` takes its catch branch in
`boot.js` and any rendered-axis assertion would pass regardless of the config.
Verified against an unguarded sample so the rule is known to bite rather than
assumed to.

**v3.131.1 — watch hours in a unit a person can picture (MW).**

"15.3K" is a number, not a quantity anyone has an intuition for. The card now
reads ~21 months alongside it, and the figure is violet so it reads as the
card's own metric rather than a repeat of Views.

**The unit is chosen by MAGNITUDE, not fixed.** The same card has to work for a
quiet month and a record one: 40 hours must not become "0.005 years" and 15,304
must not become "15,304 hours". Thresholds are hours under 2 days, days under a
fortnight, weeks under ~2 months, months under 2 years, then years. Marked with
a tilde because months are 30.44 days — it is a sense of scale, and the exact
figure is directly above it.

**The Views card no longer repeats watch hours.** That sub-line predated Watch
hours having a card of its own, and the same number twice on one slide invites
the reader to hunt for a difference that is not there. Asserted as an absence.

**v3.131.0 — YouTube gets MoM and YoY, from two tabs a human maintains.**

`YT_SHEET_ID` is now `18dIkhWSyqcSVyVf9D07R-9R6Hkih4mpZ4c__WZbhyWs`, shared read
with the compute service account. **Two tabs, two different Studio views**, and
the distinction is the whole reason this works:

| Tab | Studio view | Range | Monthly job |
|---|---|---|---|
| `Daily` | **DATE** view — one row per day, every metric | 2025-01-01 onward | replace the current-year rows |
| `Videos` | **CONTENT** view — one row per video | the report month | append below the last month |

**WHY THE DATE VIEW WAS THE BREAKTHROUGH.** The Content view gives one total per
export, so MoM and YoY would have needed a stored history. The Date view gives
every metric per DAY, so all three windows are slices of one tab and
`comparisonWindows()` is reused — YouTube's MoM now means exactly what it means
on every other slide.

**STUDIO TRUNCATES EVERY TABLE TO 500 ROWS AND KEEPS THE BUSIEST.** The last row
reads *"Showing top 500 results"*. A 577-day export therefore lost its 76
quietest days with no error and no warning — caught only because the row count
was checked against the date span. Hence `expectedDays` / `foundDays` /
`dayGaps` on the payload and an amber card on the slide. **Export one calendar
year at a time.** This is the same silent-shortfall shape as the 400 days of
zeros, arriving through the manual route instead of the automated one.

**THE `Month` COLUMN IN `Videos` IS HAND-ADDED AND LOAD-BEARING.** Content
exports carry no date of their own, so without it a June report shows July's
videos and says nothing. Accepted as a Studio date (`2026-07-01`) or as typed
text (`2026-07`) — a routine that only works when someone formats a cell right
is not a routine.

**FOUR RULES THAT WOULD HAVE BEEN WRONG THE OBVIOUS WAY:**

1. **Columns by NAME, never position.** Five real exports, five column orders as
   metrics were switched on and off. `col()` is exact-then-prefix, which is what
   separates `Likes` from `Dislikes` sitting immediately before it, and still
   resolves `Comments added` and `Watch time (hours)`.
2. **A `Total` row must drop out, not be summed.** It has no parseable date, so
   date-indexing removes it — but only because that was designed for. Summing a
   total alongside the days it totals doubles the month.
3. **Change is `null` when the baseline is absent**, not zero and not +100%. A
   partially backfilled sheet would otherwise produce a slide of triumphant
   growth against months that simply are not there yet.
4. **Watch-time units are verified**, not assumed. The header must say "hours"
   or the metric is dropped; the two forms differ by 60x.

**THE `Daily` TAB CROSS-CHECKS THE `Videos` TAB, and that is worth keeping.**
July 2026 reads 1,104,891 views from 31 date rows and 1,101,530 from 500 video
rows — two independent exports agreeing within 0.3%, the gap being the tail
beyond the 500-row cap. Any future month where those two diverge sharply means
one of the exports was mis-scoped.

**DROPPED:** the Sharing-service card (not in either export, MW's call) and the
Gained / Lost / Net subscriber split — Studio's `Subscribers` is already NET, so
two of the three numbers would have been invented.

**Fixtures use MW's REAL figures with DELIBERATELY OPPOSING SIGNS**: views fell
10% MoM and rose 238% YoY, and likes fell on both. `boot.js` asserts both an
`up` and a `down` render, because a fixture where every arrow points the same way
cannot catch a renderer that crosses the two windows or hard-codes a direction.

**v3.130.0 — YouTube reads a YouTube Studio export. A human is the credential.**

**THE SLIDE HAD BEEN REPORTING ZEROS FOR 400 DAYS AND NOBODY COULD SEE IT.**
`whoAmI` in the Apps Script settled it: MW's account is `UCkQGIWRZIdmqNCbfulaoGHQ`
("Digital Marketing", lifetime views 0). With `CHANNEL_ID` blank the job asked
about THAT channel, got 398 days of zeros, wrote all 398 rows and logged
`398 rows written` — a success message for an empty channel. Setting the real
channel id turned the fake success into an honest `Forbidden`.

**WHY A HUMAN EXPORT IS THE ANSWER AND NOT A WORKAROUND.** The channel is a
Brand Account. Apps Script and the server both run as a FIXED identity and can
only ever ask about the identity they are. A browser shows an account picker, so
a person can BE the brand account for the length of one export. That is the only
door that opens, and it is the same one Looker Studio used.

**COLUMNS ARE READ BY NAME. THREE REAL EXPORTS, THREE COLUMN ORDERS.** The first
had no `Shares` at all; the second had it at index 4; the third at index 7 with
`Dislikes`, `Likes` and `Comments added` inserted before it. Position-based
reading would have reported watch time as shares the first month someone added a
metric. `col()` is exact-match-then-prefix, which is what separates `Likes`
(1,482) from `Dislikes` (-1) sitting immediately before it, and still resolves
`Comments added` and `Watch time (hours)`.

**FOUR RULES THAT WOULD HAVE BEEN WRONG THE OBVIOUS WAY:**

1. **Use Studio's own `Total` row, do not sum the body.** The table is TRUNCATED
   to the top videos. Summing the fixture's rows gives 1,978 views against a
   real channel total of 1,104,891.
2. **A missing metric is `null`, never `0`.** `present` / `missing` travel on the
   payload and the slide omits the card and NAMES the gap. Rendering an
   un-exported metric as zero is the 400-day failure in miniature — "nobody
   liked anything this month" instead of "nobody exported likes". Adding Likes
   and Comments to the export makes two cards appear with NO code change.
3. **Watch time units are verified, not assumed.** The header must say "hours"
   or the metric is dropped. Studio can export either, they differ by 60x, and
   the old code divided by 60 a second time — which would have shown a
   15,304-hour month as 255.
4. **The daily metric is ALLOWLISTED.** Studio writes whichever metric was on
   the chart, and one real export arrived set to **Dislikes** — a negative series
   on an executive slide, labelled correctly and useless. Unexpected metrics are
   reported as a fixable process note instead of plotted. Coverage dates are read
   regardless, so the freshness check never depends on which metric was chosen.

**FRESHNESS IS ON THE SLIDE, because a pasted sheet cannot announce that nobody
pasted this month.** `covered` is the date range found IN THE FILE and `stale` is
true when it does not overlap the report period; the slide then says so in amber.
This is the direct lesson of the 400 days: the failure mode of a manual source is
silence, exactly like the automated one it replaced.

**DROPPED:** the Sharing-service card (not in the export, and MW's call), and the
Gained / Lost / Net subscriber split — Studio's `Subscribers` is already NET and
the other two are not separable, so two of three numbers would have been invented.

**Fixtures are now MW's real file**, headers, column order, `Dislikes` trap,
truncated table and Dislikes-on-the-chart included. Every YouTube test before
this passed against invented numbers, which is precisely why 400 days of zeros
shipped: the tests proved the code could read a sheet, never that the sheet was
true.

**STILL OPEN.** `YT_SHEET_ID` points at the old Apps Script sheet and must be
repointed at the permanent export sheet. Use ONE sheet that the team pastes over
each month — a fresh export creates a new file and a new id, which breaks the
dashboard silently. Share it with
`715584769614-compute@developer.gserviceaccount.com` as Viewer.

**v3.129.0 — the YouTube API path is removed, not disabled.**

MW: "remove the whole idea from our code — since we are not using API approach
anymore." Deleting the OAuth client without deleting the code leaves a path that
looks available and is not, which is the same silent-failure shape this file
keeps warning about.

**GONE:** `ytApiConfigured`, `ytAccessToken`, `ytReport`, `ytTitles`,
`buildYouTubeApi`, the `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` /
`YT_CHANNEL_ID` constants, the `apiError` diagnosis, the amber card in
`index.html`, and the mock-fetch stubs for the OAuth token exchange, the
Analytics reports and the Data API title lookup.

**KEPT:** `buildYouTube` and `YT_SHEET_ID`. The Apps Script sheet is now the
only path, and it is not a fallback any more — it is the source.

**WHY THE API COULD NEVER WORK, settled for good.** The channel is a **Brand
Account**. v3.128.0 reasoned that an OAuth consent screen shows an identity
picker, so MW-as-manager could grant it without the owner. That reasoning was
sound and the grant still failed — see §12. **Do not rebuild this on the theory
that the consent was simply done wrong.**

**TWO ASSERTIONS ARE NOW ABSENCES**, which is the point. `boot.js` fails if a
card matching `/not connected/i` renders again; `smoke.sh` boots WITH
`YT_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` deliberately set and asserts
`source === 'apps-script-sheet'` and `apiError === undefined`. A leftover secret
in Cloud Run cannot revive a path that is not there, and a copy-paste cannot
bring the amber box back without failing the suite.

**THE REAL YOUTUBE RISK MOVED TO THE SHEET, and it is unverified.** In the repo
copy of `youtube-to-sheet.gs`, **`CHANNEL_ID` is blank** (line 82), which means
the job queries `channel==MINE` — the personal channel, not the hospital's. The
script's own comment says that returns **a full run of zeros without erroring**,
and it writes a warning into the Meta tab's `notes` when it detects it. Whether
the live script has `CHANNEL_ID` set is NOT KNOWN from here. If the YouTube
slide ever reads implausibly low, check the sheet's Meta tab before touching any
code — the fault will not be in `server.js`.

**The Apps Script is a SEPARATE credential from the one that was revoked.** It
authorises as MW's own Google account under Apps Script's own hidden GCP project
`1084562832966`, not `ai-reporting-503911`. Revoking the OAuth client and the
token grant did not touch it and did not require a CSV import; the daily trigger
still runs. Worth stating because the two were easy to conflate — both are "the
YouTube API", by two different doors.

**v3.128.2 — the YouTube API error is shown on the slide.**

`apiError` was on the payload but not on screen, which meant finding it required
Ctrl+F in a 400KB JSON response. It now renders as an amber card on the YouTube
slide, next to the fallback numbers, and disappears when the API path succeeds.

The point of the diagnosis is that the two likely causes need OPPOSITE fixes —
wrong account vs consent screen left in Testing — and both look like a quiet
month. A diagnosis nobody can find is not a diagnosis.


**v3.128.1 — the YouTube API failure reason reaches the payload.**

`youtube.apiError` now carries a DIAGNOSIS, not just a log line. The three
failure modes need three different fixes and are otherwise indistinguishable
from an empty card:

- **403 / Forbidden** — the refresh token is not authorised for the channel.
  Almost always means the consent was granted by the PERSONAL account instead of
  the Bangkok Hospital Brand Account; redo consent and pick the brand account.
- **invalid_grant** — the consent screen was left in **Testing** (7-day token
  expiry) or access was revoked.
- anything else — a query problem, passed through verbatim.

The card still falls back to the Apps Script sheet, so the diagnosis appears
alongside working data rather than instead of it.

Written because a wrong-account token produces a plausible-looking card and can
sit there for a month. Making someone read Cloud Run logs to tell these apart is
how that happens.


**v3.128.0 — YouTube direct from the API, no monthly human step.**

**WHY EVERY OTHER ROUTE FAILED, and what actually works.** The Bangkok Hospital
channel is a **Brand Account**. Apps Script and service accounts run as a FIXED
identity, so they can only ever ask about the personal channel — which is why
`channel==MINE` returned 400 days of zeros and the explicit channel id returned
`Forbidden`. MW's role is delegated Manager and the primary owner is
unreachable, so promotion is not available either.

**An OAuth consent screen shows an IDENTITY PICKER**, and Google documents:

> A Brand Account may authorize scopes requested by your project's OAuth clients
> if a specified test user manages the Brand Account.

MW manages it, so MW can grant it — **without the owner**. That is the same
mechanism Looker Studio uses, which is exactly why Looker could always see the
data while everything we built could not.

**Setup, once (CONTEXT for whoever does it):**

1. Enable YouTube Analytics API + YouTube Data API v3.
2. OAuth consent screen: External, add MW as a test user, then **PUBLISH it
   ("In production")**. This is not optional: an External app left in **Testing
   has its refresh tokens killed after SEVEN DAYS**. Published, they persist.
   Verification is not required for internal use — the "unverified" warning is
   clicked through once.
3. OAuth client (Web application). Consent with `yt-analytics.readonly` and
   `youtube.readonly`, and **in the account chooser pick "Bangkok Hospital"**,
   not the personal account. That single choice is the whole trick.
4. Set `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `YT_CHANNEL_ID`
   (defaults to `UCS2S3J9FRJMDl5MvldMXc2Q`).

**THREE NARROW REPORTS, not one wide one.** `day`, `sharingService` and `video`
are separate calls. Windsor's connector failed precisely here — it asked for
`day` + `video` + `creatorContentType` with 24 metrics including annotation,
card and Red metrics in a single call and got `400 The query is not supported`.

**The Apps Script sheet stays as the fallback.** If the secrets are absent the
sheet is used; if the refresh token is ever revoked or expires, the report
**degrades to the sheet rather than to an empty card**, and smoke asserts that
with a deliberately bad token. `source` on the payload says which path served
the data.

`invalid_grant` is reported with its two real causes named — consent screen
still in Testing, or access revoked — because those need different fixes.

A video with no title falls back to its id. Zero-share services are dropped
rather than occupying a row.

**Both paths are now covered by smoke**; before this the sheet path was tested
and the API path was not.


**v3.127.0 — YouTube, via an Apps Script sheet. Two cards under Facebook.**

**WHY NOT AN API, SETTLED.** Every direct route is closed:

| Route | Why not |
|---|---|
| Service account | Google supports that flow for YouTube **Content Partners (CMS)** only, not channel owners |
| OAuth "Internal" client | Needs Google Workspace; **bangkokhospital.com is not Workspace** |
| OAuth External + Testing | **Refresh tokens expire after 7 DAYS** — useless unattended |
| OAuth External + Production | `yt-analytics.readonly` is a sensitive scope: 2–6 week verification, privacy policy, demo video |
| Windsor | Their puller sends an unsupported query (`day`+`video`+`creatorContentType` with annotation, card and Red metrics in one report) |

**Apps Script sidesteps all of it**: it runs under MW's own account, so there is
no OAuth app to verify and no token to rotate. `youtube-to-sheet.gs` (shipped
separately) writes four tabs; the dashboard reads them with the service account
it already uses for three other sheets. **+1 Sheets batchGet.**

**TWO RULES THAT WOULD HAVE BEEN WRONG THE OBVIOUS WAY:**

1. **Daily rows are filtered to the range; Sharing and Videos are NOT.** Those
   two are stamped with the WINDOW they were pulled for, not a day, so the rule
   is "the latest window starting at or before the report's end date". A plain
   date filter returns nothing whenever a pull window straddles the month
   boundary — the card would read empty on exactly the reports that matter.
2. **The script re-pulls a 14-day trailing window, not just yesterday**, because
   YouTube revises recent figures for days afterwards. A yesterday-only job
   freezes the first and lowest number it ever saw. Rows are replaced by date,
   so re-runs are idempotent.

A video with no title falls back to its id rather than rendering an empty cell.

**Setup note for the next person:** the first `backfill` fails with *"YouTube
Analytics API has not been used in project 1084562832966"* — that is Apps
Script's own hidden GCP project, not `ai-reporting-503911`. Enable YouTube
Analytics API and YouTube Data API v3 in the project the error names.


**v3.126.0 — real hospital logos, bundled, used everywhere.**

MW supplied the four SVGs, so they are now **local files** at
`public/brand/hosp-{bgh,bih,bht,wsh}.svg` — no network fetch, print-safe.

**There were TWO hospital-logo sources.** A remote `LOGOS` map fed the slide
header while `HOSPITAL` fed the Actions card, both pointing at the same four
files over the network. One map now, and `boot.js` asserts the slide header
logo is served from `brand/` — so a remote URL cannot creep back in.

Aspect ratios differ a lot between the four (BGH is 977x324, BIH 188x32), so
they are sized by HEIGHT with a max-width rather than a fixed box.

**A SIXTH temporal dead zone**, caught by the boot test: `logoImg` read
`HOSPITAL` which was declared ~80 lines below it, and the whole report rendered
its error state. The count is now high enough to be a standing rule rather than
an anecdote — **in this file, check where a helper is declared relative to where
it is read, every time.**

**YouTube diagnosed but still not built** — see §12. MW's error log shows
Windsor's puller sending an unsupported YouTube Analytics query (day + video +
creatorContentType with annotation, card and Red metrics in one report), so it
is their bug, not MW's connection. Data API v3 could build Top Videos and the
like/comment counts today; shares, sharing service, watch time and subscribers
cannot come from anywhere except a fixed Windsor connector or an owner OAuth
token.


**v3.125.0 — hospital logos; the YouTube blocker identified.**

**Hospital logos on the Actions card** (MW supplied four URLs). Three-stage
fallback like the platform marks: local `brand/hosp-<key>.svg`, then the
bangkokhospital.com asset, then the text code. They could not be bundled — the
build container gets **403 from static.bangkokhospital.com** — so the browser
fetches them; drop the files in to make them local and print-safe. Scope pills
stay text (MW).

BGH's logo IS the BHQ mark. That is correct, not a mix-up, and it is why the two
look identical on that tab.

**YOUTUBE: the answer to "can you really not use the API" is no, and for a
specific reason** — see §12. GA4 and GSC moved to direct APIs because a SERVICE
ACCOUNT can be added as a user on those properties. A YouTube channel cannot:
YouTube Analytics is OAuth-only and the grant must come from the channel owner,
which is what Windsor's own connect screen states. Data API v3 with a key gives
only public lifetime totals — no daily series, no watch time, no sharing
service.

So Windsor is right, but `get_fields("youtube")` reports no YouTube account on
team `digitalbangkokhospitalcom`, so the field names cannot be verified and the
cards are not built. **Two field-name guesses have already cost this project an
hour each** (`unique_video_views`, `search_keyword_value`); a third would be a
slide of silent zeros.


**v3.124.0 — scope is always a pill; keyword rankings replace the placeholder.**

**SCOPE IS A PILL, EVERYWHERE (MW).** It used to arrive three ways — `\u00b7 BGH`
text in a title, a bare `BHQ` word, and the `all-four` badge — so the same idea
looked different slide to slide. `slide()` now takes a `scope` argument and is
the only place that decides how it is drawn; the per-page Search, Content and
GBP headings and the Actions card's hospital code all use the same pill. Asserted:
no slide title may contain `\u00b7 BGH`-style text.

**Keyword rankings REPLACE the GBP search-keyword table** (MW) — that table was
always a placeholder, because Business Profile reports which phrases found a
listing but never where it placed. Keyed by the LISTING's brand so each GBP slide
shows its own hospital. No scorecards, no note. This reverses CONTEXT open item
1's original "alongside, not instead of": MW's intent was a replacement once the
rank data existed. The standalone rankings slide added in v3.123.0 is gone with
it.

**AI table: six columns in MW's order** — Find Doctor, Appointments, Contact us,
View Item, Add To Cart, Purchase. Eleven overflowed the slide, and the two
Better AI events read zero for every assistant; they stay on the scorecards
above, where a zero is a finding and costs no width.

**Revenue accent removed** (MW).

**WINDSOR DISCONNECTION — CHECKED, and the answer is not uniform:**

| Connector | Live `windsor()` calls | Safe to disconnect |
|---|---|---|
| `googleanalytics4` | **0** (the only match is a comment) | **YES** |
| Search Console | **0** — never a Windsor connector here; GSC has always been the direct API | **YES** |
| `google_my_business` | **11** | **NO** |

GA4 moved to the Data API in v3.60.0 and GSC to the direct API for the same
reason, so both Windsor connectors are dead weight and their slots can be
reclaimed for YouTube or TikTok Ads. **GBP is still entirely Windsor** — eleven
call sites across the report, the GBP tab and the reviews endpoint — so
disconnecting it would empty every GBP slide.


**v3.123.0 — GBP keyword rankings from the SEO sheet; revenue and Actions styling.**

**Open item 1 closed.** Third Google Sheet, `GBPKW_SHEET_ID`, one tab per
hospital: locationName, keyword, `month_week`, address, rank, avg monthly
searches, createdAt. New slide after the GBP listings.

**It sits ALONGSIDE the GBP search-keyword card, never instead of it.** That card
says what people typed to reach the listing; this one says where we place for
keywords we chose to track. Both suites assert both cards are present.

**A JOB-NAME COLLISION THAT WOULD HAVE SILENTLY BLANKED THE OTHER CARD.** The
first version used `jobs.gbpKeywords`, which is ALREADY the Windsor GBP
search-keyword pull — so the sheet replaced that card's data wholesale. Renamed
`jobs.gbpRanks`, and smoke now asserts the Windsor keywords still populate. The
irony is exact: the block written to sit beside that card almost deleted it.

**Three aggregation decisions, each with a negative control:**

- **Rank is AVERAGED across listings**, not summed — a keyword tracked at two
  listings at ranks 1 and 3 reads 2 across 2 listings. Summing ranks is
  meaningless, and the sheet's own decimals are already averages.
- **Volume is NOT summed.** It is a property of the keyword, not the listing, so
  12,100 seen at two listings stays 12,100. Adding it would multiply one number
  by the listing count — the same per-row-counter trap as the Windsor connectors.
- **`month_week` is a LABEL** (`2026-July`), so the range is converted to the set
  of labels it covers rather than compared as dates. A June row must not count in
  a July report.

Keywords with no volume reported show a **dash, not a zero**, and the count of
those is stated: a zero reads as "nobody searches this", which is not what an
absent value means.

Rank bands: green 1–3 (local pack), amber 4–10, red past ten.

**Styling (MW).** Revenue cards get `.stat-money` — a left accent rule and a
heavier figure, restrained rather than a filled card. The Actions card now
borrows the scorecard typography from the SAME `.stat .lab` / `.stat .val` rules
via `.act-row`, so the two cannot drift; its cells cannot BE `.stat` because five
of them sit inside one card and would each gain a nested surface.

**A parse failure caught immediately:** the new helper was called `money`, which
is already a currency formatter further down the file.


**v3.122.2 — appointments footnote removed; THE DONUT RING NOW CLOSES.**

Footnote removed (MW).

**The donuts were drawing about half a ring.** `rows` is the top eight but
`mix.total` counts every case — 157 locations in MW's deck, eight shown — so the
arcs summed to a fraction of the circle and the chart read as broken rather than
as a whole. The remainder is now an explicit grey **"Other (N more)"** slice,
which is also the honest label: real volume, just outside the top eight.

**The fixture could not have caught it.** Its rows summed exactly to the total,
so the ring closed from the rows alone and the Other slice was deletable with
nothing failing. Rows now sum to LESS than the total, which is the real shape of
the data. The assertion sums the actual `stroke-dasharray` lengths against the
circumference rather than counting arcs — an arc count cannot tell a closed ring
from a two-thirds one.


**v3.122.1 — revenue gets its own figures.**

Revenue was tucked into the sub-line under the Realtime and Not realtime case
counts, where it read as a footnote to a case count rather than a number in its
own right (MW). It is now three scorecards — total, realtime, not realtime —
with revenue per case beneath each split.

**A textContent assertion that passed with the card deleted.** The check looked
for "Revenue" anywhere in the card, and the FOOTNOTE says "Revenue is monthly in
the sheet", so removing the scorecard changed nothing. It matches the scorecard
`.lab` elements now. Same shape as the v3.118.0 icon check and the v3.116.0
asset check: **a substring search over a whole block is not a test that the
block contains a specific thing.**


**v3.122.0 — Appointments card: GA4 initiates against the appointments sheet.**

New card after Actions, two scope tabs, two donuts. **+1 Sheets batchGet**, and
Initiates is free (the GA4 `appointments` key event is already in the per-brand
`k_` pulls).

**Second Google Sheet**, `APPT_SHEET_ID`, separate from the e-commerce one.
Only the six needed columns are fetched as aligned single-column ranges: the two
detail tabs run to ~25,000 rows each and pulling `A:V` of both would be roughly
ten times the payload for data nothing reads.

**FOUR ATTRIBUTION RULES, all from MW, each with its own negative control:**

1. **`BHQ` and `BHQ-EN` are legacy labels for BGH** — 4,251 of 25,359 rows in
   the sample. Dropping them would have understated BGH by about a fifth.
2. **Rows whose Hospitals cell is HTML, or blank, are DISCARDED**, not bucketed.
   Scraper residue is not an appointment with an unknown hospital, and a
   fallback bucket would show it as real volume.
3. **"Bangkok International Hospital" contains "Bangkok Hospital"**, so the BGH
   pattern excludes a following `(` and the specific hospitals are tested first.
   Without that, BIH's bookings land in BGH.
4. **Blank location or specialty renders as `N/S`.**

**Revenue is monthly and PER HOSPITAL.** `Total Amounts` cols B–E are Realtime
for BGH/BIH/BHT/WSH and F–I the same four Non Realtime. MW's spec named "col B"
and "col F" because MW was describing the BGH page; hard-coding those would have
shown BGH's money on all four hospitals. Because the sheet has no finer grain, a
part-month range still carries that whole month — stated on the card, since
revenue that does not move with the dates reads as a bug.

**The card names its two sources.** Initiates is GA4 (form opened), completes is
the sheet (booking landed). The completion rate spans two systems, so it is a
comparison and not a tracked journey.

**A fixture that could not fail, fixed.** The HTML guard could be deleted with
nothing breaking, because the only junk row in the fixture was `No tags`, which
no hospital rule matches anyway. The fixture now also contains markup WRAPPING a
real hospital name — the case the guard actually exists for.

**Sheets failure degrades this card only.** The pull is wrapped: the sheet is a
separate system with its own permissions and the other seventeen slides do not
depend on it.


**v3.121.0 — "Back links"; Actions card decoloured.**

- Referral card retitled **Back links** (MW).
- **Actions · what we want them to do**: footnote removed, and the violet
  session figure and violet CR line replaced with the report's standard `.val`
  and `.sub2`, so the card matches every other scorecard on the tab (MW).
- **Appointments card is specified but NOT built** — see §12. The workbook
  structure is fully verified; it is blocked on the live Sheet ID, and on a rule
  for the 4,251 `Realtime` rows whose Hospitals column says `BHQ`/`BHQ-EN`
  rather than naming a hospital.


**v3.120.0 — Pages tab: "Where they go next".**

New block at the bottom of the Pages tab (MW): the pages visitors move to after
the page being analysed. **+1 GA4 request** on that tab only.

**GA4's Data API HAS NO NEXT-PAGE DIMENSION** — path exploration is Explore-only.
The way round it is `pageReferrer`, which holds the URL whose link was clicked to
reach a page and populates for INTERNAL navigation as well as external traffic.
So the pages that follow this one are the pages whose referrer is this one.
Verified as a real Data API dimension before use.

**Three limits, all on the card, because a proxy reads like a certainty:**

- **Shares are of ONWARD CLICKS, not of visitors.** Referrer data cannot show an
  exit, so a page most people leave and a page most people continue from produce
  identical percentages. The Views column carries the scale.
- `pageReferrer` is the DOCUMENT referrer: the page whose link was clicked, not
  necessarily the page viewed immediately before.
- It does not update between views in a single-page app, and parallel tabs break
  the chain.

**Two exclusions, and the second is why the first was not enough.** The page's
own path is dropped (a reload or self-link would otherwise top its own list).
And the server-side filter is `CONTAINS`, which a SIBLING path and an external
URL quoting this path both satisfy — those are rejected by an exact
path-or-beneath check.

**The rejected volume is now COUNTED** (`rejectedRefViews`), not silently
skipped. Deleting the prefix guard changed no assertion: the fixture's
cross-product meant a wrongly-accepted sibling inflated every destination
equally, so shares still summed to 1 and the totals looked plausible. A guard
whose only effect is subtraction needs its subtraction published, or it can be
removed without anything noticing.


**v3.119.0 — every channel card always shows; Contact us share.**

**MISSING CARDS ON BIH AND WSH** (MW). `scopeRows` dropped any channel with zero
clicks in BOTH windows, so a channel that went quiet lost its card — on the
quieter hospitals that left nine cards, or eight, and broke the fixed layout the
whole `order` field exists to provide. All ten configured channels are kept now.
`WhatsApp (other)` stays conditional: it is a catch-all for an unrecognised
number and is noise unless it fired.

A zero is a finding. "Nobody used Messenger at BIH this month" is exactly the
sort of thing a monthly deck should say out loud.

**The fixture could not reproduce it.** Every brand had every channel, so a
filter that drops zero-click channels still produced ten cards and the guard
passed. BIH now gets **no Telegram clicks in either window**, which is the real
shape of the bug; the negative control fails properly against it.

**Contact us share card** (MW): bubble clicks against every `contact_us` key
event at the same scope. Free — the per-brand `k_` pulls were already in hand,
and BHQ is the four summed rather than a separate pull, so numerator and
denominator are scoped alike (asserted).

**It can exceed 100%, and that is not a bug.** These are two measurements of the
same intent, not a subset and its whole: someone can open the bubble without
firing `contact_us`, and fire `contact_us` without touching the bubble. The card
names its denominator so the number cannot be read as a share of something that
contains it.

**2rem above the AI assistants table** — its header row was sitting hard against
the scorecards and the two blocks read as one.


**v3.118.0 — Shared Paid Media removed; one scorecard surface; BHQ share.**

**`mini()` now emits `.stat`**, the same markup `kpi()` produces, so there is
ONE card surface on the tab instead of two that nearly match. That near-match is
what made the ten AI scorecards read as off-design. Extra gap added before a
table that follows scorecards — the header row was sitting hard against the
cards above it and the two blocks read as one.

**Shared Paid Media slide removed** (MW), and the **Meta mark moved onto the
Meta Ad card**.

**The unmapped-accounts warning was NOT removed with it.** It lived on that
slide but belongs to ad accounts, and it is the guard that stopped an agency's
entire spend vanishing silently in v3.69.0. It now renders under the Meta Ad
card. Deleting a slide takes everything on it, including the parts that were
never about that slide.

Hoisting it produced a **fifth temporal dead zone** in this file — declared
after the Facebook block that consumes it. Moved above. The pattern is now
routine enough to state plainly: **in this file, check where a helper is
declared relative to where it is read, every time.**

**Chat Bubble: BHQ share card** (MW) — each hospital's clicks as a proportion of
all four, measured on the SAME quantity as the headline so the ratio describes
one population. BHQ's own card reads 100% rather than comparing itself to
itself. Smoke asserts the four shares sum to exactly 1; a negative control
measuring against `channelClicks` instead of `total` breaks it.

**Two assertions had to be re-pointed, both of which would otherwise have passed
while testing nothing**: the icon check searched `.mini`, which no longer exists,
and reported "0/0 mini cards all iconed"; and the Meta mark moved from a slide
title to a card title, so it is now checked on the card rather than dropped from
the list.


**v3.117.0 — the gradient seam; nav under the header; footnotes removed.**

**THE REPEATING BACKGROUND SEAM MW SPOTTED.** `html,body{height:100%}` makes the
background's positioning area exactly one viewport tall, so the two radial
gradients were **tiled** down the page — a hard edge recurring at a fixed
interval, which read as every block being cut in the wrong place. Fixed with
`background-repeat:no-repeat` and `background-attachment:fixed`, so the wash is
painted once and no block boundary can land on a seam. MW's instinct (fit the
gradient to the section, not the screen) was the right diagnosis from the
symptom.

**Nav under the header, everywhere** (MW). The Search and Content tab strips
rendered ABOVE their titles — the control before the thing it controls. Tabs now
sit inside each language page, directly under that page's header. Repeating them
per page is deliberate: one page is visible at a time, the handler targets every
`.lang-tab` so duplicates stay in sync, and `no-print` keeps the deck clean.

`nav under header` in `boot.js` asserts this, and **took three attempts**:
parent-only flagged the chat strip (nested a level deeper than its header);
whole-page then passed even with a strip moved back above its header, because
some earlier section's title still preceded it. The unit is the SECTION.

**Report scorecards get a surface.** `kpi()` emits a bare `.stat`, which has no
card styling — 33 call sites elsewhere pass `stat card` to get one. Inside a
slide the surface is applied by CSS, so every scorecard on the tab matches
without touching other tabs or double-framing the existing `stat card` uses.
That is why the Chat Bubble intro looked unlike everything around it.

- **AI assistants (LLMs)** now uses the same plain card as its sibling
  "Back links" block; the blue border is gone.
- **Footnotes removed** from AI assistants, Facebook, Search Ads and Content
  (MW). The "what actually fires" line on the content cards stays — it is a
  finding, not a caveat.
- **Rem scale rollout to the other tabs is in the backlog** (§12) with the
  method written down, since `type:scale` is allowlist-scoped and extending the
  list is the checklist.


**v3.116.0 — rem type scale; 64px section marks (properly); desc-first sorting.**

**A TAILWIND-SHAPED TYPE SCALE** in `:root`, all rem (MW): `--text-2xs` .6875rem
through `--text-4xl` 2.25rem, plus `--space-sm|md|lg|xl|2xl`. **Base moved from
14px to 1rem (16px)** — body copy was reading small because the base was below
browser default. Report components take their sizes from the scale now.

**New audit rule `type:scale`** so this cannot rot: a px `font-size` inside a
Monthly Reports component fails the build. It is an **allowlist**, covering only
the components actually migrated — the app chrome still carries ~80 px sizes
that predate the scale, and converting those in one untested pass would be a
large change to screens nobody asked about. Extend the list as areas move over.

That rule needed two fixes before it was worth anything: it first flagged all 87
app-chrome sizes, and then flagged ten legitimate print and responsive
overrides, because it tested each LINE for `@media` when the overrides live
INSIDE the block on lines that never mention it. It tracks brace depth now.

**THE 64px SECTION MARK, THIRD ATTEMPT.** Two previous edits reported success
and changed nothing — one anchor had drifted, one rule was never inserted. It is
now asserted from the STYLESHEET in `boot.js`, which needed a module-level `SRC`
alias: inside the render callback `html` is shadowed by the rendered report and
`js` holds only the `<script>` block, so neither can see a CSS rule. Both of
those traps had already produced a vacuous pass in this file.

- **Sortable columns sort DESC first** (MW). Every sortable column is a metric
  and the first question is which is biggest; ascending-first needed a second
  click every time.
- **4rem top and bottom padding on every section**, with a hairline between, so
  blocks read as separate things.
- **Chat Bubble moved to the very bottom** of the deck.
- Perplexity icon added (20 assets); its mark now appears in the AI table, and
  the Copilot mark finally got the 26px it was supposed to have two releases ago.


**v3.115.0 — layout pass: 64px section marks, equal card heights, fixed chat order.**

- **Section header marks 64px** (MW), chat bubble 48px, hospital wordmark 150px
  wide, slide title given the height to hold them.
- **THE RAGGED FIRST CARD** MW spotted across the whole report: a card with
  fewer lines than its neighbours sized to its own content, so the first in a
  row stood at a different height. `align-items:stretch` on `.grid` plus
  `height:100%` on the card classes. It was never one card being wrong — it was
  every row being free to be uneven.
- **Chat channel cards are NOT ranked by clicks.** They come out in a fixed
  `order` from the reference deck, interleaved so a two-column row-wise grid
  reproduces that layout and related channels pair up (LINE with LINE JP,
  Messenger with Messenger MM). The point is position stability: a channel sits
  in the same place every month, so two months' slides can be laid side by side.
  `order` is a SEPARATE field from the array order, because the array order is
  what the URL-qualified matching rules depend on and display must not be able
  to disturb it.
- **Chat cards get the report's standard surface**: `var(--glass)`,
  `var(--stroke)`, `var(--shadow)` rather than a bespoke flat white.
- Intro cards use `kpi()`, the same as Referral. **"Bubble opens" → "Bubble
  Clicks"; "Month on month" → "MoM"**, which was already the convention
  everywhere else — the chat slide was the only outlier.
- **10rem side padding** on the ten cards so they condense toward the centre;
  reduced at 1400px, dropped at 1080px, 6rem in print.
- Removed a duplicated CSS block (two copies of the section-rhythm rules) left
  behind by an earlier edit.

**Three edits silently did nothing before landing**, all caught by checking the
output rather than the exit code: `order: cfg.order` was never added, so the sort
was a no-op on undefined; a `sort` insertion missed because a comment had already
changed the anchor; and a regex keyed on unicode labels matched 7 of 11 because
the source holds `\u` escapes, not the characters.


**v3.114.0 — chat cards redesigned; marks 2x; THE TWO CLICK EVENTS DISAGREE.**

**READ THIS BEFORE TRUSTING A CHAT CHANNEL NUMBER.** The GTM custom event and
GA4 enhanced measurement report the same channels roughly **5x apart**:

| | channels | total (BGH, Jul) |
|---|---|---|
| `click_chat_bubble` (GTM) | 10 | 503 |
| `click` (enhanced measurement) | 8 | ~2,414 |

They are not measuring the same thing. Enhanced measurement fires on every
outbound anchor click and **structurally cannot see Webchat or WeChat**, which
are not outbound links — that is why it only finds eight. The GTM event sees all
ten under one consistent method. **The Looker deck's magnitudes match enhanced
measurement**, so the old deck counts the inflated set.

The GTM event is displayed. `altChannelClicks` carries the enhanced-measurement
total on the payload so the gap stays measurable instead of being a matter of
memory. **MW to decide which the deck should report** — it is a definition
question, not a bug, and switching is one line.

**Cards redesigned** (MW): identity left (mark at 52px + name), performance
right (figure at 38px + MoM). Asserted structurally in `boot.js` — two siblings
per card — so a restyle that collapses them fails the suite rather than just
looking different.

**Marks are 2x**: `.plogo` default 26px to 40px, assistant marks in the AI table
16px to 26px, slide titles given a 44px min-height to sit them properly.

**Section rhythm**: real grid gutters, space between consecutive blocks, and a
`.sep` hairline between the headline scorecards and the channel cards.


**v3.113.0 — Chat Bubble reads the GTM custom event; bubble opens now work.**

**THE ROOT CAUSE OF "Chat clicks 0".** MW's Tag Assistant screenshot settled it:
GTM fires a CUSTOM event `click_chat_bubble` carrying `Click_ID`, `Click_URL`,
`Page_Path`, `Click_Text`, `Click_Classes`, `Referrer`. The earlier version read
GA4's *enhanced measurement* `click` event via `linkId` / `linkUrl` instead.

That is why the channels worked and the total did not: **LINE, WhatsApp and the
rest are outbound `<a>` links, so enhanced measurement sees them. The bubble
button is a div — no outbound click, no link params, zero.** A partly-correct
source is more dangerous than a broken one, because the part that works makes
the part that does not look like a data problem.

Primary source is now `customEvent:Click_ID` / `customEvent:Click_URL` filtered
to `eventName == click_chat_bubble`.

**The link pulls are KEPT as a backstop.** `customEvent:` dimensions only
resolve if the parameter is REGISTERED as a custom dimension in GA4; an
unregistered name fails the request outright, and with no fallback the whole
slide would empty. Cost is 2 extra requests, and `source` on the payload says
which one is in use. **Once registration is confirmed, drop the link pulls and
reclaim them** — noted so it does not become permanent.

**Not a bug, twice over.** The channel figures MW compared were the BGH tab
against a BHQ deck slide; and BGH carries the BHQ logo, which is what made the
tab look like BHQ. Scope, not arithmetic.


**v3.112.1 — chat headline no longer prints a confident zero; scorecards flattened.**

**`chat-bubble-top-parent` produced 0.** GA4 only populates `link_id` /
`link_url` for real `<a>` clicks. If that id sits on a `div` launcher — which a
chat bubble usually is — the parameter never arrives and the filter sees
nothing. **Still needs MW to confirm what GTM sends for it.**

Meanwhile the headline falls back to channel clicks and **the card states which
quantity it is showing** (`basis: "opens" | "channels"`). A zero in a headline is
worse than a labelled substitute: it reads as "nobody used the bubble".

**Not a bug: the channel numbers.** MW compared the BGH tab against an LS slide
that is BHQ. 744 is BGH alone; the 1,087 is all four. Scope, not arithmetic.

**Shading removed from every scorecard** (MW). Gradients, the violet accent
rule, the `lead` tint and the muted `is-zero` variant are all gone — flat white
cards with one border. Shading was encoding things the number already says, and
per-card tints made a set of scorecards read like a chart. `mini()` still accepts
`lead` and `zero` and ignores them, so call sites did not all have to change.


**v3.112.0 — Chat Bubble scoped to /bangkok*; total from top-parent; marks fixed.**

**OUT-OF-SCOPE BRANCHES WERE IN THE BHQ TOTAL.** The tally added to the BHQ
scope BEFORE checking the brand, so chat clicks from other branches counted into
the group figure. That is exactly the B+/BHQ conflation this project exists to
avoid, and it was sitting in a headline number. Rows now resolve the brand first
and anything not under `/bangkok*` is dropped (MW).

**The headline is `chat-bubble-top-parent`** — the bubble being OPENED — not the
sum of channel clicks (MW). They are different acts: one person can open the
bubble and click two channels, so the sum overstates. Channel clicks are still
reported, as the sub-line on the MoM card.

**Messenger labels were BACKWARDS.** MW's figures — Messenger 84, Messenger
(Burmese) 44 — put the larger count under the plain label, and the original
guess had `facebook-messenger` as Burmese. Swapped. Both `assumed` flags and the
amber `?` markers are gone now the labels are confirmed.

**Marks: no plate, no monogram, bigger.** `plogo()` is now a bare `<img>`. The
coloured plate was showing through every transparent SVG as a solid box (most
visibly Messenger), and the monogram behind the art put transparent logos on an
unrelated brand colour. All 19 assets exist, so the fallback bought nothing and
cost correctness. 44px in the channel cards.

**Layout is two per row** (MW's 1 1 / 1 1 / 1 1 / 1 1). Footer removed, and the
"Channels used" card with it.

**Unmapped ids stay in the PAYLOAD but off the slide.** With the footer gone, an
unrecognised channel id on an in-scope page would vanish with no trace anywhere
— the silent-zero failure mode. Not rendered; there when something looks wrong.

**Two mock lessons, both about invariants that could not fail:**

- Defaulting an unknown brand to BGH still satisfied "BHQ == sum of the four",
  so the scoping guard tested nothing. In-scope chat rows are now exactly 100
  and the out-of-scope branch 9,997, which makes a leak arithmetically visible:
  the totals stop being round.
- That only worked after **decoupling chat counts from `PAGE_ACTIONS`**, which
  belongs to the content pull. Sharing it meant every chat total inherited
  content-page numbers and no round-number invariant could hold.


**v3.111.0 — all 19 icons bundled; remote fallback removed; chat channels are scorecards.**

**The last four assets are in**: `google.svg`, `google-ads.svg`, `meta.svg`,
`tiktok.svg`. Every entry in `PLATFORM` now has a real file — 19 of 19.

**The Wikimedia fallback is GONE**, and with it the runtime dependency on a
third-party CDN for a deck that gets printed. `plogo()` is one `img` with a
monogram underneath as last resort; the `data-alt` two-stage chain is deleted.
No GA4 entry at all (MW).

**Marks are bigger and no longer glossy** (MW: "make it big, dont be shine").
Two things were doing that: an inner `background:#fff` with 2px padding, which
framed every logo as a shiny sticker and shrank the art inside its own box, and
the brand colour on the WRAPPER, which put transparent logos on an unrelated
background. The colour now belongs to the monogram only, the image sits on
transparent ground at full size, 26px.

**Chat Bubble channels are SCORECARDS**, one per channel, matching `.mini`
elsewhere: label and mark on top, the figure, MoM against last month beneath. The
pill-plus-floating-number layout put each value outside the card it belonged to,
which is what read as odd. Channels with no clicks stay visible but muted.

**An assertion that broke twice on presentation, now written against meaning.**
The chat-bubble check counted `tbody tr`, then `.cb-row`, and each layout change
broke it — the first silently, reporting "0 channels" while passing. It asserts
the channel LABELS reach the page and that marks are present, which is what
actually matters and survives the next restyle. **A test coupled to a class name
is testing the CSS, not the behaviour.**


**v3.110.0 — real brand icons installed; Chat Bubble restyled to the deck.**

**Fifteen icons bundled** in `public/brand/`, so marks no longer depend on
fetching Wikimedia at runtime: gbp, facebook, messenger, whatsapp, telegram,
line, zalo, wechat, webchat, instagram, youtube, chatgpt, gemini, claude,
copilot. Total 196KB.

**Still missing an asset:** `google.svg`, `google-ads.svg`, `meta.svg`,
`tiktok.svg`. Those four fall back to the remote URL and then to a monogram.
Also unassigned among the assistants: Perplexity, DeepSeek, Grok, Mistral, Poe,
You.com, Phind, Genspark, Felo — they render as plain text rather than a wrong
logo.

**`google-map-icon.svg` was not used**: 4.3MB of base64 raster inside an SVG
wrapper, for a mark that renders at 22px. `google-my-business-icon.svg` covers
GBP.

**Zalo's asset is a pure-white mark** and would have been invisible on white. A
brand-blue rounded plate is baked into the file rather than special-cased in CSS.

**No GA4 mark** (MW) — the Channels slide is about GA4 by definition.

**Chat Bubble restyled after the reference deck**: a rounded pill naming the
channel with its mark on the right, the count and MoM beside it, two columns.

**A NEW AUDIT-STYLE CHECK, and the bug it immediately found.** `boot.js` now
asserts every `file:` in `PLATFORM` exists on disk — otherwise a typo'd filename
degrades to a monogram, which looks deliberate. First version searched `html`,
but inside that callback **`html` is shadowed by the RENDERED report**, so it
found no PLATFORM block and printed "all 0 present" — a vacuous pass. It reads
`js` (the client source) now, and fails outright if the match count is zero,
because zero matches means the search missed, not that everything is fine.

Same lesson as v3.103.0 and v3.105.0: **a check that reports a count should be
suspected when the count looks too tidy.** "0 present" and "all present" were
indistinguishable in the pass message.

The chat-bubble boot assertion had the same shape of problem: it counted
`tbody tr` after the layout moved to chips, and reported "0 channels" while
passing. It counts `.cb-row` and requires the expected number now.


**v3.109.0 — Chat Bubble, with hospital / BHQ scope tabs.**

Open item 2 closed: the GTM work is done, so chat bubble is reportable. One pull
for the window and one for the previous month, **+2 requests**.

**Verified field names**: `linkId` / `linkUrl` are the GA4 API dimensions behind
the `link_id` / `link_url` click parameters. Clicks are found by filtering
`linkId` on the `chat-bubble-channel` prefix.

**`eventName` is a DIMENSION, not a filter — deliberately.** Enhanced
measurement only fires `click` on OUTBOUND links, and Webchat opens an on-site
widget, so its clicks may arrive under some other GTM-defined event. Filtering
on an assumed event name would have read zero for that one channel and looked
fine. Grouping by it means the payload reports which events are actually in
play, and the card prints them.

**Three pairs share a click id** and are separated by destination URL:
LINE Thai vs Japanese (`@bhqjp`), the two WhatsApp numbers, and the two
messenger ids. `facebook-messenger` contains `messenger` as a substring; two
independent guards stop them merging (exact segment match, and longest-id-first
selection) and **negative controls show either alone suffices** — the redundancy
is deliberate, so neither should be removed for being individually untestable.

**TWO LABELS ARE GUESSES AND ARE MARKED AS SUCH** — which WhatsApp number is the
Arabic one, and which messenger id is Burmese. A click id does not carry a
language, so nothing in the tracking distinguishes them. They render with an
amber `?` and are flagged in the payload as `assumed`, rather than quietly
asserted. Each is a one-line change once MW confirms.

Unrecognised click ids are counted in the total and listed on the card, so a new
channel appears as a named gap instead of vanishing.

**A FOURTH temporal dead zone, caught by the smoke test.** The builder was
placed before `const { data } = await runJobs(jobs)` and threw "Cannot access
'data' before initialization"; `brandForPath` is also declared ~1,000 lines
below it, so the brand resolver is inlined. This file's declaration order has
now set that trap four times (v3.100.0 `keMonthly`, v3.106.0 `LANG_ORDER`, and
both of these). **Anything added to `buildReport` should be checked against
where its helpers are declared, not just whether it parses.**

**Mock: `linkId`/`linkUrl` are emitted as PAIRS, not a cross product.** The
generic expansion multiplies every dimension by every other, which would pair
the Japanese LINE URL with a WhatsApp id — inventing channels, and worse, making
a matcher that IGNORES the URL look correct, since every id would appear with
every URL anyway.


**v3.108.0 — Articles column is Contact us; Package footer suppressed; Content moved last.**

**Articles -> `contact_us`, measured rather than guessed.** With the mix on the
card, the live answer was unambiguous: **Contact us 22.6K, Find doctors 3.2K,
Appointments 972, View item 28.** `view_item` is an ecommerce event that fires
on package pages, so on an article it was always going to be ~0.

**The measure-don't-guess loop paid for itself, and caught me twice.** My
hypothesis had been `find_doctors` — plausible (read an article, look for a
doctor) and wrong by 7x. Worse, the MOCK had been weighted to that hypothesis,
so the fixture was quietly asserting my guess back at me. Article weights now
follow the real proportions. **A fixture built on a hypothesis tests the
hypothesis, not the code.**

**Package: footer suppressed via `hideMix`** (MW). On a package page
`view_item` IS the page view — it fires on arrival, so it dwarfs everything and
would permanently "suggest" replacing Add to cart with a restatement of the
Views column already sitting beside it. The mix and the suggestion are
suppressed together: a suggestion with no mix behind it is an assertion the
reader cannot check.

**Content moved to the end of the deck**, after TikTok Top performances (MW).

**Deploys now go straight to GitHub.** Full suite runs first; nothing is pushed
red. Every release is still packaged as a zip for manual rollback (MW).


**v3.107.0 — category pages excluded; content cards measure their own key event.**

**`/package/health-check-up-packages` excluded** (MW) — a listing of packages,
not a package. It outranked every real package on views while representing
nothing anyone can act on. Dropped BEFORE bucketing, so it neither appears in a
top-10 nor inflates that type's totals; `CONTENT_EXCLUDE` is keyed by type and
matches the slug exactly.

**MW asked which key event Articles should show instead of `view_item`. Rather
than guess a second time, the card now measures it.** The content event pull
requests ALL NINE key events instead of four — the same request, more rows — and
each type reports its own event mix. Where the configured column is not what
actually fires, the card says so in amber and names the alternative.

This turns a guess into an observation, and it generalises: the next wrong
pairing announces itself instead of sitting there looking plausible.

**A false-warning bug, caught by the mock's flat values.** The first version
suggested a swap whenever the top event had a different id from the configured
one — so a TIE produced a confident "this column is wrong" pointing at whichever
event sorted first. Now it must beat the configured event **by more than 20%**.
A warning that fires on noise gets ignored, and the real one gets ignored with
it.

**Two fixture lessons behind that:**

- A flat tie could NOT test the guard: ties keep `KEY_EVENTS` order and
  `add_to_cart` sorts first, which is exactly what Package configures, so the
  tie resolved to the configured event and the control passed either way. The
  fixture now has a **near-tie** — Appointments edging Add to cart by 10%, under
  the margin.
- `EVENT_WEIGHT` gives content pages a per-EVENT distribution. Before it, every
  key event returned the same count and the whole mix was untestable. Articles
  are weighted so `find_doctors` clearly beats `view_item`, which is the real
  case MW reported: people read an article, then look for a doctor.
- `dr-second` has fewer views but MORE appointments than `dr-valailuck`, so
  "ranked by views" and "the action column reads the action" stay independently
  checkable. They agreed by accident after the weighting change, which would
  have let a card that sorted on the wrong column pass.


**v3.106.0 — Content slides; real platform logos; GA4 reports can sort.**

**CONTENT, two slides of paired tables** (MW), inserted after Referral and
before Search. MW confirmed the URL patterns, which is what unblocked this:

| Type | Path segment | Paired action |
|---|---|---|
| Doctor | `/doctor/` | Appointments |
| Package | `/package/` | Add to cart |
| Articles | **`/content/`** | View item |
| Center | **`/center-clinic/`** | Contact us |

Slide 1 is Doctor + Package, slide 2 Articles + Center, top 10 by views each,
with **language tabs on their own namespace** (`clang-*`). Reusing Search's
would mean clicking a locale that has articles but no search data blanks the
Search pages.

**THE METRIC TRAP, AVOIDED.** `screen_page_views` against a LANDING PAGE
dimension counts every page view in those sessions, not views OF that page — a
doctor page would have been credited with the whole visit. `langSessions` was
already in flight and would have been free, and wrong. Content uses two
page-scoped pulls instead (`pagePath x screenPageViews`, and
`pagePath x eventName` for the four actions), filtered to the content segments
AND the branch regex. **+2 group-wide requests**, serving four hospitals x ten
locales x four types.

**`ga4RunReport` now supports `orderBy`**, sorting server-side on a metric
descending. This is what makes a row cap safe on a high-cardinality page report:
truncation drops the tail rather than an arbitrary slice, the same reasoning as
the GSC query pull. `orderBy` is part of the memo key — left out, two requests
differing only in sort order would share one cached promise.

**A temporal dead zone caught BEFORE shipping.** The content builder first read
`LANG_ORDER` for its locale labels; that `const` is declared ~260 lines below
the IIFE, so it would have thrown "Cannot access before initialization" on every
report. Same bug class as `buildBenchmark` (v3.100.0) — the difference is this
one never reached a deploy. It reads module-scope `LOCALES` instead.

**Slug capture takes the whole path remainder.** `/package/x` and
`/package/x/details` are different pages and a single-segment capture labelled
both "x".

**Real platform logos.** MW supplied Wikimedia URLs. `plogo()` is now three
stages: local `brand/<file>` if present, else the remote URL, else the coloured
monogram. **The build container cannot reach Wikimedia** (egress proxy 403), so
these could not be bundled — the browser fetches them, and thumbnails are
requested at 240px because they render at 22px. Fourteen platforms registered
including YouTube, LINE, Instagram, Messenger, WhatsApp, ChatGPT and Gemini;
the assistant marks now label rows in the AI table.

**Mock now varies metrics per page.** `PAGE_VIEWS` and `PAGE_ACTIONS` give each
content page a distinct value, and **actions are deliberately not proportional
to views** — the top doctor by views has the FEWER appointments, so a card
reading the wrong metric into the wrong column is visible. A flat 100 everywhere
would have made any top-N look correct however it sorted.

**One assertion honestly downgraded.** `ct excludes off-scope` is guarded twice
— the branch regex on the pull and the `brandBySegment` check in `parse()` — and
either alone is sufficient, so removing one kept it green. It took removing BOTH
to make it fail. The comment now says it tests out-of-scope exclusion overall,
not the presence of the pull filter, which earns its place on row volume that no
output assertion can observe.


**v3.105.0 — platform marks on slide titles; mini scorecards restyled; one icon set.**

**Platform marks (MW).** Slide titles now lead with the platform: Google on the
Search pages, Business Profile on GBP and Google reviews, Facebook, Meta on
Shared Paid Media, TikTok, Google Ads on Search Ads, Analytics on Channels.

**Trademarks are NOT redrawn by hand.** `plogo()` renders a coloured monogram
and layers the real logo file over it when one exists at
`public/brand/<file>.svg`. Drop the official asset in and it appears with no
code change; `onerror` removes the image so a missing file falls back to the
monogram rather than printing a broken-image box onto a slide. **MW already has
the correct assets from the LS deck** — filenames are in the `PLATFORM` map.

**Mini scorecards.** The 2x5 grid read as a wall of numbers. New `.mini` card:
tinted panel, accent rule on top, larger figure, and an icon FROM THE SHARED SET
on every label. A zero is styled down but stays legible — it is still a real
answer.

**One icon set (MW).** Both tables on the Referral slide now take their column
icons from the same `ICON` map as the cards, so the icon beside "Appointments"
on a card is the icon beside "Appointments" in the table. The remaining glyph
usages (`★` in GBP ratings, `▲▼` in the benchmark tab) are outside Monthly
Reports and untouched.

**Two negative controls exposed weak assertions, both threshold-based:**

- `ai card layout` counted `.stat, .kpi`, so restyling to `.mini` reported zero
  cards. Now counts all three classes.
- `platform marks` asserted "6 or more logos" and PASSED when the Facebook mark
  was deleted, because other slides made up the number. Now asserts each
  platform BY NAME. Third time a loose assertion has given a false pass
  (v3.103.0 text match, v3.104.1 native-signal counter) — the pattern is that a
  count or a substring is never a substitute for naming the specific thing.

**Still blocked: the Content cards.** MW asked for top-10-by-views per content
type (Doctor / Package / Articles / Center) with language tabs. The data costs
nothing extra in principle — `langSessions` already carries
`landing_page x screen_page_views` — but two things must be settled first:

1. **`screen_page_views` against a LANDING PAGE dimension counts every page view
   in those sessions, not views OF that page.** Using it as "Views" would
   overstate a doctor page by the whole session. A page-scoped pull
   (`pagePath x screenPageViews`, plus `pagePath x eventName` for the actions)
   is the correct source and costs two group-wide requests.
2. **The URL patterns are unknown.** The only confirmed content segment is
   `/package/` (from a fixture path). Doctor, article and centre segments have
   not been verified, and guessing them would produce four empty cards or, worse,
   four plausible wrong ones. Asked MW.


**v3.104.1 — GA4 now HAS an AI Assistant channel; AI card rebuilt.**

**THE DEAD END IS NO LONGER DEAD.** Previous releases said "GA4 has no LLM
channel" and matched assistants by source name. MW asked for a re-check and was
right: **`AI Assistant` is now a GA4 default channel group value**, confirmed
from live production data.

**Google added it on 13 May 2026** (medium `ai-assistant`, campaign
`(ai-assistant)`), verified against Google's release notes as well as the live
data. Two properties of that rollout that change how the numbers read:

- **It is forward-only.** GA4 did not reclassify history, so any comparison
  spanning 13 May 2026 compares two different definitions. Stated on the card.
- **Google has not published its recognised list**, and Perplexity is a known
  omission — which is exactly what MW's data shows.

The card now reports **how many sessions each signal found**
(`ai.nativeSessions` / `ai.namedSessions`), because that ratio says how much of
the figure still depends on our hand-maintained name list. Smoke asserts the two
partition the total exactly, so neither double counting nor a gap can pass.

**A negative control caught a weak assertion.** `ai native signal` still passed
with native detection removed, because a name-matched row arriving on the AI
Assistant channel is counted as native. Renamed `ai native counter` and the
comment now points at `ai channel-only hit`, which is the assertion that
actually proves native detection: `pantip.com` is not in the name list, so it
can only appear via the channel.

It is now the primary signal. **Name matching is kept as a fallback, not
replaced** — the same live data shows assistant sources also landing under
Organic Search, Referral and Unassigned, so the channel alone would miss them.
A session counts if either fires (`isAi(src, chan)`).

One scoping detail: inside the Referral branch the channel is by definition
Referral, so the "% of all referral" numerator uses `isAiSource()` only.
Using the combined test there would have been a category error.

**AI card rebuilt to MW's layout.** All nine key events are now scorecards —
**two rows of five**, Sessions first then the nine by value — replacing
Engagement rate and Actions per 100. The table drops Engagement, Actions / 100
and GA4 channel, and carries **the same nine key events as columns** instead, so
the card reads consistently across and down.

`qual()` and `per100()` had no callers left and were deleted with those columns,
along with the now-unused `site` baseline binding in the referral block.

**Two fixture lessons.**

1. The shared `events` fixture had only TWO entries, so the nine-scorecard grid
   rendered three cards and the DOM assertion caught it. A card-per-event
   layout needs a fixture with every event, including **zeros** — Purchase and
   both Better AI events are zero on purpose, because a key event that did not
   fire still gets a card.
2. `rf ai excludes plain` asserted that `pantip.com` never appears in the AI
   rows. Once the mock gained an `AI Assistant` channel that became **false by
   construction** — the mock is a cartesian product, so every source appears in
   every channel. The assertion now checks that a non-assistant source appears
   with channel exactly `AI Assistant`, which proves it arrived by channel and
   not by a leaking name match. When a mock changes shape, assertions written
   against the old shape can quietly stop meaning anything.

**Still open (not done, MW to decide):** the live data shows the same assistant
split across several source spellings — `chatgpt.com`, `chatgpt`, `chatgpt.com)`
with a stray bracket, and `perplexity` separately from `perplexity.ai`. Grouping
them under one normalised name would cut the table roughly in half and make the
per-assistant numbers真 comparable, but it changes what a row means, so it is
not being done unasked.


**v3.103.0 — Back links table shows named key events; two more blacklist entries.**

**Columns after Sessions are now MW's five named key events** — Find Doctor,
Appointments, Contact us, View Item, Add to cart — replacing engagement rate,
the key-event total and actions per 100. The reason is that "8 key events" does
not distinguish a page view from an appointment, and a back link has to answer
which action it produced. Order is MW's.

Deliberately **not all nine**: Purchase, View cart and the two Better AI events
are near-zero from referral. The engagement-rate colouring survives on the AI
assistants table, where the comparison against site average still earns its
place.

Server now accumulates **per-source event counts** (`referrers[].events`), not
just a total. Smoke asserts the per-source breakdown sums exactly to that
source's `actions`, so a dropped event cannot pass.

**Blacklist: `excel.officeapps.live.com` and `linktr.ee` added** — nine entries
now.

**A second test that could not fail.** The five-column check used
`text.includes("Appointments")` against the whole report — but that label
appears in several other Actions tables, so deleting a column from THIS table
still passed. It now reads the header row of the back links table through the
DOM and compares the full list in order, which catches both a removed column and
a reordered one. Second time in two releases that a loose text match gave a
false pass; assertions on a specific block should query that block.


**v3.102.1 — MW's referrer blacklist populated.**

Seven entries, all internal tooling or partner plumbing rather than editorial
back links: `shop.bedee.com`, `bangkokhospital.lightning.force.com` (Salesforce),
`bangkokhospitalpartnerprogram.rocket-loyalty.app`, `canva.com`,
`teams.public.onecdn.static.microsoft` (Teams link unfurling),
`bangkokhospital.app.agnoshealth.com`, `bhq-cms-v2.local`.

The switch is now live, since `blacklistActive` is true once the list is
non-empty.

**A test that could not fail, caught by a negative control.** Swapping the
substring match for exact equality broke nothing — because the fixture used the
bare host `canva.com`, which matches either way. The fixture now uses
**`www.canva.com`**, a subdomain, so exact equality fails three assertions.
Subdomains are the normal case in GA4 source data, so the substring behaviour is
the thing that actually needs proving.


**v3.102.0 — Referral becomes Back Links; referrer blacklist with a switch.**

Retitled **Referral · Back Links · <hospital>** (MW), and the card below it
reads "Back links, and how good is the traffic".

**Scorecards are now the three MW asked for:** Referral sessions | AI assistants
(% of all referral) | Key events. Engagement rate moved out of the scorecards —
it is still the per-source column in the table, which is where it is read.

**REFERRER BLACKLIST — the list lives in one place**, `BLACKLIST` inside the
`referral` builder in `server.js`, and is currently **empty pending MW's list**.
Substring match on a lowercased source, so `doubleclick` catches every
subdomain.

Blacklisted referrers are **flagged, never dropped**. The server returns both
sets of totals (`totals` clean, `totalsAll` full), every row carries a
`blacklisted` boolean, and the slide has a switch, on by default. Both sets of
numbers are rendered into the DOM and **CSS picks one**, so nothing is
recomputed on toggle, the scorecards and the table cannot disagree, and whatever
is on screen is what prints. State is `S.reportBlacklist`, so it survives a
hospital-tab re-render.

**A ratio bug caught by reading the output.** The AI scorecard divided
all-channel assistant sessions by referral-only sessions — two different
populations — and the mock showed **250%**. The numerator now counts only
assistants arriving THROUGH referral, so the figure is a share of the thing it
is divided by and cannot exceed 100%. The table below still counts every
assistant session whichever channel GA4 filed it under, so its total is usually
larger; the card says so. A smoke assertion now bounds the ratio at 1.

**Third `change:capped` rename in two releases:** `pctOrDash(v)` → `(share)`.
The rule keys "rate or change" off the identifier, so a share should be named
one. Renaming keeps being the right fix rather than widening the exemption.


**v3.101.0 — Referral quality slide with an AI-assistant spotlight; shared media scorecards.**

**New Referral slide, inserted BEFORE Search in MW's sequence.** Per hospital,
and it costs **nothing**: the per-brand `s_`/`k_` pulls already carry channel
group and source, so this is a filter and a regroup on rows in hand.

Ranked by sessions, but the two right-hand columns are the point — **engagement
rate** and **actions per 100 sessions**. A referrer can send thousands of visits
that bounce, and sorting on volume alone puts it top. Both are coloured against
**this hospital's own site average** rather than an invented absolute: green at
least 15% above, red at least 15% below.

**AI assistants (LLMs) get their own sub-section**, matched by source across
ALL channels, not just Referral. ~~GA4 has no LLM channel~~ — **superseded in
v3.104.0: GA4 added an `AI Assistant` channel on 13 May 2026.** At the time of
this release it scattered assistants across Referral and Organic Search and
filed some as Direct, so the channel each landed in is shown as a column,
accumulated in a **Set** (a substring check would treat "Paid Search" as already
covered by "Search").

Two limits stated on the card, because the number is small enough that
over-reading it would be easy: an assistant that strips the referrer arrives as
**Direct and cannot be counted at all**, so this is a floor; and because the
match is by name, **a new assistant is invisible until its name is added**.
Current list: ChatGPT/OpenAI, Perplexity, Gemini/Bard, Claude/Anthropic,
Copilot, Poe, You.com, DeepSeek, Grok/x.ai, Mistral, Meta.ai, Phind, Genspark,
Felo.

**Search Ads: the unattributed card is removed** (MW). The bucketing still
exists server-side, so nothing is folded into a hospital — it is simply no
longer shown.

**Shared Paid Media metrics are now framed scorecards** with a derived rate
beneath each: CPM under spend, CTR under impressions, cost per click under
clicks. Same three figures, but each one now carries the ratio that makes it
readable.

**Two renames to satisfy `change:capped`, both of which improve the names.**
`shareOfSite` → `siteShare` and the `qual(v, base)` parameter → `rate`. The rule
keys "is this a rate or a change" off the identifier, so a value that is a rate
should say so. Renaming was the right fix, not an exemption.

**Mock widened, and it changed a real number.** `sessionDefaultChannelGroup`
gained **Referral** and **Cross-network**, and `sessionManualSource` gained
`pantip.com` and `chatgpt.com`. Without an AI source in the fixture, `isAi()`
could have been broken with every layer green. Cross-network is there
specifically to prove the Search Ads matcher does **not** count it when the
source is not Google: BGH visits must be 300, and 600 means the guard was
relaxed. Negative controls run on all three.

**v3.100.0 — Search Ads per hospital; Shared Paid Media; TikTok gets two slides.**

**Search Ads is now per hospital, and the brand comes from the CAMPAIGN CODE.**
There is no Google Ads account→brand registry and inventing one would have meant
guessing. But Google Ads campaigns follow the same `YYMMDD-NN_brand_objective`
convention as Meta (§7), so adding `campaign` to the search-term pull splits four
ways for **zero extra requests** — rule 1 of the budget, more rows on a pull
already in flight. `brandFromCampaignCode()` returns null for `bcm` (a real code
brand, not a hospital) and for campaigns that ignore the convention
(`rightchoice-google-reserve`); both land in a visible **unattributed** line
rather than being spread across the four.

Visits and actions cost nothing either: the per-brand `s_`/`k_` pulls already
carry the channel group, so paid search is a filter on rows in hand. **All nine
key events**, zeros included — "no purchases from search ads" is a finding.

Paid search is `Paid Search`, **plus `Cross-network` only where the source is
Google**. Cross-network on its own would fold in non-Google campaigns and
inflate every hospital's funnel.

**Two honest limits stated on the card rather than hidden.** TOFU impressions are
the sum of the search terms Google reported, and Google withholds very
low-volume terms, so the funnel top is a floor rather than the account total.
And there is **no MoM column**: `srcKeyEventsPrev` is held for the four hospitals
together, so a per-hospital month-back comparison would cost four more requests.

**Paid media → Shared Paid Media, scorecard only** (MW). These accounts run
across all four and the platform reports no allocation, so splitting them would
be an invention. The per-hospital Meta spend chart is gone — superseded by the
Meta Ad card, which already lists all four with the open one highlighted
(v3.99.2). The **unmapped-accounts warning is deliberately kept**: it is a
data-quality flag, not brand spend, and it is what stopped an agency's whole
spend vanishing silently in v3.69.0.

**TikTok: two slides, and one field name that would have been wrong.** Reach is
**`unique_video_views`** ("daily reached audience"). There is **no `reach` field
on `tiktok_organic` at all** — the guess would have shipped a zero. Verified
against the connector, third time this rule has paid for itself after
`search_keyword_value` and the GBP surface split.

- Channel slide: views, reach, profile views, a daily views trend, likes /
  comments / shares, and **`bio_link_clicks` / `phone_number_clicks`** — the only
  two profile actions the connector exposes, so there is no website-click card.
- **Reach is a sum of DAILY reached audience**, so someone who watched on two
  days counts twice. It is an upper bound on monthly unique viewers, and the
  card says so. Same family as the `page_follows` trap (v3.96.0) in the other
  direction: that one must never be summed, this one may be but must not be
  renamed "unique reach".
- Top performances slide: top post by views / comments / shares / favourites,
  then the four rates. **`video_views_count` is the per-video figure;
  `video_views` is the ACCOUNT total** — different tables on one connector, and
  mixing them double counts.
- **Rates are our definition, not TikTok's** — the connector publishes no rate
  field, so they are engagements ÷ views and the card says so; the LS deck may
  divide by reach. Posts under **100 views are excluded from the rate ranking**,
  or a video seen three times and liked once leads at 33%.

The video pull is the **one genuinely unavoidable new request** in this release:
it is the connector's Video table and cannot share the Account-table pull.

**Organic social removed.** Fully superseded — its Facebook half duplicates the
Facebook slide and its TikTok half duplicates these two. Its `repTt` and
`repMeta` draw calls went with it; `charts:wired` confirmed no orphans.

**Duplicate `jobs.langKeyEventsPrev` deleted.** Assigned twice since v3.99.0.
Harmless — `memoUpstream` caches the promise, so the second call shared the
first's round trip — but it read as two requests.

**`change:capped` had an order dependency, now fixed.** The rule exempts
`const pct = (v) => …` with a non-global regex, so a new local `pct` declared
EARLIER in the file consumed the single replacement and left the real formatter
flagged. The audit's own comment had predicted this. The exemption is now `/g`,
and the local was renamed `ratePct`. Negative control re-run.

**THE GCS TEST STUB ANSWERED EVERY READ WITH THE ACCESS LIST**, whatever object
was asked for. Three consequences, and the third is the expensive one:

1. `/api/report` returned the **users array with a 200**. The Monthly Reports
   payload was never built in the suite.
2. `/api/report` was **not in `smoke.sh` at all** — the tab under active
   development had no endpoint coverage whatsoever.
3. `buildBenchmark` had **never once executed**, which hid a live
   `Cannot access 'keMonthly' before initialization` — used at the monthly
   loop, `const`-declared forty lines below it. Same temporal dead zone class
   as v3.12.1. **Benchmarks would throw on any cold cache in production.**
   Hoisted; the endpoint now builds for real in the suite.

The stub now routes by object path and 404s everything except
`access/users.json`, so cached endpoints build their payload. This is §10.4
again: **a stub that answers the same however it is asked cannot fail**, and it
hid a broken endpoint for as long as it existed.

`smoke.sh` gained `/api/report` plus 13 content assertions, chosen so each can
fail: the per-hospital impressions, the case-insensitive `BIH`/`bih` merge, the
nine key events, `bcm` staying out of every hospital, TikTok's reach field name,
the multi-account daily sum, and the rate floor.

**A slide count cannot tell a rendered block from an empty one.** `boot.js`
asserted `slides >= 8`, which passes just as happily when a renderer falls
through to its "unavailable" branch — the section still exists. It now checks
for strings only the real blocks emit AND asserts the fallback text is absent.
Worth the belt and braces: the first needle chosen for Search Ads was
"Search keyword", which also matches the GBP card, so the negative control
passed when it should have failed.

**Fixtures exercise the awkward paths, not the happy one:** WSH has no search
ads at all, `top.favorites` is null, and two cards have no thumbnail.

**v3.99.2 — GCS cache is versioned; review mix relabelled; Meta Ad shows all four.**

**CACHE BUG, and the reason the rating mix showed all zeros.** The GCS object
was keyed by date range alone, so after a deploy that ADDED a field the server
happily served the previous build's payload — and the new UI rendered zeros
against data that had no such key. The path now carries the build version
(`report/v<VERSION>/<from>_<to>.json`), so a new build can never read an old
shape. Worth remembering for any future durable cache: **key it by schema, not
just by query.**

**Rating mix is no longer called "year to date".** It is every review held,
accumulated to the end of the selected period, and the heading now says
`as at <period end>`. Renamed `ytdStars` → `mixToDate`. The note explains it
covers reviews on record rather than the full lifetime count, since Google
publishes a lifetime average and total but not the lifetime star split.

The **"This year"** row is gone — MW: it invited confusion between three
overlapping windows on one card.

**Meta Ad card now lists all four hospitals**, with the open one highlighted.
MW's reasoning, which is right: every account boosts posts on the *same* page,
so the organic reach and engagement on the left are the product of all four
budgets together — showing one hospital's spend beside a shared result implied
a causal link that does not hold. Shared group accounts appear as their own row.

**v3.99.1 — heat bars, wider gaps, reviews layout.**

**Heat bars behind the SORTED column**, wired into the existing sort handler so
one implementation serves every sortable table. A column of numbers makes you
read each one; a bar makes the shape obvious, and tying it to the sorted column
means it always marks what the reader is comparing. Filled from the right so it
grows away from the right-aligned figure. `data-heat="n"` sets the default
column, painted on render by `initHeat_` rather than waiting for a click.
Applied to Channels, Countries, Actions by language, Top keywords and GBP
keywords. Sortable headers are bold; the active one takes the accent.

`initHeat_` was first written inside `renderReport`'s scope but called from
`render()` — boot caught the ReferenceError immediately. Hoisted.

Gaps widened again (76px title margin, 48px between slides). The Search section
gets an extra 46px plus a rule above its Actions table, which was colliding with
the block above.

**Duplicate BHQ removed:** the badge is suppressed when the title already
contains BHQ.

**Reviews layout per MW:** left is "Reviews this month" — back to the original
count + average line chart — with Rating mix this period beneath. Right (All
time) is the lifetime headline, the **last 6 months stacked chart**, and
**Rating mix year to date**.

That mix is **year to date, not lifetime**, and says so: Google publishes a
lifetime average and count but not the lifetime star split, so YTD is the widest
window that can be stated honestly.

**v3.99.0 — MW review pass: 13 fixes.**

**Bug:** GCS-served responses omitted `cacheAgeSec`, so the header read
**"cached undefineds ago"**. Now returns 0.

- Badge reads **BHQ**, not "all four hospitals".
- Section gaps widened (`slide-title` margin 34→56px, `.slide + .slide` 6→34px).
- Hospital codes use the existing `.hcode` / `.hcode-sm` (#002D73, 800). I had
  started adding a second class for this before noticing one already existed —
  removed.
- **Sessions by language:** tooltip gone, "(MoM)" under the hospital code. New
  `dltPlain()` for tables whose header already names the comparison —
  `dlt(v, ' ')` still emitted `data-tip` and the hand cursor.
- **Actions by language:** values at `.strong`, icons on all nine columns.
- **Search pages:** Actions is its own sub-section with an **MoM column**; all
  nine key events including Better AI. Keywords sortable.
- **GBP scorecards show ABSOLUTE change**, not percent — "+1,240 calls" is
  actionable, "+12%" makes the reader work out of what.
- **GBP keywords:** column is **Search Vol**, sortable, and `รพ.กรุงเทพ` added
  to the brand filter.
- **Ranking position does not exist** in GBP: it reports which phrases found the
  listing, never where it placed. Needs a rank tracker — same sheet as the
  keyword table MW is sending. Said so on the card.
- **Reviews:** monthly chart back on the left; the two long notes deleted and
  the rating mix moved into the All time card.
- **Missing 2★ sample explained:** samples only existed where a review carried a
  comment, so a star level with rating-only reviews vanished. Those now render
  "n reviews at this rating, none with a comment".
- **Facebook:** Actions sub-section with MoM; card titled **Meta Ad**, Spend →
  **Total cost**.

MoM on the Actions blocks costs **two group-wide requests**
(`langKeyEventsPrev`, `srcKeyEventsPrev`), not eight per-brand ones.

**v3.98.0 — upstream memo: never fetch the same thing twice.**

Endpoint caches are keyed by ENDPOINT. `memoUpstream` is keyed by the **request
itself**, wrapping `ga4RunReport`, `gscQuery` and `windsor`, so an identical
upstream call is never made twice within 5 minutes regardless of which endpoint
asked. Two wins:

1. **Cross-endpoint reuse** — Overview and Monthly Reports pull overlapping GA4
   reports; whichever runs second gets them free.
2. **In-flight de-duplication** — the **promise** is cached, not the result, so
   identical calls fired in the same tick share one round trip rather than
   racing. Verified: three concurrent identical calls → one upstream hit.

Failures are evicted rather than cached, so a transient 500 does not stick.

**`refresh=1` busts the memo, via one middleware** rather than at each endpoint
— a route added later cannot forget. A Refresh button that quietly returns
memoised data is worse than no button, because the person believes the numbers
are fresh. Verified the generation bump reaches the wire.

`GA4_MAX_CONCURRENT` raised 6 → 8, of GA4's 10 per-property slots, leaving room
for a second endpoint to run alongside without either being rejected. Cuts the
report from ~6 waves to ~4.

**Honest limit:** none of this speeds up a genuinely cold build of a date range
never seen before — that is bounded by GA4 latency × waves. What it fixes is
everything after the first: repeat loads, overlapping endpoints, and the
duplicate calls inside a single build.

**v3.97.0 — report cached to GCS; Facebook funnel; review chart restyled.**

**LOAD TIME: the report is now cached in Cloud Storage, not just memory.**
`/api/report` makes ~35 upstream requests behind a 6-slot gate, so a cold build
is slow — and in-memory caching barely helped, because **Cloud Run scales to
zero and every cold start threw the cache away**. The first person each morning,
and anyone landing on a fresh instance, paid full price. It now reads
`report/<from>_<to>.json` from the bucket first, writes it after a build, and
holds the memory copy for 24h. A completed month cannot change, so the object is
durable. `refresh=1` still forces a rebuild. Same pattern Benchmarks already
used; falls back to memory when no bucket is configured.

**Google reviews moved directly under Google Business Profile**, and both it and
Facebook are now above the "not yet reviewed" divider.

**Review chart restyled to match the GBP tab:** stacked star counts per month
with a rating line, last six months, 5★ at the base so the small low-rating
bands stay visible. The line is **that month's own average**, and the note says
so — the GBP tab's all-time line needs an opening balance derived from the
lifetime total, which is a different calculation and would be wrong to imply.
The redundant line chart in the left card is gone; rating mix stays.

**Facebook now follows the reference:** TOFU page impressions and post
engagements, MOFU visits, BOFU actions, with **all nine key events** listed.

Visits and actions are sessions whose source is Facebook **or Instagram** — the
page and its ads run both surfaces, so splitting them would misattribute the
paid side. Obtained by adding `session_manual_source` to the per-brand
`s_`/`k_` pulls: **same number of requests**, more rows, and channels now
aggregate over source. That also opens TikTok and LINE funnels later at no
request cost.

**v3.96.0 — Facebook slide; all-time card reworked.**

**All-time card:** the "This period" row duplicated the KPI card directly above
it. Replaced with the **last six months, rating and volume per month**, then
This year and Lifetime — the same space now shows the shape of the trend
instead of repeating a number.

**New Facebook slide.** One page serves all four hospitals, so the funnel on the
left is identical on every tab and is badged **shared by all four**; the ad
effort on the right is that hospital's alone. Showing them side by side is the
point — the same audience, different money behind it.

- Page: impressions with **organic-only beneath**, followers, post engagements.
  `page_follows` is a LIFETIME total, so the latest row is taken, never summed —
  summing a lifetime metric across days is a classic way to invent a number.
- Ad: spend, **reach (people, not impressions)**, post engagements, link clicks,
  with CPR / CPE / CPC. Fields confirmed against Windsor: `reach`,
  `actions_post_engagement`, `actions_link_click`.
- WSH shows "the account exists; it simply ran nothing" rather than a blank —
  no spend is a fact, not missing data.

Shared group accounts stay under Paid media, so this slide is not double
counting them.

**v3.95.0 — brand keywords filtered out; sample reviews per star.**

**Replied KPI removed.** It read 100% of 550 — a constant is not a metric.

**GBP keywords now exclude brand and address searches.** A profile's keyword
list is dominated by people typing the hospital's own name and the soi, which
confirms brand demand and says nothing about competitive ground. The card now
shows non-brand phrases only — symptoms, treatments, category terms someone used
*before* choosing where to go — and states how many brand phrases and searchers
were excluded, so nothing is hidden.

Two tiers of matching, and the distinction matters:
- `BRAND_KW_GLOBAL` — brand for every hospital: "bangkok hospital",
  "โรงพยาบาลกรุงเทพ", plus address fragments (phetchaburi, huai khwang, soi).
  Someone typing the soi is navigating, not shopping.
- `BRAND_KW_BY_BRAND` — brand only for its owner. **"heart hospital" is BHT's
  own name but a genuinely competitive query for BGH**, so filtering it globally
  would delete real signal from three hospitals.

**Sample reviews per star**, under the trend and all-time blocks: the most
recent commented review at each rating. The mix says 7% left two stars; the
sample says what they said. `review_comment` and `review_reviewer` are back in
the pull for this — removed in v3.94.0 when the triage list went.

Fixtures carry one brand keyword, one non-brand, one withheld count and samples
at two star levels, so the split, the `<15` path and the sample selection are
all exercised.

**v3.94.0 — Monthly Reports reviews: executive view, not a work queue.**

**"Needs a reply" removed.** This report is read by executives; a list of
unanswered 2-stars is a job for whoever works the profile. It was also
duplicated work — the **Google Profile tab already lists every review with a
Replied flag and an unreplied count in its header**, so nothing needed moving,
only deleting. The server no longer builds the list or pulls
`review_comment` / `review_reviewer` for this report.

**That space is now "All time":** the lifetime average shown large with stars,
over the lifetime review count, and a three-row ladder — **this period /
this year / lifetime** — with a note giving the gap between period and lifetime.
That gap is the executive question: a single month's score says nothing about
direction, and a lifetime average over hundreds of reviews moves slowly, so a
gap takes months to close.

**Scope, now consistent across the tab:** GBP and reviews both count the
hospital's **own listing only**. Dental and JMS appear nowhere in Monthly
Reports — they still roll into group figures on the Overview tab.

**v3.93.0 — Google reviews per hospital, rebuilt around what is actionable.**

Was a four-up grid of ratings; now one page per hospital tab, matching GBP.
With the space freed:

- **Reply rate** — replied vs total for the period
- **Lifetime** total and average beside the period figures, so a good month
  against a weak base is visible
- **Reviews by month** — count and average across the year, not just this window
- **"Needs a reply"** — reviews of three stars or fewer left unanswered, with the
  comment and date

That last card is the point of the rebuild. A star average tells you where you
landed; an unanswered 2-star tells you what to do this afternoon. Answering
those moves a rating faster than chasing new reviews.

**Scope matches the GBP page: the hospital's OWN listing only.** Dental rolls
into BGH on group slides, but including it here made BGH show 4 reviews where
its GBP page showed one listing — two pages on one tab that did not reconcile.

**One pull, not two.** Reviews are fetched year-to-date; the in-period figures
are a filter on the same rows, so the monthly trend costs nothing extra.
`review_reply_comment` is what makes an unanswered review detectable.

Fixtures carry two months and one unanswered low rating, so the trend line and
the needs-a-reply path are both exercised rather than always empty.

The `change:capped` audit fired on `RVB.replyRate` — a rate, not a change. The
exemption now matches any identifier ending in Rate / Ratio / Share / Pct / CTR
rather than a hand-listed few, so the next such name does not need a patch.
Negative control re-run.

**Backlog:** MW will share a Google Sheet of keyword rank / search volume from
an SEO tool — to be added alongside the GBP keyword card, not instead of it.
They answer different questions: what people typed to find you, versus what the
market searches for.

**v3.92.0 — GBP keyword counts DO exist. Correcting v3.91.0.**

v3.91.0 dropped the keyword count column and recorded that Windsor "exposes the
keyword but not its count". **That was wrong** — the field is
**`search_keyword_value`**: "the sum of the number of unique users that used the
keyword in a month". I had guessed at `search_keyword_impressions`,
`keyword_search_volume`, `value`, `threshold` and others, and concluded from
their absence that the data was missing. Absence of a guessed name is not
absence of the field.

**No case for the Business Profile API here.** It would add an access-request
process and a service-account grant that Business Profile does not readily
support, to fetch something Windsor already returns.

**`search_keyword_threshold`** is the paired field: Google withholds counts
below a floor and returns a threshold instead — exactly one of the two is
present per row. Rendered as **`<15`**, which is a real answer, not a zero.
Disclosed counts sort above withheld ones. The fixture returns a threshold row
so that path is exercised.

Column relabelled **Searchers**, since it counts unique people rather than
impressions.

Note for the LS comparison: that deck's **Rank** and **Search Vol** columns
(12100, 27100, 3600…) are Keyword Planner volumes and local-pack ranks from an
SEO tool, not GBP — no connector will reproduce them.

**v3.91.0 — five fixes from MW's review, plus a new audit rule.**

1. **Delta chips say what they compare.** Every chip on this tab is MoM against
   the same length of window one month back; the tooltip now says so. `.dlt`
   had inherited `cursor:pointer` from the v3.61.2 cursor swap, so untipped
   chips looked clickable and did nothing — the hand is now `.dlt[data-tip]`
   only.
2. **Icons** on Actions and Actions-by-language, matching the reference.
3. **Search by language:** the outer heading duplicated the per-page one, logo
   and all — removed. Stage labels moved OUTSIDE the bars: the pills are
   width-limited by ratio, so at small ratios white label text spilled past the
   coloured bar onto white background.
4. **GBP** shows only the hospital whose tab is open; the four metrics are
   framed scorecards. **The keyword Impressions column is gone** — Windsor's GBP
   connector exposes the keyword phrase but no count (checked
   `search_keyword_impressions`, `keyword_search_volume`, `value`, `threshold`
   and others; none exist), so the column was zeros. Rank and search volume as
   the LS deck shows them must come from an SEO tool, not this connector.
5. **Google reviews split per hospital**, with a star-distribution bar each. The
   group average concealed one listing carrying the rating while another slid.

**New audit rule `charts:wired`.** A `drawChart`/`drawBars` call whose canvas no
longer exists returns early — no error, no chart, nobody notices. That has now
happened three times while removing superseded blocks, so it is a check rather
than a habit. Verified against a planted violation.

**v3.90.1 — HOTFIX "chip is not defined", and boot now renders the report.**

v3.90.0 removed the in-page brand selector but left the row that called it, so
Monthly Reports showed **"Something went wrong — chip is not defined"**. Parses
fine, boots fine, throws the moment data arrives.

**Why nothing caught it, and what now does.** `test/boot.js` rendered only the
EMPTY Overview — it never executed a template against data, so any dead
identifier inside a renderer was invisible. Boot now serves a **full report
payload** (every key the renderer reads, one row deep), clicks the BGH nav item,
and asserts three things: no thrown error, **no "Something went wrong" state**,
and at least 8 sections rendered. Verified by reintroducing the bug — both new
checks fail on it and pass once fixed.

Chart.js is a CDN script JSDOM does not load; the app degrades cleanly, so that
expected console noise is muted in boot rather than left to bury a real error.

This is the fifth client-render break this session. The lesson generalises:
**parsing a template is not executing it.** Any renderer worth shipping is worth
running against data in the suite.

**v3.90.0 — Monthly Reports restructured: a nav SECTION with one tab per hospital.**

"Monthly Reports" is now a nav section like META ADS or GOOGLE ADS, with four
items: **BGH / BIH / BHT / WSH**. The in-page brand selector is gone; the
hospital comes from the nav, and each report carries that hospital's logo on
every slide. There is no BHQ tab — the comparison blocks render inside every
hospital's report, badged "all four hospitals".

**All four nav items share `data-view="report"`** so Monthly Reports stays a
single permission tab; `data-brand` distinguishes them, and the active-state
check compares both. Adding four tab ids would have fragmented per-user
permissions for no benefit.

**Slide order is now MW's sequence:**
1. Sessions overview · BHQ
2. Who reaches us from outside Thailand
3. Actions · what we want them to do · BHQ
4. Sessions by language · BHQ *(was "Foreign language versions")*
5. Actions by language · <hospital>
6. Channels · where do they find us
7. Referral · who brings quality · <hospital> *(v3.101.0, with the AI-assistant spotlight)*
8. Search by language · <hospital> — ten pages
8. Google Business Profile · <hospital>

Anything MW has not yet reviewed sits **below** that sequence: Google reviews,
Search Ads, Paid media, Organic social. Keep that split — it marks what is
agreed against what is provisional.

**Removed as redundant** (my inventions, superseded by MW's layout):
`perfBody` (KPIs + channel/key-event charts — now covered by Sessions overview,
Channels and Actions), `byHospital` (duplicated the table inside Sessions
overview), `langBody` (superseded by the Sessions-by-language matrix and the
per-language Search pages), and the group `gbpBody` (superseded by per-hospital
GBP pages). Their orphaned `drawBars` calls went with them — checked by
diffing canvas ids against draw targets, which found six dead calls the eye
would have missed.

**v3.89.0 — Google Business Profile page per hospital.**

One slide each for BGH / BIH / BHT / WSH: impressions, call clicks, website
clicks and direction requests with MoM; daily **impressions split by surface**
(Mobile Search, Mobile Maps, Desktop Search, Desktop Maps); daily clicks; and
the top search keywords for that listing.

**Dental and JMS are excluded from these pages** (MW). They still feed the group
GBP totals, but they are not hospitals and get no page. `listingOwner()` matches
`b.gbp[0]` only — the hospital's own listing — so Dental at `b.gbp[1]` is
deliberately skipped here while continuing to roll into BGH elsewhere.

**Three pulls, not eight.** Grouped by `location_title` × `date` and bucketed in
JS: current window, previous window for MoM, and keywords. Rule 2 from the
budget.

Field names confirmed against Windsor rather than guessed — the surface split is
`impressions_mobile_search` / `impressions_mobile_maps` /
`impressions_desktop_search` / `impressions_desktop_maps`. An earlier guess of
`business_impressions_*` does not exist.

**Post clicks** (in the LS page) has no field on this connector and is omitted.

**v3.88.0 — Search pages: 10 languages × 4 hospitals, for ONE extra request.**

The LS Search page — TOFU impressions → MOFU visits → BOFU actions, with the
keywords behind them — now exists for every language and every hospital.

**Forty pages, one new query.** Visits and actions were already computed in
`ALB` for actions-by-language. Only the Search Console side was missing, and a
page URL carries both the branch segment and the locale, so a single
`query × page` pull buckets into all forty cells. The alternative was 40
filtered pulls. This is rule 1 from the request budget in §v3.87.1 working as
intended — check what is already in flight before adding requests.

`gscQuery` gained **paging** (`maxPages`), since `query × page` exceeds Search
Console's 25,000-row ceiling. Three pages; rows arrive sorted by clicks, so any
tail lost is the tail rather than the headline.

**Tabs on screen, one slide per language in print.** Each language renders as
its own `.lang-page`; screen CSS hides all but the active one, print forces them
all visible with a page break before each. A deck needs forty pages, a browser
does not want forty stacked sections — same markup serves both, so there is no
separate export path to keep in sync.

**v3.87.1 — request budget for Monthly Reports.**

Current cost of `/api/report`: **40 jobs — 31 GA4 reports, 1 Search Console,
8 Windsor.** Removed the two group-wide `prevAll` / `yoyAll` pulls: the
per-brand prev/yoy pulls already cover the same four segments, so the group
total is their sum (`sumBrandWindow`).

**Scaling rule for the remaining LS pages.** A per-brand section costs **4
requests per window** — a section with current + previous costs 8. The endpoint
is fine at 31 GA4 reports behind a 6-slot gate (roughly 5–6 waves, so on the
order of 10–30s cold, well inside the 300s Cloud Run timeout, and cached for
600s afterwards). It will NOT stay fine if every new page adds 8.

**Prefer, in this order:**
1. **Derive from an existing pull.** A landing page encodes both the brand and
   the locale, which is how the language matrix and actions-by-language cost
   nothing extra. Always check whether a pull already in flight carries the
   dimension.
2. **One group-wide pull bucketed in JS**, rather than four filtered ones.
3. **Only then** add per-brand requests.

**Splitting the endpoint does not reduce GA4 load** — the gate is module-global
and the quota is per property, so total wall time is unchanged. Split for
failure isolation and progressive rendering, not for speed.

Note the gate is shared across ALL requests and endpoints: two people loading
the report at once queue behind the same 6 slots.

**v3.87.0 — GA4 CONCURRENCY GATE. This was causing random "no data".**

`buildReport` fans out roughly **thirty GA4 reports at once** — four brands
× several windows, plus the language and country pulls. The Data API caps
concurrent requests per property, so the surplus were rejected; `runJobs` turned
each rejection into null, and the failures surfaced as **"no data" on whichever
slides lost the race**. Different brands went blank on different runs, which is
exactly why it read as a per-brand bug — BGH and BHT empty on the countries
slide while BIH and WSH were fine.

`ga4RunReport` now queues behind **6 slots** (`GA4_MAX_CONCURRENT`). Verified
with 40 simulated tasks: all complete, peak concurrency 6, no deadlock — the
release hands its slot straight to the next waiter rather than decrementing,
which is the bug most such gates ship with.

Slower by a few seconds, deterministic instead of arbitrary. **If a slide shows
"no data" now, it is genuinely missing data, not a lost race** — which finally
makes those cases worth investigating.

Also: the CR line on the Actions slide was 10.5px in `--faint` and effectively
unreadable; now 11px semibold in the accent colour.

**v3.86.0 — Channels slide.**

"Where do they find us" — four hospitals in the same 2×2 card grid as the
countries slide, top five channels each with sessions and MoM. The two
comparison pages now read identically, which is the point of a grid.

**No new query.** The previous-window pull `p_${brand}` was fetching a bare
session total for the usersOverview MoM; it now groups by
`session_default_channel_group`, and the same rows serve both — summed for the
headline MoM, per-channel for this slide. Verified both still compute.

**v3.85.0 — Actions by language.**

Per-locale rows: views, sessions, find doctors, appointments, contact us, view
items, add to cart, revenue — the LS "Actions by languages" page. Computed for
**every hospital and for BHQ combined**, and rendered for whichever tab is
selected. This is the only slide on the tab that is genuinely per-brand rather
than a comparison, so it is deliberately NOT badged "all four".

Costs no new query. A landing page carries the hospital, the locale and the page
metrics; `ga4KeyEvents(["landing_page"])` was already returning key events keyed
by the same landing page. Two metrics were added to the existing pull —
`screen_page_views` (new to `GA4_METRIC_MAP`) and `purchase_revenue` — and the
whole grid falls out of it.

BHQ accumulates every in-scope page as a real sum, verified: Thai 700 = BGH 100
+ BIH 100 + BHT 400 + WSH 100.

Revenue will read 0 while orders do not reach GA4 (§11); the note says so rather
than leaving a bare zero.

**v3.84.0 — Actions slide.**

The LS "Actions | What we want them to do" page: one row per hospital, sessions
plus four actions with a conversion rate against **that hospital's own
sessions**, so BGH at 781K and WSH at 35K stay comparable. Costs no extra query
— built from the `keyEventBreakdown` each brand already carries.

**Mapping note.** LS shows ค้นหาแพทย์ / นัดหมายแพทย์ / ติดต่อเรา / แพ็กเกจ. The first
three map cleanly to `find_doctors`, `appointments`, `contact_us`. The fourth is
rendered here as **`view_item`** — but GA4 also has a separate **`packages`**
event (36,452 group-wide in July) which is what LS may actually be counting, and
`packages` is NOT in `KEY_EVENTS`. **Awaiting MW.** If it is the right one, add
it to `KEY_EVENTS` and swap the mapping; the numbers will not match the LS deck
until that is settled.

**v3.83.0 — Foreign language versions matrix.**

Hospital × locale, sessions and MoM in every cell — the LS "Foreign Language
Versions" page. Forty numbers whose meaning comes from their position in the
grid, so this stays a matrix rather than becoming charts.

**Built from one extra query, not eight.** A landing page carries both facts —
which hospital (the branch segment) and which language (the locale segment) —
so the existing `langSessions` pull fills all forty cells; only a
previous-window copy had to be added for MoM. `brandForPath()` reads the segment
straight out of the path via `brandBySegment()`, so it stays tied to the BRANDS
registry rather than duplicating the mapping.

Column order is taken from the LS deck (TH EN JA ZH MY KM AR VN DE ID) rather
than the `LOCALES` declaration order, so the two can be read side by side during
the changeover.

Fixtures gained `/en/` and `/ja/` in-scope pages: with only `/th/` present the
matrix filled a single column and a broken locale split would have looked
identical to a correct one.

**v3.82.1 — `.g-2` never existed on screen.**

It was defined **only inside the `@media print` block**, so every two-up grid
built with `grid g-2` collapsed to a single column in the browser — the
countries cards stacked full width instead of sitting 2×2, and the same applied
to the GBP, reviews, search-terms and language slides. Now defined in the base
stylesheet, and added to the 1080px breakpoint so it collapses like its
siblings.

Section spacing increased (`.slide-title` margin 22px → 34px) so topics read as
separate blocks rather than one scroll.

**Logo mapping, confirmed by MW — counter-intuitive on purpose:**
| Tab | File | Which mark |
|---|---|---|
| **BHQ** | `2024/04/BGHlogo.svg` | plain, no sub-text |
| **BGH** | `2025/05/BHQ-Logo.svg` | the one carrying HEADQUARTERS |

The filenames are the reverse of the tabs they serve. Do not "fix" this.

**v3.82.0 — countries slide; print fills the page; BHQ logo corrected.**

**New slide: "Who reaches us from outside Thailand"** — four hospitals, top five
countries each, sessions and MoM. Kept as small ranked tables rather than
charts: five rows with a delta read faster than four bar charts, and the country
names are the point. Thailand is filtered at render, not in the query, so the
payload keeps the domestic row and the share maths stays honest if that ever
changes. `country` added to `GA4_DIM_MAP`.

**Print was shrinking to fit instead of filling.** v3.81.0 capped chart wrappers
at 190px, which left a 16:9 slide half empty. Now 300px, with `.slide` given a
6.3in minimum and slightly larger stat and table type, so a slide occupies the
page it is given.

**BHQ logo** corrected to `BGHlogo.svg` per MW.

**v3.81.0 — stage bars add up; print layout and logo fixed.**

**Stages 1 and 2 are now SOURCE-based, not channel-based.** They are platform
stages, and mapping a platform onto a GA4 channel row only works while that
channel exists in the data. When it does not — TikTok with no Organic Social row
— the source counted toward the headline but appeared in no segment, and the bar
silently failed to add up (41,270 headline against 41,170 of segments). Stage 1
now segments by Meta / Google Ads / Search / TikTok / Facebook organic / GBP;
stage 2 by ad clicks / search clicks / post engagements / TikTok engagements /
profile clicks. Stages 3–5 stay channel-based, where the channel IS the unit.
**All three bars verified to sum exactly to their headlines.**

Stage 5's off-site actions render as muted grey segments rather than being
absent from the bar.

Post engagements stay in stage 2 per MW: "at least they are slightly moving
toward us than they did nothing."

**Print fixes:**
- **BHQ had no logo entry**, so the most-used export showed none. Added.
- Two-up grids collapsed to one column in print, which is what split Sessions
  overview across pages 2 and 3. `g-2-1`, `g-2` and `g-3` are now forced in
  print, and inline chart heights are overridden to 190px so a chart and its
  companion card fit one slide.
- MoM and YoY were stacked badges in a single cell; they are now **two columns**.

**v3.80.0 — the five stages now mean what MW says they mean.**

Stage definitions, set by MW 23 Aug 2026:

| # | Stage | Contains |
|---|---|---|
| 1 | **TOFU · Impressions** | paid + organic impressions, social reach, TikTok views, GBP profile views, (email sends, LINE broadcasts — no connector) |
| 2 | **Interactions** | interaction with what was seen: ad + search clicks, post engagements, TikTok engagements, GBP website clicks. Interim, hence the narrow bar |
| 3 | **MOFU · Visits** | web visits, where consideration happens |
| 4 | **Engagement** | on-site engagement, interim before acting |
| 5 | **BOFU · Value actions** | web key events + GBP calls + GBP directions + Meta ad messages + Google Ads phone calls |

**The Facebook double-count is solved properly.** `page_impressions` counts
organic + boosted + dark, which is why it had to be excluded. Windsor exposes
**`page_impressions_organic`** — organic distribution only. Facebook now sits IN
stage 1 with its organic reach while Meta Ads keeps all paid distribution
including dark posts. No subtraction, no estimate, no overlap. (`page_impressions`
is still pulled as `impressions.fbPageAll` for reference.)

`google_ads.phone_calls` — "number of offline phone calls" — supplies the
call-from-Google-Ads outcome in stage 5.

`totals.keyEvents` is now web + off-site; `keyEventsWeb` and `keyEventsOffsite`
are exposed separately because **the stacked bar splits by GA4 channel and
off-site actions have no channel**, so they are in the total but not in the
segments. The stage note says so.

Removed the dead v3.76 bands block from `server.js`, which also took
`addNullable` with it — restored. `sumOrNull` now tolerates `undefined` as well
as null: a mistyped job key used to 500 the whole endpoint rather than degrade.

**v3.79.0 — Overview funnel rolled back; Monthly Reports opens with Sessions overview.**

**ROLLED BACK: the three-band marketing funnel on Overview.** MW: the five-stage
funnel was already correct. Restored Impressions → Ad & search clicks → Visits →
Engagement → Key Events, with Impr and Clicks back in the channel table.

The intent behind the bands still stands — off-site action belongs **inside**
these five stages, not in a parallel structure. **Awaiting MW on which stage
each off-site action belongs to** before folding them in. Do not re-invent the
bands.

**New opening slide: Sessions overview**, mirroring the LS "Users Overview" —
stacked months by hospital on the left, headline with MoM / YoY and a
per-hospital breakdown on the right. Sessions, not users, so the dashboard keeps
one unit.

The monthly series runs **year-to-date regardless of the selected range**, as the
LS deck does, so the trend is always readable; only the headline and the
comparisons follow the picker. MoM and YoY use `comparisonWindows()`, so both
compare equal-length windows rather than calendar months.

**v3.78.0 — Monthly Reports exports per hospital, with the hospital's logo.**

**PDF follows the selected tab.** The Performance slide shows the chosen
hospital; every other slide keeps rendering because those blocks are
**comparisons or group-level assets with no per-brand split** — by hospital,
search by language, GBP, reviews, paid media, search terms, social. Each is
badged **"all four hospitals"** so nobody in a BHT export mistakes them for
BHT's own numbers.

Screen and print now show the same thing, per MW — no separate export path to
keep in sync.

**Hospital logo on every printed slide.** `print-head` renders once at the top
of the document, so a logo there does not appear on pages 2–8. The logo now sits
in each `.slide-title`, which guarantees one per printed page — a page pulled
out of the deck still says which brand it belongs to. Served from the public
CDN, with `onerror` hiding the img rather than leaving a broken icon:

| | |
|---|---|
| BGH | `static.bangkokhospital.com/uploads/2025/05/BHQ-Logo.svg` |
| BIH | `.../2024/03/bih-1.svg` |
| BHT | `.../2024/04/BHTlogo.svg` |
| WSH | `.../2024/04/WSHlogo.svg` |

The print masthead now names the hospital too, so an exported file is
self-identifying.

**v3.77.0 — the website is IN the funnel; Top Products is branch-scoped at last.**

**Engage band gained Website visits and Engaged sessions.** The band listed ad
clicks, post engagements and profile clicks but omitted the largest response
channel of all, because the website sat only in the detail below. "Visits" in
that lower funnel is renamed **Web visits** so the two are not confused.

**Top Products → Top packages viewed, now filtered to the four hospitals.**

This was the last figure on Overview still covering all 27 branches. GA4's
item-scoped metrics (`itemsViewed`, `itemRevenue`) **cannot be combined with any
page or session dimension**, so an item-name table can never be branch-filtered
— no amount of filter work fixes it. Solved by changing the *measure* rather
than the filter: count **`view_item` events against `pageTitle`**, which is
event- and page-scoped and therefore filterable on `pagePath`.

Trades accepted: page titles instead of item names, and revenue dropped — item
revenue has no page-scoped equivalent, and GA4 web purchases are 0 anyway
because orders never reach GA4 (§11).

**Every number on Overview is now four-branch scoped.** No exceptions remain.

Two mock gaps closed: the `OutOfScope` marker only watched the landing
dimension, so a report scoped via `pagePath` looked unfiltered; and `pages` was
filtered on the landing dimension alone. Both now consider `pagePath`.

`test/boot.js` caught a backtick inside a template literal (`view_item` in a
note) that broke the whole client parse — fourth time that layer has paid for
itself.

**v3.76.0 — Overview is a MARKETING funnel now, not a web funnel.**

Off-site reach and action are folded in. The page leads with three bands:

- **Reach** — Meta Ads, Google Ads, Search, Facebook page, TikTok, GBP profile views
- **Engage** — ad clicks, search clicks, FB post engagements, TikTok engagements, GBP website clicks
- **Act** — website key events, calls from profile, direction requests, Meta conversations

**The bands are deliberately NOT a narrowing funnel.** Someone who calls from
Maps was never a visit, and the same person can appear in several channels with
no way to dedupe, so there is **no conversion rate between bands** and no total
across them. Every row states its own unit, because a TikTok view, a boosted
Facebook reach and a search impression are genuinely different things. The
website funnel keeps its rates and sits below, where each stage really is a
subset of the one above.

**Channel detail is now purely GA4** — the Impr and Clicks columns are gone.
Attributing TikTok views to the "Organic Social" channel group produced 96.9K
impressions against 20.1K visits in a row that also contains Facebook, Instagram
and LINE traffic: two taxonomies in one row, and a ratio that reads as a
conversion rate while being nothing of the sort. Platform reach belongs in the
Reach band; GA4 channel groups belong in the channel table; they should never
share a row again.

Trap: `addNullable` was declared below its first use by the bands — a `const` in
the temporal dead zone, which `node -c` does not catch and `test/boot.js` does.

**v3.75.0 — Search Ads terms, organic social, nav order.**

**Monthly Reports moved above the separator**, directly under Overview.

**Search Ads · what people typed** — top terms by clicks plus CTR, from
`search_term` (the query someone actually entered) rather than `keyword_text`
(the term we bid on). The two diverge, and the query is the one that says what
patients are looking for. Long Thai queries are truncated at 34 characters or
the axis swallows the chart.

**Organic social** — Facebook reach and post engagements, TikTok views and an
engagement mix chart. Reported side by side and **never summed**: page reach
includes Boost Post and therefore overlaps Meta Ads, and a TikTok view counts
autoplay (§v3.68.0).

**Chat Bubble is NOT built.** `click_chat_bubble` appears in the LS deck but is
tracked nowhere in this codebase, and there is no per-channel parameter to split
Telegram / LINE / WhatsApp / Messenger. It needs GTM work before it can be
reported.

The `change:capped` audit rule was firing on `x.ctr` — a **rate**, not a change.
Rates legitimately render as raw percentages and must not be capped at ">10x".
Exemption widened to `.ctr` / `.rate` / `.share`, and the negative control
re-run to confirm the rule still catches genuine violations.

Monthly Reports now stands at **8 slides, 14 charts, 0 tables**.

**v3.74.0 — Monthly Reports: Google Business Profile and Reviews.**

Two new slides, four charts, no tables.

**GBP by hospital** — profile views, plus calls / directions / website clicks as
a grouped bar. Listings do **not** map one-to-one to hospitals: Dental rolls
into BGH (so BGH shows 2 listings), JMS serves all four and is reported as
shared exactly like the Meta group accounts, and anything unrecognised lands in
an **unlisted** bucket that is shown in the note and logged as
`gbp_listings_unmapped` — same rule as unmapped ad accounts, nothing is dropped
quietly.

**Google reviews** — count, average and 5-star share, with rating mix and
average-by-hospital charts. Shared listings count toward the group average but
not toward any hospital's.

Fixture widened from a single "Bangkok Hospital" row to **all six real listings
plus one unknown**. With one row, the Dental roll-up, the JMS shared path and
the unlisted bucket were all unexercised — three mappings that would have
tested green while doing nothing.

**v3.73.0 — Monthly Reports is chart-first, and the print break is fixed.**

**The break bug:** a `.slide-title` printed alone at the foot of a slide with its
content on the next page. Cards carry `break-inside:avoid`, so a card that could
not fit the remaining height moved on and abandoned its heading. Fixed with
`break-after:avoid` on `.slide-title`, plus `.slide{break-inside:auto}` so the
slide is the unit that flows while its cards stay whole.

**Charts replace tables.** The tab now renders **7 charts and 0 tables** — a
20–30 page deck is skimmed, not read, so a number that needs a row scan is a
number nobody sees. New `drawBars()` helper covers the categorical comparisons a
board deck is mostly made of; `drawChart()` remains for time series. Horizontal
by default, because category labels here are long and multilingual and rotated
labels are unreadable at slide size.

Per slide: **Performance** — 3 KPIs, channels, key events. **By hospital** —
sessions/engaged, and KE-per-session as a rate. **Search by language** — visits
with key events, and impressions separately, because impressions run to millions
against a CTR of a few percent and flatten to nothing if plotted together.
**Paid media** — shared KPIs and spend by hospital.

Animation is disabled on these charts: print captures the canvas as it stands,
and a mid-animation canvas prints half-drawn.

**v3.72.0 — Monthly Reports laid out as topic slides for print.**

The tab is now structured as **topic slides**, not one scroll. Each topic gets a
`.slide-title` and every topic after the first carries `.slide-break`, so
printing produces one **16:9** slide per topic — the `@page{size:13.333in 7.5in}`
rule already existed, what was missing was the sectioning.

Order follows how a board reads it, mirroring the LS deck without copying it:

1. **Performance** — BHQ or the selected hospital
2. **By hospital** — share of sessions, engaged, key events (BHQ view only)
3. **Search by language** — impressions → clicks → visits → key events
4. **Paid media** — BHQ shared accounts, and any unmapped ones

The brand selector is `no-print`, so a printed deck shows the chosen scope
without the chrome. Sections render only when they have content, so a
single-hospital print does not emit empty slides.

Build sections into this structure as they are added — retrofitting slide
breaks after the fact is what makes a print stylesheet unmanageable.

**v3.71.0 — Monthly Reports: search by language.**

Renames: **Board Report → Monthly Reports**; **E-commerce · Monthly report →
E-commerce · Report**; brand labels are now the short codes MW uses (BGH, BIH,
BHT, WSH) rather than full hospital names.

Added the per-language strip the LS deck repeats ten times: **impressions →
clicks → visits → key events** per locale, with CTR and KE/visit. Search Console
supplies impressions and clicks keyed on `page`; GA4 supplies sessions and key
events keyed on landing page; both bucket through the same `localeFromPath()`,
which reads the URL locale segment and never guesses from script (§7 — EN, DE,
VN and ID share Latin characters).

Unlike the cross-platform bands on Overview, this **is** a real funnel: each
stage is a subset of the one above for the same pages, so the rates mean
something.

**Trap hit while building:** `ga4KeyEvents` validates dimensions against
`GA4_DIM_MAP`, which lacked `landing_page`. It threw, `runJobs` turned the
rejection into null, and every language would have shown **zero key events with
no error visible**. `landing_page` is now in `GA4_DIM_MAP`; `GA4_DIM_MAP_FULL`
no longer duplicates it. Any new dimension used by a key-event pull must be
added there or it fails this way — silently.

**v3.70.0 — BHQ is a real total, and the naming is fixed.**

**Vocabulary, which matters more than it sounds:**
- **B+ / "group"** = the 27-branch GA4 property `484633959`
- **BHQ** = the four hospitals combined — what this dashboard reports
- **BGH / BIH / BHT / WSH** = individual hospitals

v3.69.0 used "group-level" for the shared-asset block, which in BHQ's own
vocabulary means 27 branches. Renamed to **"BHQ shared — runs for all four
hospitals"**. Using one word for both is how a board deck ends up presenting
27 branches' numbers as four.

"All four" showed four separate cards; it is now **BHQ**, a genuine sum with a
**By hospital** table underneath giving each hospital's share of sessions,
engaged, key events and KE/session. Summing cannot double-count: a session has
one landing page and therefore one brand.

**Cross-check worth running on live data:** BHQ sessions should equal the
Overview funnel's Visits, since both count sessions landing on the same four
segments. They differ in the mock only because the stub generates rows from the
dimensions requested rather than from traffic, and Overview groups by
date × channel while the report groups by channel alone. If they diverge in
production, one of the two filters is wrong.

**v3.69.1 — the brand registry had a hole; unmapped accounts now surface.**

**Two agencies run Meta for BHQ: ADA and EGG.** Most brands have one account
with each. v3.69.0 listed only the ADA accounts, so every EGG account's spend
was **silently dropped** — an unmapped account hit `continue` and vanished with
no error and no visible gap. A registry that quietly ignores what it does not
recognise is worse than no registry, because it looks authoritative.

Fixed two ways:
1. EGG accounts added for all four brands.
2. **An `UNMAPPED` bucket.** Any account nobody claims is collected, shown in
   the UI in a bordered card headed "not counted anywhere", and logged as
   `meta_accounts_unmapped`. A new ad account can never disappear silently
   again — it will appear and ask to be classified.

Also corrected: v3.69.0 asserted in a comment that **WSH has no Meta account**.
It does — `WSH x ADA` (id 327561266199410) and `WSH x EGG`. Recent months simply
show no spend. A confidently wrong comment is worse than no comment.

`BHQ Inter x EGG` is **inferred** shared from its ADA equivalent and is NOT in
the registry; it will appear in the unmapped card until MW confirms.

Fixture now includes an EGG account, a WSH account, and a deliberately unknown
one, so the unmapped path is proven rather than assumed.

**v3.69.0 — Board Report tab: the spine.**

First pass at replacing the four Looker Studio monthly exports with one tab and
a brand selector (All / BGH / BIH / BHT / WSH). Sessions is the unit, chosen by
MW so the whole dashboard speaks one language.

**`BRANDS` is now the single brand registry.** Five systems identify a brand
five different ways and share no key — GA4 and Search Console by landing path,
GBP by listing title, Meta by account name, Facebook by page. Every section
reads from `BRANDS` rather than inventing its own lookup, which is how such
tables drift apart unnoticed.

Mapping confirmed by MW 22 Aug 2026:

| Brand | GA4 segment | GBP | Meta |
|---|---|---|---|
| BGH | `bangkok` | Bangkok Hospital + **Dental** | BGH x ADA |
| BIH | `bangkok-bone-brain` | BIH (Brain x Bone) | BIH x ADA |
| BHT | `bangkok-heart` | Bangkok Heart | BHT x ADA |
| WSH | `bangkok-cancer` | Cancer Wattanosoth | **none** |

**Shared assets serve all four and belong to none:** Meta `BHQ x AIQ` and
`BHQ Inter x ADA`, the single Facebook page, and the JMS listing. They are
reported in a separate "Group-level" block and **never added to a brand's
totals**. The consequence is deliberate and must be stated in the deck: **brand
figures do not sum to the group total.** `BHQ Shopee x EGG` is e-commerce only
and excluded from this report entirely.

WSH having no Meta account is correct, not a gap — its paid social runs from the
shared group accounts.

**Not reproducible from the LS deck, by decision:** YouTube (connector not
added) and the Appointments page (sourced from a Google Sheet of appointment
records, no connector). Both wait for MW.

Brand splits will NOT match LS exactly: LS reads the four dedicated GA4
properties, this reads the group property filtered by landing path, so a session
landing on one brand and converting on another is credited differently. MW
accepts and will explain.

Test fixtures widened to one page per brand plus brand/shared/ecom Meta
accounts — with only `bangkok-heart` present, three of four brands read zero and
a broken segment filter looked identical to correct output.

**Still to build:** search by language, ads, social, GBP, reviews, chat bubble.

**v3.68.1 — panel renamed; the Bookings zero was a lie.**

"Reach without site visits" → **"Off-site reach & action"**, since the panel now
holds outcomes as well as reach.

**`business_bookings` will always be 0 here**, and a row saying so was
misleading. That metric counts bookings made through a **Reserve with Google**
partner. BHQ's booking button links to the site, so Google records a *click* and
never learns whether a booking followed. The row now renders only when the value
is non-zero — it will appear by itself if Reserve with Google is ever adopted —
and the note explains that booking taps arrive as `website_clicks`.

**Why Facebook page reach is 23.1M against TikTok's 96.9K:** Boost Post. Every
boosted organic post's reach lands in `page_impressions` AND in Meta Ads
impressions. Confirmed by MW 22 Aug 2026. The note now names Boost Post rather
than "ads", because that is the mechanism a marketer will recognise.

Correcting an assumption made earlier the same day: TikTok was believed to be
the large organic-reach contributor. Once split, it is **0.4%** of what
Facebook page reach reports. Almost all of the old 23.2M "Organic Social" line
was Facebook, most of it boosted.

**Known inconsistency, deferred to the band layout.** The Organic Social channel
row now shows TikTok views (96.9K) against 20.1K visits — a 21% rate that cannot
be true. GA4's Organic Social channel group spans Facebook, TikTok, IG and LINE,
while only TikTok reach is attributed to it. Platform reach and GA4 channel
groups are different taxonomies and should not share a row. The fix is to stop
attributing platform reach to channel rows entirely and show all reach in the
off-site panel — part of the TOFU/MOFU/BOFU reshape.

**v3.68.0 — off-site ACTION surfaced; Facebook page reach removed from the total.**

Step one of the TOFU/MOFU/BOFU reshape: the marketing funnel does not end at the
website. Three things landed.

**1. A real double-count is gone.** Meta defines `page_impressions` as "any
content from your Page or about your Page... this includes posts, stories,
**ADS**". It was being added to Meta Ads impressions, so every paid impression
was counted twice in the Impressions headline. Facebook page reach now sits in
the reach panel labelled "includes ads" and is **excluded from the total**.
Expect Impressions to drop.

**2. TikTok split out.** A video view is not an impression — autoplay counts.
Merged with Facebook it produced a 23.2M "impressions" line against 20.1K
visits, which read as a failing channel rather than a different unit. The
Organic Social channel row now carries TikTok views only.

**3. Off-site actions, previously pulled and discarded:** GBP `call_clicks`,
`direction_requests` and the newly added **`business_bookings`** (the booking
button is live on the profile), plus Meta
`actions_onsite_conversion_total_messaging_connection`.

**Connector facts established 22 Aug 2026 by querying Windsor directly:**
- **GBP `conversations` is DEPRECATED** — Google shut down Business Profile
  chat. There are no GBP messages to count, ever.
- **`facebook_messenger` connector does not exist** ("We don't have this
  connector yet!"). `facebook_organic` has no messaging fields either. So
  message volume is **ad-attributed only** and is a floor, not a total. The UI
  says so.
- **YouTube IS available** in Windsor, unconnected. Prefer it to the GCP route:
  the YouTube Analytics API needs OAuth as channel owner, which a service
  account cannot do without domain-wide delegation.
- Windsor **GA4 and Search Console are now unused** by this service — both moved
  to Google's APIs. Safe to disconnect. **Google Ads is NOT** — it is live in the
  funnel since v3.67.0.

**Backlog (after the Looker Studio changeover):** disconnect Windsor GA4 +
Search Console; connect YouTube and re-enable LINE; then the TOFU/MOFU/BOFU band
layout with the web funnel nested intact.

**v3.67.0 — Google Ads in the Overview funnel.**

Overview never pulled `google_ads` at all, so **Paid Search showed visits with
no impressions and no clicks**, and the "Paid media" card counted Meta only
while calling itself paid media. Both fixed:

- `google_ads` added to the Overview pull; `IMPRESSION_SOURCE_BY_CHANNEL` maps
  **`paid search` → `gads`**, and impressions/clicks feed the channel row and
  the funnel totals.
- **Paid media now sums Meta + Google Ads**, with the split shown under the
  spend figure. Nulls are preserved per platform: one platform unavailable must
  not read as zero for the other, and both unavailable still renders "—".

**Deliberate limitation.** The connector returns one total across all campaign
types, so this attributes all Google Ads impressions to **Paid Search**. Display
and Video campaigns land in GA4's "Display" and "Paid Video" channel groups and
are NOT claimed here — if Display spend becomes material, split the pull by
`campaign_type` rather than widening the map, or those channels will be
credited with search impressions.

The GA4 stub now emits a **Paid Search** channel group; without it the mapping
was never exercised and the whole change would have tested green while doing
nothing.

**v3.66.0 — backlog batch: Pages daily chart, key-event types, table fixes.**

- **Pages** gains a **By day** line chart (visits / engaged / key events) and a
  **Key events by type** card. Neither costs an API call: `buildPage` already
  fetched `dateS` and `dateK` and was aggregating them to months, discarding day
  resolution. The breakdown is restricted to the page's own rows, so it sums to
  `totals.keyEvents`.
- **Trend tooltips** show the weekday (`2026-07-18 · Sat`). Parsed as UTC so the
  day cannot shift in +07.
- **`th.num` / `td.num` gained `padding-left:14px`.** Numeric columns had zero
  left padding, so two adjacent headers collided as "ViewsRevenue ฿" once Top
  Products took a third column. Affected every wide table, not just that one.
- **Meta Ads by account:** `฿` moved into the Spend header instead of repeating
  on every row.

Note for future edits: `buildGoogleAds` and `buildPage` **end with an identical
`monthly:` line**. A first-match replace on it lands in the wrong function and
fails as `daily is not defined`. Anchor on a neighbouring unique key.

**v3.65.1 — branch regex was dropping UTM-tagged section-root landings.**

GA4 landing pages have **no trailing slash** on a section root: `/th/bangkok`,
not `/th/bangkok/`. The pattern ended `(/|$)`, so a campaign landing on
`/th/bangkok-heart?utm_source=facebook` hit `?`, matched neither branch, and was
excluded — **exactly the traffic campaigns generate.** Deeper pages were fine
(`/th/bangkok-heart/package/x?utm=1` has the `/`), so this only bit section
roots, which is why the totals looked plausible. Now `([/?]|$)`, in both the
GA4 and Search Console patterns. Mock fixture covers the case.

**Verifying the filter in the GA4 UI — the semantics differ from the API.**
Explore's "matches regex" is a **FULL** match; the Data API uses
`PARTIAL_REGEXP`. The server pattern pasted into Explore returns only section
roots (2,967 sessions) and looks broken when it is not. For a UI check, use the
full-match form:

```
^/([a-z]{2}/)?(bangkok|bangkok-bone-brain|bangkok-heart|bangkok-cancer)([/?].*)?$
```

Third appearance of FULL vs PARTIAL regex semantics in one session: the
v3.63.0 outage, the mock that matched too leniently, and this verification
procedure. Whenever a regex crosses a boundary here, state which semantics
apply.

**v3.65.0 — `ga4Items` fixed. GA4 is now clean.**

The cause, visible within minutes of v3.64.2's logging landing:

```
GA4 Data API 400: Please remove itemViewEvents to make the request compatible.
The request's dimensions & metrics are incompatible.
```

`itemViewEvents` is **event-scoped** and cannot be combined with `itemName` and
item-scoped metrics. Replaced with **`itemsViewed`**, the item-scoped
equivalent. `item_view_events` is removed from `GA4_METRIC_MAP` entirely so it
cannot be reused by accident. The yellow degradation banner is gone and Top
Products populates for the first time.

`test/mock-fetch.js` now enforces GA4 **scope compatibility** and returns a 400
for a known-incompatible pair, verified by reverting the metric and confirming
the stub reproduces the failure. Third instance this session of the same
lesson: a stub that accepts what the real API refuses certifies code that
cannot work. The others were FULL_REGEXP semantics and filters on ungrouped
dimensions.

Top Products gained a **Views** column, `฿` moved into the header, and the card
now states it covers **all 27 branches** — item-scoped metrics cannot take the
landing-page filter, so it is the one number on Overview that is not
branch-scoped, and saying so beats a silent inconsistency.

**v3.64.2 — `runJobs` now LOGS job failures.**

It captured the reason into `errors[k]` and showed it to nobody. The banner
names the failed job — "Unavailable this run: ga4Items" — but not why, and
nothing reached Cloud Logging, so a source could fail on every run for weeks
with the cause recorded nowhere. That is why `ga4Items` was undiagnosable:
searching the logs for it returned empty, which looked like "no error" and was
actually "no logging".

Every failure now writes `job_failed` with the job name and the first 500
characters of the reason:

```
gcloud logging read 'resource.type=cloud_run_revision AND
  resource.labels.service_name=ai-reporting-git AND
  jsonPayload.message="job_failed"' --limit 20 --freshness=1h \
  --format='value(jsonPayload.job, jsonPayload.error)'
```

A degradation path that hides the cause is only half a degradation path — it
keeps the dashboard up and makes the bug permanent.

**v3.64.1 — GA4 cleanup after the migration.**

`ga4Fields()` became dead code once every GA4 pull moved to the Data API — and
with it, its 10-metric guard. **The guard protected nothing.** It now lives in
`ga4RunReport()`, the single choke point all GA4 traffic passes through, and
also checks the 9-dimension cap. The Data API has the same limits Windsor did,
so the protection is still needed; it was just attached to the wrong thing.

Confirmed clean in this pass: no `windsor("googleanalytics4")` call remains
(one comment reference only), all scoped calls go through `withBranch()`, and
`/api/page` plus `ga4Items` are the only deliberate exemptions.

Still open: **`ga4Items` fails on every run** and is the recurring yellow banner
plus the empty Top Products card. It failed under Windsor too, so it predates
the migration. Item-scoped metrics cannot take the session-scoped landing-page
filter, so it is exempt from branch scoping and will be group-wide if it ever
returns — the card needs a label saying so.

**v3.64.0 — Search Console moved to its own API and branch-filtered.**

After v3.63.0 the funnel compared unlike things: Impressions 109.7M and clicks
1.4M covering all 27 branches, against Visits 1.0M covering four. Windsor cannot
filter (§3), so all three GSC pulls moved to
`searchconsole.googleapis.com/webmasters/v3`, filtered with `includingRegex` on
`page`.

| Item | Value |
|---|---|
| Scope | `https://www.googleapis.com/auth/webmasters.readonly` |
| Site | `GSC_SITE`, default `sc-domain:bangkokhospital.com` |
| Override | `GSC_API_BASE`, and `BRANCH_SEGMENTS=off` disables filtering |
| Requires | Search Console API enabled + service account added as a user on the property |

This also relieves the volume problem: the unfiltered `query x page` pull was
44.8 MB in 260 s against a 300 s Cloud Run timeout. Filtered to four branches it
is a fraction of that, so Topic Explorer should be well clear of the ceiling.

GSC returns `page` as a **full URL**, so the pattern is anchored past the host:
`^https?://[^/]+/([a-z]{2}/)?(seg|...)(/|$)`. Note the hostname trap that was
predicted here does NOT actually bite — "bangkok" in "bangkokhospital.com" is
not followed by a slash, so even an unanchored pattern rejects it. The anchor is
kept because it is more precise, not because it fixes a live bug.

**Deliberately NOT scoped, both confirmed correct by MW 22 Aug 2026:**
- **Meta / TikTok / Facebook organic / Google Ads** — every ad account already
  belongs to BHQ, so there is nothing to filter.
- **GBP** — all six listings in `GBP_LISTINGS` are in scope, including Dental
  and JMS. The panel deliberately shows more than the four hospital branches.

**v3.63.1 — HOTFIX. v3.63.0 took every GA4 figure to zero in production.**

`FULL_REGEXP` in GA4 requires the pattern to match the **entire** dimension
value. The branch filter is a prefix pattern, so it matched nothing and every
GA4 report came back empty — Visits 0, Key Events 0, "no data". Not an error,
just silence, which is why the degradation banner said nothing. Now
**`PARTIAL_REGEXP`**, still anchored with `^`. Do not "tidy" it back.

**`BRANCH_SEGMENTS=off`** now disables the filter service-wide. Reports revert
to all 27 branches — wrong but visible, which beats zero that looks like an
outage. Use it if the filter is ever wrong again.

`ga4Items` is exempt: item-scoped metrics cannot be combined with a
session-scoped landing-page filter, so that one report stays group-wide.

**Two mock failures let this reach production, both now fixed:**

1. The stub matched `FULL_REGEXP` with a bare `RegExp.test()`, which is a
   PARTIAL match — **more permissive than the real API**, so it certified code
   that could not work. It now anchors `^(?:...)$` for FULL_REGEXP and treats
   PARTIAL_REGEXP separately.
2. More important: the stub only applied a filter to dimensions the report
   GROUPS BY. The branch filter targets the landing page while the funnel groups
   by date × channel, so it was never evaluated at all. Real GA4 applies it to
   the underlying sessions — no matching landing page means an empty report. The
   stub now emulates that, and **reproduces the outage**: reverting to
   FULL_REGEXP gives visits 0 in tests, the fix gives 400.

The rule from §10 class 4, restated harder: a stub must not only be able to
fail, it must fail **the same way the real service does**. Being more lenient is
worse than being absent.

**v3.63.0 — THE BRANCH FILTER. Read this before trusting any historical figure.**

GA4 property **484633959 is the BDMS *group* property: 27 branches.** The War
Room watches four — BGH `/bangkok/`, BIH `/bangkok-bone-brain/`,
BHT `/bangkok-heart/`, WSH `/bangkok-cancer/`. Windsor cannot filter (§3), so
**every GA4 number this dashboard produced before v3.63.0 was the 27-branch
group total**, not the four hospitals it claimed to report. Expect every figure
to drop sharply. That is the fix working, not a regression.

All GA4 now goes through the **Data API**; the Windsor `googleanalytics4`
connector is unused. A shim, `ga4Compat(windsorDims, windsorMetrics, from, to)`,
takes Windsor field names and returns Windsor-shaped rows, so the dozens of
consumers reading `r.sessions` did not have to change. Ten pulls migrated.

Attribution is by **landing page**: a session is credited to the branch it
arrived on, matching the Pages tab. A visit landing on `/bangkok/` that later
reads a heart article counts as BGH. The regex is
`^/([a-z]{2}/)?(seg|seg|...)/` — locale optional — overridable via
`BRANCH_SEGMENTS`.

**Two traps found while building this, both of which produce silent wrong
numbers rather than errors:**

1. `ga4KeyEvents` called `ga4RunReport` directly and bypassed the filter, so
   session metrics covered 4 branches and key events covered 27. The merge
   *hides* this — unmatched keys are never looked up, so nothing errors and
   every rate inflates. **Any new `ga4RunReport` call must go through
   `withBranch()`** unless it is `/api/page`, which is deliberately unfiltered
   because the user pastes arbitrary URLs.
2. Declaration order. `GA4_LANDING_DIM`, `ga4Date` and `GA4_DIM_MAP` were
   defined near `buildPage` but are now consumed at module top level by
   `GA4_DIM_MAP_FULL`. A `const` spread evaluates immediately, so this throws
   on boot in the temporal dead zone — and `node -c` does **not** catch it.
   `test/boot.js` does.

Also fixed: the funnel double-counted key events (2.0M against a true 410K)
because it added `ke.byKey` once per Windsor row and Windsor could return
several rows per `(date, channel)`. Data API rows are unique per combination,
so the bug is gone by construction. Verified against GA4 directly — view_item
187,506, contact_us 131,758, find_doctors 55,467, appointments 32,911, exact.

The key-events caption under the funnel is now generated from `KEY_EVENTS`; it
was a hardcoded list of seven and had already gone stale at nine.

`test/mock-fetch.js` honours `FULL_REGEXP` and carries two out-of-scope branch
pages plus an **`OutOfScope` marker** emitted whenever a report arrives without
a branch filter. Grep any endpoint's output for it: a hit means that endpoint is
querying all 27 branches.

**v3.62.0** — key events moved off Windsor's flattened columns onto the GA4
Data API, and **`better_ai_start`** + **`better_ai_result`** added.

Adding them to `KEY_EVENT_FIELDS` was impossible: GA4 caps a request at 10
metrics and five pulls were already at 9, so `ga4Fields()` would have thrown on
Overview, Campaign, three Benchmark windows and the Benchmark monthly roll-up.
Key events are now fetched as ROWS (`eventName` × `keyEvents`) via a shared
`ga4KeyEvents(dims, from, to)` helper and merged back onto each Windsor pull by
`ga4JoinKey()`. There is no longer a ceiling — a tenth key event costs nothing.

Nine Windsor pulls lost their `conversions_*` columns (Overview funnel, Campaign
main/rev/daily, Benchmarks m3/m6/m12/monthly, Tagging audit, Monthly report),
each gaining a paired Data API job. `KEY_EVENT_FIELDS` and `sumKeyEvents()` are
gone; `KEY_EVENTS` (name + label) is the single definition.

**The join is the fragile part.** GA4 writes dates as `YYYYMMDD` and untagged
values as `(not set)`; Windsor writes `YYYY-MM-DD` and empty strings. If the two
sides normalise differently the merge yields **zero, not an error** — every key
event in the dashboard silently becomes 0 while the page renders fine.
`ga4JoinKey()` is the only place that normalisation lives; keep it that way.

Overview's breakdown is now filtered to the groupings the funnel counted, so it
sums to `totals.keyEvents`. Unfiltered it reported every key event in the
property — 108 against a headline of 27 in the fixture.

**LINE:** connector left in place but off. `LINE_ENABLED` already defaulted to
off, so check the Cloud Run env for `LINE_ENABLED=1`. The UI no longer renders a
permanent "unavailable" LINE row, and copy that named LINE as a source has been
updated. Re-enabling is one env var.

**v3.61.2** — tooltip affordance changed from `cursor:help` to `cursor:pointer`
across all 10 sites. The question-mark cursor is technically the correct
semantic for a hint, but users read the hand as "this does something" and were
not discovering the tooltips at all.

**v3.61.1** — every percentage change now goes through one `changeText()`
helper, which caps at **`>10×`** above +1000% and floors at `−100%`.

The Pages tab was rendering `+42867%` (3 sessions → 1,289) as its largest
figure. Above tenfold a percentage stops informing and starts reading as either
a spectacular result or a broken dashboard; `>10×` says the same thing without
pretending to five significant figures. The real baseline stays in each
caller's tooltip, so nothing is hidden.

I had claimed `delta()` was a single choke point. **It was not** — there were
**four** independent renderers: `delta()`, `arrow()` in Monthly Report, the
year-bar caption, and `mom()` in Channels. Each formatted its own percentage
and only `delta()` was ever looked at. All four now share the formatter and
keep their own colour and markup.

`pct()` is deliberately NOT routed through it: that renders rates and shares,
which legitimately run 0–100% and must never be capped.

New audit rule **`change:capped`** fails the build if a fifth raw renderer
appears. It exempts `changeText()` and `pct()` by name, and was verified by
inserting a violation and confirming the rule catches it — the same "a check
must be able to fail" discipline as §10 class 4. Note the exemption is anchored
to `const pct = (v) =>`; a looser pattern matches an unrelated local `pct` at
line 1233 and silently exempts the wrong thing.

**v3.61.0** — the ROAS tab is now **Ad Performance**, pivoted onto the ad
campaigns instead of a revenue ratio. `445.8×` was the largest figure on the
screen and meant nothing: the denominator was ฿11.3K from one campaign live
**7 days**, the numerator ฿5.0M of *all* Shopee revenue over **31 days**,
whether ads touched it or not. Different windows, different campaigns, no
causal link. The card said "treat as a scale check", but nobody reads a caveat
under a number rendered that large — the real risk was it reaching a management
deck as "Meta returned 445×".

Hero stats are now spend, impressions, link clicks and CPC, at both total and
account level; per-account also shows CPM. All of those describe only what the
ads did. Storefront revenue moved out of the stat cards into the note as prose,
which states plainly that it is not attributable to these ads and says why —
every marketplace order carries the same campaign name (§11), so an ad-driven
order cannot be told from an organic one.

**The tab id stays `ecomroas`.** Only labels changed. `requireTab("ecomroas")`
gates the endpoint and per-user permissions are stored against that key, so
renaming it would silently revoke access for everyone who has it.

Same class of error as the `+42867%` MoM on Pages, seen the same day: **a ratio
rendered as a headline without a guard on whether the denominator can carry
one.** Worth checking for wherever a rate is displayed large.

**v3.60.2** — small `AI` badge on the Topic Explorer nav item, so it is visible
at a glance which tab's output is generated rather than read from a connector.
Topic Explorer is the **only** one: Claude expands the topic into search terms
across ten languages and clusters the results, while the figures themselves
come from Search Console (§1 — the LLM is never on the data-refresh path).
The tooltip says exactly that, because "AI" alone invites the reading that the
numbers are invented.

Styled from the existing `.pill` tokens rather than a new treatment. An earlier
draft used CSS `color-mix`, which appears nowhere else in the file; dropped it,
since a novel CSS feature is not worth a badge (cf. the Chart.js CDN lesson
in §8).

**v3.60.1** — `/api/campaign`'s `ga4Landing` report moved to the GA4 Data API
(§4a). It was pulling `campaign × landing_page` across the whole property —
all 44,463 pages — filtering client-side, and displaying **the top eight**.
Same shape as the v3.60.0 bug and equally invisible, since the eight rows were
always correct; it never OOM-killed anything only because it asks for one
metric rather than nine. Now filtered server-side with `BEGINS_WITH` on
`sessionManualCampaignName`, `caseSensitive: false` to match the prefix
convention in §7, with the existing `norm().startsWith()` guard kept behind it.
Landing pages are normalised through `pagePath()` so query strings collapse and
locale detection reads a clean path.

The rest of `/api/campaign` stays on Windsor: those reports key on campaign
name without `landing_page`, so they are bounded by campaign count.

`test/mock-fetch.js`'s GA4 stub is now **per-field** — it was applying any
`BEGINS_WITH` to the landing page regardless of which field the filter named,
which would have passed this change while testing nothing.

**v3.60.0** — `/api/page` moved off Windsor onto the **GA4 Data API**, because
Windsor's `filters` parameter does nothing on the googleanalytics4 connector
(§3, proven with byte-identical responses including a filter on a nonexistent
field). v3.59's "server-side filtering" never worked; the tab pulled the entire
property — 482,355 rows for one month — five times concurrently and OOM-killed
the container, surfacing as the 503 in §11. It was invisible because
`buildPage` filtered client-side, so **the numbers were always correct**; only
the volume was absurd.

Ten small filtered reports now replace five property-wide pulls. Sessions and
key events come from paired reports merged by key, so `login` stays out of the
key-event totals (§4a). Response shape is unchanged — the client was not
touched beyond the build stamp.

`test/mock-fetch.js` now stubs the GA4 Data API and **honours the filter it is
sent**, with a sibling page and a `login` event in the fixture so the narrowing
logic is actually exercised. The old mock returned one row however it was
asked, which is why four green layers missed this entirely (§10, class 4).

Also corrected: the `// a filter miss should never reach here` comment in
`buildRoas` said the opposite of the truth. That guard is load-bearing.

Cloud Run memory raised 512 MiB → 2 GiB; it had regressed below the ≥1 GiB
that §2 has required since the Topic Explorer OOM.

**v3.59.1** — cleared the last two "Signal Room" strings, including the startup
log line so logs identify the right build.

*Process failure worth remembering:* the version bump for this release silently
did not run. The command was `grep -c "Signal Room" server.js && sed -i …`, and
`grep -c` prints `0` but **exits 1** when there are no matches, so `&&`
short-circuited and both `sed` commands were skipped. The shipped zip therefore
held a changed `server.js` beside a `package.json` and `index.html` byte
identical to the previous release. GitHub correctly created no commit for the
unchanged files, which looked like "public/index.html and package.json won't
update". **Never chain a mutation behind `grep -c`.**

A second silent failure compounded it: `CONTEXT.md` was restored from an older
zip after a container reset, so several anchor-based `str.replace` changelog
edits matched nothing and did nothing. Anchor replacements fail silently by
design — append to this section instead.

**v3.59** — Pages tab: GA4 was returning "Data size is too big" on any long
range. Cause was one query crossing landing_page × date × source × medium ×
campaign across the whole property. **Windsor supports server-side GA4 filters**
— `filters: [{field:"landing_page", operation:"contains", value:path}]`,
verified live — so the pull is filtered first and split by dimension. YoY and
MoM added on the back of it.

**v3.58** — renamed to BHQ War Room; new Pages tab under Campaigns; removed the
Registered short links card (the data still matches organic posts, only the list
went).

**v3.57** — Google Ads folded into campaign analysis via the AD_PLATFORMS
registry. The platforms cannot share a field list: Google Ads has no
`campaign_objective` and no `actions_*` metrics, and requesting them fails the
whole call. Google campaigns expand to ad groups.

**v3.56** — LINE disconnected from Windsor and replaced by Google Ads. LINE is
behind `LINE_ENABLED` (default off) rather than deleted; the mock now returns
HTTP 400 for any LINE call so a reintroduced one fails the suite.

**v3.55.1** — "days live" counted rows, not dates. Windsor returns one row per
campaign × ad set × date, so six ad sets over seven days read as 42. Any
per-row counter on this connector is counting that cross-product.

### Earlier

v1 realtime cross-channel · v2 Topic Explorer (AI) · v2.1 Model Armor +
structured logging · v3 SPA, light theme, funnel, e-commerce, campaigns ·
v3.4 custom engagement event (later reverted) · v3.5 source/medium keying ·
v3.7 Google Sheets integration · v3.8 tagging audit + 16:9 PDF ·
v3.9 benchmarks · v3.10 objective awareness · v3.11 Google Business Profile ·
v3.12 goal-aware campaigns · v3.13 user management + hash routing + smoke test ·
v3.14 link clicks vs clicks-all, landing-page-view tagging check ·
v3.17.2 same-day FB post candidates: when the link bridge matches nothing, the campaign view lists posts PUBLISHED on the code date with their impressions/clicks and the bkhos.co link found in each — human recognises theirs, registers the link in UTM Builder col M (never folded into totals) · LINE same-day delivery volume folded into the LINE variant row Impr with a  pill (delivery, not views) ·
v3.17.1 campaign funnel chart draws each bar's value at its end (barValueLabels inline plugin; the earlier inline labels only covered the Overview stacked bars) · organic FB post imp/clicks are folded onto the organic facebook variant row in the campaign detail table (flagged with an 'org' pill) and post clicks now count into the campaign clicks total (funnel stage relabelled 'Clicks') ·
v3.17 funnel bar segments show values inline (>=9% width; slivers stay hover-only) · global Load renamed Refresh and hidden on Campaigns (Analyse is the fetch there) · fbPosts pull window widened to cover campaign code date +45d so posts published outside the viewing range still match (verified: post 98150133139_1459670356208819 carries bkhos.co/J3yTks in post_message and is returned by Windsor — the old miss was the window, not the field) · LINE same-day pull tries plain field names (broadcast, targeting, api_*) before prefixed message__* ids, since Windsor's raw URL API and metadata API disagree on naming ·
v3.16.1 fmtISO was UTC-based (toISOString) so all presets shifted -1 day in Bangkok (UTC+7) — now formats local dates · link bridge also matches the post link attachment (`url` field), not just `post_message` · LINE same-day heuristic: campaign code YYMMDD date → that day's LINE delivery volume shown as "sends on campaign date" (delivery only; opens/clicks stay unknowable) ·
v3.16 rename to "BHQ Signal Room" · LM (last calendar month) date preset is now the default · organic FB post clicks (post_clicks) added to campaign link-bridge — NOTE: Meta deprecated impressions Nov 2025 but Windsor transparently remapped the old field IDs to the new "views"-based metrics, so post_impressions/post_clicks/page_impressions still return live data (verified 2026-08-07); LINE message_delivered/click remain zeros (OA Manager sends carry no request IDs — permanent) ·
v3.15 ACCESS_BUCKET persistence (gcsRead/gcsWrite were hardcoded to
BENCHMARK_BUCKET — fixed) + IAP grant command shown live in the Users tab.
IAP here is **Cloud Run-native** — grants use `gcloud iap web
add-iam-policy-binding --resource-type=cloud-run`, NOT
`gcloud run services add-iam-policy-binding` (that returns "role not
supported for this resource").
