# CONTEXT — read this before changing anything

Handoff document for **BHQ War Room** (formerly "BHQ Signal Room", originally
"Cross-Channel Control Room").

Everything below was **verified against the live APIs**, not inferred from
documentation. Several entries exist specifically because the obvious approach
failed; those are marked **DEAD END** and should not be re-attempted without new
information. Re-discovering them costs days.

---

## 0. Current state — read before anything else

**Version 3.59.1.** Sections 1–9 below were written around v3.17 and remain
accurate on the APIs, but the product has roughly doubled since. What changed:

**Tabs now (14).** Overview · Google Profile · Campaigns · **Pages** ·
Meta Ads (Benchmarks, Audiences, Tagging audit) · **Google Ads (Overview)** ·
**E-commerce (Overview, Monthly report, Centers, Channels, ROAS, Churn,
Migration)** · Topic Explorer · Users.

**Connectors changed.** LINE was disconnected from Windsor in Aug 2026 and
replaced by **Google Ads**. LINE code is behind `LINE_ENABLED` (default off),
not deleted — see §6.

**A second data source exists.** E-commerce reads a Google Sheet of normalised
coupon orders, not Windsor — see §6a. ~85,500 rows, Jan 2024 to Jul 2026.

**Testing is now four layers** and all four run on `npm test` — see §10. The
boot test exists because a broken template literal passes every text-level
check while breaking the whole app.

**Three silent-failure classes have each bitten more than once.** Read §10
before making edits: a find-and-replace that matches nothing, a partial deploy,
and a per-row counter on a connector that returns one row per
campaign × ad set × date.

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

- **Audience-set performance ranking** — which audience works for which campaign
  type. Meta's adset dimension should support it.
- **Short.io** — clicks per short link across LINE, Facebook and EDM; the only
  realistic substitute for LINE engagement data. Needs a connector slot.
- Page-level SEO mapping in Topic Explorer; scheduled weekly digest;
  true keyword discovery beyond own rankings (needs SEMrush or similar).

---

## 13. Version history

### Recent (August 2026)

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
