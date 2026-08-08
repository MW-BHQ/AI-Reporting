# CONTEXT — read this before changing anything

Handoff document for BHQ Signal Room (formerly "Cross-Channel Control Room").

Everything below was **verified against the live APIs**, not inferred from
documentation. Several entries exist specifically because the obvious approach
failed; those are marked **DEAD END** and should not be re-attempted without new
information. Re-discovering them costs days.

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

## 10. Testing

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

**Blocking value:**
- `ACCESS_BUCKET` unset → user permissions reset on cold start
- Memory may still be 512 MiB → Topic Explorer can 503 on wide ranges
- Google Ads not connected → an entire channel missing from every cost figure

**Data quality found in their account:**
- `260701-08` — Meta reports ~432 landing page views in 3 days, GA4 records **zero**
  sessions for the code. Confirmed tagging break on ~฿8.3K of spend.
- ~50 campaigns arrive as bare numeric Meta IDs (no utm_campaign at all)
- `__CAMPAIGN_NAME__` placeholder reached production (~75 sessions)
- `260428-02_b _tra` — typo, space instead of a brand code
- A campaign named `…_Engagement_THB 8344.46_NotUse` is still accruing spend
- Dental GBP sits at **4.2** against 4.7–4.9 everywhere else
- E-commerce: ~2.1K item views → 1 add-to-cart → 0 purchases. If those packages
  are meant to sell online, that path looks broken.

**Known inconsistency:**
- Benchmarks CPC still uses `clicks` (all), while Campaigns now uses
  `actions_link_click`. Left deliberately so historical comparisons stay stable —
  decide whether to switch or show both.

---

## 12. Requested but not built

- **Audience-set performance ranking** — which audience works for which campaign
  type. Meta's adset dimension should support it.
- **Short.io** — clicks per short link across LINE, Facebook and EDM; the only
  realistic substitute for LINE engagement data. Needs a connector slot.
- Page-level SEO mapping in Topic Explorer; scheduled weekly digest;
  true keyword discovery beyond own rankings (needs SEMrush or similar).

---

## 13. Version history

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
