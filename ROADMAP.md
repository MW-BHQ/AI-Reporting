# Roadmap — Cross-Channel Control Room

## v.1 — Realtime cross-channel overview  ✅ shipped

Deterministic dashboard. Cloud Run service pulls live from Windsor.ai REST across
Meta Ads, FB + TikTok organic, Google My Business, Search Console and LINE, in
parallel, and aggregates server-side. No BigQuery, no cache, no LLM in the refresh
path. Team access via Google sign-in. Windsor key in Secret Manager.

Endpoints: `GET /api/sync?from=&to=`

## v.2 — Topic Explorer (multilingual semantic search)  ✅ shipped

Adds an AI layer for the questions Search Console can't answer on its own:
"show me everything we rank for on the topic *gallbladder*, across every language
and country that searches for it."

Two Anthropic calls bookend a deterministic Windsor pull, so the AI does only the
semantic reasoning — never the data plumbing, never on the hot refresh path:

1. **Expand** — Claude turns a topic ("gallbladder") into ranking-relevant terms
   across TH / ZH / JA / AR / MY / KM / EN: medical + lay synonyms, related
   procedures and conditions, common misspellings.
2. **Pull** — Windsor Search Console returns real query-level clicks, impressions,
   position and country (no AI). The server matches those queries against the
   expanded term set.
3. **Cluster** — Claude groups the matched queries into labelled sub-topics and
   flags expanded terms that returned no ranking data (content opportunities).

Endpoints: `POST /api/topic` with `{ topic, from, to }`
Requires: `ANTHROPIC_API_KEY` (Secret Manager), in addition to `WINDSOR_API_KEY`.

## v.2.1 — GCP-native hardening  ✅ shipped

Layered onto v.2 without changing its architecture, using only the GCP services
that genuinely fit a lean single-service deployment:

- **Model Armor** screens the user-typed topic for prompt injection before it
  reaches Claude. Optional (env-gated on `MODEL_ARMOR_LOCATION` +
  `MODEL_ARMOR_TEMPLATE`); fails open on a Model Armor outage so it can't take the
  feature down. Runtime SA needs `roles/modelarmor.user`.
- **Structured logging + trace correlation** — every request emits a JSON log line
  that Cloud Logging / Trace / Monitoring pick up automatically. No app config.

Deliberately **not** adopted: Vertex AI Agent Platform / Agent Registry (v.2 is
deterministic by design, not an agent), App Hub, App Topology, Compute Engine,
Dataform (BigQuery, which we removed), Notebooks, Security Command Center. These
are reviewed in DEPLOY.md so future maintainers know it was a choice, not an
oversight.

### Honest limits of v.2
- Search Console only reports queries that cleared Google's impression threshold,
  so a term showing "no ranking data" means *not captured*, not *definitely not
  ranking*. The UI says so.
- Term expansion is model-generated; review it for a clinical topic before trusting
  the gap list as a content brief.
- Clustering runs on the top matched queries by impressions (capped) to keep the
  AI call fast and cheap.

## v.3 — candidate ideas (not built)

- **True topic discovery beyond your own rankings.** v.2 finds what you *already*
  rank for. To surface terms you're missing entirely, add a keyword-tool source
  (Windsor connects SEMrush, Search Metrics, Serpstat, Dragon Metrics) and diff
  its universe against your Search Console queries.
- **Page-level mapping.** Join matched queries to the URLs that rank for them
  (`page` field) so each sub-topic points at the content that owns it — or the gap
  where no page does.
- **Scheduled briefs.** A Cloud Scheduler job that runs a fixed set of clinical
  topics weekly and writes a digest, instead of on-demand only.
- **Cross-channel topic view.** Extend a topic from Search Console into Meta Ads
  interest overlap, closing the loop with the audience-targeting work.
- **Cross-channel topic view** — extend a topic into Meta Ads interest overlap.
  topic+language so repeat lookups skip the first AI call.

## Model configuration

The Anthropic model is set via the `ANTHROPIC_MODEL` env var (default
`claude-sonnet-4-6`). Point it at whichever model your API access allows.

If you ever want Claude routed through GCP governance (unified billing, IAM,
native Model Armor) instead of the Anthropic API directly, Claude models are also
available on Vertex AI. That's a drop-in change to the `anthropic()` helper's
endpoint + auth — worth it only if central GCP governance becomes a requirement;
the direct API is simpler otherwise.

## v.3 — Funnel, e-commerce, campaigns, light UI  ✅ shipped

Single-page app (left rail, light glass theme, self-hosted Poppins + Sarabun).
Tab switches are client-side, so they never refetch — the original complaint.

**Caching.** Server-side in-memory TTL cache (default 600s) keyed by
endpoint+params; `refresh=1` / the Load button bypasses it. Plus SPA state so
moving between tabs is instant. No Redis/Firestore — per-instance only, which
means a cold start empties it; set `--min-instances=1` to keep it warm.

**GA4 is the funnel spine** (Group property 484633959). Visits = sessions by
`session_default_channel_group`; Key Events = 7 configured conversions
(add_to_cart, appointments, contact_us, find_doctors, view_cart, view_item,
purchase). Impressions come from Meta / Search Console / organic social mapped
onto matching channel groups — units differ, and the UI says so. GMB and LINE
reach sit outside the funnel since they don't produce attributable sessions.

**E-commerce cards**: product views, add to cart, purchases, revenue, plus a
month-end run-rate forecast and a top-products table. GA4 web only — Shopee and
Lazada are not included.

**Campaign tab**: case-insensitive *prefix* matching on
`session_manual_campaign_name`, so `260501`, `260501-11` and `260501-11_bgh` all
work and every variant becomes a row under one rolled-up funnel. Meta Ads
campaign names are matched on the same prefix to supply the Impressions stage.
A "Browse codes" view lists what ran in range and flags bare numeric platform
IDs as untagged.

**Language attribution rewritten**: read from the page URL locale
(`/th/ /en/ /zh/ /ja/ /ar/ /de/ /my/ /vn/ /km/ /id/`), because EN/DE/VN/ID share
Latin script and cannot be separated by characters. Script detection is now only
a fallback, and the UI distinguishes the two with pill colour.

**Null is not zero.** Any source that fails returns null and renders as "—" with
an explicit "unavailable this run" banner. This was a real trust bug: a
rate-limited LINE call was being displayed as a confident 0.

### Known limits of v.3
- Windsor rate-limits; the cache reduces exposure but a burst of refreshes can
  still trip it. Failures degrade per-source rather than failing the page.
- The month-end forecast is a naive run-rate and will mislead around campaign
  bursts, paydays or seasonality.
- Impression totals mix platform units by design (accepted trade for a single
  stacked view).
