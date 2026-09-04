/**
 * BHQ War Room (Cross-Channel Marketing Intelligence) — v3
 *
 * Single Cloud Run service. Serves the SPA and exposes:
 *   GET  /api/overview?from&to[&refresh=1]   funnel + channels + ecommerce + forecast
 *   GET  /api/campaigns?from&to              distinct utm_campaign values (browse/autocomplete)
 *   GET  /api/campaign?code&from&to          funnel for one campaign code + its variants
 *   POST /api/topic  {topic,from,to}         multilingual SEO topic explorer (AI)
 *   GET  /api/version                        build/version marker
 *
 * Principles carried from v1/v2:
 *  - Windsor REST is called directly; no LLM on the data-refresh path.
 *  - A source that FAILS returns null, never 0. The UI shows "unavailable"
 *    rather than a confident zero. (A rate-limited LINE call reading as a real
 *    0 is what motivated this.)
 *  - Secrets come from env (Secret Manager in Cloud Run), never the browser.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json({ limit: "256kb" }));

/**
 * `refresh=1` must reach the wire, not stop at the upstream memo.
 *
 * Done here rather than at each endpoint so a route added later cannot forget:
 * a Refresh button that quietly returns memoised data is worse than no button,
 * because the person believes they have fresh numbers.
 */
app.use((req, res, next) => {
  if (req.query && req.query.refresh === "1") bustUpstream();
  next();
});

const PORT = process.env.PORT || 8080;
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const WINDSOR_BASE = "https://connectors.windsor.ai";

// GA4: Bangkok Hospital (Group) property.
const GA4_ACCOUNT = process.env.GA4_ACCOUNT || "484633959";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";

const MA_LOCATION = process.env.MODEL_ARMOR_LOCATION;
const MA_TEMPLATE = process.env.MODEL_ARMOR_TEMPLATE;
const MA_ENABLED = Boolean(MA_LOCATION && MA_TEMPLATE);

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

/**
 * The Engagement funnel stage uses GA4's `engaged_sessions`: sessions over 10
 * seconds, or with 2+ screen views, or containing a key event.
 *
 * An earlier build counted a custom "engagement" EVENT instead. That was
 * abandoned deliberately: an event count is unbounded, so it exceeded the visit
 * count above it and read like a broken funnel. engaged_sessions is a subset of
 * sessions, so the stage always narrows as a funnel should. (GA4 exposes no
 * "engaged users" metric — only engaged sessions and active users — so the
 * label says sessions.)
 */

let VERSION = "unknown";
try { VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; } catch (_) {}

if (!WINDSOR_API_KEY) console.warn("[warn] WINDSOR_API_KEY not set — data endpoints will fail.");
if (!ANTHROPIC_API_KEY) console.warn("[warn] ANTHROPIC_API_KEY not set — /api/topic will fail.");
console.log(`[init] v${VERSION} | GA4=${GA4_ACCOUNT} | cache=${CACHE_TTL_MS / 1000}s | ModelArmor=${MA_ENABLED ? "on" : "off"}`);

// ------------------------------------------------------- Google Sheets layer
/**
 * Two internal sheets provide context Windsor can't:
 *   UTM Builder 2026  - column L utm_campaign, column M short link
 *   Content Plan 2026 - column C topic (the human campaign name)
 * Both have one tab per month.
 *
 * Read with the Cloud Run runtime service account via ADC; the sheets are
 * shared read-only with that identity, so nothing is published and no key file
 * exists. If the scope is refused the error is surfaced verbatim by
 * /api/sheets-check rather than being swallowed into an empty result.
 */
const SHEET_UTM = process.env.SHEET_UTM_ID || "13QuzSmYP-XA1kFX9_voVFB492x6327RGJIu4kvrTGwE";
const SHEET_PLAN = process.env.SHEET_PLAN_ID || "1ClBR81GbG-QSKuj4f24-8M_4Gjmoz3i2gPZfd1mpjok";
const MONTH_TABS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEET_CACHE_TTL_MS = Number(process.env.SHEET_CACHE_TTL_MS || 30 * 60 * 1000);

let _sheetsAuth = null;
async function sheetsToken() {
  if (!_sheetsAuth) _sheetsAuth = new GoogleAuth({ scopes: [SHEETS_SCOPE] });
  const client = await _sheetsAuth.getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : t && t.token;
  if (!token) throw new Error("Could not obtain an access token for the Sheets API");
  return token;
}

/** batchGet several ranges in one request. Missing tabs are skipped, not fatal. */
/**
 * `opts.unformatted` asks the API for RAW cell values instead of display text.
 *
 * WHY IT MATTERS: the values endpoint returns FORMATTED_VALUE by default, so a
 * cell holding 2923 arrives as the STRING "2,923" once the sheet has a thousands
 * separator on it. `Number("2,923")` is NaN, which the global `n()` floors to 0 —
 * so every figure at or above a thousand silently became zero while everything
 * below it stayed correct. Better Club shipped that way: 514 new members and 48
 * returning were right, 2,923 paying members and ฿102.5M were both 0.
 *
 * Left OPT-IN rather than made the default: the existing callers parse display
 * strings on purpose (Thai dates, Buddhist-era years, `รวม` total rows), and
 * flipping them to raw values would turn their date columns into serials.
 */
async function sheetBatchGet(spreadsheetId, ranges, opts = {}) {
  const token = await sheetsToken();
  const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const render = opts.unformatted ? "&valueRenderOption=UNFORMATTED_VALUE" : "";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${qs}&majorDimension=ROWS${render}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.valueRanges || [];
}

// --------------------------------------------------- GA4 Data API (direct)

/**
 * A SECOND path to GA4 that bypasses Windsor, used only by the Pages tab.
 *
 * Windsor accepts a `filters` parameter on the googleanalytics4 connector,
 * returns HTTP 200, and then ignores it completely. Verified 21 Aug 2026: the
 * same one-day request with no filter, a valid `landing_page` filter, and a
 * filter on a field that does not exist all returned byte-identical responses
 * (1,799,637 bytes, 16,887 rows, 11,072 distinct landing pages). v3.59 was
 * built on the belief that server-side filtering worked; it never did.
 *
 * The consequence was invisible because buildPage filtered client-side, so the
 * numbers were always right — the endpoint was merely pulling the entire
 * property (482,355 rows for one month) five times concurrently and running the
 * container out of memory. That surfaced as a bare Cloud Run 503.
 *
 * The Data API applies dimensionFilter server-side for real, which turns those
 * five property-wide pulls into a handful of rows. Everything else in this
 * service still goes through Windsor; this is a deliberate, narrow exception.
 */
const GA4_DATA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GA4_API_BASE = process.env.GA4_API_BASE || "https://analyticsdata.googleapis.com/v1beta";

let _ga4Auth = null;
async function ga4Token() {
  if (!_ga4Auth) _ga4Auth = new GoogleAuth({ scopes: [GA4_DATA_SCOPE] });
  const client = await _ga4Auth.getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : t && t.token;
  if (!token) throw new Error("Could not obtain an access token for the GA4 Data API");
  return token;
}

/**
 * runReport, returning rows as flat objects keyed by the names asked for, so
 * callers read `row.sessions` exactly as they did with Windsor.
 *
 * The Data API caps a response at 100,000 rows and defaults to 10,000, so the
 * limit is explicit and a truncated response is reported rather than silently
 * short. With a landing-page filter applied this should never come close.
 */
const GA4_METRIC_LIMIT = 10;
const GA4_DIMENSION_LIMIT = 9;

/**
 * CONCURRENCY GATE.
 *
 * The GA4 Data API caps concurrent requests per property. buildReport fans out
 * roughly thirty reports at once (four brands x several windows, plus the
 * language and country pulls), so the excess were being rejected — and because
 * runJobs turns a rejection into null, the failures surfaced as "no data" on
 * whichever slides happened to lose the race. Different brands went blank on
 * different runs, which is what made it look like a per-brand bug.
 *
 * Requests now queue behind a fixed number of slots. Slower by a little,
 * deterministic instead of arbitrary.
 */
/**
 * UPSTREAM MEMO — one line of defence below every endpoint cache.
 *
 * Endpoint caches are keyed by endpoint. This is keyed by the REQUEST itself,
 * so an identical upstream call is never made twice within the window no
 * matter which endpoint asked. Two things it buys:
 *
 *  1. Cross-endpoint reuse — Overview and Monthly Reports pull overlapping GA4
 *     reports; the second one to run gets them free.
 *  2. In-flight de-duplication — the PROMISE is cached, not the result, so two
 *     identical calls fired in the same tick share one round trip instead of
 *     racing. With ~35 parallel jobs that happens more than you would think.
 *
 * Failures are evicted rather than cached: a transient 500 must not stick.
 * `refresh=1` bumps the generation, which invalidates everything at once.
 */
const UPSTREAM_TTL_MS = Number(process.env.UPSTREAM_TTL_MS || 5 * 60 * 1000);
const UPSTREAM_MAX = 500;
const _upstream = new Map();
let _upstreamGen = 0;
function bustUpstream() { _upstreamGen++; _upstream.clear(); }
function memoUpstream(key, fn) {
  const k = `${_upstreamGen}|${key}`;
  const hit = _upstream.get(k);
  if (hit && Date.now() - hit.at < UPSTREAM_TTL_MS) return hit.p;
  const p = fn();
  _upstream.set(k, { at: Date.now(), p });
  p.catch(() => _upstream.delete(k));
  if (_upstream.size > UPSTREAM_MAX) {
    // Oldest first; these are all cheap to refetch.
    const oldest = [...(_upstream.entries())].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _upstream.delete(oldest[0]);
  }
  return p;
}

// 8 of GA4's 10 concurrent slots, leaving room for another endpoint to run
// alongside without either being rejected.
const GA4_MAX_CONCURRENT = Number(process.env.GA4_MAX_CONCURRENT || 8);
let _ga4Active = 0;
const _ga4Queue = [];
function ga4Slot() {
  if (_ga4Active < GA4_MAX_CONCURRENT) { _ga4Active++; return Promise.resolve(); }
  return new Promise((resolve) => _ga4Queue.push(resolve));
}
function ga4Release() {
  const next = _ga4Queue.shift();
  if (next) next();          // hand the slot straight on
  else _ga4Active--;
}

function ga4RunReport(opts) {
  const { dimensions, metrics, from, to, dimensionFilter, limit = 100000, orderBy } = opts;
  /**
   * `orderBy` is part of the memo key. Left out, two requests differing only in
   * sort order would share one cached promise and the second would silently get
   * the first one's ordering.
   */
  return memoUpstream(
    `ga4|${from}|${to}|${limit}|${dimensions.join(",")}|${metrics.join(",")}|${JSON.stringify(dimensionFilter || null)}|${orderBy || ""}`,
    () => ga4RunReportGated({ dimensions, metrics, from, to, dimensionFilter, limit, orderBy }));
}

async function ga4RunReportGated({ dimensions, metrics, from, to, dimensionFilter, limit, orderBy }) {
  /**
   * The Data API caps a request at 10 metrics and 9 dimensions, exactly as
   * Windsor did. This guard used to live in ga4Fields(), which every Windsor
   * GA4 pull was built through; once those pulls moved here ga4Fields became
   * dead code and the guard protected nothing. Failing loudly at build time
   * beats an opaque HTTP 400.
   */
  if (metrics.length > GA4_METRIC_LIMIT) {
    throw new Error(`GA4 request asks for ${metrics.length} metrics; the API allows ${GA4_METRIC_LIMIT}. Split it, or fetch as rows (see KEY_EVENTS).`);
  }
  if (dimensions.length > GA4_DIMENSION_LIMIT) {
    throw new Error(`GA4 request asks for ${dimensions.length} dimensions; the API allows ${GA4_DIMENSION_LIMIT}.`);
  }
  await ga4Slot();
  try {
    return await ga4RunReportInner({ dimensions, metrics, from, to, dimensionFilter, limit, orderBy });
  } finally {
    ga4Release();
  }
}

async function ga4RunReportInner({ dimensions, metrics, from, to, dimensionFilter, limit, orderBy }) {
  const token = await ga4Token();
  const body = {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit,
    returnPropertyQuota: false,
  };
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  /**
   * Sort server-side on a metric, descending. This is what makes a row limit
   * safe on a high-cardinality page report: truncation then drops the tail
   * rather than an arbitrary slice, the same reasoning as the GSC query pull.
   */
  if (orderBy) body.orderBys = [{ metric: { metricName: orderBy }, desc: true }];

  const res = await fetch(`${GA4_API_BASE}/properties/${GA4_ACCOUNT}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`GA4 Data API ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status === 403 ? 403 : 502;
    throw err;
  }
  const json = await res.json();
  const dimHeaders = (json.dimensionHeaders || []).map((h) => h.name);
  const metHeaders = (json.metricHeaders || []).map((h) => h.name);
  const rows = (json.rows || []).map((r) => {
    const o = {};
    dimHeaders.forEach((h, i) => { o[h] = (r.dimensionValues && r.dimensionValues[i] || {}).value ?? null; });
    metHeaders.forEach((h, i) => { o[h] = (r.metricValues && r.metricValues[i] || {}).value ?? null; });
    return o;
  });
  if (rows.length >= limit) {
    logJson("WARNING", "ga4_report_truncated", { limit, dimensions, metrics, from, to });
  }
  return rows;
}

const GA4_LANDING_DIM = process.env.GA4_LANDING_DIM || "landingPagePlusQueryString";

/** GA4 reports dates as YYYYMMDD; the rest of this service speaks YYYY-MM-DD. */
const ga4Date = (v) => {
  const s = String(v || "");
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

/**
 * Windsor dimension name -> GA4 Data API dimension name, for the dimensions a
 * key-event pull is ever grouped by. Anything absent here is a programming
 * error rather than a missing feature, so it throws loudly.
 */
const GA4_DIM_MAP = {
  date: "date",
  session_default_channel_group: "sessionDefaultChannelGroup",
  session_manual_campaign_name: "sessionManualCampaignName",
  session_manual_source: "sessionManualSource",
  session_manual_medium: "sessionManualMedium",
  // Needed by the per-language split, which buckets key events by the locale
  // segment of the landing page. Absent, ga4KeyEvents throws, runJobs turns it
  // into null, and every language reads zero key events with no error shown.
  landing_page: GA4_LANDING_DIM,
  country: "country",
};


/**
 * THE BRANCH FILTER.
 *
 * Property 484633959 is the BDMS group property: 27 branches. The War Room
 * watches four. Windsor could not filter (§3), so every GA4 figure this
 * dashboard has ever shown silently included all 27 — the group total, not the
 * four hospitals it claims to report on.
 *
 * Landing page is the attribution rule: a session is credited to the branch it
 * ARRIVED on, which matches how the Pages tab already works and how campaigns
 * are judged. A session landing on /bangkok/ that later reads a heart article
 * counts as BGH, not BHT.
 *
 * The locale segment is optional in the pattern because not every URL carries
 * one; see §7 for the ten locales.
 */
const BRANCH_FILTER_OFF = String(process.env.BRANCH_SEGMENTS || "").toLowerCase() === "off";
const BRANCH_SEGMENTS = (process.env.BRANCH_SEGMENTS ||
  "bangkok,bangkok-bone-brain,bangkok-heart,bangkok-cancer").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * PARTIAL_REGEXP, not FULL_REGEXP.
 *
 * GA4's FULL_REGEXP requires the pattern to match the ENTIRE dimension value,
 * so this prefix pattern matched nothing and v3.63.0 returned zero rows for
 * every GA4 report — a dead dashboard rather than a visible error. PARTIAL_REGEXP
 * matches anywhere in the value, and the leading ^ still anchors it to the start
 * of the path. Do not "tidy" this back to FULL_REGEXP.
 */
/**
 * The segment may be followed by `/`, `?`, or end-of-string. The `?` case is
 * NOT optional: GA4's landingPagePlusQueryString keeps the query string, so a
 * campaign landing on "/th/bangkok-heart?utm_source=facebook" ends the segment
 * with "?" — under the earlier `(/|$)` pattern every UTM-tagged landing on a
 * section root was silently dropped, which is precisely the traffic campaigns
 * generate. Section roots have no trailing slash ("/th/bangkok"), so `$` is
 * needed too.
 */
const branchRegexFor = (segments) =>
  `^/([a-z]{2}/)?(${(segments && segments.length ? segments : BRANCH_SEGMENTS).join("|")})([/?]|$)`;
const BRANCH_REGEX = branchRegexFor(null);
/** Pass `segments` to narrow to one brand; omit for all four. */
const branchFilter = (segments) => ({
  filter: {
    fieldName: GA4_LANDING_DIM,
    stringFilter: { matchType: "PARTIAL_REGEXP", value: branchRegexFor(segments), caseSensitive: false },
  },
});

/**
 * AND the branch filter onto a caller's own filter, if any.
 *
 * Set BRANCH_SEGMENTS=off to disable group-wide — the escape hatch for when the
 * filter is wrong and the dashboard is dark. Reports then cover all 27 branches,
 * which is wrong but visible, rather than zero, which looks like an outage.
 */
function withBranch(dimensionFilter, segments) {
  if (BRANCH_FILTER_OFF) return dimensionFilter;
  const b = branchFilter(segments);
  if (!dimensionFilter) return b;
  return { andGroup: { expressions: [b, dimensionFilter] } };
}

/**
 * Windsor field names in, Windsor-shaped rows out — but the data comes from the
 * GA4 Data API, branch-filtered. A drop-in replacement for the
 * `windsor("googleanalytics4", ...)` calls, so the
 * dozens of consumers that read `r.sessions` or `r.session_manual_campaign_name`
 * did not all have to be rewritten.
 *
 * Rows are unique per dimension combination, unlike Windsor, which could return
 * several rows for the same key and made a naive per-row merge double-count.
 */
const GA4_METRIC_MAP = {
  sessions: "sessions",
  engaged_sessions: "engagedSessions",
  screen_page_views: "screenPageViews",
  purchase_revenue: "purchaseRevenue",
  ecommerce_purchases: "ecommercePurchases",
  transactions: "transactions",
  items_viewed: "itemsViewed",
  add_to_carts: "addToCarts",
  // itemViewEvents is deliberately absent: it is EVENT-scoped and GA4 rejects
  // it alongside itemName and item-scoped metrics with "The request's
  // dimensions & metrics are incompatible". Use items_viewed instead.
  items_added_to_cart: "itemsAddedToCart",
  items_purchased: "itemsPurchased",
  item_revenue: "itemRevenue",
};
const GA4_DIM_MAP_FULL = { ...GA4_DIM_MAP, item_name: "itemName" };

async function ga4Compat(windsorDims, windsorMetrics, from, to, opts = {}) {
  const dims = windsorDims.map((d) => {
    const g = GA4_DIM_MAP_FULL[d];
    if (!g) throw new Error(`ga4Compat: no Data API mapping for dimension "${d}"`);
    return g;
  });
  const mets = windsorMetrics.map((m) => {
    const g = GA4_METRIC_MAP[m];
    if (!g) throw new Error(`ga4Compat: no Data API mapping for metric "${m}"`);
    return g;
  });
  const rows = await ga4RunReport({
    dimensions: dims, metrics: mets, from, to,
    dimensionFilter: opts.noBranchFilter ? opts.dimensionFilter
      : withBranch(opts.dimensionFilter, opts.segments),
  });
  // Translate back to the Windsor names the consumers expect.
  return rows.map((r) => {
    const o = {};
    windsorDims.forEach((d, i) => {
      const v = r[dims[i]];
      o[d] = d === "date" ? ga4Date(v) : ((v === "(not set)" || v === "(none)") ? "" : v);
    });
    windsorMetrics.forEach((m, i) => { o[m] = r[mets[i]]; });
    return o;
  });
}

// --------------------------------------------------- Search Console API

/**
 * Search Console, direct, so it can be filtered to the four branches.
 *
 * Windsor cannot filter (§3), so the GSC figures covered the whole domain —
 * all 27 branches — while GA4 covered four. That mismatch was created by
 * v3.63.0 and made the funnel compare unlike things: 70.3M impressions and
 * 1.2M clicks against 806.4K visits, the first two group-wide.
 *
 * It also cuts the volume problem. The unfiltered `query x page` pull was
 * 44.8 MB and 260 s against a 300 s Cloud Run timeout; filtered to four
 * branches it is a fraction of that.
 */
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GSC_API_BASE = process.env.GSC_API_BASE || "https://searchconsole.googleapis.com/webmasters/v3";
const GSC_SITE = process.env.GSC_SITE || "sc-domain:bangkokhospital.com";

/**
 * GSC returns `page` as a FULL URL, so the branch pattern must be anchored past
 * the host. Without that anchor "bangkok" matches "bangkokhospital.com" itself
 * and every page on the domain passes — the filter would look applied and do
 * nothing, which is the failure mode this whole exercise keeps producing.
 */
const GSC_BRANCH_REGEX = `^https?://[^/]+/([a-z]{2}/)?(${BRANCH_SEGMENTS.join("|")})([/?]|$)`;

let _gscAuth = null;
async function gscToken() {
  if (!_gscAuth) _gscAuth = new GoogleAuth({ scopes: [GSC_SCOPE] });
  const client = await _gscAuth.getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : t && t.token;
  if (!token) throw new Error("Could not obtain an access token for the Search Console API");
  return token;
}

/**
 * Rows come back keyed by the dimension names asked for plus clicks,
 * impressions, ctr and position, matching the Windsor shape so consumers that
 * read `r.clicks` or `r.page` did not change.
 */
/**
 * `maxPages` walks Search Console's 25,000-row ceiling with startRow. The
 * query x page pull that feeds the per-language search pages exceeds one page
 * comfortably; rows come back sorted by clicks, so a truncated tail costs the
 * long tail rather than the headline, but paging keeps the buckets honest.
 */
function gscQuery(dimensions, from, to, opts = {}) {
  const { rowLimit = 25000, noBranchFilter = false, maxPages = 1, localeRegex = null } = opts;
  // `localeRegex` is part of the memo key: without it, ten locale queries that
  // differ ONLY by their filter would all be served the first one's answer.
  return memoUpstream(`gsc|${from}|${to}|${dimensions.join(",")}|${rowLimit}|${maxPages}|${noBranchFilter}|${localeRegex || ""}`,
    () => gscQueryUncached(dimensions, from, to, { rowLimit, noBranchFilter, maxPages, localeRegex }));
}

/**
 * PER-LOCALE TOTALS, ASKED FOR DIRECTLY INSTEAD OF SUMMED FROM A PAGE LIST.
 *
 * MW compared BGH Thai impressions against Looker Studio: 16.9M there, 7.4M
 * here. The cause was the `["page"]` pull that fed the language buckets —
 * Search Console caps a response at 25,000 rows and `maxPages` was 1, so
 * everything past the first 25,000 URLs was dropped. Rows come back sorted by
 * clicks, so what went missing was the long tail, which on a hospital site is
 * most of the impressions. A short page ends the loop and looks exactly like
 * completion; nothing warned.
 *
 * PAGING IT WOULD HAVE WORKED AND IS STILL THE WRONG ANSWER. Reaching 16.9M for
 * one locale means hundreds of thousands of URLs, so it would be twenty-plus
 * sequential calls and half a million row objects held in memory, to compute
 * ten sums. Search Console will do the summing: one query per locale, filtered
 * by a page regex, with NO dimensions returns a single row of totals. Ten small
 * calls, exact figures, and no row ceiling to truncate against — ever.
 *
 * THE DEFAULT LOCALE'S REGEX MAKES THE PREFIX OPTIONAL, which is the same rule
 * `localeFromPath(url, true)` applies: bangkokhospital.com serves Thai with no
 * prefix, so `/bangkok/...` is Thai and must be counted as Thai. `/en/bangkok/`
 * cannot match it — after the optional `th/` the next segment has to be a
 * branch, and `en` is not one.
 */
async function gscLocaleTotals(from, to) {
  const branches = `(${BRANCH_SEGMENTS.join("|")})`;
  const out = {};
  await Promise.all(Object.keys(LOCALES).map(async (code) => {
    const prefix = code === DEFAULT_LOCALE ? `(${code}/)?` : `${code}/`;
    const rx = `^https?://[^/]+/${prefix}${branches}([/?]|$)`;
    try {
      const rows = await gscQuery([], from, to, { localeRegex: rx, rowLimit: 1 });
      const r = rows[0] || {};
      out[code] = { impressions: n(r.impressions), clicks: n(r.clicks) };
    } catch (e) {
      // One locale failing must not empty the other nine. `null` is not zero:
      // the row is left absent so the consumer can tell "no data" from "none".
      logJson("WARN", "gsc_locale_failed", { code, error: String(e.message || e) });
      out[code] = null;
    }
  }));
  return out;
}

async function gscQueryUncached(dimensions, from, to, { rowLimit, noBranchFilter, maxPages, localeRegex }) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await gscQueryPage(dimensions, from, to, { rowLimit, noBranchFilter, localeRegex, startRow: page * rowLimit });
    out.push(...batch);
    if (batch.length < rowLimit) break;      // last page
  }
  return out;
}

async function gscQueryPage(dimensions, from, to, { rowLimit, noBranchFilter, startRow, localeRegex }) {
  const token = await gscToken();
  const body = {
    startDate: from, endDate: to,
    dimensions,
    rowLimit,
    startRow,
    dataState: "final",
  };
  // A locale regex already restricts to the four branches, so it REPLACES the
  // branch filter rather than stacking with it.
  const rx = localeRegex || ((!noBranchFilter && !BRANCH_FILTER_OFF) ? GSC_BRANCH_REGEX : null);
  if (rx) {
    body.dimensionFilterGroups = [{
      groupType: "and",
      filters: [{ dimension: "page", operator: "includingRegex", expression: rx }],
    }];
  }
  const res = await fetch(`${GSC_API_BASE}/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Search Console API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const rows = (json.rows || []).map((r) => {
    const o = { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
    dimensions.forEach((d, i) => { o[d] = (r.keys || [])[i]; });
    return o;
  });
  return rows;
}

const CODE_RE = /^\d{6}-\d{1,3}/;   // 260605-01...
const looksLikeCode = (v) => CODE_RE.test(String(v || "").trim());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * utm_campaign -> { links, lineRequestIds, months } from UTM Builder.
 * Column L is the campaign code, M the short link. Columns N-P are scanned for
 * anything shaped like a LINE message request ID (a UUID). LINE only reports
 * per-message delivered/opens/clicks when those IDs are supplied, and they can't
 * be discovered from the API — so if the team starts logging them in this sheet,
 * they are picked up automatically with no code change.
 */
async function loadUtmLinks() {
  const ranges = MONTH_TABS.map((m) => `${m}!L:P`);
  const got = await sheetBatchGet(SHEET_UTM, ranges);
  const map = new Map();
  got.forEach((vr, i) => {
    for (const row of vr.values || []) {
      const code = String(row[0] || "").trim();
      const link = String(row[1] || "").trim();
      if (!code || !looksLikeCode(code)) continue;
      if (!map.has(code)) map.set(code, { code, links: [], lineRequestIds: [], months: [] });
      const e = map.get(code);
      if (link && !e.links.includes(link)) e.links.push(link);
      for (let c = 2; c <= 4; c++) {
        const v = String(row[c] || "").trim();
        if (UUID_RE.test(v) && !e.lineRequestIds.includes(v)) e.lineRequestIds.push(v);
      }
      if (!e.months.includes(MONTH_TABS[i])) e.months.push(MONTH_TABS[i]);
    }
  });
  return map;
}

/**
 * campaign code -> human topic, from Content Plan.
 * Layout is A Launch Date, B Campaign Code, C Topic. Column B is used directly,
 * but if it stops holding codes (a column gets inserted) the scan below picks
 * whichever of A:H matches the code pattern most often, so a layout change
 * degrades instead of silently returning nothing.
 */
async function loadCampaignTopics() {
  const ranges = MONTH_TABS.map((m) => `${m}!A:H`);
  const got = await sheetBatchGet(SHEET_PLAN, ranges);
  const hits = new Array(8).fill(0);
  for (const vr of got) for (const row of vr.values || []) {
    for (let c = 0; c < 8; c++) if (looksLikeCode(row[c])) hits[c]++;
  }
  const PLAN_CODE_COL = 1; // column B
  const codeCol = hits[PLAN_CODE_COL] > 0 ? PLAN_CODE_COL : hits.indexOf(Math.max(...hits));
  const map = new Map();
  if (Math.max(...hits) === 0) return { map, codeCol: null, rows: 0 };
  let rows = 0;
  for (const vr of got) for (const row of vr.values || []) {
    const code = String(row[codeCol] || "").trim();
    if (!looksLikeCode(code)) continue;
    const topic = String(row[2] || "").trim(); // column C
    if (!topic) continue;
    if (!map.has(code)) { map.set(code, topic); rows++; }
  }
  return { map, codeCol, rows };
}

/** Both sheets, cached — they change far less often than the metrics. */
let _sheetCache = { at: 0, value: null };
async function loadSheetContext(refresh = false) {
  if (!refresh && _sheetCache.value && Date.now() - _sheetCache.at < SHEET_CACHE_TTL_MS) {
    return _sheetCache.value;
  }
  const [links, topics] = await Promise.allSettled([loadUtmLinks(), loadCampaignTopics()]);
  const value = {
    links: links.status === "fulfilled" ? links.value : new Map(),
    topics: topics.status === "fulfilled" ? topics.value.map : new Map(),
    codeCol: topics.status === "fulfilled" ? topics.value.codeCol : null,
    errors: [
      ...(links.status === "rejected" ? [`UTM Builder: ${links.reason.message}`] : []),
      ...(topics.status === "rejected" ? [`Content Plan: ${topics.reason.message}`] : []),
    ],
  };
  _sheetCache = { at: Date.now(), value };
  return value;
}

/** Longest-prefix topic lookup: exact code first, then the code's stem. */
function topicFor(code, topics) {
  if (!code) return null;
  if (topics.has(code)) return topics.get(code);
  const nc = norm(code);
  let best = null;
  for (const [k, v] of topics.entries()) {
    const nk = norm(k);
    if (nc.startsWith(nk) || nk.startsWith(nc)) {
      if (!best || nk.length > best.len) best = { topic: v, len: nk.length };
    }
  }
  return best ? best.topic : null;
}

// --------------------------------------------------------- access control
/**
 * Per-tab permissions on top of IAP.
 *
 * IAP decides WHO can open the app at all; this decides WHAT they see inside.
 * Removing somebody from IAP remains the real off-switch — this layer is for
 * shaping the view, not for keeping a determined person out.
 *
 * Identity comes from the header IAP injects. That header is only trustworthy
 * because the service refuses unauthenticated traffic, so IAP is the sole way in.
 * If the service is ever set to allow-unauthenticated, this becomes spoofable —
 * DEPLOY.md says so.
 */
/**
 * THE BRAND REGISTRY \u2014 the single place that knows what "BGH" means.
 *
 * Five systems identify a brand five different ways and share no key: GA4 and
 * Search Console by landing path, GBP by listing title, Meta by ad account
 * name, Facebook by page. Each section inventing its own lookup is how they
 * drift apart without anyone noticing, so they all read from here.
 *
 * `shared` assets serve all four brands and belong to none. They are reported
 * in their own block and NEVER added to a brand's totals \u2014 otherwise the four
 * brand views sum to more than the group total. Consequence to keep in mind:
 * brand views deliberately do not sum to All.
 *
 * Mapping confirmed by MW 22 Aug 2026.
 */
/**
 * Two agencies run Meta for BHQ — **ADA** and **EGG** — so most brands have two
 * ad accounts. Listing only the ADA ones (as v3.69.0 did) silently dropped
 * every EGG account's spend, because an unmapped account fell through
 * `continue` and vanished. See UNMAPPED handling below: nothing is dropped
 * quietly any more.
 */
const BRANDS = [
  { key: "BGH", label: "BGH",   segment: "bangkok",
    gbp: ["Bangkok Hospital", "Dental Center | Bangkok Hospital"],
    meta: ["BGH x ADA", "BGH x EGG"] },
  { key: "BIH", label: "BIH",   segment: "bangkok-bone-brain",
    gbp: ["Bangkok International Hospital (Brain x Bone)"],
    meta: ["BIH x ADA", "BIH x EGG"] },
  { key: "BHT", label: "BHT",   segment: "bangkok-heart",
    gbp: ["Bangkok Heart Hospital"],
    meta: ["BHT x ADA", "BHT x EGG"] },
  // WSH DOES have its own accounts (WSH x ADA id 327561266199410, WSH x EGG).
  // Recent months show no spend, which is a spend gap, not an account gap.
  { key: "WSH", label: "WSH",   segment: "bangkok-cancer",
    gbp: ["Bangkok Cancer Hospital Wattanosoth"],
    meta: ["WSH x ADA", "WSH x EGG"] },
];
const BRAND_KEYS = BRANDS.map((b) => b.key);

/** Serve all four; reported separately, never folded into a brand. */
const SHARED_ASSETS = {
  // "BHQ Inter x EGG" is INFERRED from the ADA equivalent and needs confirming;
  // until then it lands in the unmapped bucket, which is visible in the UI.
  meta: ["BHQ x AIQ", "BHQ Inter x ADA"],
  gbp: ["Japanese Medical Services (JMS) \u30d0\u30f3\u30b3\u30af\u75c5\u9662\u65e5\u672c\u4eba\u5c02\u9580\u30af\u30ea\u30cb\u30c3\u30af"],
  facebookPage: true,   // one page for all four
};
/** E-commerce only \u2014 excluded from the general report entirely. */
const ECOM_ONLY_META = ["BHQ Shopee x EGG"];

/**
 * Brand-keyword detection for GBP search terms.
 *
 * A profile's keyword list is dominated by people typing the hospital's own
 * name and address — useful for confirming brand demand, useless for finding
 * competitive ground. These are split so the non-brand list can lead.
 *
 * GLOBAL terms are brand for every hospital. PER-BRAND terms are brand only for
 * the hospital that owns them: "heart hospital" is BHT's own name but a
 * genuinely competitive query for BGH, so it must not be filtered everywhere.
 * Address fragments count as brand — someone typing the soi is navigating to a
 * known destination, not shopping.
 */
const BRAND_KW_GLOBAL = [
  "bangkok hospital", "bangkokhospital", "\u0e42\u0e23\u0e07\u0e1e\u0e22\u0e32\u0e1a\u0e32\u0e25\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e",
  "\u0e23\u0e1e \u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e", "\u0e23.\u0e1e.\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e", "\u0e23\u0e1e.\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e", "bdms",
  // address fragments: navigational, not competitive
  "phetchaburi", "\u0e40\u0e1e\u0e0a\u0e23\u0e1a\u0e38\u0e23\u0e35", "huai khwang", "\u0e2b\u0e49\u0e27\u0e22\u0e02\u0e27\u0e32\u0e07",
  "bang kapi", "\u0e1a\u0e32\u0e07\u0e01\u0e30\u0e1b\u0e34", "soi ", "\u0e0b\u0e2d\u0e22",
];
const BRAND_KW_BY_BRAND = {
  BGH: [],
  BIH: ["bangkok international", "brain x bone", "\u0e2d\u0e34\u0e19\u0e40\u0e15\u0e2d\u0e23\u0e4c\u0e40\u0e19\u0e0a\u0e31\u0e19\u0e41\u0e25"],
  BHT: ["heart hospital", "\u0e42\u0e23\u0e07\u0e1e\u0e22\u0e32\u0e1a\u0e32\u0e25\u0e2b\u0e31\u0e27\u0e43\u0e08"],
  WSH: ["wattanosoth", "\u0e27\u0e31\u0e12\u0e42\u0e19\u0e2a\u0e16", "cancer hospital", "\u0e42\u0e23\u0e07\u0e1e\u0e22\u0e32\u0e1a\u0e32\u0e25\u0e21\u0e30\u0e40\u0e23\u0e47\u0e07"],
};
const isBrandKeyword = (kw, brandKey) => {
  const k = norm(kw);
  const terms = [...BRAND_KW_GLOBAL, ...(BRAND_KW_BY_BRAND[brandKey] || [])];
  return terms.some((t) => k.includes(norm(t)));
};

const brandBySegment = (seg) => BRANDS.find((b) => b.segment === seg) || null;
const brandForMetaAccount = (name) => {
  const n = norm(name);
  if (ECOM_ONLY_META.some((a) => norm(a) === n)) return "ECOM";
  if (SHARED_ASSETS.meta.some((a) => norm(a) === n)) return "SHARED";
  const b = BRANDS.find((x) => x.meta.some((a) => norm(a) === n));
  return b ? b.key : null;
};
const brandForGbpListing = (title) => {
  const t = norm(title);
  if (SHARED_ASSETS.gbp.some((g) => norm(g) === t)) return "SHARED";
  const b = BRANDS.find((x) => x.gbp.some((g) => norm(g) === t));
  return b ? b.key : null;
};

/**
 * Brand from a campaign code. The convention is `YYMMDD-NN_brand_objective`
 * (\u00a77) and Google Ads campaigns follow the same one as Meta, which is what lets
 * Search Ads split per hospital off a single pull rather than needing a Google
 * Ads account registry that does not exist yet.
 *
 * Two deliberate nulls, both of which land in the caller's unattributed bucket
 * rather than being folded into a hospital:
 *   - `bcm` is a real code brand but is not one of the four hospitals.
 *   - Campaigns that ignore the convention entirely (`12th-checkup`,
 *     `rightchoice-google-reserve`) are valid campaigns, not errors.
 * Casing is inconsistent in the wild, so matching is case-insensitive.
 *
 * The trailing guard is `(?![A-Za-z])`, NOT `\b`: the separator after the brand
 * is an underscore, which regex counts as a word character, so `\b` never fires
 * and every coded campaign fell through to unattributed. Caught by reading the
 * payload — the suite was green throughout.
 */
const CODE_BRAND_RE = /^\d{6}-\d{1,3}[_-]([A-Za-z]{3})(?![A-Za-z])/;
const brandFromCampaignCode = (name) => {
  const m = CODE_BRAND_RE.exec(String(name || "").trim());
  if (!m) return null;
  const k = m[1].toUpperCase();
  return BRAND_KEYS.includes(k) ? k : null;
};

const TABS = [
  { id: "overview",  label: "Overview" },
  { id: "report",    label: "Monthly Reports" },
  { id: "campaigns", label: "Campaigns" },
  { id: "pages",     label: "Pages" },
  { id: "gbp",       label: "Google Profile" },
  { id: "benchmark", label: "Benchmarks" },
  { id: "audit",     label: "Tagging audit" },
  { id: "topics",    label: "Topic Explorer" },
  { id: "audiences", label: "Audiences" },
  { id: "gads",      label: "Google Ads" },
  { id: "bclub",     label: "Better Club" },
  { id: "ecom",      label: "E-commerce" },
  { id: "ecomcentre",label: "E-commerce · Centres" },
  { id: "ecompackages", label: "E-commerce · Packages" },
  { id: "ecomchannels", label: "E-commerce · Channels" },
  { id: "ecommigration", label: "E-commerce · Migration" },
  { id: "ecomchurn",  label: "E-commerce · Churn" },
  { id: "ecommonthly", label: "E-commerce · Report" },
  { id: "ecomroas",   label: "E-commerce · Ad Performance" },
  { id: "users",     label: "Users", adminOnly: true },
];
const TAB_IDS = TABS.filter((t) => !t.adminOnly).map((t) => t.id);

const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "mongkhon.oo@bangkokhospital.com")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
// What a newly-admitted user sees before an admin grants anything. Deliberately
// minimal, but not empty — an empty app looks broken rather than restricted.
const DEFAULT_TABS = String(process.env.DEFAULT_TABS || "overview")
  .split(",").map((t) => t.trim()).filter((t) => TAB_IDS.includes(t));
const ACCESS_BUCKET = process.env.ACCESS_BUCKET || process.env.BENCHMARK_BUCKET || "";
const ACCESS_OBJECT = "access/users.json";
const DEV_USER = process.env.DEV_USER || "";

function callerEmail(req) {
  const raw = req.header("X-Goog-Authenticated-User-Email") || "";
  // IAP formats this as "accounts.google.com:someone@example.com".
  const email = raw.includes(":") ? raw.split(":").pop() : raw;
  return (email || DEV_USER || "").trim().toLowerCase();
}
const isAdmin = (email) => ADMIN_EMAILS.includes(String(email || "").toLowerCase());

// In-memory mirror so a GCS outage doesn't take the app down mid-session.
let _access = { at: 0, users: null };

async function readAccess() {
  if (_access.users && Date.now() - _access.at < 60 * 1000) return _access.users;
  let users = [];
  if (ACCESS_BUCKET) {
    try {
      const stored = await gcsRead(ACCESS_OBJECT, ACCESS_BUCKET);
      if (stored && Array.isArray(stored.users)) users = stored.users;
    } catch (e) {
      logJson("WARNING", "access_read_failed", { error: String(e.message || e) });
      if (_access.users) return _access.users;   // keep serving the last good copy
    }
  } else if (_access.users) {
    return _access.users;
  }
  _access = { at: Date.now(), users };
  return users;
}

async function writeAccess(users) {
  _access = { at: Date.now(), users };
  if (!ACCESS_BUCKET) return { persisted: false };
  const ok = await gcsWrite(ACCESS_OBJECT, { users, updatedAt: new Date().toISOString() }, ACCESS_BUCKET);
  return { persisted: Boolean(ok) };
}

async function tabsFor(email) {
  if (!email) return [];
  if (isAdmin(email)) return TABS.map((t) => t.id);
  const users = await readAccess();
  const rec = users.find((u) => String(u.email || "").toLowerCase() === email);
  if (!rec) return DEFAULT_TABS.slice();
  return (rec.tabs || []).filter((t) => TAB_IDS.includes(t));
}

/** Gate a data endpoint on the tab it belongs to. Client-side hiding is cosmetic. */
function requireTab(tabId) {
  return async (req, res, next) => {
    const email = callerEmail(req);
    if (!email) {
      // No identity at all: IAP isn't in front, or this is local dev.
      if (!ACCESS_BUCKET && !process.env.ADMIN_EMAILS) return next();
      return res.status(401).json({ error: "Not signed in" });
    }
    const allowed = await tabsFor(email);
    if (!allowed.includes(tabId)) {
      return res.status(403).json({ error: `You don't have access to ${tabId}. Ask an admin to grant it.` });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  const email = callerEmail(req);
  if (!isAdmin(email)) return res.status(403).json({ error: "Admins only" });
  next();
}

// ---------------------------------------------------------------- utilities

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const num0 = (v) => Number(v || 0).toLocaleString("en-US");
const totals0Spend = (byPlatform) => byPlatform.reduce((a, p) => a + n(p.spend), 0);
const norm = (s) => String(s || "").toLowerCase().trim();
const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function logJson(severity, message, extra = {}) {
  process.stdout.write(JSON.stringify({ severity, message, ...extra }) + "\n");
}

const LOCALES = {
  th: "Thai", en: "English", zh: "Chinese", ja: "Japanese", ar: "Arabic",
  de: "German", my: "Myanmar", vn: "Vietnamese", km: "Khmer", id: "Indonesian",
};

/**
 * Language from a URL locale segment. This is the only reliable method:
 * EN/DE/VN/ID share Latin script and cannot be separated by characters alone.
 */
/**
 * THE SITE'S DEFAULT LANGUAGE, for URLs that carry no locale segment.
 *
 * bangkokhospital.com serves Thai with no prefix — `/bangkok/package/...` is a
 * Thai page, `/th/bangkok/package/...` is the same page reached through the
 * explicit prefix. Both are Thai and both must count as Thai.
 */
const DEFAULT_LOCALE = (process.env.DEFAULT_LOCALE || "th").toLowerCase();

/**
 * The locale a URL belongs to.
 *
 * `orDefault` is the fix for MW's Thai and English shortfall. Returning `null`
 * for an un-prefixed path meant the row was DISCARDED — 23,000 Thai page views
 * and 2,700 English simply left the report (794.0K against Looker Studio's
 * 817,370), while every explicitly prefixed language matched to the digit. That
 * pattern — some languages exact, two of them short — was the whole clue, and it
 * pointed here rather than at any metric.
 *
 * It is a PARAMETER and not the default behaviour on purpose. A page-level
 * caller listing URLs by locale should still be able to say honestly "this URL
 * carries no locale", and a Search Console query has no path at all to fall back
 * from. Only the callers that BUCKET traffic into a language pass it, because
 * for them the alternative to a default is throwing the traffic away.
 */
function localeFromPath(url, orDefault) {
  if (!url) return orDefault ? DEFAULT_LOCALE : null;
  const m = String(url).match(/\/(th|en|zh|ja|ar|de|my|vn|vi|km|id)(?:\/|$|\?|#)/i);
  if (!m) return orDefault ? DEFAULT_LOCALE : null;
  const code = m[1].toLowerCase();
  return code === "vi" ? "vn" : code;
}

/** Script fallback, used only when the URL carries no locale. */
function scriptGuess(q = "") {
  if (/[\u0600-\u06FF]/.test(q)) return "ar";
  if (/[\u3040-\u30FF]/.test(q)) return "ja";
  if (/[\u0E00-\u0E7F]/.test(q)) return "th";
  if (/[\u1000-\u109F]/.test(q)) return "my";
  if (/[\u1780-\u17FF]/.test(q)) return "km";
  if (/[\u4E00-\u9FFF]/.test(q)) return "zh";
  if (/[ăâđêôơư]/i.test(q)) return "vn";
  return null; // Latin script is ambiguous — do not guess "en"
}

// ------------------------------------------------------------ cache (in-mem)
// Per-instance and TTL'd. Cloud Run scales to zero so it empties on cold start;
// accepted trade for zero extra infrastructure. min-instances=1 keeps it warm.

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + (ttlMs || CACHE_TTL_MS), storedAt: Date.now() });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}
async function withCache(key, refresh, producer, ttlMs) {
  if (!refresh) {
    const hit = cacheGet(key);
    if (hit) return { value: hit.value, cached: true, ageSec: Math.round((Date.now() - hit.storedAt) / 1000) };
  }
  const value = await producer();
  cacheSet(key, value, ttlMs);
  return { value, cached: false, ageSec: 0 };
}

// ------------------------------------------------------------------ windsor

function windsor(connector, fields, from, to, opts = {}) {
  const { accounts, filters, options } = opts;
  return memoUpstream(
    `ws|${connector}|${from}|${to}|${fields.join(",")}|${JSON.stringify(accounts || null)}|${JSON.stringify(filters || null)}|${JSON.stringify(options || null)}`,
    () => windsorUncached(connector, fields, from, to, { accounts, filters, options }));
}

async function windsorUncached(connector, fields, from, to, { accounts, filters, options } = {}) {
  const params = new URLSearchParams();
  params.set("api_key", WINDSOR_API_KEY);
  params.set("fields", fields.join(","));
  params.set("date_from", from);
  params.set("date_to", to);
  if (accounts) params.set("accounts", Array.isArray(accounts) ? accounts.join(",") : accounts);
  if (filters) params.set("filters", JSON.stringify(filters));
  // Connector-specific read options, e.g. LINE's message_request_ids.
  if (options) for (const [k, v] of Object.entries(options)) if (v != null && v !== "") params.set(k, String(v));

  const res = await fetch(`${WINDSOR_BASE}/${connector}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${connector} HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  const json = await res.json();
  return Array.isArray(json) ? json : json.data || [];
}

/**
 * LINE was disconnected from Windsor in Aug 2026 and replaced with Google Ads.
 * Every call site already treated a null result as "unavailable", so the
 * connector is simply skipped rather than removed: set LINE_ENABLED=1 if it is
 * ever reconnected and the whole LINE path returns without a code change.
 * Left as a flag rather than deleted because the request-ID join and the
 * same-day broadcast heuristic took real work to get right.
 */
const LINE_ENABLED = process.env.LINE_ENABLED === "1";
const lineWindsor = (...args) => (LINE_ENABLED ? windsor("line", ...args) : Promise.resolve(null));

/** Parallel jobs. A failure yields null (not []) so it reads as "unavailable". */
async function runJobs(jobs) {
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map((k) => jobs[k]));
  const data = {}, errors = {};
  settled.forEach((s, i) => {
    const k = names[i];
    if (s.status === "fulfilled") data[k] = s.value;
    else {
      data[k] = null;
      errors[k] = String((s.reason && s.reason.message) || s.reason);
      /**
       * LOG IT. The reason used to be captured here and shown to nobody: the
       * banner names the failed job ("Unavailable this run: ga4Items") but not
       * why, and nothing reached Cloud Logging. A source could fail on every
       * run for weeks with the cause never recorded anywhere — which is exactly
       * what happened to ga4Items.
       */
      logJson("WARNING", "job_failed", { job: k, error: errors[k].slice(0, 500) });
    }
  });
  return { data, errors };
}

function sumOrNull(rows, field) {
  // undefined as well as null: a mistyped job key used to throw
  // "Cannot read properties of undefined" and 500 the whole endpoint.
  if (rows === null || rows === undefined) return null;
  return rows.reduce((a, r) => a + n(r[field]), 0);
}

// --------------------------------------------------------- GA4 field config

/**
 * Key events, defined by their GA4 EVENT NAME.
 *
 * These used to be Windsor's flattened `conversions_<event>` columns, one
 * metric each. That shape hit a wall at v3.62: GA4 allows 10 metrics per
 * request and several pulls were already at 9, so adding better_ai_start and
 * better_ai_result would have thrown on five call sites. Key events are now
 * fetched from the GA4 Data API as ROWS (`eventName` x `keyEvents`), which has
 * no such ceiling — the tenth and eleventh key event cost nothing.
 *
 * `login` is a key event in GA4 and is deliberately absent: it measures
 * returning-user friction, not marketing outcome, and folding it in would
 * inflate every key-event figure in the dashboard.
 */
const KEY_EVENTS = [
  { name: "add_to_cart",      label: "Add to cart" },
  { name: "appointments",     label: "Appointments" },
  { name: "contact_us",       label: "Contact us" },
  { name: "find_doctors",     label: "Find doctors" },
  { name: "view_cart",        label: "View cart" },
  { name: "view_item",        label: "View item" },
  { name: "purchase",         label: "Purchase" },
  { name: "better_ai_start",  label: "Better AI start" },
  { name: "better_ai_result", label: "Better AI result" },
];
const KEY_EVENT_NAMES = KEY_EVENTS.map((e) => e.name);
const KEY_EVENT_LABELS = Object.fromEntries(KEY_EVENTS.map((e) => [e.name, e.label]));


/**
 * The join key between a Windsor row and a Data API row.
 *
 * Both sides must normalise identically or the merge silently produces zeros:
 * GA4 writes dates as YYYYMMDD and untagged values as "(not set)", Windsor
 * writes YYYY-MM-DD and empty strings. \u0000 separates parts because it cannot
 * occur in a campaign name.
 */
function ga4JoinKey(windsorDims, row, fromGa4) {
  return windsorDims.map((d) => {
    const raw = fromGa4 ? row[GA4_DIM_MAP[d]] : row[d];
    if (d === "date") return fromGa4 ? ga4Date(raw) : String(raw || "");
    const v = String(raw ?? "").trim();
    return (v === "(not set)" || v === "(none)") ? "" : v;
  }).join("\u0000");
}

/**
 * Fetch key events grouped by the given WINDSOR dimension names, so a caller
 * can pair this with its existing Windsor pull and merge on ga4JoinKey().
 *
 * Returns { total, byKey, byName, byKeyEvent, rows } — byKey for per-row
 * merging, byName for unfiltered breakdown tables, byKeyEvent for a single
 * named event at a grouping (e.g. contact_us per campaign), and rows when the
 * caller needs to filter before aggregating. Never throws: a failure yields
 * zeros and is logged, because a missing key-event count must not take down a
 * whole tab.
 */
async function ga4KeyEvents(windsorDims, from, to, segments) {
  const empty = { total: 0, byKey: new Map(), byName: new Map(), byKeyEvent: new Map(), rows: [], failed: false };
  for (const d of windsorDims) {
    if (!GA4_DIM_MAP[d]) throw new Error(`ga4KeyEvents: no Data API mapping for dimension "${d}"`);
  }
  try {
    const raw = await ga4RunReport({
      dimensions: [...windsorDims.map((d) => GA4_DIM_MAP[d]), "eventName"],
      /**
       * `eventCount`, NOT `keyEvents` — MW's GA4 Events screen settled this.
       *
       * TWO REASONS, and the first is a silent zero:
       *   1. `purchase` IS NOT FLAGGED as a key event in the property (its star
       *      is grey while the other eight are filled). `keyEvents` only counts
       *      an event that carries the flag, so the Purchase column and every
       *      total containing it were reading 0 — a real number replaced by a
       *      plausible one.
       *   2. THE KEY-EVENT FLAG IS NOT RETROACTIVE. An event accrues to
       *      `keyEvents` only from the day it was marked, so any event flagged
       *      part-way through a window is undercounted for the earlier days,
       *      by an amount that depends on the configuration date rather than on
       *      anything in the data. `eventCount` has no such dependency.
       *
       * This is what put the War Room below the Looker Studio deck on every
       * action column while VIEWS matched to the digit — views come from a
       * different metric, so they were never affected. MW's own question
       * ("or you have been using a different event than the LS?") was the
       * right one; it was the metric rather than the event names.
       *
       * `eventCount` counts every occurrence, so three taps of Find doctors
       * count three times. That is what LS reports and therefore what the
       * hospital has been reading all along.
       */
      metrics: ["eventCount"],
      from, to,
      // MUST be branch-filtered too. Without this, session metrics cover the
      // four branches and key events cover all 27 — every rate on the dashboard
      // silently inflates, and the merge hides it because unmatched keys are
      // never looked up.
      dimensionFilter: withBranch({ filter: { fieldName: "eventName", inListFilter: { values: KEY_EVENT_NAMES } } }, segments),
    });
    const out = { total: 0, byKey: new Map(), byName: new Map(), byKeyEvent: new Map(), rows: [], failed: false };
    for (const r of raw) {
      const v = n(r.eventCount);
      const k = ga4JoinKey(windsorDims, r, true);
      out.total += v;
      out.byKey.set(k, (out.byKey.get(k) || 0) + v);
      out.byName.set(r.eventName, (out.byName.get(r.eventName) || 0) + v);
      out.byKeyEvent.set(`${k}\u0000${r.eventName}`, (out.byKeyEvent.get(`${k}\u0000${r.eventName}`) || 0) + v);
      out.rows.push({ key: k, eventName: r.eventName, value: v });
    }
    return out;
  } catch (e) {
    logJson("WARNING", "key_events_unavailable", { error: String(e.message || e), dims: windsorDims });
    return { ...empty, failed: true };
  }
}

/**
 * The per-event table the UI renders, in descending order. `keep` optionally
 * restricts to a subset of join keys, which is how a campaign view counts only
 * its own key events rather than the whole property's.
 */
const keyEventBreakdownFrom = (ke, keep) => {
  const per = new Map();
  for (const r of ke.rows) {
    if (keep && !keep(r.key)) continue;
    per.set(r.eventName, (per.get(r.eventName) || 0) + r.value);
  }
  return KEY_EVENTS
    .map((e) => ({ id: e.name, label: e.label, value: per.get(e.name) || 0 }))
    .sort((a, b) => b.value - a.value);
};

/**
 * GA4's Data API rejects any request asking for more than 10 metrics.
 * This helper makes that limit structural rather than a comment someone can
 * miss: build every GA4 field list through it and an over-limit request fails
 * loudly here at build time instead of as an opaque HTTP 400 from Windsor.
 */

// Which platform's impressions belong to which GA4 channel group. Units differ
// across platforms; the UI states this rather than implying one true total.
const IMPRESSION_SOURCE_BY_CHANNEL = {
  "paid social": "meta",
  "organic search": "gsc",
  // TikTok views only. Facebook page reach is NOT here: it includes ads by
  // Meta's definition, so putting it in a column that sums into the headline
  // double-counts every paid impression. It is reported in the reach panel.
  "organic social": "tiktok",
  // Google Ads search campaigns land in GA4's "Paid Search" channel group.
  // Display and Video campaigns land in "Display" / "Paid Video", which this
  // deliberately does NOT claim: the connector returns one total across all
  // campaign types, so attributing it to Paid Search alone would be wrong for
  // the others. If Display spend becomes material, split the pull by
  // campaign type rather than widening this map.
  "paid search": "gads",
};

/**
 * Ad platforms queried for campaign-level impressions, clicks and spend.
 * ONLY platforms actually authorised in Windsor belong here — querying
 * unconnected ones just burns requests and litters the UI with "not connected"
 * rows. To add one later (Google Ads, TikTok Ads, LINE Ads) authorise it in
 * Windsor and add a single line below; nothing else needs to change.
 */
const AD_METRIC_FIELDS = ["impressions", "clicks", "spend"];

/**
 * Ad platforms folded into campaign analysis. `extra` lists fields that exist
 * only on that platform: Google Ads has no campaign_objective and none of the
 * actions_* metrics, and asking for them makes the whole request fail rather
 * than returning nulls — which is why the platforms cannot share one field list.
 */
const AD_PLATFORMS = [
  { id: "facebook", label: "Meta Ads", campaignKey: "campaign",
    extra: ["campaign_objective", "actions_link_click", "actions_landing_page_view",
            "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d"] },
  { id: "google_ads", label: "Google Ads", campaignKey: "campaign", extra: [] },
];

// utm_source patterns that indicate traffic came from a given ad platform, used
// to attribute spend to a utm variant. Extend alongside AD_PLATFORMS.
const PLATFORM_SOURCE_HINTS = {
  "Meta Ads": [/facebook/i, /meta/i, /(^|[^a-z])fb([^a-z]|$)/i, /instagram/i, /(^|[^a-z])ig([^a-z]|$)/i],
  // GA4 records Google Ads traffic as google/cpc, and YouTube buys arrive as
  // youtube or the auto-tagged gclid source.
  "Google Ads": [/^google$/i, /googleads/i, /youtube/i, /(^|[^a-z])gclid([^a-z]|$)/i],
};
const PAID_MEDIUM_RE = /(cpc|ppc|paid|display|video|banner)/i;

// ------------------------------------------------------------- /api/overview

async function buildOverview(from, to) {
  // Session metrics only: 2. Key events come from the Data API as rows, so this
  // no longer sits at the 10-metric ceiling (see KEY_EVENTS).
  const GA4_FUNNEL_DIMS = ["date", "session_default_channel_group"];
  // Commerce call: 5 metrics.
  const GA4_ECOM_METRICS = ["items_viewed", "add_to_carts", "ecommerce_purchases", "purchase_revenue", "transactions"];

  // Month-to-date pulled separately so the forecast is stable no matter which
  // range is being viewed.
  const today = new Date();
  const monthFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const monthTo = today.toISOString().slice(0, 10);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysElapsed = today.getDate();

  const { data, errors } = await runJobs({
    /**
     * YouTube rides along as AWARENESS (MW). One Sheets read, and `runJobs`
     * nulls it if the sheet is unavailable, so it cannot fail the pull.
     *
     * It is NOT in the funnel. YouTube views never become a GA4 session, and the
     * sessions YouTube DOES drive are already counted under Organic Social —
     * adding views to the funnel total would double-count the ones that
     * converted and invent the ones that did not.
     */
    youtube: buildYouTube(from, to),
    ga4: ga4Compat(GA4_FUNNEL_DIMS, ["sessions", "engaged_sessions"], from, to),
    keyEvents: ga4KeyEvents(GA4_FUNNEL_DIMS, from, to),
    ga4Ecom: ga4Compat(GA4_FUNNEL_DIMS, GA4_ECOM_METRICS, from, to),
    // Item-scoped metrics cannot be combined with the session-scoped landing
    // page filter — GA4 rejects the pair — so this stays group-wide and is
    // labelled as such in the UI rather than silently implying branch scope.
    /**
     * Top packages, measured PAGE-side rather than item-side.
     *
     * Item-scoped metrics (itemsViewed, itemRevenue) cannot be combined with any
     * page or session dimension, so an item report can never be branch-filtered
     * and this table covered all 27 branches. Counting `view_item` against
     * pageTitle is event- and page-scoped, which IS filterable, so it now
     * respects the four-branch scope like everything else. The trade is item
     * names for page titles, and revenue is dropped — item revenue has no
     * page-scoped equivalent and web purchases are 0 regardless (§11).
     */
    ga4Items: ga4RunReport({
      dimensions: ["pageTitle", "pagePath"],
      metrics: ["eventCount"],
      from, to,
      dimensionFilter: {
        andGroup: { expressions: [
          { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "view_item" } } },
          { filter: { fieldName: "pagePath",
            stringFilter: { matchType: "PARTIAL_REGEXP", value: BRANCH_REGEX, caseSensitive: false } } },
        ] },
      },
    }),
    ga4Month: ga4Compat(["date"], ["purchase_revenue", "ecommerce_purchases"], monthFrom, monthTo),
    meta: windsor("facebook", ["date", "account_name", "spend", "impressions", "clicks",
      // Ad-ATTRIBUTED conversations only. There is no organic Messenger or IG
      // DM metric on any connector Windsor offers (facebook_messenger does not
      // exist; facebook_organic has no messaging fields), so this undercounts
      // real message volume and the UI must say so rather than imply totality.
      "actions_onsite_conversion_total_messaging_connection"], from, to),
    gads: windsor("google_ads",
      // phone_calls: calls placed straight from the ad, a stage-5 outcome that
      // never becomes a session.
      ["date", "account_name", "spend", "impressions", "clicks", "phone_calls"], from, to),
    gsc: gscQuery(["date"], from, to),
    gmb: windsor("google_my_business",
      ["date", "location_title", "impressions", "call_clicks", "website_clicks", "direction_requests",
        "business_bookings"], from, to),
    /**
     * page_impressions_organic, NOT page_impressions.
     *
     * The plain field counts organic + boosted + dark, so adding it to Meta Ads
     * double-counted every paid impression and the field had to be excluded
     * from the funnel entirely. The organic-only variant has no overlap, so
     * Facebook can finally sit IN the Impressions stage: Meta Ads keeps all
     * paid distribution (boosted and dark alike) and this adds only what
     * reached people organically. No estimate, no subtraction.
     */
    fbOrganic: windsor("facebook_organic",
      ["date", "page_impressions", "page_impressions_organic", "post_engagements"], from, to),
    ttOrganic: windsor("tiktok_organic", ["date", "video_views", "likes", "comments", "shares"], from, to),
    line: lineWindsor(["date", "message__broadcast", "message__targeting", "message__api_broadcast",
      "message__api_narrowcast", "message__api_multicast", "message__api_push",
      "followers__followers", "followers__targeted_reaches"], from, to),
    // Separate call: the message-event table carries actual opens/clicks, which
    // is a real impression rather than a send count. LINE returns null for any
    // value under 20, so small sends legitimately come back empty.
    lineEvents: lineWindsor(["date", "message_delivered", "message_unique_impression", "message_unique_click"], from, to),
  });

  const ga4 = data.ga4;
  const ga4Available = ga4 !== null;
  // runJobs turns a rejection into null; ga4KeyEvents already swallows its own
  // errors, so this is only null if the job itself was never fulfilled.
  const ke = data.keyEvents || { total: 0, byKey: new Map(), byName: new Map(), failed: true };
  const ecom = data.ga4Ecom;

  /**
   * YouTube views for the window, or NULL — never 0.
   *
   * The export sheet starts at 2025-01-01, so a range before that legitimately
   * has no rows. `days === 0` means "not in the sheet", which is a different
   * statement from "nobody watched", and the second is what a 0 would say on an
   * executive slide. This is the same distinction that let a dead channel look
   * like a quiet month for 400 days.
   */
  const ytTotals = (data.youtube && data.youtube.totals) || null;
  const ytViews = ytTotals && ytTotals.days ? ytTotals.views : null;

  const impressions = {
    youtube: ytViews,
    meta: sumOrNull(data.meta, "impressions"),
    gads: sumOrNull(data.gads, "impressions"),
    gsc: sumOrNull(data.gsc, "impressions"),
    gmb: sumOrNull(data.gmb, "impressions"),
    /**
     * SPLIT, and fbPage deliberately EXCLUDED from the impressions total.
     *
     * Meta defines page_impressions as "any content from your Page or about
     * your Page... this includes posts, stories, ADS". So it contains the Meta
     * Ads impressions already counted in `meta`, and summing both
     * double-counted every paid impression. It is now reported on its own as
     * "Facebook page reach (includes ads)" rather than folded into a headline
     * that cannot be defended.
     *
     * TikTok is separate because a video view is not an impression — autoplay
     * counts. Merging the two produced a 23.2M "impressions" line against 20.1K
     * visits, a rate an order of magnitude below every other channel, which
     * read as a failing channel rather than a different unit.
     */
    fbPage: sumOrNull(data.fbOrganic, "page_impressions_organic"),
    fbPageAll: sumOrNull(data.fbOrganic, "page_impressions"),   // organic + boosted + dark, reference only
    tiktok: sumOrNull(data.ttOrganic, "video_views"),

    /**
     * LINE reach. The connector's message-EVENT metrics (message_delivered,
     * message_unique_impression, message_unique_click) return 0 for every date:
     * they are keyed per broadcast request, not per day, so they don't aggregate
     * on a date dimension. The message-DELIVERY table is the reliable one, so
     * reach = broadcast + targeted + API push sends. Opens are preferred if they
     * ever start reporting.
     */
    line: (() => {
      const opens = sumOrNull(data.lineEvents, "message_unique_impression");
      if (opens) return opens;
      if (data.line === null) return null;
      // Every outbound send type LINE reports. Reply/greeting/chat/auto-response
      // are excluded on purpose: they're conversational, not campaign reach.
      return ["message__broadcast", "message__targeting", "message__api_broadcast",
        "message__api_narrowcast", "message__api_multicast", "message__api_push"]
        .reduce((a, f) => a + n(sumOrNull(data.line, f)), 0);
    })(),
  };

  const lineOpens = sumOrNull(data.lineEvents, "message_unique_impression");
  const lineBasis = lineOpens ? "unique opens"
    : (data.line !== null ? "messages sent · per-message opens need request IDs" : "unavailable");
  const lineFollowers = data.line === null ? null : Math.max(0, ...data.line.map((r) => n(r.followers__followers)));
  const lineReachable = data.line === null ? null : Math.max(0, ...data.line.map((r) => n(r.followers__targeted_reaches)));

  // ---- funnel by GA4 channel group ----
  const chanMap = new Map();
  if (ga4Available) {
    for (const r of ga4) {
      const label = r.session_default_channel_group || "Unassigned";
      if (!chanMap.has(label)) chanMap.set(label, { channel: label, visits: 0, engagement: 0, keyEvents: 0 });
      const c = chanMap.get(label);
      c.visits += n(r.sessions);
      c.engagement += n(r.engaged_sessions);
      c.keyEvents += ke.byKey.get(ga4JoinKey(GA4_FUNNEL_DIMS, r, false)) || 0;
    }
  }
  // Ad clicks belong to the same channels that have ad impressions.
  const adClicksByKey = {
    meta: sumOrNull(data.meta, "clicks"),
    gads: sumOrNull(data.gads, "clicks"),
    gsc: sumOrNull(data.gsc, "clicks"),
    tiktok: null,   // TikTok reports no click-out metric at all.
  };
  /**
   * Channel detail is now PURELY GA4 — no platform impressions or clicks.
   *
   * Platform reach and GA4 channel groups are different taxonomies. Attributing
   * TikTok views to "Organic Social" produced 96.9K impressions against 20.1K
   * visits, in a row that also contains Facebook, Instagram and LINE traffic:
   * a ratio that looks like a conversion rate and is not one. Platform reach
   * now lives entirely in the Reach band, where the units can be stated.
   */
  const funnel = [...chanMap.values()].map((c) => {
    const srcKey = IMPRESSION_SOURCE_BY_CHANNEL[norm(c.channel)];
    return {
      ...c,
      impressions: srcKey ? impressions[srcKey] : null,
      clicks: srcKey ? (adClicksByKey[srcKey] ?? null) : null,
      impressionSource: srcKey || null,
    };
  }).sort((a, b) => b.visits - a.visits);

  // Platform reach with no GA4 channel equivalent.
  /**
   * Off-site reach and off-site ACTION. These never become a GA4 session, so
   * they sit outside the funnel — but a call or a booking from Maps is a better
   * outcome than a form fill, not a lesser one, so the actions are surfaced
   * rather than discarded as they were until v3.68.
   */
  const gmbAction = (f) => sumOrNull(data.gmb, f);
  const reachOnly = [
    { channel: "Google Business Profile", impressions: impressions.gmb, note: "profile views" },
    { channel: "Facebook page", impressions: impressions.fbPage,
      // Boost Post is the mechanism: a boosted organic post's reach lands here
      // AND in Meta Ads impressions, so this cannot join the funnel total.
      note: "page reach — includes Boost Post, so not added to the funnel total" },
    { channel: "TikTok", impressions: impressions.tiktok, note: "video views — counted in the funnel as Organic Social" },
    /**
     * SCOPE IS ON THE ROW, and it has to be. Everything else in Overview is
     * filtered to the four hospitals; the YouTube channel is a single corporate
     * channel that cannot be split by branch. Leaving that unsaid would put a
     * group-level number inside a BHQ-scoped view — exactly the conflation this
     * project refuses to make anywhere else.
     */
    { channel: "YouTube", impressions: impressions.youtube,
      note: "video views — one corporate channel, so NOT branch-scoped like the rest of this view",
      sub: ytTotals && ytTotals.days
        ? `${ytTotals.days} days in the export${ytTotals.hoursWatched ? ` · ${Math.round(ytTotals.hoursWatched).toLocaleString()} hours watched` : ""}`
        : "no rows in the export sheet for this range" },
    // LINE is listed only while the connector is on. Showing a permanent
    // "unavailable" row trains people to ignore the panel.
    ...(LINE_ENABLED ? [{ channel: "LINE", impressions: impressions.line, note: lineBasis,
      sub: lineFollowers ? `${lineFollowers.toLocaleString()} followers${lineReachable ? ` · ${lineReachable.toLocaleString()} targetable` : ""}` : null }] : []),
  ];

  /**
   * BOFU actions that never touch the website. Bookings are the strongest of
   * these for a hospital and only exist because the booking button is live on
   * the profile. Meta messaging is ad-attributed ONLY — organic Messenger and
   * IG DMs have no metric on any available connector, so this is a floor.
   */

  // Nulls must stay null when BOTH sides are missing, but one side being
  // unavailable must not read as zero for the other.
  const bothNull = (a, b) => a === null && b === null;
  const addNullable = (a, b) => (bothNull(a, b) ? null : n(a) + n(b));

  const offsiteActions = {
    gbpCalls: gmbAction("call_clicks"),
    gbpDirections: gmbAction("direction_requests"),
    gbpBookings: gmbAction("business_bookings"),
    gbpWebsiteClicks: gmbAction("website_clicks"),
    metaMessages: sumOrNull(data.meta, "actions_onsite_conversion_total_messaging_connection"),
    gadsCalls: sumOrNull(data.gads, "phone_calls"),
  };
  offsiteActions.total = ["gbpCalls", "gbpDirections", "gbpBookings", "metaMessages"]
    .every((k) => offsiteActions[k] === null) ? null
    : ["gbpCalls", "gbpDirections", "gbpBookings", "metaMessages"]
      .reduce((a, k) => a + n(offsiteActions[k]), 0);

  const totals = {
    impressions: (() => {
      /**
       * TOFU. Everything that put us in front of someone: paid impressions,
       * organic search impressions, organic social reach, and GBP profile
       * views. fbPage is the ORGANIC-only figure, so Meta Ads can keep its
       * boosted and dark distribution without either being counted twice.
       * Email sends and LINE broadcasts belong here too but have no connector.
       */
      /**
       * YouTube views are IN this total (MW), which is what keeps the bar
       * honest: the segments are drawn as a share of `totals.impressions`, so a
       * source in the bar but not in the total makes every percentage overstate
       * and the widths sum past 100%.
       *
       * Note the scope mismatch this creates and does not hide: every other
       * figure here is filtered to the four hospitals, while the YouTube channel
       * is one corporate channel. The awareness row below says so explicitly.
       * The alternative — leaving YouTube out of a slide called "everything that
       * put us in front of someone" — understates by a million views a month.
       */
      const vals = [impressions.meta, impressions.gads, impressions.gsc,
                    impressions.tiktok, impressions.fbPage, impressions.gmb,
                    impressions.youtube];
      return vals.every((v) => v === null) ? null : vals.reduce((a, v) => a + n(v), 0);
    })(),
    clicks: (() => {
      /**
       * Stage 2 is INTERACTION with what they saw, not only clicks: post
       * engagements and TikTok engagements are the same intent as a click and
       * belong here (MW 23 Aug 2026). Still an interim stage — narrower than
       * reach, wider than a visit.
       */
      const vals = [adClicksByKey.meta, adClicksByKey.gads, adClicksByKey.gsc,
                    sumOrNull(data.fbOrganic, "post_engagements"),
                    data.ttOrganic === null ? null
                      : n(sumOrNull(data.ttOrganic, "likes")) + n(sumOrNull(data.ttOrganic, "comments"))
                        + n(sumOrNull(data.ttOrganic, "shares")),
                    offsiteActions.gbpWebsiteClicks];
      return vals.every((v) => v === null) ? null : vals.reduce((a, v) => a + n(v), 0);
    })(),
    visits: ga4Available ? funnel.reduce((a, c) => a + c.visits, 0) : null,
    engagement: ga4Available ? funnel.reduce((a, c) => a + c.engagement, 0) : null,
    /**
     * BOFU — VALUE ACTIONS, not just website key events (MW 23 Aug 2026).
     * A call from Maps, a direction request, a message from a Meta ad and a
     * call placed straight from a Google ad are all outcomes of equal worth
     * that never become a session, so they belong in this stage rather than
     * beside the funnel.
     */
    keyEvents: (() => {
      const web = ga4Available ? funnel.reduce((a, c) => a + c.keyEvents, 0) : null;
      const off = [offsiteActions.gbpCalls, offsiteActions.gbpDirections,
                   offsiteActions.metaMessages, sumOrNull(data.gads, "phone_calls")];
      if (web === null && off.every((v) => v === null)) return null;
      return n(web) + off.reduce((a, v) => a + n(v), 0);
    })(),
    keyEventsWeb: ga4Available ? funnel.reduce((a, c) => a + c.keyEvents, 0) : null,
    keyEventsOffsite: (() => {
      const off = [offsiteActions.gbpCalls, offsiteActions.gbpDirections,
                   offsiteActions.metaMessages, sumOrNull(data.gads, "phone_calls")];
      return off.every((v) => v === null) ? null : off.reduce((a, v) => a + n(v), 0);
    })(),
  };

  /**
   * Restricted to the (date x channel) groupings the funnel actually counted,
   * so the breakdown table always sums to totals.keyEvents. Left unfiltered it
   * reports every key event in the property, which is a larger number than the
   * headline above it — a discrepancy nobody can explain and everybody notices.
   */
  const funnelKeys = new Set(ga4Available ? ga4.map((r) => ga4JoinKey(GA4_FUNNEL_DIMS, r, false)) : []);
  const keyEventBreakdown = ga4Available
    ? keyEventBreakdownFrom(ke, (k) => funnelKeys.has(k)) : null;

  // ---- ecommerce (from the second GA4 call) ----
  let ecommerce = null;
  if (ecom !== null) {
    ecommerce = {
      productViews: ecom.reduce((a, r) => a + n(r.items_viewed), 0),
      addToCarts: ecom.reduce((a, r) => a + n(r.add_to_carts), 0),
      purchases: ecom.reduce((a, r) => a + n(r.ecommerce_purchases), 0),
      revenue: ecom.reduce((a, r) => a + n(r.purchase_revenue), 0),
      transactions: ecom.reduce((a, r) => a + n(r.transactions), 0),
    };
    ecommerce.cartRate = ecommerce.productViews ? (ecommerce.addToCarts / ecommerce.productViews) * 100 : null;
    ecommerce.purchaseRate = ecommerce.productViews ? (ecommerce.purchases / ecommerce.productViews) * 100 : null;
    ecommerce.aov = ecommerce.purchases ? ecommerce.revenue / ecommerce.purchases : null;
  }

  let forecast = null;
  if (data.ga4Month !== null) {
    const mtd = data.ga4Month.reduce((a, r) => a + n(r.purchase_revenue), 0);
    const runRate = daysElapsed ? mtd / daysElapsed : 0;
    forecast = {
      monthToDate: mtd, projectedMonthEnd: runRate * daysInMonth,
      daysElapsed, daysInMonth, method: "run-rate: MTD daily average x days in month",
    };
  }

  const topProducts = data.ga4Items === null ? null : (() => {
    const m = new Map();
    for (const r of data.ga4Items) {
      const name = String(r.pageTitle || "").trim();
      if (!name || name === "(not set)") continue;
      if (!m.has(name)) m.set(name, { name, views: 0 });
      m.get(name).views += n(r.eventCount);
    }
    return [...m.values()].sort((a, b) => b.views - a.views).slice(0, 10);
  })();

  // ---- trend ----
  const trendMap = new Map();
  const touch = (d) => {
    if (!trendMap.has(d)) trendMap.set(d, { d, visits: 0, engagement: 0, keyEvents: 0, revenue: 0, spend: 0, impressions: 0 });
    return trendMap.get(d);
  };
  if (ga4Available) for (const r of ga4) {
    if (!r.date) continue;
    const t = touch(r.date);
    t.visits += n(r.sessions);
    t.keyEvents += ke.byKey.get(ga4JoinKey(GA4_FUNNEL_DIMS, r, false)) || 0;
  }
  if (ecom !== null) for (const r of ecom) {
    if (!r.date) continue;
    touch(r.date).revenue += n(r.purchase_revenue);
  }
  if (ga4Available) for (const r of ga4) {
    if (!r.date) continue;
    touch(r.date).engagement += n(r.engaged_sessions);
  }
  if (data.meta !== null) for (const r of data.meta) {
    if (!r.date) continue;
    const t = touch(r.date);
    t.spend += n(r.spend);
    t.impressions += n(r.impressions);
  }
  const trend = [...trendMap.values()].sort((a, b) => a.d.localeCompare(b.d));

  /**
   * ALL paid media, not just Meta. A card headed "Paid media" that counted only
   * Meta understated spend by whatever Google Ads was doing, and did it
   * silently. Nulls are preserved: if BOTH platforms are unavailable the figure
   * is null (renders as "—"), but one platform down must not read as zero for
   * the other, so an available platform still contributes.
   */
  const metaSpend = sumOrNull(data.meta, "spend");
  const gadsSpend = sumOrNull(data.gads, "spend");
  const paid = {
    spend: addNullable(metaSpend, gadsSpend),
    impressions: addNullable(impressions.meta, impressions.gads),
    clicks: addNullable(adClicksByKey.meta, adClicksByKey.gads),
    byPlatform: {
      meta: { spend: metaSpend, impressions: impressions.meta, clicks: adClicksByKey.meta },
      googleAds: { spend: gadsSpend, impressions: impressions.gads, clicks: adClicksByKey.gads },
    },
  };
  paid.cpc = paid.clicks ? paid.spend / paid.clicks : null;

  const topAccounts = data.meta === null ? null : (() => {
    const m = new Map();
    for (const r of data.meta) {
      const k = r.account_name || "Unknown";
      if (!m.has(k)) m.set(k, { name: k, spend: 0, clicks: 0, impressions: 0 });
      const a = m.get(k);
      a.spend += n(r.spend); a.clicks += n(r.clicks); a.impressions += n(r.impressions);
    }
    return [...m.values()].sort((a, b) => b.spend - a.spend).slice(0, 8);
  })();

  const search = { clicks: sumOrNull(data.gsc, "clicks"), impressions: impressions.gsc, position: null, ctr: null };
  if (data.gsc !== null && search.impressions) {
    const w = data.gsc.reduce((a, r) => a + n(r.position) * n(r.impressions), 0);
    search.position = w / search.impressions;
    search.ctr = (search.clicks / search.impressions) * 100;
  }

  return {
    range: { from, to },
    totals, funnel, reachOnly, keyEventBreakdown, offsiteActions,
    // Per-source figures for the non-GA4 segments of the stage bars.
    impressionsBySource: {
      meta: impressions.meta, gads: impressions.gads, gsc: impressions.gsc,
      fbPage: impressions.fbPage, gmb: impressions.gmb, tiktok: impressions.tiktok,
      // Explicit whitelist, so adding a key to `impressions` is not enough —
      // that is exactly how this one was missed on the first attempt.
      youtube: impressions.youtube,
      adClicks: addNullable(adClicksByKey.meta, adClicksByKey.gads),
      searchClicks: adClicksByKey.gsc,
      fbEngagements: sumOrNull(data.fbOrganic, "post_engagements"),
      ttEngagements: data.ttOrganic === null ? null
        : n(sumOrNull(data.ttOrganic, "likes")) + n(sumOrNull(data.ttOrganic, "comments"))
          + n(sumOrNull(data.ttOrganic, "shares")),
    },
    ecommerce, forecast, topProducts,
    paid, topAccounts, search, trend,
    unavailable: Object.keys(errors),
    errors,
    ga4Property: GA4_ACCOUNT,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * The board report: the four brands side by side, replacing four separate
 * Looker Studio exports with one view and a brand selector.
 *
 * Sessions, not users — chosen by MW so the whole dashboard speaks one unit.
 * Shared assets are returned in their own block and are NOT inside any brand,
 * so the four brands deliberately do not sum to the group figure.
 */
async function buildReport(from, to) {
  const perBrand = {};
  for (const b of BRANDS) perBrand[b.key] = { key: b.key, label: b.label, segment: b.segment };

  // One filtered pair of reports per brand: each is small, and bucketing a
  // single wide landing-page pull in JS would drag tens of thousands of rows.
  const jobs = {};
  for (const b of BRANDS) {
    /**
     * Source is carried alongside the channel group so a platform funnel
     * (Facebook, and later TikTok or LINE) can be built without extra requests.
     * Same number of reports, more rows: channels aggregate over source.
     */
    jobs[`s_${b.key}`] = ga4Compat(["session_default_channel_group", "session_manual_source"],
      ["sessions", "engaged_sessions"], from, to, { segments: [b.segment] });
    jobs[`k_${b.key}`] = ga4KeyEvents(["session_default_channel_group", "session_manual_source"],
      from, to, [b.segment]);
  }
  /**
   * Year-to-date monthly series per hospital, for the opening slide. The LS
   * deck shows January onward regardless of the selected range, so the trend is
   * always readable; only the headline follows the picker.
   */
  const ytdFrom = `${String(to).slice(0, 4)}-01-01`;
  for (const b of BRANDS) {
    jobs[`m_${b.key}`] = ga4Compat(["date"], ["sessions"], ytdFrom, to, { segments: [b.segment] });
  }
  // Same length of window, one month back and one year back, for MoM and YoY.
  const cwr = comparisonWindows(from, to);
  // No group-wide prev/yoy pulls: the per-brand ones below already cover the
  // same four segments, so the totals are their sum. Two fewer round trips.
  for (const b of BRANDS) {
    // Grouped by channel rather than a bare total: the same rows serve the
    // usersOverview MoM (summed) and the per-channel MoM, so the Channels slide
    // costs nothing extra.
    jobs[`p_${b.key}`] = ga4Compat(["session_default_channel_group"], ["sessions"],
      cwr.prev.from, cwr.prev.to, { segments: [b.segment] });
    jobs[`y_${b.key}`] = ga4Compat([], ["sessions"], cwr.yoy.from, cwr.yoy.to, { segments: [b.segment] });
  }
  jobs.meta = windsor("facebook", ["account_name", "spend", "impressions", "clicks"], from, to);
  /**
   * Search by language: the TOFU/MOFU/BOFU strip repeated ten times in the LS
   * deck. Impressions and clicks come from Search Console keyed on `page`;
   * sessions and key events from GA4 keyed on landing page. Both are bucketed
   * by the SAME locale segment via localeFromPath(), which is the only reliable
   * split — EN/DE/VN/ID share Latin script and cannot be told apart by
   * characters (§7).
   */
  // GBP per listing, mapped to brands through the registry. Dental rolls into
  // BGH and JMS is shared, so the listing count (6) is not the brand count (4).
  /**
   * Search Ads by search term — what people actually typed, not the keyword we
   * bid on. `search_term` is the query; `keyword_text` is our bid term. The LS
   * deck shows the former, which is the more useful of the two.
   */
  /**
   * Countries per hospital, current window and one window back for MoM.
   * Thailand is excluded at render time, not here — the LS page is "who gets
   * into our sites from OUTSIDE Thailand", and keeping the domestic row in the
   * payload means the share maths stays honest if that ever changes.
   */
  for (const b of BRANDS) {
    jobs[`c_${b.key}`] = ga4Compat(["country"], ["sessions"], from, to, { segments: [b.segment] });
    jobs[`cp_${b.key}`] = ga4Compat(["country"], ["sessions"], cwr.prev.from, cwr.prev.to, { segments: [b.segment] });
  }
  /**
   * `campaign` rides along on the search-term pull: the code carries the brand,
   * so this is one request that buckets into four hospitals plus an
   * unattributed remainder. Rule 1 of the request budget \u2014 more rows on a pull
   * already in flight, not a second pull.
   */
  jobs.gadsTerms = windsor("google_ads", ["campaign", "search_term", "impressions", "clicks", "spend"], from, to);
  jobs.fbOrganic = windsor("facebook_organic",
    ["date", "page_impressions", "page_impressions_organic", "post_engagements",
      "page_follows", "page_daily_follows_unique"], from, to);
  /**
   * Ad effort per hospital. `reach` is people, `impressions` is views — the LS
   * card shows reach, so both are pulled and labelled distinctly.
   */
  jobs.metaAds = windsor("facebook",
    ["account_name", "spend", "impressions", "reach", "clicks",
      "actions_link_click", "actions_post_engagement"], from, to);
  /**
   * TikTok, two pulls for two slides. Field names verified against the
   * connector, not guessed \u2014 reach is `unique_video_views` ("daily reached
   * audience"); there is no `reach` field on this connector at all.
   *
   * `account_name` rides along so the note can name which channels are in
   * scope rather than assuming a single one.
   */
  jobs.ttOrganic = windsor("tiktok_organic",
    ["date", "account_name", "video_views", "unique_video_views", "profile_views",
      "likes", "comments", "shares", "bio_link_clicks", "phone_number_clicks"], from, to);
  /**
   * Per-video, for Top performances. This is the connector's Video table rather
   * than its Account table, so it cannot share the pull above \u2014 the one place
   * in this report where a second request is genuinely unavoidable.
   *
   * `video_views_count` is the per-video figure; `video_views` in the pull above
   * is the ACCOUNT total. Summing the two together would double count, so they
   * are deliberately never mixed.
   */
  jobs.ttVideos = windsor("tiktok_organic",
    ["video_id", "video_caption", "video_thumbnail_url", "video_share_url",
      "video_views_count", "video_reach", "video_likes", "video_comments",
      "video_shares", "video_favorites"], from, to);
  jobs.gbp = windsor("google_my_business",
    ["location_title", "impressions", "call_clicks", "website_clicks", "direction_requests"], from, to);
  /**
   * GBP detail per hospital: daily series split by surface, plus the same
   * window a month back for MoM. Two pulls grouped by location and date, then
   * bucketed in JS — not eight per-hospital pulls.
   */
  const GBP_DAILY_FIELDS = ["date", "location_title", "impressions",
    "impressions_mobile_search", "impressions_mobile_maps",
    "impressions_desktop_search", "impressions_desktop_maps",
    "call_clicks", "website_clicks", "direction_requests"];
  jobs.gbpDaily = windsor("google_my_business", GBP_DAILY_FIELDS, from, to);
  jobs.gbpDailyPrev = windsor("google_my_business", GBP_DAILY_FIELDS, cwr.prev.from, cwr.prev.to);
  /**
   * `search_keyword_value` is the unique users who searched that phrase.
   * Google withholds it below a floor and returns `search_keyword_threshold`
   * instead — exactly one of the two is present. "<15" is a real answer and
   * is shown as such rather than collapsed to 0, which is what an earlier
   * attempt using the generic `impressions` field produced.
   */
  jobs.gbpKeywords = windsor("google_my_business",
    ["location_title", "search_keyword", "search_keyword_value", "search_keyword_threshold"], from, to);
  /**
   * Reviews year-to-date, not just the selected window: the monthly trend needs
   * history, and the in-period slice is a filter on the same rows. One pull
   * serves both. `review_reply_comment` is what makes an unanswered review
   * visible — a 2-star with no reply is the single most actionable thing on a
   * hospital's profile.
   */
  jobs.gbpReviews = windsor("google_my_business",
    // Comment and reviewer are back, for ONE sample review per star rating —
    // a rating mix says 7% left two stars; a sample says what they said.
    // The full review-by-review list still belongs on the Google Profile tab.
    ["review_create_time", "location_title", "review_star_rating",
      "review_comment", "review_reviewer", "review_reply_comment"], ytdFrom, to);
  jobs.gbpLifetime = windsor("google_my_business",
    ["location_title", "review_total_count", "review_average_rating_total"], from, to);
  /**
   * TEN TOTALS FROM SEARCH CONSOLE, not one truncated list of pages.
   * See `gscLocaleTotals`: the old `["page"]` pull lost everything past 25,000
   * URLs, which put BGH Thai at 7.4M against Looker Studio's 16.9M.
   */
  jobs.gscLangTotals = gscLocaleTotals(from, to).catch((e) => {
    logJson("WARN", "gsc_locale_totals_failed", { error: String(e.message || e) });
    return null;
  });
  /**
   * ONE request covering all 40 hospital x language search pages. The page URL
   * carries both the branch segment and the locale, so query x page buckets
   * into every combination at once — the alternative was 40 filtered pulls.
   * Three pages of 25,000 rows; sorted by clicks, so any tail lost is the tail.
   */
  jobs.gscQueries = gscQuery(["query", "page"], from, to, { maxPages: 3 });
  jobs.langSessions = ga4Compat(["landing_page"],
    ["sessions", "screen_page_views", "purchase_revenue"], from, to);
  // Previous window, for the MoM on the language matrix. One extra report
  // rather than eight: the landing page carries BOTH the brand segment and the
  // locale, so a single pull buckets into all 40 cells.
  jobs.langSessionsPrev = ga4Compat(["landing_page"], ["sessions"], cwr.prev.from, cwr.prev.to);
  jobs.langKeyEvents = ga4KeyEvents(["landing_page"], from, to);
  /**
   * Previous window, for the MoM columns on the per-language Actions and Search
   * blocks. ONE request: the landing page carries hospital and locale, so it
   * serves both the Actions-by-language table and every Search page.
   *
   * (This line was assigned twice until v3.100.0 — harmless, because
   * `memoUpstream` caches the promise and the second call shared the first's
   * round trip, but it read as two different requests.)
   */
  jobs.langKeyEventsPrev = ga4KeyEvents(["landing_page"], cwr.prev.from, cwr.prev.to);
  // Keyed by source, so the Facebook actions carry MoM for one group-wide
  // request rather than four per-brand ones.
  jobs.srcKeyEventsPrev = ga4KeyEvents(["session_manual_source"], cwr.prev.from, cwr.prev.to);

  /**
   * CONTENT PAGES, top performers per type. Two group-wide pulls that serve all
   * four hospitals, every locale and all four content types — rule 2 of the
   * budget, not per-brand requests.
   *
   * WHY NOT `langSessions`, which is already in flight: `screen_page_views`
   * against a LANDING PAGE dimension counts every page view in those sessions,
   * not views OF that page. A doctor page would be credited with the whole
   * visit. Page-scoped `pagePath x screenPageViews` is the only correct source.
   *
   * Both are filtered to the four content segments AND the branch regex, which
   * is what keeps a 44,000-page property down to a sane row count, and both are
   * sorted server-side so the row cap drops the tail rather than a random slice.
   */
  const CONTENT_SEGMENT_RE = "/(doctor|package|content|center-clinic)/";
  const contentPageFilter = (extra) => ({
    andGroup: { expressions: [
      { filter: { fieldName: "pagePath",
        stringFilter: { matchType: "PARTIAL_REGEXP", value: CONTENT_SEGMENT_RE, caseSensitive: false } } },
      { filter: { fieldName: "pagePath",
        stringFilter: { matchType: "PARTIAL_REGEXP", value: BRANCH_REGEX, caseSensitive: false } } },
      ...(extra || []),
    ] },
  });
  jobs.contentViews = ga4RunReport({
    dimensions: ["pagePath", "pageTitle"],
    metrics: ["screenPageViews"],
    from, to, limit: 20000, orderBy: "screenPageViews",
    dimensionFilter: contentPageFilter(),
  });
  /**
   * All nine key events against the page, not just the four the columns show.
   *
   * MW's pairing for Articles (`view_item`) turned out to be wrong, and the
   * only way to answer "which event should this column be" is to measure what
   * actually fires on those pages. Requesting all nine costs the SAME request
   * — more rows on a pull already in flight — and each card now reports its own
   * event mix, so the next wrong pairing answers itself.
   */
  jobs.contentEvents = ga4RunReport({
    dimensions: ["pagePath", "eventName"],
    metrics: ["eventCount"],
    from, to, limit: 20000, orderBy: "eventCount",
    dimensionFilter: contentPageFilter([
      { filter: { fieldName: "eventName", inListFilter: { values: KEY_EVENT_NAMES } } },
    ]),
  });
  /**
   * CHAT BUBBLE. TWO SOURCES, because they see different things.
   *
   * 1. `click_chat_bubble` — the GTM custom event (confirmed by MW from Tag
   *    Assistant). Its parameters are `Click_ID` / `Click_URL` / `Page_Path`,
   *    which reach the Data API as `customEvent:Click_ID` and so on. This is
   *    the authoritative source and the ONLY one that sees
   *    `chat-bubble-top-parent` — the bubble button itself.
   *
   * 2. `click` with `linkId` / `linkUrl` — GA4 enhanced measurement. This is
   *    what the earlier version used, and it worked for the channels precisely
   *    because LINE, WhatsApp and the rest are OUTBOUND LINKS. The bubble
   *    button is a div, fires no outbound click, and so read zero. That was the
   *    bug behind "Chat clicks 0".
   *
   * Both are pulled and the custom event wins wherever it has data. The link
   * event stays as a backstop because `customEvent:` dimensions only resolve if
   * the parameter has been REGISTERED as a custom dimension in GA4 — an
   * unregistered name fails the request, and with no fallback the whole slide
   * would empty. Once registration is confirmed, drop the two link pulls and
   * reclaim the requests.
   */
  const CHAT_ID_RE = "chat-bubble";
  const chatCustomPull = (f, t) => ga4RunReport({
    dimensions: ["pagePath", "customEvent:Click_ID", "customEvent:Click_URL"],
    metrics: ["eventCount"],
    from: f, to: t, limit: 20000, orderBy: "eventCount",
    dimensionFilter: { filter: { fieldName: "eventName",
      stringFilter: { matchType: "EXACT", value: "click_chat_bubble" } } },
  });
  const chatLinkPull = (f, t) => ga4RunReport({
    dimensions: ["pagePath", "eventName", "linkId", "linkUrl"],
    metrics: ["eventCount"],
    from: f, to: t, limit: 20000, orderBy: "eventCount",
    dimensionFilter: { filter: { fieldName: "linkId",
      stringFilter: { matchType: "PARTIAL_REGEXP", value: CHAT_ID_RE, caseSensitive: false } } },
  });
  /**
   * Appointments: the sheet side. `Initiates` comes from the GA4 `appointments`
   * key event already in the per-brand `k_` pulls, so only the sheet is new —
   * one batchGet, not a per-brand request.
   *
   * Wrapped so a Sheets failure degrades this one card rather than the report:
   * the sheet is a separate system with its own permissions, and the other
   * fifteen slides do not depend on it.
   */
  /**
   * NAMED `gbpRanks`, not `gbpKeywords`: that job name is already taken by the
   * Windsor GBP search-keywords pull, and reusing it silently replaced that
   * card's data with this sheet. Two different questions, two different keys —
   * this block exists precisely BECAUSE they are not interchangeable.
   */
  /**
   * Wrapped like the other sheets: the YouTube tab may not exist yet (the Apps
   * Script has to run once first), and one empty card must not take the report
   * down with it.
   */
  /**
   * SHEET ONLY. The direct YouTube Analytics path was removed in v3.129.0.
   *
   * It could never work: the channel is a BRAND ACCOUNT, and the grant has to
   * come from an identity that manages it. The OAuth client, its refresh token
   * and the `apiError` card are gone, along with the amber box that reported a
   * failure nobody could fix from here. The Apps Script sheet is the only path,
   * and it authorises as MW's own account rather than as an OAuth app.
   *
   * If YouTube numbers look wrong, the fault is in the SHEET, not here — check
   * the Meta tab's `notes` for the wrong-channel warning (`CHANNEL_ID` unset
   * queries `channel==MINE`, which returns a full run of zeros without erroring).
   */
  jobs.youtube = buildYouTube(from, to).catch((e) => {
    logJson("WARN", "youtube_failed", { error: String(e.message || e) });
    return null;
  });
  /**
   * Better AI, from the agentic assistant's own Sheet. Wrapped like YouTube:
   * a sheet that is unshared, renamed or empty degrades that one section rather
   * than failing the whole monthly pull. The reason is kept IN the payload, not
   * only in the log, so the slide can say why it is empty.
   */
  jobs.betterAi = buildBetterAi(from, to).catch((e) => {
    logJson("WARN", "betterai_failed", { error: String(e.message || e) });
    return { available: false, error: String(e.message || e) };
  });
  jobs.gbpRanks = buildGbpKeywords(from, to).catch((e) => {
    logJson("WARN", "gbp_keywords_failed", { error: String(e.message || e) });
    return null;
  });
  jobs.appointments = buildAppointments(from, to).catch((e) => {
    logJson("WARN", "appointments_failed", { error: String(e.message || e) });
    return null;
  });
  jobs.chatCustom = chatCustomPull(from, to);
  jobs.chatCustomPrev = chatCustomPull(cwr.prev.from, cwr.prev.to);
  jobs.chatBubble = chatLinkPull(from, to);
  jobs.chatBubblePrev = chatLinkPull(cwr.prev.from, cwr.prev.to);
  const { data } = await runJobs(jobs);

  for (const b of BRANDS) {
    const rows = data[`s_${b.key}`] || [];
    const ke = data[`k_${b.key}`] || { total: 0, byName: new Map(), rows: [] };
    const chanMap = new Map();
    for (const r of rows) {
      const key = r.session_default_channel_group || "(unassigned)";
      const e = chanMap.get(key) || { channel: key, sessions: 0, engaged: 0 };
      e.sessions += n(r.sessions); e.engaged += n(r.engaged_sessions);
      chanMap.set(key, e);
    }
    const chan = [...chanMap.values()].sort((x, y) => y.sessions - x.sessions);
    perBrand[b.key].sessions = chan.reduce((a, c) => a + c.sessions, 0);
    perBrand[b.key].engaged = chan.reduce((a, c) => a + c.engaged, 0);
    perBrand[b.key].channels = chan.slice(0, 6);
    perBrand[b.key].keyEvents = ke.total;
    perBrand[b.key].keyEventBreakdown = KEY_EVENTS
      .map((e) => ({ id: e.name, label: e.label, value: ke.byName.get(e.name) || 0 }))
      .filter((e) => e.value > 0).sort((a, c) => c.value - a.value);
    perBrand[b.key].unavailable = data[`s_${b.key}`] === null;
  }

  // Meta split three ways: brand-owned, shared across all four, e-commerce only.
  const blank = () => ({ spend: 0, impressions: 0, clicks: 0, accounts: [] });
  const metaByBrand = {}, metaShared = blank(), metaUnmapped = blank();
  for (const r of (data.meta || [])) {
    const owner = brandForMetaAccount(r.account_name);
    if (owner === "ECOM") continue;              // e-commerce only, out of scope here
    /**
     * An account nobody claims goes to UNMAPPED and is shown in the UI, never
     * dropped. v3.69.0 listed only the ADA agency's accounts, so every EGG
     * account fell through a `continue` and its spend disappeared with no
     * error and no visible gap. A registry that silently ignores what it does
     * not recognise is worse than no registry — it looks authoritative.
     */
    const bucket = owner === "SHARED" ? metaShared
      : owner === null ? metaUnmapped
      : (metaByBrand[owner] = metaByBrand[owner] || blank());
    bucket.spend += n(r.spend); bucket.impressions += n(r.impressions); bucket.clicks += n(r.clicks);
    if (!bucket.accounts.includes(r.account_name)) bucket.accounts.push(r.account_name);
  }
  if (metaUnmapped.accounts.length) {
    logJson("WARNING", "meta_accounts_unmapped",
      { accounts: metaUnmapped.accounts, spend: Math.round(metaUnmapped.spend) });
  }
  for (const b of BRANDS) perBrand[b.key].meta = metaByBrand[b.key] || null;

  /**
   * BHQ = the four hospitals combined. NOT the same as "group" / B+, which in
   * BHQ's vocabulary means the 27-branch GA4 property. Naming these the same
   * thing is how a board deck ends up claiming 27 branches' numbers are four.
   *
   * Summing the four brands cannot double-count: a session has exactly one
   * landing page and therefore exactly one brand. This total should match the
   * Overview funnel's Visits figure, which filters all four segments at once —
   * a useful cross-check if the two ever diverge.
   */
  const live = BRANDS.map((b) => perBrand[b.key]).filter((b) => !b.unavailable);
  const chanMerged = new Map();
  const keMerged = new Map();
  for (const b of live) {
    for (const c of (b.channels || [])) {
      const e = chanMerged.get(c.channel) || { channel: c.channel, sessions: 0, engaged: 0 };
      e.sessions += c.sessions; e.engaged += c.engaged;
      chanMerged.set(c.channel, e);
    }
    for (const k of (b.keyEventBreakdown || [])) keMerged.set(k.id, (keMerged.get(k.id) || 0) + k.value);
  }
  const bhq = {
    key: "BHQ", label: "BHQ · all four hospitals",
    sessions: live.reduce((a, b) => a + b.sessions, 0),
    engaged: live.reduce((a, b) => a + b.engaged, 0),
    keyEvents: live.reduce((a, b) => a + b.keyEvents, 0),
    channels: [...chanMerged.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 8),
    keyEventBreakdown: KEY_EVENTS.map((e) => ({ id: e.name, label: e.label, value: keMerged.get(e.name) || 0 }))
      .filter((e) => e.value > 0).sort((a, b) => b.value - a.value),
    meta: (() => {
      const acc = { spend: 0, impressions: 0, clicks: 0, accounts: [] };
      for (const b of live) if (b.meta) {
        acc.spend += b.meta.spend; acc.impressions += b.meta.impressions; acc.clicks += b.meta.clicks;
        acc.accounts.push(...b.meta.accounts);
      }
      return acc.accounts.length ? acc : null;
    })(),
    unavailable: live.length === 0,
  };

  /**
   * Per language: impressions -> visits -> actions. This IS a genuine funnel —
   * each stage is a subset of the one above for the same set of pages — unlike
   * the cross-platform bands, so rates between the stages are meaningful.
   */
  const langBlank = () => ({ impressions: 0, clicks: 0, sessions: 0, keyEvents: 0 });
  const byLang = {};
  for (const k of Object.keys(LOCALES)) byLang[k] = { code: k, label: LOCALES[k], ...langBlank() };
  /**
   * `true` HERE TOO, and its absence was a bug (v3.206.0).
   *
   * v3.180 gave the five traffic buckets a default locale for un-prefixed URLs
   * and left this one alone, on the reasoning that "a Search Console query has
   * no path to fall back from". Wrong field: `page` is a URL, not a query. So
   * on the SAME TABLE, impressions and clicks discarded un-prefixed pages while
   * sessions and actions counted them as Thai — Thai impressions understated
   * against Thai sessions on the same row, which is the kind of internal
   * disagreement nobody can debug from the outside.
   *
   * The genuine no-fallback case is the one below at `byQuery`, where the row
   * really is a search term with no URL.
   */
  // Straight from Search Console, one exact total per locale.
  for (const [code, t] of Object.entries(data.gscLangTotals || {})) {
    if (!t || !byLang[code]) continue;
    byLang[code].impressions += n(t.impressions);
    byLang[code].clicks += n(t.clicks);
  }
  for (const r of (data.langSessions || [])) {
    const l = localeFromPath(r.landing_page, true); if (!l || !byLang[l]) continue;
    byLang[l].sessions += n(r.sessions);
  }
  const keLang = data.langKeyEvents;
  if (keLang && keLang.rows) {
    for (const r of keLang.rows) {
      const l = localeFromPath(r.key, true); if (!l || !byLang[l]) continue;
      byLang[l].keyEvents += r.value;
    }
  }
  const languages = Object.values(byLang)
    .filter((x) => x.impressions || x.sessions || x.keyEvents)
    .sort((a, b) => b.sessions - a.sessions);

  /**
   * GBP by brand. Listings do not map one-to-one to hospitals: Dental belongs
   * to BGH, JMS serves all four and is reported as shared, exactly like the
   * Meta group accounts. Anything unrecognised goes to `unlisted` and is shown,
   * never dropped \u2014 the same rule as unmapped ad accounts.
   */
  const gBlank = () => ({ impressions: 0, calls: 0, website: 0, directions: 0, listings: [] });
  const gbpByBrand = {}, gbpShared = gBlank(), gbpUnlisted = gBlank();
  for (const b of BRANDS) gbpByBrand[b.key] = gBlank();
  for (const r of (data.gbp || [])) {
    const owner = brandForGbpListing(r.location_title);
    const bucket = owner === "SHARED" ? gbpShared : owner ? gbpByBrand[owner] : gbpUnlisted;
    bucket.impressions += n(r.impressions);
    bucket.calls += n(r.call_clicks);
    bucket.website += n(r.website_clicks);
    bucket.directions += n(r.direction_requests);
    if (r.location_title && !bucket.listings.includes(r.location_title)) bucket.listings.push(r.location_title);
  }
  if (gbpUnlisted.listings.length) {
    logJson("WARNING", "gbp_listings_unmapped", { listings: gbpUnlisted.listings });
  }

  /**
   * Reviews per hospital: this period, the year's monthly trend, the lifetime
   * position and the reply rate. Deliberately NO list of unanswered reviews —
   * this report is read by executives, and the review-by-review triage lives on
   * the Google Profile tab, which already flags every unreplied one.
   */
  const reviewsByBrand = (() => {
    /**
     * The hospital's OWN listing only, matching the GBP page beside it. Dental
     * rolls into BGH on the group slides, but a per-hospital review page that
     * silently included a second listing would not reconcile with the GBP page
     * on the same tab.
     */
    const hospitalOnly = (title) => {
      const t = norm(title);
      const b = BRANDS.find((x) => norm(x.gbp[0]) === t);
      return b ? b.key : null;
    };
    const blank = () => ({ count: 0, stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, replied: 0,
      months: new Map(), samples: {} });
    const acc = {}; for (const b of BRANDS) acc[b.key] = blank();
    for (const r of (data.gbpReviews || [])) {
      const st = starOf(r.review_star_rating); if (!st) continue;
      const owner = hospitalOnly(r.location_title);
      if (!owner || !acc[owner]) continue;
      const a = acc[owner];
      const when = String(r.review_create_time || "");
      const month = when.slice(0, 7);
      if (month) {
        const m = a.months.get(month) || { month, count: 0, sum: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
        m.count += 1; m.sum += st; m[`s${st}`] += 1; a.months.set(month, m);
      }
      // In-period slice, from the same year-to-date rows.
      if (when.slice(0, 10) >= from) {
        a.count += 1; a.stars[st] += 1;
        if (String(r.review_reply_comment || "").trim()) a.replied += 1;
        // Keep the most recent commented review at each star level.
        const body = String(r.review_comment || "").trim();
        if (body) {
          const prev = a.samples[st];
          if (!prev || when > prev.when) {
            a.samples[st] = { stars: st, when: when.slice(0, 10),
              reviewer: String(r.review_reviewer || "").slice(0, 40),
              comment: body.slice(0, 220),
              replied: String(r.review_reply_comment || "").trim().length > 0 };
          }
        }
      }
    }
    const life = new Map();
    for (const r of (data.gbpLifetime || [])) {
      const owner = hospitalOnly(r.location_title);
      if (!owner) continue;
      life.set(owner, { total: n(r.review_total_count), avg: n(r.review_average_rating_total) || null });
    }
    return BRANDS.map((b) => {
      const a = acc[b.key];
      const sum = Object.entries(a.stars).reduce((x, [k, v]) => x + Number(k) * v, 0);
      return {
        key: b.key, label: b.label,
        count: a.count, avg: a.count ? +(sum / a.count).toFixed(2) : null,
        stars: a.stars,
        replyRate: a.count ? a.replied / a.count : null,
        replied: a.replied,
        lifetime: life.get(b.key) || null,
        // Every review held, cumulative to the end of the selected period.
        // Not lifetime — Google does not publish the lifetime star split — but
        // not "year to date" either, since the window follows the picker.
        mixToDate: [...a.months.values()].reduce((acc, m) => {
          for (const st of [1, 2, 3, 4, 5]) acc[st] += m[`s${st}`] || 0;
          return acc;
        }, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }),
        samples: [5, 4, 3, 2, 1].map((st) => a.samples[st]
          || (a.stars[st] > 0 ? { stars: st, count: a.stars[st], comment: null } : null)),
        monthly: [...a.months.values()].sort((x, y) => x.month.localeCompare(y.month))
          .map((m) => ({ month: m.month, count: m.count, avg: +(m.sum / m.count).toFixed(2),
            s1: m.s1, s2: m.s2, s3: m.s3, s4: m.s4, s5: m.s5 })),
      };
    });
  })();

  const gbp = {
    byBrand: BRANDS.map((b) => ({ key: b.key, label: b.label, ...gbpByBrand[b.key] })),
    shared: gbpShared.listings.length ? gbpShared : null,
    unlisted: gbpUnlisted.listings.length ? gbpUnlisted : null,
    reviewsByBrand,
    available: data.gbp !== null,
  };

  /**
   * Search Ads, per hospital rather than per group.
   *
   * The brand comes from the CAMPAIGN CODE, not from an ad-account registry:
   * Google Ads uses the same `YYMMDD-NN_brand_objective` convention as Meta, so
   * one pull splits four ways. Campaigns outside the convention (and `bcm`,
   * which is not a hospital) go to `unattributed` and are shown, never spread
   * across the four \u2014 the same rule as unmapped Meta accounts.
   *
   * Visits and actions cost nothing: the per-brand `s_`/`k_` pulls already
   * carry the channel group, so paid search is a filter on rows in hand.
   */
  const searchAds = (() => {
    /**
     * Google Ads traffic in GA4 is "Paid Search", plus the slice of
     * "Cross-network" (Performance Max, Demand Gen) whose source is google.
     * Cross-network is NOT matched on its own \u2014 it would fold in non-Google
     * campaigns and inflate every hospital's funnel.
     */
    const isPaidSearch = (chan, src) => {
      const c = String(chan || "").toLowerCase();
      return c === "paid search" || (c === "cross-network" && /google/i.test(String(src || "")));
    };

    const perBrandTerms = {}; const spendBy = {};
    for (const k of BRAND_KEYS) { perBrandTerms[k] = new Map(); spendBy[k] = { impressions: 0, clicks: 0, spend: 0 }; }
    const unattributed = { impressions: 0, clicks: 0, spend: 0, campaigns: [] };

    for (const r of (data.gadsTerms || [])) {
      const owner = brandFromCampaignCode(r.campaign);
      const imp = n(r.impressions), clk = n(r.clicks), sp = n(r.spend);
      if (owner === null) {
        unattributed.impressions += imp; unattributed.clicks += clk; unattributed.spend += sp;
        const cn = String(r.campaign || "(unnamed)");
        if (unattributed.campaigns.length < 8 && !unattributed.campaigns.includes(cn)) {
          unattributed.campaigns.push(cn);
        }
        continue;
      }
      spendBy[owner].impressions += imp; spendBy[owner].clicks += clk; spendBy[owner].spend += sp;
      const t = String(r.search_term || "").trim(); if (!t) continue;
      const m = perBrandTerms[owner];
      const e = m.get(t) || { term: t, impressions: 0, clicks: 0, spend: 0 };
      e.impressions += imp; e.clicks += clk; e.spend += sp;
      m.set(t, e);
    }

    const byBrand = BRANDS.map((b) => {
      let visits = 0;
      for (const r of (data[`s_${b.key}`] || [])) {
        if (!isPaidSearch(r.session_default_channel_group, r.session_manual_source)) continue;
        visits += n(r.sessions);
      }
      const ev = {};
      const ke = data[`k_${b.key}`];
      for (const r of ((ke && ke.rows) || [])) {
        // key is channel\u0000source
        const [chan, src] = String(r.key).split("\u0000");
        if (!isPaidSearch(chan, src)) continue;
        ev[r.eventName] = (ev[r.eventName] || 0) + r.value;
      }
      // All nine, in value order. A key event that did not fire is a zero row,
      // not a missing one — "no purchases from search ads" is a finding.
      const actions = KEY_EVENTS
        .map((e) => ({ id: e.name, label: e.label, value: ev[e.name] || 0 }))
        .sort((a, b2) => b2.value - a.value);
      const terms = [...perBrandTerms[b.key].values()]
        .map((t) => ({ ...t, ctr: t.impressions ? t.clicks / t.impressions : null }))
        .sort((a, b2) => b2.clicks - a.clicks).slice(0, 20);
      const s = spendBy[b.key];
      return { key: b.key, label: b.label,
        impressions: s.impressions, clicks: s.clicks, spend: s.spend,
        ctr: s.impressions ? s.clicks / s.impressions : null,
        visits, actions, actionsTotal: actions.reduce((a, e) => a + e.value, 0), terms };
    });

    return { available: data.gadsTerms !== null, byBrand,
      unattributed: unattributed.impressions || unattributed.spend ? unattributed : null };
  })();

  /**
   * Referral, per hospital, and who brings QUALITY rather than volume.
   *
   * Costs nothing: the per-brand `s_`/`k_` pulls already carry channel group
   * and source, so this is a filter and a regroup on rows already in hand.
   *
   * Quality here is two ratios, both of which a big but useless referrer fails:
   * engagement rate (GA4's engaged sessions over sessions) and actions per 100
   * sessions. A site can send thousands of visits that bounce; ranking on
   * sessions alone would put it top of the table.
   */
  const referral = (() => {
    /**
     * REFERRER BLACKLIST — MW's list. Add entries here.
     *
     * Substring match on a lowercased source, so "doubleclick" catches every
     * subdomain. These are referrers that are not editorial back links: our own
     * properties, payment gateways, ad and tag infrastructure, translation
     * proxies. They inflate the table without representing anyone choosing to
     * link to us.
     *
     * Nothing is deleted. Blacklisted rows are flagged, not dropped, and the
     * slide carries a switch — the numbers are reported both ways and the
     * default is simply the more useful one.
     */
    const BLACKLIST = [
      // MW's list, Aug 2026. Not editorial back links — internal tools, portals
      // and partner systems that link to us as plumbing, not as endorsement.
      "shop.bedee.com",                                    // partner storefront
      "bangkokhospital.lightning.force.com",               // Salesforce console
      "bangkokhospitalpartnerprogram.rocket-loyalty.app",  // partner loyalty portal
      "canva.com",                                         // design tool previews
      "teams.public.onecdn.static.microsoft",              // Teams link unfurling
      "bangkokhospital.app.agnoshealth.com",               // Agnos partner app
      "bhq-cms-v2.local",                                  // our own CMS, internal
      "excel.officeapps.live.com",                         // links opened from Excel
      "linktr.ee",                                         // link-in-bio hop, not a back link
    ];
    const isBlacklisted = (src) => {
      const s = String(src || "").toLowerCase();
      return BLACKLIST.some((p) => s.includes(String(p).toLowerCase()));
    };
    /**
     * GA4 ADDED AN "AI Assistant" DEFAULT CHANNEL GROUP on 13 May 2026
     * (medium `ai-assistant`), confirmed against the live data. That is the
     * primary signal, because it catches assistants Google recognises without
     * us naming them.
     *
     * Name matching is KEPT alongside it, not replaced, and MW's own numbers
     * show why: `gemini.google.com` arrives as AI Assistant, but `perplexity`
     * lands in Unassigned, `openai` in Organic Search and `felo.ai` in
     * Referral. Google has not published its recognised list and Perplexity is
     * a known omission. A session counts if EITHER signal fires.
     *
     * Three limits follow, all stated on the card:
     *   - The native channel is FORWARD-ONLY from 13 May 2026 and GA4 did not
     *     reclassify history, so a comparison spanning that date compares two
     *     different definitions.
     *   - Referrer-less arrivals still land in Direct and cannot be counted.
     *   - Because half the match is by name, a new assistant stays invisible
     *     until its name is added above.
     */
    const AI_SOURCES = [
      "chatgpt", "openai", "perplexity", "gemini", "bard", "claude", "anthropic",
      "copilot", "poe.com", "you.com", "deepseek", "grok", "x.ai", "mistral",
      "meta.ai", "phind", "genspark", "felo",
    ];
    const isAiSource = (src) => {
      const s = String(src || "").toLowerCase();
      return AI_SOURCES.some((a) => s.includes(a));
    };
    const isAiChannel = (chan) => /^ai\s*assistant/i.test(String(chan || "").trim());
    const isAi = (src, chan) => isAiSource(src) || isAiChannel(chan);
    const shape = (t) => ({ ...t,
      engagementRate: t.sessions ? t.engaged / t.sessions : null,
      actionsPer100: t.sessions ? (t.actions / t.sessions) * 100 : null });

    const byBrand = BRANDS.map((b) => {
      const rows = data[`s_${b.key}`] || [];
      const ke = data[`k_${b.key}`];
      // Key events keyed by channel\u0000source, so they join the session rows.
      const evBySrc = new Map();
      for (const r of ((ke && ke.rows) || [])) {
        const [chan, src] = String(r.key).split("\u0000");
        const k = `${chan}\u0000${src}`;
        const e = evBySrc.get(k) || { total: 0, byName: {} };
        e.total += r.value; e.byName[r.eventName] = (e.byName[r.eventName] || 0) + r.value;
        evBySrc.set(k, e);
      }
      const blank = (source, channel) => ({ source, channel, sessions: 0, engaged: 0, actions: 0, events: {} });
      const refMap = new Map(); const aiMap = new Map();
      let siteSessions = 0;
      const aiEvents = {};
      const aiRef = { sessions: 0, engaged: 0, actions: 0 };
      let aiRefBlacklisted = 0;
      let aiNativeSessions = 0, aiNamedSessions = 0;
      for (const r of rows) {
        const chan = String(r.session_default_channel_group || "(unassigned)");
        const src = String(r.session_manual_source || "(not set)");
        const s = n(r.sessions), eng = n(r.engaged_sessions);
        const ev = evBySrc.get(`${chan}\u0000${src}`) || { total: 0, byName: {} };
        siteSessions += s;
        if (/^referral$/i.test(chan)) {
          const t = refMap.get(src) || blank(src, chan);
          t.sessions += s; t.engaged += eng; t.actions += ev.total;
          // Per-event counts, so the table can show which back links drive
          // Find doctors and Appointments rather than one opaque total.
          for (const [nm, v] of Object.entries(ev.byName)) t.events[nm] = (t.events[nm] || 0) + v;
          refMap.set(src, t);
          // Assistants arriving THROUGH referral, tracked separately: the
          // scorecard ratio is "% of all referral", so numerator and
          // denominator must describe the same channel. Dividing all-channel
          // assistant sessions by referral-only sessions produced 250% in
          // testing — a ratio of two different populations.
          if (isAiSource(src)) {
            aiRef.sessions += s; aiRef.engaged += eng; aiRef.actions += ev.total;
            if (isBlacklisted(src)) aiRefBlacklisted += s;
          }
        }
        if (isAi(src, chan)) {
          const t = aiMap.get(src) || { ...blank(src, chan), channels: new Set() };
          t.sessions += s; t.engaged += eng; t.actions += ev.total;
          // Which signal found it. Reported as a note rather than a column,
          // because it says how much of this depends on our name list still
          // being current — the part that rots.
          if (isAiChannel(chan)) aiNativeSessions += s; else aiNamedSessions += s;
          // Every channel this assistant landed in, as a Set: a substring
          // check would treat "Paid Search" as already covered by "Search".
          t.channels.add(chan);
          // Per-assistant event counts, for the columns in the table.
          for (const [nm, v] of Object.entries(ev.byName)) t.events[nm] = (t.events[nm] || 0) + v;
          aiMap.set(src, t);
          for (const [nm, v] of Object.entries(ev.byName)) aiEvents[nm] = (aiEvents[nm] || 0) + v;
        }
      }
      const referrers = [...refMap.values()]
        .map((t) => ({ ...shape(t), blacklisted: isBlacklisted(t.source) }))
        .sort((a, b2) => b2.sessions - a.sessions);
      const ai = [...aiMap.values()]
        .map((t) => {
          const list = [...t.channels].sort();
          return { ...shape(t), channels: undefined,
            channel: list.slice(0, 3).join(", ") + (list.length > 3 ? ` +${list.length - 3}` : "") };
        })
        .sort((a, b2) => b2.sessions - a.sessions);
      const totals = (list) => shape(list.reduce((a, t) => ({
        sessions: a.sessions + t.sessions, engaged: a.engaged + t.engaged, actions: a.actions + t.actions,
      }), { sessions: 0, engaged: 0, actions: 0 }));
      const refTotalAll = totals(referrers);
      const kept = referrers.filter((r) => !r.blacklisted);
      const refTotalClean = totals(kept);
      const aiTotal = totals(ai);
      /**
       * AI share is measured against REFERRAL sessions (MW), and against the
       * clean total when the blacklist is on, so both halves of the ratio
       * describe the same population.
       *
       * It can exceed 100%: assistants are counted wherever GA4 files them,
       * including Organic Search and Cross-network, while the denominator is
       * the Referral channel alone. That is a real property of the ratio, not
       * a bug, and the card says so.
       */
      const aiShare = (base, aiSessions) =>
        (base && base.sessions ? aiSessions / base.sessions : null);
      // Site-wide baseline, so "good" is measured against this hospital's own
      // average rather than an absolute anyone would have to invent.
      let allEngaged = 0, allActions = 0;
      for (const r of rows) allEngaged += n(r.engaged_sessions);
      for (const r of ((ke && ke.rows) || [])) allActions += r.value;
      const site = shape({ sessions: siteSessions, engaged: allEngaged, actions: allActions });
      return { key: b.key, label: b.label,
        referrers: referrers.slice(0, 20),
        referrerCount: referrers.length,
        blacklistedCount: referrers.length - kept.length,
        blacklistActive: BLACKLIST.length > 0,
        totals: refTotalClean, totalsAll: refTotalAll,
        ai: { rows: ai, totals: aiTotal,
          actions: KEY_EVENTS.map((e) => ({ id: e.name, label: e.label, value: aiEvents[e.name] || 0 }))
            .sort((a, b2) => b2.value - a.value),
          nativeSessions: aiNativeSessions,
          namedSessions: aiNamedSessions,
          referralSessions: aiRef.sessions - aiRefBlacklisted,
          referralSessionsAll: aiRef.sessions,
          shareOfReferral: aiShare(refTotalClean, aiRef.sessions - aiRefBlacklisted),
          shareOfReferralAll: aiShare(refTotalAll, aiRef.sessions),
          siteShare: siteSessions ? aiTotal.sessions / siteSessions : null },
        site };
    });
    return { byBrand };
  })();


  /**
   * Content performance, per hospital and locale. Four types, each paired with
   * the one action that matters for it (MW):
   *   Doctor -> Appointments, Package -> Add to cart,
   *   Articles -> View item, Center -> Contact us.
   *
   * The path carries type, hospital and locale, so two group-wide pulls bucket
   * into every combination at once.
   */
  /**
   * CHAT BUBBLE channels. Rules are ordered and FIRST MATCH WINS, so the
   * URL-qualified variants must come before their bare id.
   *
   * Two ids carry two different channels each, separable only by URL:
   *   - `line` is Thai or Japanese, told apart by `@bhqjp`.
   *   - `whatsapp` is two numbers.
   * And there are two distinct messenger ids.
   *
   * TWO LABELS ARE MW'S TO CONFIRM, marked `assumed` below: which WhatsApp is
   * the Arabic one, and which messenger id is Burmese. Nothing distinguishes
   * them in the tracking itself — a click id does not carry a language — so
   * these are the one place in this block that is a guess rather than a
   * reading. They are labelled and flagged in the UI rather than quietly
   * asserted, and each is a one-line change.
   */
  const CHAT_CHANNELS = [
    { id: "line",     url: "@bhqjp",        label: "LINE (\u65e5\u672c\u8a9e)", logo: "line", order: 6 },
    { id: "line",     url: null,            label: "LINE",                      logo: "line", order: 5 },
    { id: "whatsapp", url: "66641405673",   label: "WhatsApp (\u0627\u0644\u0639\u0631\u0628\u064a\u0629)", logo: "whatsapp", order: 2 },
    { id: "whatsapp", url: "wa.me/message", label: "WhatsApp",                  logo: "whatsapp", order: 10 },
    { id: "whatsapp", url: null,            label: "WhatsApp (other)",          logo: "whatsapp", order: 11 },
    /**
     * MESSENGER IDS ARE SWAPPED relative to the first guess.
     *
     * MW's figures: Messenger 84, Messenger (Burmese) 44 — the plain label is
     * the LARGER. The first mapping had `facebook-messenger` as Burmese, which
     * put the larger count under the Burmese label. Corrected from the data.
     */
    { id: "facebook-messenger", url: null,  label: "Messenger",                 logo: "messenger", order: 3 },
    { id: "messenger", url: null,           label: "Messenger (\u1019\u103c\u1014\u103a\u1019\u102c\u1018\u102c\u101e\u102c)", logo: "messenger", order: 4 },
    { id: "telegram", url: null,            label: "Telegram",                  logo: "telegram", order: 1 },
    { id: "zalo",     url: null,            label: "ZALO",                      logo: "zalo", order: 7 },
    { id: "wechat",   url: null,            label: "\u5fae\u4fe1 WeChat",       logo: "wechat", order: 8 },
    { id: "webchat",  url: null,            label: "Webchat (TH/EN)",           logo: "webchat", order: 9 },
  ];
  const chatBubble = (() => {
    /**
     * Normalise both shapes to { pagePath, id, url } so the tally does not care
     * which source it came from. The custom event is preferred whenever it
     * returned rows; the link event is the fallback.
     */
    const fromCustom = (rows) => (rows || []).map((r) => ({
      pagePath: r.pagePath, id: r["customEvent:Click_ID"], url: r["customEvent:Click_URL"],
      eventName: "click_chat_bubble", eventCount: r.eventCount,
    }));
    const fromLink = (rows) => (rows || []).map((r) => ({
      pagePath: r.pagePath, id: r.linkId, url: r.linkUrl,
      eventName: r.eventName, eventCount: r.eventCount,
    }));
    const customOk = Array.isArray(data.chatCustom) && data.chatCustom.length > 0;
    const source = customOk ? "click_chat_bubble" : "click (enhanced measurement)";
    const cur = customOk ? fromCustom(data.chatCustom) : fromLink(data.chatBubble);
    const was = customOk ? fromCustom(data.chatCustomPrev) : fromLink(data.chatBubblePrev);
    if (!cur.length && data.chatBubble === null) return { available: false };
    /**
     * `facebook-messenger` contains `messenger`, so the two must not merge.
     *
     * TWO independent things stop that, and negative controls show EITHER
     * alone is sufficient: the segment match (`facebook-messenger` is not
     * `messenger` and does not start with `messenger-`), and the longest-id
     * sort below, which picks the more specific rule when both match. Neither
     * control fails on its own; the redundancy is deliberate, and neither
     * should be removed on the grounds that the tests stay green without it.
     */
    const matchChannel = (linkId, linkUrl) => {
      const id = String(linkId || "").toLowerCase();
      const url = String(linkUrl || "").toLowerCase();
      const seg = (id.split("chat-bubble-channel-")[1] || "").split(/[|,\s]/)[0];
      const candidates = CHAT_CHANNELS
        .filter((c) => seg === c.id || seg.startsWith(`${c.id}-`) || id.includes(`channel-${c.id}`))
        .sort((a, b) => b.id.length - a.id.length);
      // URL-qualified rules first; the unqualified one is the fallback.
      return candidates.find((c) => c.url && url.includes(c.url.toLowerCase()))
        || candidates.find((c) => !c.url)
        || null;
    };
    /**
     * Brand from the page the click happened on.
     *
     * Resolved locally rather than calling `brandForPath`, which is declared
     * ~1,000 lines BELOW this IIFE — referencing it here throws "Cannot access
     * before initialization". Third time this file's declaration order has set
     * that trap (v3.100.0 `keMonthly`, v3.106.0 `LANG_ORDER`), and the first
     * two only surfaced because something else was being tested at the time.
     */
    const brandOfPath = (path) => {
      const m = String(path || "").match(/^\/(?:[a-z]{2}\/)?([a-z-]+)(?:[/?]|$)/i);
      if (!m) return null;
      const b = brandBySegment(norm(m[1]));
      return b ? b.key : null;
    };
    const tally = (rows) => {
      const per = {};     // brandKey|BHQ -> label -> clicks
      const opens = {};   // brandKey|BHQ -> bubble opens
      const events = {};
      /**
       * Kept in the PAYLOAD but off the slide (MW removed the footer). An
       * unrecognised channel id on an in-scope page would otherwise vanish with
       * no trace anywhere — the silent-zero failure this project keeps getting
       * bitten by. Not rendered; available when something looks wrong.
       */
      const unmapped = {};
      const add = (scope, label, v) => {
        per[scope] = per[scope] || {};
        per[scope][label] = (per[scope][label] || 0) + v;
      };
      for (const r of (rows || [])) {
        const v = n(r.eventCount); if (!v) continue;
        const linkId = r.id, linkUrl = r.url;
        /**
         * OUT-OF-SCOPE PAGES ARE DROPPED FIRST (MW: ignore anything not under
         * /bangkok*). The bubble runs on other branches too, and their clicks
         * were being counted into BHQ — the previous version added to the BHQ
         * scope before checking the brand, so the group total included branches
         * that are not BHQ. That is the B+/BHQ conflation the whole project
         * guards against, and it was in the total.
         */
        const b = brandOfPath(pagePath(r.pagePath));
        if (!b) continue;
        const id = String(linkId || "").toLowerCase();
        events[String(r.eventName || "(unnamed)")] = (events[String(r.eventName || "(unnamed)")] || 0) + v;
        // The bubble being opened, which is the headline figure.
        if (id.includes("top-parent")) {
          opens.BHQ = (opens.BHQ || 0) + v;
          opens[b] = (opens[b] || 0) + v;
          continue;
        }
        const ch = matchChannel(linkId, linkUrl);
        if (!ch) {
          const k = `${linkId || "(no id)"} ${linkUrl || ""}`.trim();
          unmapped[k] = (unmapped[k] || 0) + v;
          continue;
        }
        add("BHQ", ch.label, v);
        add(b, ch.label, v);
      }
      return { per, opens, events, unmapped };
    };
    const now = tally(cur);
    const prev = tally(was);
    /**
     * THE TWO EVENTS DISAGREE, by roughly 5x on the same channels.
     *
     * BGH, July: the GTM event reports 503 channel clicks across 10 channels;
     * enhanced measurement reported 2,414 across 8. The Looker deck's
     * magnitudes match the enhanced-measurement figures, so that is what the
     * old deck counts.
     *
     * Neither is provably right from here, and they are not measuring quite the
     * same thing: enhanced measurement fires on every outbound anchor click and
     * STRUCTURALLY CANNOT SEE Webchat or WeChat, which are not outbound links.
     * The GTM event sees all ten and is one consistent method.
     *
     * The GTM event is displayed, and the alternative total is carried in the
     * payload so the gap is measurable rather than a matter of memory.
     */
    const altTally = customOk ? tally(fromLink(data.chatBubble)) : null;
    const altChannelClicks = altTally
      ? Object.values(altTally.per.BHQ || {}).reduce((a, v) => a + v, 0) : null;
    const scopeRows = (scope) => {
      const cur = now.per[scope] || {};
      const was = prev.per[scope] || {};
      const opens = now.opens[scope] || 0;
      const opensPrev = prev.opens[scope] || 0;
      const seen = [...new Set([...CHAT_CHANNELS.map((c) => c.label), ...Object.keys(cur)])];
      const rows = seen.map((label) => {
        const cfg = CHAT_CHANNELS.find((c) => c.label === label) || {};
        return { label, logo: cfg.logo || null, assumed: !!cfg.assumed, order: cfg.order,
          clicks: cur[label] || 0, prev: was[label] || 0,
          change: (cur[label] || 0) - (was[label] || 0) };
      /**
       * NOT RANKED BY CLICKS (MW). Rows come out in a FIXED `order` taken from
       * the reference deck, interleaved so a two-column row-wise grid
       * reproduces that layout and related channels sit side by side (LINE with
       * LINE JP, Messenger with Messenger MM).
       *
       * The point is position stability: a channel sits in the same place every
       * month, so this month's slide can be laid beside last month's. Ranking
       * by clicks moves cards whenever two channels swap places, which is what
       * makes a deck hard to skim.
       *
       * `order` is a separate field from the array order on purpose — the array
       * order is what the URL-qualified matching rules depend on, and display
       * must not be able to disturb it.
       */
      })
        /**
         * EVERY configured channel is kept, even at zero both months (MW: cards
         * were missing on BIH and WSH). A card that disappears when a channel
         * goes quiet breaks the fixed layout the order exists to provide, and
         * "nobody used Messenger this month" is a finding, not an absence.
         *
         * The exception is `WhatsApp (other)` — a catch-all for a number we do
         * not recognise, which is noise unless it actually fired.
         */
        .filter((r) => r.order <= 10 || r.clicks || r.prev)
        .sort((a, b) => (a.order || 99) - (b.order || 99));
      /**
       * `total` is bubble OPENS (`chat-bubble-top-parent`), not the sum of
       * channel clicks. They are different acts and the sum would overstate:
       * one person can open the bubble and click two channels.
       */
      const channelClicks = rows.reduce((a, r) => a + r.clicks, 0);
      const channelPrev = rows.reduce((a, r) => a + r.prev, 0);
      /**
       * `chat-bubble-top-parent` is the preferred headline, but GA4 only
       * populates `link_id` for real <a> clicks — if that id sits on a div
       * launcher the parameter never arrives and opens read 0. Rather than
       * print a confident zero, fall back to channel clicks and SAY which one
       * is being shown, so the number is never silently the wrong quantity.
       */
      const hasOpens = opens > 0;
      return { rows,
        total: hasOpens ? opens : channelClicks,
        totalPrev: hasOpens ? opensPrev : channelPrev,
        basis: hasOpens ? "opens" : "channels",
        opens, channelClicks,
        totalChangePct: (() => {
          const cur = hasOpens ? opens : channelClicks;
          const was = hasOpens ? opensPrev : channelPrev;
          return was ? (cur - was) / was : null;
        })() };
    };
    /**
     * Total `contact_us` key events per hospital, for the Contact Us share.
     *
     * Free: the per-brand `k_` pulls are already in hand. BHQ is the sum of the
     * four, not a separate pull, so the share and its denominator describe the
     * same population at both scopes.
     */
    const contactUs = { BHQ: 0 };
    for (const b of BRANDS) {
      const ke = data[`k_${b.key}`];
      let t = 0;
      for (const r of ((ke && ke.rows) || [])) if (r.eventName === "contact_us") t += r.value;
      contactUs[b.key] = t;
      contactUs.BHQ += t;
    }
    const byScope = { BHQ: scopeRows("BHQ") };
    for (const b of BRANDS) byScope[b.key] = scopeRows(b.key);
    /**
     * BHQ share (MW): this hospital's clicks as a proportion of all four.
     *
     * Measured on the SAME quantity the headline shows — bubble clicks against
     * bubble clicks — so the ratio describes one population. BHQ's own share is
     * 100% by definition and is not shown as a comparison.
     */
    for (const k of Object.keys(byScope)) {
      const sc = byScope[k];
      sc.bhqShare = (k !== "BHQ" && byScope.BHQ.total)
        ? sc.total / byScope.BHQ.total : null;
      /**
       * Chat's share of all Contact us intent (MW). Numerator is bubble clicks,
       * denominator every `contact_us` key event for the same scope.
       *
       * These are two different measurements of the same intent, not a subset
       * and its whole, so the ratio can exceed 100% — a person who opens the
       * bubble may never fire `contact_us`, and vice versa. The card names the
       * denominator so the figure cannot be read as "share of a total that
       * contains it".
       */
      sc.contactUs = contactUs[k] || 0;
      sc.contactUsShare = sc.contactUs ? sc.total / sc.contactUs : null;
    }
    return { available: true, byScope, source, altChannelClicks,
      // Which GA4 events these clicks actually arrived under, so a channel
      // reading zero can be told apart from a channel tracked under an event
      // nobody expected.
      events: Object.entries(now.events).map(([name, clicks]) => ({ name, clicks }))
        .sort((a, b) => b.clicks - a.clicks),
      unmapped: Object.entries(now.unmapped).map(([key, clicks]) => ({ key, clicks }))
        .sort((a, b) => b.clicks - a.clicks).slice(0, 12),
    };
  })();

  /**
   * APPOINTMENTS. Initiates is the GA4 `appointments` key event; everything
   * else comes from the sheet. Both scopes are built so the card can show one
   * hospital or all four.
   *
   * The completion rate is completes over INITIATES, two systems measuring two
   * ends of the same funnel — GA4 sees the form open, the sheet sees the
   * booking land. They can disagree for real reasons (a booking made twice, a
   * form opened and abandoned), so the card names both sides.
   */
  const appointments = (() => {
    const sheet = data.appointments;
    if (!sheet) return { available: false };
    const initiatesFor = (key) => {
      let t = 0;
      const keys = key === "BHQ" ? BRAND_KEYS : [key];
      for (const k of keys) {
        const ke = data[`k_${k}`];
        for (const r of ((ke && ke.rows) || [])) if (r.eventName === "appointments") t += r.value;
      }
      return t;
    };
    const byScope = {};
    for (const k of Object.keys(sheet.byScope)) {
      const sc = sheet.byScope[k];
      const initiates = initiatesFor(k);
      byScope[k] = { ...sc, initiates,
        completionRate: initiates ? sc.completes / initiates : null };
    }
    return { available: true, byScope,
      discarded: sheet.discarded, revMonths: sheet.revMonths,
      notSpecified: sheet.notSpecified };
  })();

  const CONTENT_TYPES = [
    { id: "doctor",  segment: "doctor",        label: "Doctor",   action: "appointments" },
    /**
     * `hideMix` suppresses the "what actually fires" footer (MW).
     *
     * On a package page `view_item` IS the page view — it fires on arrival, so
     * it dwarfs everything and would permanently "suggest" replacing Add to
     * cart with a restatement of the Views column already beside it. The
     * comparison is meaningless here, so it is not shown rather than shown and
     * explained away.
     */
    { id: "package", segment: "package",       label: "Package",  action: "add_to_cart", hideMix: true },
    // Contact us, not view_item (MW, confirmed from live data: Contact us 22.6K
    // against View item 28 on article pages). `view_item` is an ecommerce event
    // that fires on package pages; on an article it was always going to be ~0.
    { id: "article", segment: "content",       label: "Articles", action: "contact_us" },
    { id: "center",  segment: "center-clinic", label: "Center",   action: "contact_us" },
  ];
  /**
   * CATEGORY PAGES, excluded from the content tables (MW).
   *
   * `/package/health-check-up-packages` is a listing of packages, not a
   * package. It outranks every real package on views while representing no
   * single thing anyone can act on, so it crowds the top of the table and tells
   * you nothing. Matched on the slug, exactly, per type.
   */
  const CONTENT_EXCLUDE = {
    package: ["health-check-up-packages"],
  };
  const content = (() => {
    if (data.contentViews === null) return { available: false };
    const SEG_TO_TYPE = Object.fromEntries(CONTENT_TYPES.map((t) => [t.segment, t.id]));
    /**
     * `/{locale}/{brand}/{segment}/{slug}`. The locale is optional in the
     * pattern because a path without one still names a real page; it simply
     * cannot be filed under a language tab.
     *
     * The slug capture takes the WHOLE remainder, not one segment:
     * `/package/x` and `/package/x/details` are different pages, and capturing
     * only the first segment labelled both of them "x".
     */
    const PAGE_RE = /^\/(?:([a-z]{2})\/)?([a-z-]+)\/(doctor|package|content|center-clinic)\/([^?#]+)/i;
    const parse = (raw) => {
      const path = pagePath(raw);
      const m = PAGE_RE.exec(path);
      if (!m) return null;
      const brand = brandBySegment(norm(m[2]));
      if (!brand) return null;                       // out-of-scope branch
      const type = SEG_TO_TYPE[String(m[3]).toLowerCase()];
      if (!type) return null;
      const locale = (m[1] || "").toLowerCase();
      return { path, brand: brand.key, type,
        slug: String(m[4]).replace(/\/+$/, ""),
        locale: LOCALES[locale] ? locale : null };
    };

    // Events first, so views rows can pick their action up by path.
    const evByPath = new Map();
    for (const r of (data.contentEvents || [])) {
      const path = pagePath(r.pagePath);
      const name = String(r.eventName || "");
      const e = evByPath.get(path) || {};
      e[name] = (e[name] || 0) + n(r.eventCount);
      evByPath.set(path, e);
    }

    const bucket = new Map();   // brand \u0000 locale \u0000 type -> Map(path -> row)
    let unmatched = 0, excluded = 0;
    for (const r of (data.contentViews || [])) {
      const p = parse(r.pagePath);
      if (!p) { unmatched += n(r.screenPageViews); continue; }
      if (!p.locale) continue;
      // Category pages are dropped before bucketing, so they cannot appear in a
      // top-10 nor inflate that type's totals.
      if ((CONTENT_EXCLUDE[p.type] || []).includes(p.slug)) { excluded += n(r.screenPageViews); continue; }
      const k = `${p.brand}\u0000${p.locale}\u0000${p.type}`;
      const m = bucket.get(k) || new Map();
      // Several titles can share a path (A/B tests, title changes mid-month);
      // views are summed and the first title kept rather than duplicating rows.
      const row = m.get(p.path) || { path: p.path, slug: p.slug,
        title: String(r.pageTitle || "").trim(), views: 0, action: 0 };
      row.views += n(r.screenPageViews);
      m.set(p.path, row);
      bucket.set(k, m);
    }
    /**
     * Per-page action for the column, and per-TYPE mix of all nine events.
     * The mix is what answers "is this column the right event for these
     * pages" — it is measured, not assumed.
     */
    const mixByType = {};
    for (const t of CONTENT_TYPES) mixByType[t.id] = {};
    for (const [k, m] of bucket) {
      const type = k.split("\u0000")[2];
      const action = (CONTENT_TYPES.find((t) => t.id === type) || {}).action;
      for (const row of m.values()) {
        const ev = evByPath.get(row.path) || {};
        row.action = ev[action] || 0;
        for (const [nm, v] of Object.entries(ev)) {
          mixByType[type][nm] = (mixByType[type][nm] || 0) + v;
        }
      }
    }
    const mixFor = (type) => KEY_EVENTS
      .map((e) => ({ id: e.name, label: e.label, value: mixByType[type][e.name] || 0 }))
      .sort((a, b2) => b2.value - a.value);

    const byBrand = {};
    for (const b of BRANDS) {
      byBrand[b.key] = {};
      for (const lc of Object.keys(LOCALES)) {
        const cell = {};
        let any = 0;
        for (const t of CONTENT_TYPES) {
          const m = bucket.get(`${b.key}\u0000${lc}\u0000${t.id}`);
          const rows = m ? [...m.values()].sort((x, y) => y.views - x.views) : [];
          cell[t.id] = { rows: rows.slice(0, 10), pageCount: rows.length,
            views: rows.reduce((a, r) => a + r.views, 0),
            actions: rows.reduce((a, r) => a + r.action, 0) };
          any += cell[t.id].views;
        }
        cell.hasData = any > 0;
        byBrand[b.key][lc] = cell;
      }
    }
    /**
     * Locale labels travel WITH the payload. The client has no locale table of
     * its own, and duplicating one there would be a second place for the
     * language list to drift.
     *
     * `LOCALES` (module scope) rather than `LANG_ORDER`, which is declared
     * ~260 lines BELOW this IIFE — reading it here throws "Cannot access
     * before initialization" the moment this runs. Same temporal dead zone that
     * took down `buildBenchmark` (v3.100.0); the difference is this one was
     * caught before shipping.
     */
    /**
     * `suggestedAction` is the event that ACTUALLY fires most on this type's
     * pages, and it is only reported when it beats the configured column by a
     * clear margin.
     *
     * STRICTLY GREATER, and by more than 20%: an earlier version suggested a
     * swap whenever the top event had a different id, so a TIE produced a
     * confident "the column is wrong" warning pointing at whichever event
     * happened to sort first. A warning that fires on noise gets ignored, and
     * then the real one (Articles) gets ignored with it.
     */
    const types = CONTENT_TYPES.map(({ id, label, action, hideMix }) => {
      const mix = mixFor(id);
      const configured = mix.find((e) => e.id === action);
      const configuredValue = configured ? configured.value : 0;
      const top = mix.find((e) => e.value > 0) || null;
      const clearlyBetter = top && top.id !== action && top.value > configuredValue * 1.2;
      return { id, label, action, hideMix: !!hideMix,
        actionLabel: (KEY_EVENTS.find((e) => e.name === action) || {}).label || action,
        actionValue: configuredValue,
        // Both suppressed together: a suggestion with no mix behind it would be
        // an assertion the reader cannot check.
        mix: hideMix ? [] : mix.slice(0, 4),
        suggestedAction: (!hideMix && clearlyBetter) ? top : null };
    });
    return { available: true, byBrand, unmatchedViews: unmatched, excludedViews: excluded,
      excluded: CONTENT_EXCLUDE,
      locales: Object.keys(LOCALES).map((k) => ({ key: k, label: LOCALES[k] })),
      types };
  })();

  /**
   * Organic social. Facebook page reach INCLUDES Boost Post, and a TikTok view
   * is not an impression, so the two are reported side by side and never summed
   * — same reasoning as the Overview funnel (§v3.68.0).
   */
  const social = {
    facebook: data.fbOrganic === null ? null : {
      reach: sumOrNull(data.fbOrganic, "page_impressions"),
      engagements: sumOrNull(data.fbOrganic, "post_engagements"),
    },
    tiktok: data.ttOrganic === null ? null : {
      views: sumOrNull(data.ttOrganic, "video_views"),
      likes: sumOrNull(data.ttOrganic, "likes"),
      comments: sumOrNull(data.ttOrganic, "comments"),
      shares: sumOrNull(data.ttOrganic, "shares"),
    },
  };

  /**
   * TikTok, two slides: the channel, and its top performing posts.
   *
   * ONE HONESTY NOTE THAT DRIVES THE LABELLING. `unique_video_views` is the
   * DAILY reached audience, so summing it over a month counts a person who
   * watched on Tuesday and Thursday twice. It is an upper bound on monthly
   * unique reach, not unique reach, and the card says so. The same trap as
   * `page_follows` (v3.96.0), in the other direction: that one must never be
   * summed, this one may be but must not be renamed.
   */
  const tiktok = (() => {
    if (data.ttOrganic === null) return { available: false };
    const rows = data.ttOrganic || [];
    const sum = (f) => rows.reduce((a, r) => a + n(r[f]), 0);

    // Several accounts would mean several rows per date, so the daily series
    // sums across accounts rather than assuming one channel.
    const byDate = new Map();
    for (const r of rows) {
      const d0 = String(r.date || "").slice(0, 10); if (!d0) continue;
      byDate.set(d0, (byDate.get(d0) || 0) + n(r.video_views));
    }
    const daily = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      // `d` is the label key drawChart reads; `date` would render blank axes.
      .map(([d0, views]) => ({ d: d0, views }));
    const accounts = [...new Set(rows.map((r) => String(r.account_name || "").trim()).filter(Boolean))];

    const channel = {
      views: sum("video_views"),
      reach: sum("unique_video_views"),
      profileViews: sum("profile_views"),
      likes: sum("likes"), comments: sum("comments"), shares: sum("shares"),
      bioLinkClicks: sum("bio_link_clicks"), phoneClicks: sum("phone_number_clicks"),
      daily, accounts,
    };

    /**
     * Top performers. Rates are computed on VIEWS and the card says so — the
     * connector publishes no rate field, so this is our definition rather than
     * TikTok's, and the LS deck may well divide by reach instead.
     *
     * Rate rankings ignore posts under MIN_RATE_VIEWS. Without a floor a video
     * seen three times and liked once tops the board at 33%, which is noise
     * wearing a percentage sign.
     */
    const MIN_RATE_VIEWS = 100;
    const vids = [];
    for (const r of (data.ttVideos || [])) {
      const id = String(r.video_id || "").trim(); if (!id) continue;
      vids.push({
        id, caption: String(r.video_caption || "").trim(),
        thumb: String(r.video_thumbnail_url || "").trim(),
        url: String(r.video_share_url || "").trim(),
        views: n(r.video_views_count), reach: n(r.video_reach),
        likes: n(r.video_likes), comments: n(r.video_comments),
        shares: n(r.video_shares), favorites: n(r.video_favorites),
      });
    }
    const topBy = (metric) => {
      const best = vids.slice().sort((a, b) => b[metric] - a[metric])[0];
      return best && best[metric] > 0 ? { ...best, metric, value: best[metric] } : null;
    };
    const topRate = (metric) => {
      const eligible = vids.filter((v) => v.views >= MIN_RATE_VIEWS);
      const scored = eligible.map((v) => ({ ...v, metric, rate: v.views ? v[metric] / v.views : 0 }));
      const best = scored.sort((a, b) => b.rate - a.rate)[0];
      return best && best.rate > 0 ? best : null;
    };
    const top = {
      views: topBy("views"), comments: topBy("comments"),
      shares: topBy("shares"), favorites: topBy("favorites"),
      likeRate: topRate("likes"), commentRate: topRate("comments"),
      shareRate: topRate("shares"), favoriteRate: topRate("favorites"),
      videoCount: vids.length, minRateViews: MIN_RATE_VIEWS,
      available: data.ttVideos !== null,
    };
    return { available: true, channel, top };
  })();

  /** Month-by-month sessions per hospital, plus MoM / YoY on the headline. */
  const monthsSet = new Set();
  const seriesByBrand = {};
  for (const b of BRANDS) {
    const m = new Map();
    for (const r of (data[`m_${b.key}`] || [])) {
      const key = String(r.date || "").slice(0, 7); if (!key) continue;
      monthsSet.add(key);
      m.set(key, (m.get(key) || 0) + n(r.sessions));
    }
    seriesByBrand[b.key] = m;
  }
  const months = [...monthsSet].sort();
  const sumSessions = (rows) => rows === null ? null : rows.reduce((a, r) => a + n(r.sessions), 0);
  /** Group total for a comparison window, summed from the per-brand pulls. */
  const sumBrandWindow = (prefix) => {
    const parts = BRANDS.map((b) => sumSessions(data[`${prefix}${b.key}`]));
    return parts.every((v) => v === null) ? null : parts.reduce((a, v) => a + n(v), 0);
  };
  const chg = (now, before) => (before && before > 0) ? (now - before) / before : null;

  const usersOverview = {
    months,
    series: BRANDS.map((b) => ({
      key: b.key, label: b.label,
      data: months.map((m) => seriesByBrand[b.key].get(m) || 0),
    })),
    total: bhq.sessions,
    mom: chg(bhq.sessions, sumBrandWindow("p_")),
    yoy: chg(bhq.sessions, sumBrandWindow("y_")),
    byBrand: BRANDS.map((b) => {
      const cur = perBrand[b.key].sessions;
      return { key: b.key, label: b.label, sessions: cur,
        mom: chg(cur, sumSessions(data[`p_${b.key}`])),
        yoy: chg(cur, sumSessions(data[`y_${b.key}`])) };
    }),
    windows: cwr,
  };

  /** Top countries outside Thailand, per hospital, with MoM. */
  const THAI = new Set(["thailand", "th"]);
  const countries = BRANDS.map((b) => {
    const cur = new Map(), prev = new Map();
    for (const r of (data[`c_${b.key}`] || [])) cur.set(String(r.country || ""), n(r.sessions));
    for (const r of (data[`cp_${b.key}`] || [])) prev.set(String(r.country || ""), n(r.sessions));
    const rows = [...cur.entries()]
      .filter(([c]) => c && !THAI.has(norm(c)) && norm(c) !== "(not set)")
      .map(([country, sessions]) => {
        const was = prev.get(country);
        return { country, sessions, mom: (was && was > 0) ? (sessions - was) / was : null };
      })
      .sort((x, y) => y.sessions - x.sessions).slice(0, 5);
    return { key: b.key, label: b.label, rows };
  });

  /**
   * Foreign Language Versions: hospital x locale, sessions and MoM.
   * A landing page carries both facts — the branch segment and the locale — so
   * one pull fills all forty cells.
   */
  const brandForPath = (path) => {
    const m = String(path || "").match(/^\/(?:[a-z]{2}\/)?([a-z-]+)(?:[/?]|$)/i);
    if (!m) return null;
    const b = brandBySegment(norm(m[1]));
    return b ? b.key : null;
  };
  const langCell = {};
  for (const b of BRANDS) { langCell[b.key] = {}; for (const l of Object.keys(LOCALES)) langCell[b.key][l] = { sessions: 0, prev: 0 }; }
  const fillLang = (rows, field) => {
    for (const r of (rows || [])) {
      const bk = brandForPath(r.landing_page); if (!bk) continue;
      const lc = localeFromPath(r.landing_page, true); if (!lc || !langCell[bk][lc]) continue;
      langCell[bk][lc][field] += n(r.sessions);
    }
  };
  fillLang(data.langSessions, "sessions");
  fillLang(data.langSessionsPrev, "prev");

  // Column order taken from the LS deck rather than the LOCALES declaration,
  // so the two can be read side by side during the changeover.
  const LANG_ORDER = ["th", "en", "ja", "zh", "my", "km", "ar", "vn", "de", "id"];
  const languageMatrix = {
    locales: LANG_ORDER.map((k) => ({ code: k.toUpperCase(), label: LOCALES[k], key: k })),
    rows: BRANDS.map((b) => ({
      key: b.key, label: b.label,
      cells: LANG_ORDER.map((l) => {
        const c = langCell[b.key][l];
        return { key: l, sessions: c.sessions, mom: c.prev > 0 ? (c.sessions - c.prev) / c.prev : null };
      }),
    })),
    available: data.langSessions !== null,
  };

  /**
   * Actions by language, per hospital AND for BHQ combined.
   *
   * A landing page carries the hospital, the locale and the page metrics, and
   * ga4KeyEvents already returns key events keyed by landing page — so the whole
   * grid comes out of pulls that were already being made. `__BHQ` accumulates
   * every in-scope page so the combined view is a real sum, not an average.
   */
  const ALB = {};
  const albBlank = () => ({ views: 0, sessions: 0, revenue: 0, events: {}, prevEvents: {} });
  for (const k of [...BRAND_KEYS, "BHQ"]) {
    ALB[k] = {}; for (const l of Object.keys(LOCALES)) ALB[k][l] = albBlank();
  }
  for (const r of (data.langSessions || [])) {
    const bk = brandForPath(r.landing_page); if (!bk) continue;
    const lc = localeFromPath(r.landing_page, true); if (!lc || !ALB[bk][lc]) continue;
    for (const target of [ALB[bk][lc], ALB.BHQ[lc]]) {
      target.views += n(r.screen_page_views);
      target.sessions += n(r.sessions);
      target.revenue += n(r.purchase_revenue);
    }
  }
  const fillEvents = (src, field) => {
    for (const r of ((src && src.rows) || [])) {
      const bk = brandForPath(r.key); if (!bk) continue;
      const lc = localeFromPath(r.key, true); if (!lc || !ALB[bk][lc]) continue;
      for (const target of [ALB[bk][lc], ALB.BHQ[lc]]) {
        target[field][r.eventName] = (target[field][r.eventName] || 0) + r.value;
      }
    }
  };
  fillEvents(data.langKeyEvents, "events");
  fillEvents(data.langKeyEventsPrev, "prevEvents");
  /**
   * Channels per hospital with MoM — the LS "Where do they find us" page.
   * Top five by sessions, matching the deck.
   */
  const channelsByBrand = BRANDS.map((b) => {
    const prev = new Map();
    for (const r of (data[`p_${b.key}`] || [])) {
      prev.set(norm(r.session_default_channel_group || ""), n(r.sessions));
    }
    const rows = (perBrand[b.key].channels || []).map((c) => {
      const was = prev.get(norm(c.channel));
      return { channel: c.channel, sessions: c.sessions,
        mom: (was && was > 0) ? (c.sessions - was) / was : null };
    }).sort((x, y) => y.sessions - x.sessions).slice(0, 5);
    return { key: b.key, label: b.label, rows };
  });

  const actionsByLanguage = Object.fromEntries([...BRAND_KEYS, "BHQ"].map((k) => [k,
    LANG_ORDER.map((l) => ({ key: l, label: LOCALES[l], ...ALB[k][l] }))
      .filter((x) => x.views || x.sessions)
      .sort((a, b) => b.views - a.views)]));

  /**
   * Search by hospital x language: TOFU impressions, MOFU visits, BOFU actions
   * and the top keywords behind them. Visits and actions come free from ALB
   * (already built for actions-by-language); only the GSC side is new.
   */
  const brandFromUrl = (u) => brandForPath(String(u || "").replace(/^https?:\/\/[^/]+/, ""));
  const localeFromUrl = (u) => localeFromPath(String(u || "").replace(/^https?:\/\/[^/]+/, ""));
  const SL = {};
  for (const k of [...BRAND_KEYS, "BHQ"]) {
    SL[k] = {};
    for (const l of Object.keys(LOCALES)) SL[k][l] = { impressions: 0, clicks: 0, terms: new Map() };
  }
  for (const r of (data.gscQueries || [])) {
    const bk = brandFromUrl(r.page); if (!bk) continue;
    const lc = localeFromUrl(r.page); if (!lc || !SL[bk][lc]) continue;
    for (const t of [SL[bk][lc], SL.BHQ[lc]]) {
      t.impressions += n(r.impressions);
      t.clicks += n(r.clicks);
      const q = String(r.query || "");
      const e = t.terms.get(q) || { query: q, impressions: 0, clicks: 0, posSum: 0, posN: 0 };
      e.impressions += n(r.impressions); e.clicks += n(r.clicks);
      if (r.position) { e.posSum += n(r.position) * n(r.impressions); e.posN += n(r.impressions); }
      t.terms.set(q, e);
    }
  }
  const searchByLanguage = Object.fromEntries([...BRAND_KEYS, "BHQ"].map((k) => [k,
    LANG_ORDER.map((l) => {
      const t = SL[k][l];
      const cell = (ALB[k] && ALB[k][l]) || { sessions: 0, events: {} };
      const prev = cell.prevEvents || {};
      const actions = KEY_EVENTS
        .map((e) => {
          const value = (cell.events || {})[e.name] || 0;
          const was = prev[e.name] || 0;
          return { id: e.name, label: e.label, value, mom: was > 0 ? (value - was) / was : null };
        })
        .filter((e) => e.value > 0).sort((a, b) => b.value - a.value);
      return {
        key: l, label: LOCALES[l],
        impressions: t.impressions, clicks: t.clicks,
        visits: cell.sessions,
        actionsTotal: actions.reduce((a, e) => a + e.value, 0),
        actions,
        terms: [...t.terms.values()]
          .map((e) => ({ query: e.query, impressions: e.impressions, clicks: e.clicks,
            ctr: e.impressions ? e.clicks / e.impressions : null,
            position: e.posN ? +(e.posSum / e.posN).toFixed(2) : null }))
          .sort((a, b) => b.clicks - a.clicks).slice(0, 20),
      };
    }).filter((x) => x.impressions || x.visits)]));

  /**
   * GBP detail, the four hospital listings only — Dental and JMS are excluded
   * here by MW: they roll into the group totals elsewhere but are not hospitals
   * and do not get their own page.
   */
  const gbpDetail = (() => {
    const blank = () => ({ impressions: 0, mobileSearch: 0, mobileMaps: 0, desktopSearch: 0, desktopMaps: 0,
      calls: 0, website: 0, directions: 0 });
    const perBrandDaily = {}, perBrandTot = {}, perBrandPrev = {};
    for (const b of BRANDS) { perBrandDaily[b.key] = new Map(); perBrandTot[b.key] = blank(); perBrandPrev[b.key] = blank(); }
    // Only the listing that IS the hospital: b.gbp[0]. Dental sits at gbp[1].
    const listingOwner = (title) => {
      const t = norm(title);
      const b = BRANDS.find((x) => norm(x.gbp[0]) === t);
      return b ? b.key : null;
    };
    const add = (target, r) => {
      target.impressions += n(r.impressions);
      target.mobileSearch += n(r.impressions_mobile_search);
      target.mobileMaps += n(r.impressions_mobile_maps);
      target.desktopSearch += n(r.impressions_desktop_search);
      target.desktopMaps += n(r.impressions_desktop_maps);
      target.calls += n(r.call_clicks);
      target.website += n(r.website_clicks);
      target.directions += n(r.direction_requests);
    };
    for (const r of (data.gbpDaily || [])) {
      const k = listingOwner(r.location_title); if (!k) continue;
      add(perBrandTot[k], r);
      const day = String(r.date || "").slice(0, 10); if (!day) continue;
      if (!perBrandDaily[k].has(day)) perBrandDaily[k].set(day, { d: day, ...blank() });
      add(perBrandDaily[k].get(day), r);
    }
    for (const r of (data.gbpDailyPrev || [])) {
      const k = listingOwner(r.location_title); if (!k) continue;
      add(perBrandPrev[k], r);
    }
    const kw = {};
    for (const b of BRANDS) kw[b.key] = new Map();
    for (const r of (data.gbpKeywords || [])) {
      const k = listingOwner(r.location_title); if (!k) continue;
      const q = String(r.search_keyword || "").trim(); if (!q) continue;
      const e = kw[k].get(q) || { keyword: q, users: 0, below: null };
      const val = n(r.search_keyword_value);
      if (val > 0) e.users += val;
      else if (r.search_keyword_threshold) {
        // Below Google's disclosure floor: keep the smallest threshold seen so
        // the label reads "<15" rather than pretending the count is zero.
        const t = n(r.search_keyword_threshold);
        e.below = e.below === null ? t : Math.min(e.below, t);
      }
      kw[k].set(q, e);
    }
    const chg2 = (a, b2) => (b2 && b2 > 0) ? (a - b2) / b2 : null;
    return BRANDS.map((b) => {
      const t = perBrandTot[b.key], pv = perBrandPrev[b.key];
      return {
        key: b.key, label: b.label, listing: b.gbp[0],
        totals: t,
        mom: { impressions: chg2(t.impressions, pv.impressions), calls: chg2(t.calls, pv.calls),
          website: chg2(t.website, pv.website), directions: chg2(t.directions, pv.directions) },
        daily: [...perBrandDaily[b.key].values()].sort((x, y) => x.d.localeCompare(y.d)),
        keywords: (() => {
          const all = [...kw[b.key].values()]
            // Disclosed counts first, then withheld ones — a withheld keyword is
            // by definition smaller than any disclosed one.
            .sort((x, y) => (y.users - x.users) || ((x.below || 0) - (y.below || 0)));
          const nonBrand = all.filter((x) => !isBrandKeyword(x.keyword, b.key));
          const brandCount = all.length - nonBrand.length;
          const brandUsers = all.filter((x) => isBrandKeyword(x.keyword, b.key))
            .reduce((a, x) => a + x.users, 0);
          return { rows: nonBrand.slice(0, 10), brandCount, brandUsers,
            totalUsers: all.reduce((a, x) => a + x.users, 0) };
        })(),
      };
    });
  })();

  /**
   * Facebook. ONE page serves all four hospitals, so the page funnel is
   * identical on every tab and is badged as shared. What differs per hospital
   * is the ad spend behind it, which is why the two sit side by side rather
   * than being summed into one number.
   */
  const facebook = (() => {
    /**
     * Facebook-sourced sessions and key events, summed across all four
     * hospitals — the page is shared, so its funnel is a BHQ figure. Matches
     * Instagram too: the page and its ads run both surfaces, and splitting them
     * here would misattribute the paid side.
     */
    const isFb = (src) => /facebook|^fb$|instagram|^ig$|\bm\.facebook\b/i.test(String(src || ""));
    let fbVisits = 0, fbEngaged = 0;
    const fbEvents = {};
    for (const b of BRANDS) {
      for (const r of (data[`s_${b.key}`] || [])) {
        if (!isFb(r.session_manual_source)) continue;
        fbVisits += n(r.sessions); fbEngaged += n(r.engaged_sessions);
      }
      const ke = data[`k_${b.key}`];
      for (const r of ((ke && ke.rows) || [])) {
        // key is channel\u0000source
        if (!isFb(String(r.key).split("\u0000")[1])) continue;
        fbEvents[r.eventName] = (fbEvents[r.eventName] || 0) + r.value;
      }
    }
    // Previous window, keyed by source, so the Facebook actions carry MoM for
    // one extra group-wide request rather than four per-brand ones.
    const fbPrev = {};
    for (const r of ((data.srcKeyEventsPrev && data.srcKeyEventsPrev.rows) || [])) {
      if (!isFb(r.key)) continue;
      fbPrev[r.eventName] = (fbPrev[r.eventName] || 0) + r.value;
    }
    const fbActions = KEY_EVENTS
      .map((e) => {
        const value = fbEvents[e.name] || 0, was = fbPrev[e.name] || 0;
        return { id: e.name, label: e.label, value, mom: was > 0 ? (value - was) / was : null };
      })
      .sort((a, b2) => b2.value - a.value);

    const page = data.fbOrganic === null ? null : {
      impressions: sumOrNull(data.fbOrganic, "page_impressions"),
      organicReach: sumOrNull(data.fbOrganic, "page_impressions_organic"),
      engagements: sumOrNull(data.fbOrganic, "post_engagements"),
      // page_follows is a lifetime total, so take the latest row, never a sum.
      followers: (() => {
        const rows = (data.fbOrganic || []).filter((r) => n(r.page_follows) > 0)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        return rows.length ? n(rows[rows.length - 1].page_follows) : null;
      })(),
      newFollows: sumOrNull(data.fbOrganic, "page_daily_follows_unique"),
    };
    const blank = () => ({ spend: 0, reach: 0, impressions: 0, clicks: 0, engagements: 0, accounts: [] });
    const byBrand = {}; for (const b of BRANDS) byBrand[b.key] = blank();
    const shared = blank();
    for (const r of (data.metaAds || [])) {
      const owner = brandForMetaAccount(r.account_name);
      if (owner === "ECOM" || owner === null) continue;
      const t = owner === "SHARED" ? shared : byBrand[owner];
      t.spend += n(r.spend); t.reach += n(r.reach); t.impressions += n(r.impressions);
      t.clicks += n(r.actions_link_click) || n(r.clicks);
      t.engagements += n(r.actions_post_engagement);
      if (r.account_name && !t.accounts.includes(r.account_name)) t.accounts.push(r.account_name);
    }
    const rate = (spend, unit) => (unit > 0 ? spend / unit : null);
    const shape = (t) => ({ ...t,
      cpr: rate(t.spend, t.reach), cpe: rate(t.spend, t.engagements), cpc: rate(t.spend, t.clicks) });
    return { page, visits: fbVisits, engaged: fbEngaged,
      actions: fbActions, actionsTotal: fbActions.reduce((a, e) => a + e.value, 0),
      byBrand: BRANDS.map((b) => ({ key: b.key, label: b.label, ...shape(byBrand[b.key]) })),
      shared: shared.accounts.length ? shape(shared) : null };
  })();

  return {
    range: { from, to },
    bhq,
    facebook,
    gbpDetail,
    searchByLanguage,
    usersOverview,
    countries,
    languageMatrix,
    actionsByLanguage,
    channelsByBrand,
    gbp,
    searchAds,
    referral,
    content,
    chatBubble,
    appointments,
    gbpRanks: data.gbpRanks || { unavailable: true },
    youtube: data.youtube || { available: false },
    betterAi: data.betterAi || { available: false },
    tiktok,
    social,
    languages,
    languagesAvailable: data.gscLangTotals !== null || data.langSessions !== null,
    brands: BRAND_KEYS.map((k) => perBrand[k]),
    unmapped: metaUnmapped.accounts.length ? metaUnmapped : null,
    shared: {
      meta: metaShared.accounts.length ? metaShared : null,
      note: "Serves all four hospitals, so it is reported here and not added to any single brand. "
          + "The four brand figures therefore do not sum to the BHQ total.",
    },
    unit: "sessions",
  };
}

app.get("/api/report", requireTab("report"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (!WINDSOR_API_KEY) return res.status(500).json({ error: "Server missing WINDSOR_API_KEY" });
  /**
   * Cached in GCS as well as in memory.
   *
   * This endpoint makes ~35 upstream requests behind a 6-slot gate, so a cold
   * build is slow. In-memory caching alone did not help much: Cloud Run scales
   * to zero and every cold start threw the cache away, so the first person each
   * morning — and anyone landing on a fresh instance — paid full price.
   *
   * A completed month cannot change, so the object is durable and the TTL long.
   * `refresh=1` still forces a rebuild and overwrites it.
   */
  const refresh = req.query.refresh === "1";
  /**
   * VERSION is in the path deliberately.
   *
   * Without it, a deploy that adds a field to the payload keeps serving the
   * previous build's object, and the new UI renders zeros against data that
   * simply has no such key — which is exactly what happened to the review
   * rating mix after v3.99.1. A cache keyed only by date range silently
   * outlives the shape it was written for.
   */
  const objectName = `report/v${VERSION}/${from}_${to}.json`;
  try {
    if (!refresh) {
      const stored = await gcsRead(objectName).catch(() => null);
      // cacheAgeSec must be present or the client renders "cached undefineds ago".
      if (stored) return res.json({ ...stored, cached: true, cacheAgeSec: 0, store: "gcs" });
    }
    const out = await withCache(`report:${from}:${to}`, refresh,
      () => buildReport(from, to), 24 * 3600 * 1000);
    gcsWrite(objectName, out.value)
      .catch((e) => logJson("WARNING", "report_store_failed", { error: String(e.message || e) }));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec,
      store: BENCH_BUCKET ? "gcs" : "memory" });
  } catch (err) {
    logJson("ERROR", "report_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Report failed" });
  }
});

app.get("/api/overview", requireTab("overview"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (!WINDSOR_API_KEY) return res.status(500).json({ error: "Server missing WINDSOR_API_KEY" });
  try {
    const out = await withCache(`overview:${from}:${to}`, req.query.refresh === "1", () => buildOverview(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "overview_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Overview failed" });
  }
});

// ------------------------------------------------------------ /api/campaigns

/**
 * Campaign codes follow YYMMDD-NN_brand_objective, so the first six digits are
 * the launch date. Decoding it lets the tool explain an empty result ("this
 * campaign started before your date range") instead of just showing zeros.
 * Returns null for codes that don't follow the convention.
 */
function codeLaunchDate(code) {
  const m = String(code || "").match(/^(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const y = 2000 + Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

const NON_CAMPAIGN = new Set(["(organic)", "(not set)", "(referral)", "(direct)", "(ai-assistant)", "(none)"]);
const isPlatformId = (s) => /^\d{6,}$/.test(String(s || "").trim());

async function buildCampaignList(from, to) {
  const [rows, sheets] = await Promise.all([
    ga4Compat(["session_manual_campaign_name"], ["sessions"], from, to),
    loadSheetContext().catch(() => ({ topics: new Map(), errors: [] })),
  ]);
  const list = rows
    .map((r) => ({ code: r.session_manual_campaign_name, visits: n(r.sessions) }))
    .filter((c) => c.code && !NON_CAMPAIGN.has(norm(c.code)))
    .map((c) => ({ ...c, untagged: isPlatformId(c.code), topic: topicFor(c.code, sheets.topics) }))
    .sort((a, b) => b.visits - a.visits);
  return {
    range: { from, to },
    campaigns: list.slice(0, 400),
    total: list.length,
    untaggedCount: list.filter((c) => c.untagged).length,
    syncedAt: new Date().toISOString(),
  };
}

app.get("/api/campaigns", requireTab("campaigns"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`campaigns:${from}:${to}`, req.query.refresh === "1", () => buildCampaignList(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "campaigns_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Campaign list failed" });
  }
});

// ------------------------------------------------------------- /api/campaign
// Case-insensitive prefix match, so "260501", "260501-11" and "260501-11_bgh"
// all work; every matching variant is a row and the funnel is the roll-up.

async function buildCampaign(code, from, to) {
  const needle = norm(code);
  // 9 metrics: sessions, page views, 7 key events. Revenue moves to a second
  // call because 11 metrics in one request is rejected by GA4.
  const GA4_MAIN_DIMS = ["session_manual_campaign_name", "session_manual_source", "session_manual_medium"];
  const GA4_DAILY_DIMS = ["date", "session_manual_campaign_name"];

  const jobs = {
    ga4: ga4Compat(GA4_MAIN_DIMS, ["sessions", "engaged_sessions"], from, to),
    ga4Rev: ga4Compat(GA4_MAIN_DIMS, ["purchase_revenue", "ecommerce_purchases"], from, to),
    ga4Daily: ga4Compat(GA4_DAILY_DIMS, ["sessions"], from, to),
    keyEvents: ga4KeyEvents(GA4_MAIN_DIMS, from, to),
    keyEventsDaily: ga4KeyEvents(GA4_DAILY_DIMS, from, to),
    // Top landing pages for this campaign. Filtered SERVER-SIDE on the campaign
    // name: Windsor ignores its `filters` parameter (§3), so the Windsor version
    // of this pulled campaign x landing_page across all 44,463 pages of the
    // property to display eight rows. BEGINS_WITH is case-insensitive to match
    // the convention in §7, and the norm() guard below still narrows it.
    ga4Landing: ga4RunReport({
      dimensions: ["sessionManualCampaignName", GA4_LANDING_DIM],
      metrics: ["sessions"],
      from, to,
      dimensionFilter: withBranch({
        filter: {
          fieldName: "sessionManualCampaignName",
          stringFilter: { matchType: "BEGINS_WITH", value: code, caseSensitive: false },
        },
      }),
    }).catch((e) => {
      logJson("WARNING", "campaign_landing_unavailable", { error: String(e.message || e) });
      return null;
    }),
    // Organic posts, matched to the campaign by the short link in their text.
    // The pull window is widened to always include the campaign's code date
    // plus 45 days: posts are returned by publish date, so a post published
    // after the viewing range (e.g. an August post for a July-registered code,
    // viewed with the Last Month preset) would otherwise never be searched.
    fbPosts: (() => {
      const cd = String(code || "").match(/^(\d{2})(\d{2})(\d{2})/);
      let pFrom = from, pTo = to;
      if (cd) {
        const codeIso = `20${cd[1]}-${cd[2]}-${cd[3]}`;
        const plus45 = new Date(`${codeIso}T00:00:00Z`); plus45.setUTCDate(plus45.getUTCDate() + 45);
        const today = new Date().toISOString().slice(0, 10);
        const plus45Iso = plus45.toISOString().slice(0, 10) > today ? today : plus45.toISOString().slice(0, 10);
        if (codeIso < pFrom) pFrom = codeIso;
        if (plus45Iso > pTo) pTo = plus45Iso;
      }
      return windsor("facebook_organic",
        ["post_id", "post_created_time", "post_message", "url", "permalink_url", "post_impressions", "post_clicks", "post_engagements"], pFrom, pTo);
    })(),
  };
  // One job per ad platform; unconnected ones fail harmlessly into null.
  for (const p of AD_PLATFORMS) {
    // Objective and its matching result metrics come along, so a campaign is
    // judged on what it was actually built to do.
    /**
     * `clicks` is Meta's "clicks (all)" — it includes reactions, expands and
     * profile taps, so it badly overstates traffic intent. `actions_link_click`
     * is the click on the link, and `actions_landing_page_view` is Meta's count
     * of people whose browser actually rendered the destination. That last one is
     * the only fair comparison against GA4 sessions, and the gap between them is
     * what exposes a missing utm tag.
     */
    jobs[`ad_${p.id}`] = windsor(p.id, [p.campaignKey, ...AD_METRIC_FIELDS, ...(p.extra || [])], from, to);
  }
  const { data, errors } = await runJobs(jobs);
  const EMPTY_KE = { total: 0, byKey: new Map(), byName: new Map(), byKeyEvent: new Map(), rows: [], failed: true };
  const ke = data.keyEvents || EMPTY_KE;
  const keDaily = data.keyEventsDaily || EMPTY_KE;

  if (data.ga4 === null) {
    const e = new Error(`GA4 unavailable: ${errors.ga4}`);
    e.status = 502;
    throw e;
  }

  const matches = data.ga4.filter((r) => norm(r.session_manual_campaign_name).startsWith(needle));

  /**
   * Variants are keyed by campaign + source + medium, NOT campaign alone.
   * One utm_campaign routinely carries several sources (e.g. facebook/paid for
   * the ad flight plus line/social for the broadcast). Collapsing them into one
   * row summed the traffic correctly but labelled it with whichever source
   * happened to be read first — which both misrepresented the channel mix and
   * broke spend attribution, since the source no longer matched the platform.
   */
  const vkey = (r) => `${r.session_manual_campaign_name}\u0000${r.session_manual_source || ""}\u0000${r.session_manual_medium || ""}`;

  const vMap = new Map();
  for (const r of matches) {
    const k = vkey(r);
    if (!vMap.has(k)) vMap.set(k, {
      code: r.session_manual_campaign_name,
      source: r.session_manual_source || "", medium: r.session_manual_medium || "",
      visits: 0, engagement: 0, keyEvents: 0, contacts: 0, revenue: 0, purchases: 0,
      impressions: null, clicks: null, spend: null, spendEstimated: false,
      adNames: [], costPerVisit: null, costPerContact: null,
    });
    const v = vMap.get(k);
    v.visits += n(r.sessions);
    v.engagement += n(r.engaged_sessions);
    v.keyEvents += ke.byKey.get(k) || 0;
    v.contacts += ke.byKeyEvent.get(`${k}\u0000contact_us`) || 0;
  }

  // Revenue keyed identically, so no allocation guesswork is needed.
  if (data.ga4Rev !== null) {
    for (const r of data.ga4Rev) {
      const name = r.session_manual_campaign_name;
      if (!name || !norm(name).startsWith(needle)) continue;
      const k = vkey(r);
      if (!vMap.has(k)) vMap.set(k, {
        code: name, source: r.session_manual_source || "", medium: r.session_manual_medium || "",
        visits: 0, engagement: 0, keyEvents: 0, contacts: 0, revenue: 0, purchases: 0,
        impressions: null, clicks: null, spend: null, spendEstimated: false,
        adNames: [], costPerVisit: null, costPerContact: null,
      });
      const v = vMap.get(k);
      v.revenue += n(r.purchase_revenue);
      v.purchases += n(r.ecommerce_purchases);
    }
  }

  // Ad-platform campaigns are kept SEPARATE from GA4 utm variants on purpose.
  // Platform campaign names and utm_campaign values are different strings that
  // only share the prefix (e.g. Meta "260605-01_BIH_DAA_5JUN2026_..._THB8344"
  // vs utm "260605-01_bih_tra"), so forcing them into one row produced
  // meaningless zero-visit entries. Media spend and site traffic are two views
  // of the same campaign, joined by the code — not by an exact name match.
  const byPlatform = [];
  const adCampaigns = [];
  let anyAdMatch = false;
  for (const p of AD_PLATFORMS) {
    const rows = data[`ad_${p.id}`];
    if (rows === null) {
      byPlatform.push({ platform: p.label, connected: false, impressions: null, clicks: null, spend: null, matched: 0 });
      continue;
    }
    const agg = new Map();
    for (const r of rows) {
      const name = r[p.campaignKey];
      const camp = norm(name);
      if (!camp || !camp.startsWith(needle)) continue;
      if (!agg.has(name)) agg.set(name, {
        name, platform: p.label, objective: r.campaign_objective || null,
        goal: goalOf(r.campaign_objective, name),
        impressions: 0, clicks: 0, linkClicks: 0, landingPageViews: 0, spend: 0, leads: 0, messages: 0,
      });
      const a = agg.get(name);
      a.impressions += n(r.impressions);
      a.clicks += n(r.clicks);
      a.linkClicks += n(r.actions_link_click);
      a.landingPageViews += n(r.actions_landing_page_view);
      a.spend += n(r.spend);
      a.leads += n(r.actions_lead);
      a.messages += n(r.actions_onsite_conversion_messaging_conversation_started_7d);
    }
    const list = [...agg.values()].sort((a, b) => b.impressions - a.impressions);
    adCampaigns.push(...list);
    if (list.length) anyAdMatch = true;
    byPlatform.push({
      platform: p.label, connected: true, matched: list.length,
      impressions: list.reduce((a, c) => a + c.impressions, 0),
      clicks: list.reduce((a, c) => a + c.clicks, 0),
      linkClicks: list.reduce((a, c) => a + c.linkClicks, 0),
      landingPageViews: list.reduce((a, c) => a + c.landingPageViews, 0),
      spend: list.reduce((a, c) => a + c.spend, 0),
      leads: list.reduce((a, c) => a + c.leads, 0),
      messages: list.reduce((a, c) => a + c.messages, 0),
    });
  }
  adCampaigns.sort((a, b) => b.impressions - a.impressions);

  // ---- internal sheet context: human name + the short links we published ----
  const sheets = await loadSheetContext().catch((e) => ({ links: new Map(), topics: new Map(), errors: [e.message] }));
  const topic = topicFor(code, sheets.topics);

  // Every short link registered against this code (prefix match, same as GA4).
  const shortLinks = [];
  for (const [c, entry] of sheets.links.entries()) {
    if (norm(c).startsWith(needle)) shortLinks.push(...entry.links);
  }
  const uniqueLinks = [...new Set(shortLinks)];

  // LINE per-message insights, only possible when request IDs were logged.
  const lineReqIds = [];
  for (const [c, entry] of sheets.links.entries()) {
    if (norm(c).startsWith(needle)) lineReqIds.push(...(entry.lineRequestIds || []));
  }
  let lineMessages = null;
  if (LINE_ENABLED && lineReqIds.length) {
    try {
      const rows = await lineWindsor(
        ["message_request_id", "message_send_time", "message_delivered", "message_unique_impression", "message_unique_click"],
        from, to, { options: { message_request_ids: [...new Set(lineReqIds)].join(",") } });
      const list = (rows || []).filter((r) => r.message_request_id).map((r) => ({
        requestId: r.message_request_id,
        sentAt: r.message_send_time || null,
        delivered: n(r.message_delivered),
        opens: n(r.message_unique_impression),
        clicks: n(r.message_unique_click),
      }));
      lineMessages = {
        messages: list,
        delivered: list.reduce((a, m) => a + m.delivered, 0),
        opens: list.reduce((a, m) => a + m.opens, 0),
        clicks: list.reduce((a, m) => a + m.clicks, 0),
      };
    } catch (e) {
      logJson("WARNING", "line_message_insights_failed", { error: String(e.message || e) });
    }
  }

  /**
   * Organic reach for the campaign. Ad platforms report their own impressions,
   * but an organic Facebook post carrying the campaign's short link is invisible
   * to both GA4 (which only sees the resulting session) and the ads API. The
   * bridge is the link: find posts whose text contains one of the campaign's
   * short links, then read that post's impressions and engagement.
   *
   * Link matching ignores scheme and trailing slash, since sheets and posts
   * rarely store a URL identically.
   */
  const linkKeys = uniqueLinks.map((l) => norm(l).replace(/^https?:\/\//, "").replace(/\/+$/, "")).filter((l) => l.length > 5);
  let organicPosts = null;
  if (data.fbPosts !== null && linkKeys.length) {
    const seen = new Set();
    organicPosts = [];
    for (const r of data.fbPosts) {
      const msg = norm(r.post_message);
      const attach = norm(r.url).replace(/^https?:\/\//, "");
      if (!msg && !attach) continue;
      const hit = linkKeys.find((k) => (msg && msg.includes(k)) || (attach && attach.includes(k)));
      if (!hit) continue;
      const id = r.post_id || r.permalink_url || msg.slice(0, 40);
      if (seen.has(id)) continue;
      seen.add(id);
      organicPosts.push({
        postId: r.post_id || null,
        permalink: r.permalink_url || null,
        excerpt: String(r.post_message || "").slice(0, 140),
        impressions: n(r.post_impressions),
        clicks: n(r.post_clicks),
        engagements: n(r.post_engagements),
        matchedLink: hit,
        platform: "Facebook organic",
      });
    }
    organicPosts.sort((a, b) => b.impressions - a.impressions);
  }
  const organicTotals = organicPosts ? {
    posts: organicPosts.length,
    impressions: organicPosts.reduce((a, p) => a + p.impressions, 0),
    clicks: organicPosts.reduce((a, p) => a + (p.clicks || 0), 0),
    engagements: organicPosts.reduce((a, p) => a + p.engagements, 0),
  } : null;

  // Top landing pages for this campaign, so the team can recall the creative.
  let landingPages = null;
  if (data.ga4Landing !== null) {
    const lp = new Map();
    for (const r of data.ga4Landing) {
      if (!norm(r.sessionManualCampaignName).startsWith(needle)) continue;
      // Normalised so "/th/x?utm=1" and "/th/x" are one page, and so locale
      // detection reads a clean path (§7).
      const page = pagePath(r[GA4_LANDING_DIM]);
      if (!page || page === "/") continue;
      if (!lp.has(page)) lp.set(page, { page, visits: 0, locale: localeFromPath(page) });
      lp.get(page).visits += n(r.sessions);
    }
    landingPages = [...lp.values()].sort((a, b) => b.visits - a.visits).slice(0, 8);
  }

  const variants = [...vMap.values()].sort((a, b) => b.visits - a.visits);

  /**
   * Attribute each platform's spend to the utm variants that came from it.
   * The join is utm_source -> platform (names can't be matched directly, see
   * above). Where one paid variant matches a platform the figure is exact; where
   * several do, spend is split by visit share and flagged `spendEstimated` so
   * the UI can mark it. Organic variants keep spend = null, not 0.
   */
  const orphanAdCampaigns = [];
  for (const p of byPlatform) {
    if (!p.connected || !(p.spend || p.impressions)) continue;
    const hints = PLATFORM_SOURCE_HINTS[p.platform] || [];
    const owned = variants.filter((v) =>
      hints.some((re) => re.test(v.source)) && (PAID_MEDIUM_RE.test(v.medium) || PAID_MEDIUM_RE.test(v.source))
    );
    const names = adCampaigns.filter((c) => c.platform === p.platform).map((c) => c.name);
    if (!owned.length) {
      // Nothing in GA4 carries this platform's source, so the media can't fold
      // into a traffic row. Keep it visible rather than silently dropping spend.
      orphanAdCampaigns.push(...adCampaigns.filter((c) => c.platform === p.platform));
      continue;
    }
    const totalVisits = owned.reduce((a, v) => a + v.visits, 0);
    for (const v of owned) {
      const share = owned.length === 1 ? 1 : (totalVisits ? v.visits / totalVisits : 1 / owned.length);
      v.spend = n(v.spend) + p.spend * share;
      v.impressions = n(v.impressions) + p.impressions * share;
      v.clicks = n(v.clicks) + p.clicks * share;
      v.adNames = [...v.adNames, ...names];
      v.platform = p.platform;
      if (owned.length > 1) v.spendEstimated = true;
    }
  }
  // Spend that belongs to the campaign but couldn't be tied to a utm variant.
  const attributedSpend = variants.reduce((a, v) => a + n(v.spend), 0);
  const platformSpend = byPlatform.reduce((a, p) => a + n(p.spend), 0);
  const unattributedSpend = Math.max(0, platformSpend - attributedSpend);

  for (const v of variants) {
    v.costPerVisit = v.spend && v.visits ? v.spend / v.visits : null;
    v.costPerContact = v.spend && v.contacts ? v.spend / v.contacts : null;
  }

  /**
   * What was this campaign actually for?
   *
   * A lead-form or Messenger campaign never sends anyone to the website, so
   * zero sessions is the expected result, not a failure and not a tagging bug.
   * Reporting "0 visits" without that context makes a working campaign look
   * broken, so the goal is resolved from the ad platform and carried into the
   * headline metrics.
   */
  const goalSpend = new Map();
  for (const c of adCampaigns) {
    if (!goalSpend.has(c.goal)) goalSpend.set(c.goal, 0);
    goalSpend.set(c.goal, goalSpend.get(c.goal) + c.spend);
  }
  const primaryGoal = [...goalSpend.entries()].sort((a, b) => b[1] - a[1])[0];
  const goal = primaryGoal ? primaryGoal[0] : null;
  const goalDef = goal ? (GOAL_DEFS[goal] || GOAL_DEFS.unclassified) : null;
  const adLeads = byPlatform.reduce((a, p) => a + n(p.leads), 0);
  const adMessages = byPlatform.reduce((a, p) => a + n(p.messages), 0);
  const goalResults = goalDef
    ? (goalDef.result === "leads" ? adLeads
      : goalDef.result === "messages" ? adMessages
      : goalDef.result === "clicks" ? byPlatform.reduce((a, p) => a + n(p.clicks), 0)
      : goalDef.result === "impressions" ? byPlatform.reduce((a, p) => a + n(p.impressions), 0)
      : null)
    : null;
  const offSiteGoal = Boolean(goalDef && goalDef.source === "Meta" && ["leads", "messages"].includes(goal));

  // Organic FB rows in the detail table would otherwise always show blanks for
  // impressions and clicks even when the link bridge found the posts. Fold the
  // matched post metrics onto the organic facebook variant (spend stays null,
  // and the row is flagged so the UI can mark the numbers as organic-post data).
  if (organicTotals && organicTotals.posts) {
    const fbOrg = variants.find((v) =>
      norm(v.source || "").includes("facebook") && v.spend == null && v.impressions == null);
    if (fbOrg) {
      fbOrg.impressions = organicTotals.impressions;
      fbOrg.clicks = organicTotals.clicks;
      fbOrg.organicSource = true;
    }
  }

  // Same-day heuristic: the campaign code starts with YYMMDD, and LINE's
  // delivery table does report how many broadcast messages went out per day.
  // A broadcast sent on the campaign's launch date is very likely the campaign
  // broadcast, so surface that day's send volume, clearly labelled as a
  // same-day match rather than a tracked link. Opens/clicks stay unknowable
  // for OA Manager sends (no request IDs).
  // Only for campaigns that actually ran on LINE (a GA4 line-source variant
  // exists): the date heuristic exists because LINE is blind, and it has no
  // business firing for FB/IG/ads campaigns that merely share a launch date.
  let lineSameDay = null;
  const isLineCampaign = variants.some((v) => norm(v.source || "").includes("line"));
  const codeDigits = String(code || "").match(/^(\d{2})(\d{2})(\d{2})/);
  if (isLineCampaign && codeDigits) {
    const codeDate = `20${codeDigits[1]}-${codeDigits[2]}-${codeDigits[3]}`;
    // Windsor's raw connector API and its metadata API disagree on LINE field
    // naming (plain "broadcast" vs prefixed "message__broadcast"), so try the
    // plain names first and fall back to the prefixed ones.
    const attempts = [
      ["broadcast", "targeting", "api_broadcast", "api_narrowcast", "api_multicast", "api_push"],
      ["message__broadcast", "message__targeting", "message__api_broadcast", "message__api_narrowcast", "message__api_multicast", "message__api_push"],
    ];
    for (const flds of attempts) {
      try {
        const rows = await lineWindsor(["date", ...flds], codeDate, codeDate);
        if (!rows || !rows.length) continue;
        const sum = (name) => rows.reduce((a, r) => a + n(r[name] !== undefined ? r[name] : r[`message__${name.replace(/^message__/, "")}`]), 0);
        const broadcasts = sum(flds[0]) + sum(flds[2]);
        const targeted = sum(flds[1]) + sum(flds[3]) + sum(flds[4]) + sum(flds[5]);
        if (broadcasts + targeted > 0) { lineSameDay = { date: codeDate, broadcasts, targeted }; break; }
      } catch (e) {
        logJson("WARNING", "line_same_day_attempt_failed", { fields: flds[0], error: String(e.message || e) });
      }
    }
  }


  // LINE can never report views or clicks for OA Manager sends, but delivery
  // volume on the campaign date exists — put it in the LINE row's Impr column,
  // flagged as "sent" so nobody reads delivery as views.
  if (lineSameDay) {
    // GA4 splits LINE into broadcast-style rows (medium paid/broadcast) and the
    // rich menu (persistent tap menu, no send event). Delivery volume belongs
    // only to the send-style row — never stamp it on richmenu.
    const lineRows = variants.filter((v) =>
      norm(v.source || "").includes("line") && v.spend == null && v.impressions == null
      && !norm(v.medium || "").includes("richmenu"));
    const lineOrg = lineRows.find((v) => /paid|broadcast|social/.test(norm(v.medium || ""))) || lineRows[0];
    if (lineOrg) {
      lineOrg.impressions = n(lineSameDay.broadcasts) + n(lineSameDay.targeted);
      lineOrg.lineSent = true;
    }
  }

  const paidImpressions = anyAdMatch ? byPlatform.reduce((a, p) => a + n(p.impressions), 0) : null;
  const totals = {
    paidImpressions,
    organicImpressions: organicTotals ? organicTotals.impressions : null,
    impressions: (paidImpressions === null && !organicTotals) ? null
      : n(paidImpressions) + (organicTotals ? organicTotals.impressions : 0),
    visits: variants.reduce((a, v) => a + v.visits, 0),
    engagement: variants.reduce((a, v) => a + v.engagement, 0),
    keyEvents: variants.reduce((a, v) => a + v.keyEvents, 0),
    contacts: variants.reduce((a, v) => a + v.contacts, 0),
    revenue: variants.reduce((a, v) => a + v.revenue, 0),
    purchases: variants.reduce((a, v) => a + v.purchases, 0),
    spend: byPlatform.some((p) => p.connected && p.spend) ? platformSpend : null,
    clicks: (!anyAdMatch && !(organicTotals && organicTotals.clicks)) ? null
      : (anyAdMatch ? byPlatform.reduce((a, p) => a + n(p.clicks), 0) : 0) + (organicTotals ? n(organicTotals.clicks) : 0),
  };
  /**
   * Ad-platform ratios are computed unconditionally. They're measured by Meta
   * and are meaningful whatever the objective — withholding them because a
   * campaign was classified as "traffic" hid the very numbers needed to judge it.
   * clickToVisit is the diagnostic that matters most: clicks arriving with no
   * session is the signature of a broken or missing utm tag.
   */
  const adLinkClicks = byPlatform.reduce((a, p) => a + n(p.linkClicks), 0);
  const adLpv = byPlatform.reduce((a, p) => a + n(p.landingPageViews), 0);
  totals.linkClicks = adLinkClicks || null;
  totals.landingPageViews = adLpv || null;
  // CTR on link clicks, since that's the click that expresses intent.
  totals.ctr = totals.impressions && adLinkClicks ? (adLinkClicks / totals.impressions) * 100 : null;
  totals.ctrAll = totals.impressions ? (totals.clicks / totals.impressions) * 100 : null;
  totals.cpc = totals.spend && adLinkClicks ? totals.spend / adLinkClicks : null;
  totals.cpm = totals.impressions ? (totals.spend / totals.impressions) * 1000 : null;
  totals.costPerLpv = totals.spend && adLpv ? totals.spend / adLpv : null;
  // The tagging check: Meta says this many browsers rendered the page; GA4 says
  // this many sessions carried the code. A wide gap means the tag is missing.
  totals.lpvToVisit = adLpv ? (totals.visits / adLpv) * 100 : null;
  totals.clickToVisit = adLinkClicks ? (totals.visits / adLinkClicks) * 100 : null;
  totals.lostSessions = adLpv ? Math.max(0, adLpv - totals.visits) : null;
  totals.leads = adLeads;
  totals.messages = adMessages;
  totals.costPerLead = totals.spend && adLeads ? totals.spend / adLeads : null;
  totals.costPerMessage = totals.spend && adMessages ? totals.spend / adMessages : null;
  totals.leadRate = totals.clicks && adLeads ? (adLeads / totals.clicks) * 100 : null;
  totals.messageRate = totals.clicks && adMessages ? (adMessages / totals.clicks) * 100 : null;
  totals.costPerVisit = totals.spend && totals.visits ? totals.spend / totals.visits : null;
  totals.costPerContact = totals.spend && totals.contacts ? totals.spend / totals.contacts : null;
  totals.unattributedSpend = unattributedSpend;
  totals.visitRate = totals.impressions ? (totals.visits / totals.impressions) * 100 : null;
  totals.keyEventRate = totals.visits ? (totals.keyEvents / totals.visits) * 100 : null;
  totals.costPerKeyEvent = totals.spend && totals.keyEvents ? totals.spend / totals.keyEvents : null;

  // Restricted to this campaign's groupings: ke covers the whole property.
  const matchedKeys = new Set(matches.map(vkey));
  const keyEventBreakdown = keyEventBreakdownFrom(ke, (k) => matchedKeys.has(k));

  let trend = [];
  if (data.ga4Daily !== null) {
    const tm = new Map();
    for (const r of data.ga4Daily) {
      if (!r.date || !norm(r.session_manual_campaign_name).startsWith(needle)) continue;
      if (!tm.has(r.date)) tm.set(r.date, { d: r.date, visits: 0, keyEvents: 0 });
      const t = tm.get(r.date);
      t.visits += n(r.sessions);
      t.keyEvents += keDaily.byKey.get(ga4JoinKey(GA4_DAILY_DIMS, r, false)) || 0;
    }
    trend = [...tm.values()].sort((a, b) => a.d.localeCompare(b.d));
  }

  const notConnected = byPlatform.filter((p) => !p.connected).map((p) => p.platform);
  const matchedNone = byPlatform.filter((p) => p.connected && p.matched === 0).map((p) => p.platform);

  // Nothing at all matched: most often the date range, since the code encodes
  // its own launch date. Say that plainly instead of rendering a zeroed funnel.
  const launch = codeLaunchDate(code);
  const emptyResult = variants.length === 0 && !anyAdMatch;
  let dateHint = null;
  if (emptyResult && launch) {
    if (launch < from) {
      dateHint = {
        launch,
        message: `This code decodes to a launch date of ${launch}, which is before your selected range starts (${from}). The campaign most likely ran earlier — widen the range to cover ${launch}.`,
      };
    } else if (launch > to) {
      dateHint = {
        launch,
        message: `This code decodes to a launch date of ${launch}, which is after your selected range ends (${to}). Extend the range to include it.`,
      };
    }
  }

  let notes = "";
  if (variants.length === 0 && anyAdMatch && offSiteGoal) {
    notes = `This is a ${goalDef.label.toLowerCase()} campaign — its clicks open a ${goal === "leads" ? "lead form" : "chat"} on Meta rather than your website, so zero website visits is expected and not a tagging problem. Judge it on ${goalResults != null ? `the ${num0(goalResults)} ${goalDef.resultLabel}${goalResults === 1 ? "" : "s"} Meta recorded` : "its platform results"}.`;
  } else if (variants.length === 0 && anyAdMatch) {
    notes = `Meta reports spend and clicks for this code, but no website session carries utm_campaign "${code}". For a traffic campaign that points to a missing utm tag on the ad's destination URL.`;
  } else if (emptyResult) {
    notes = `Nothing matched "${code}" in ${from} to ${to} — no GA4 traffic and no ad campaigns.`;
  } else if (!anyAdMatch) {
    notes = `No ad platform reported a campaign matching this code, so the Impressions stage is unavailable. GA4 visits and key events are complete.`;
    if (notConnected.length) notes += ` Not connected to Windsor: ${notConnected.join(", ")}.`;
  } else if (notConnected.length) {
    notes = `Impressions cover only connected platforms. Not connected to Windsor: ${notConnected.join(", ")} — any spend there is missing from the Impressions stage.`;
  }

  return {
    code, range: { from, to },
    matchedVariants: variants.length,
    totals, variants, keyEventBreakdown, trend,
    byPlatform, adCampaigns, orphanAdCampaigns, landingPages,
    topic, shortLinks: uniqueLinks, organicPosts, organicTotals,
    goal, goalLabel: goalDef ? goalDef.label : null,
    objectives: [...new Set(adCampaigns.map((c) => c.objective).filter(Boolean))],
    goalResultLabel: goalDef ? goalDef.resultLabel : null,
    goalResults, goalCostPerResult: goalResults && totals0Spend(byPlatform) ? totals0Spend(byPlatform) / goalResults : null,
    offSiteGoal, adLeads, adMessages,
    lineMessages, lineSameDay, lineRequestIdsFound: lineReqIds.length,
    sheetErrors: sheets.errors,
    unattributedSpend,
    emptyResult, dateHint, launchDate: launch,
    adImpressionsMatched: anyAdMatch,
    notConnected, matchedNone,
    notes,
    errors,
    syncedAt: new Date().toISOString(),
  };
}

app.get("/api/campaign", requireTab("campaigns"), async (req, res) => {
  const { code, from, to } = req.query;
  if (!code || String(code).trim().length < 2) return res.status(400).json({ error: "code (min 2 chars) required" });
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`campaign:${norm(code)}:${from}:${to}`, req.query.refresh === "1",
      () => buildCampaign(String(code).trim(), from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "campaign_failed", { error: String(err.message || err) });
    res.status(err.status || 500).json({ error: err.message || "Campaign lookup failed" });
  }
});

// ----------------------------------------------- ad objective classification
/**
 * A campaign's efficiency can only be judged against its own goal: cost per
 * visit is meaningless for a lead form that never sends anyone to the site, and
 * a message ad's result is a conversation, not a session.
 *
 * Meta's own `campaign_objective` is authoritative, so it's read first. Campaign
 * names are only a fallback for rows where the objective is missing.
 */
const OBJECTIVE_GOALS = {
  OUTCOME_TRAFFIC: "traffic", LINK_CLICKS: "traffic", TRAFFIC: "traffic",
  OUTCOME_LEADS: "leads", LEAD_GENERATION: "leads",
  OUTCOME_SALES: "sales", CONVERSIONS: "sales", PRODUCT_CATALOG_SALES: "sales",
  MESSAGES: "messages", OUTCOME_MESSAGES: "messages",
  OUTCOME_ENGAGEMENT: "engagement", POST_ENGAGEMENT: "engagement", PAGE_LIKES: "engagement",
  OUTCOME_AWARENESS: "awareness", BRAND_AWARENESS: "awareness", REACH: "awareness", VIDEO_VIEWS: "awareness",
  OUTCOME_APP_PROMOTION: "app",
};

function goalOf(objective, campaignName) {
  const o = String(objective || "").trim().toUpperCase();
  if (OBJECTIVE_GOALS[o]) return OBJECTIVE_GOALS[o];
  const nm = String(campaignName || "");
  if (/lead\s*form|leadform|_lead/i.test(nm)) return "leads";
  if (/message|whatsapp|chat/i.test(nm)) return "messages";
  if (/traffic/i.test(nm)) return "traffic";
  if (/awareness|reach|video/i.test(nm)) return "awareness";
  if (/conversion|purchase|sale/i.test(nm)) return "sales";
  return "unclassified";
}

/**
 * Each goal's "result" — the denominator for cost-per and result-per-baht.
 * `source` records whether the count comes from the ad platform or the site, so
 * the UI never implies a lead was measured on the website.
 */
const GOAL_DEFS = {
  traffic:      { label: "Traffic",      result: "visits",   resultLabel: "visit",        source: "GA4" },
  leads:        { label: "Lead gen",     result: "leads",    resultLabel: "lead",         source: "Meta" },
  messages:     { label: "Messaging",    result: "messages", resultLabel: "conversation", source: "Meta" },
  sales:        { label: "Sales",        result: "purchases",resultLabel: "purchase",     source: "GA4" },
  engagement:   { label: "Engagement",   result: "clicks",   resultLabel: "click",        source: "Meta" },
  awareness:    { label: "Awareness",    result: "impressions", resultLabel: "1k impressions", source: "Meta", perThousand: true },
  app:          { label: "App",          result: "clicks",   resultLabel: "click",        source: "Meta" },
  unclassified: { label: "Unclassified", result: "clicks",   resultLabel: "click",        source: "Meta" },
};

// ---------------------------------------------------- durable benchmark store
/**
 * Benchmark output only changes when a month ends, so it is written to Cloud
 * Storage keyed by the last complete month and read back on later requests.
 * Without a bucket configured it falls back to the in-memory cache with a long
 * TTL — correct, just re-computed after each cold start.
 */
const BENCH_BUCKET = process.env.BENCHMARK_BUCKET || process.env.ACCESS_BUCKET || "";
// The normalised e-commerce sheet. Carries no customer PII — names, phones and
// emails are replaced with irreversible keys before they ever reach it.
const ECOM_SHEET_ID = process.env.ECOM_SHEET_ID || "";

/**
 * WEB APPOINTMENTS — a second Google Sheet, separate from the e-commerce one.
 *
 * Structure verified against MW's `Web_Appointment_2025.xlsx`, not guessed:
 *
 *   Realtime      col C  Appointment Location   (donut)
 *                 col T  Hospitals              (attribution)
 *                 col U  Date                   (the web booking timestamp)
 *   Non Realtime  col B  วันที่ทำนัดบนเว็บ        (the web booking date)
 *                 col P  Preferred Specialty    (donut)
 *                 col S  Hospital               (attribution)
 *   Total Amounts col A  Month, B–E Realtime revenue per hospital,
 *                 F–I Non Realtime revenue per hospital
 *
 * Only the six needed columns are fetched, as separate ranges aligned by row
 * index. The two detail tabs run to ~25,000 rows; pulling A:V of both would be
 * roughly ten times the payload for data nothing reads.
 */
const APPT_SHEET_ID = process.env.APPT_SHEET_ID || "1Yt_4NknQdLQogZKwtZoG9dGAe99HlF0UuilebMxt95Q";

/**
 * Hospital attribution (MW).
 *
 * `BHQ` and `BHQ-EN` are LEGACY LABELS for BGH — 4,251 of 25,359 Realtime rows
 * in the sample, so ~17% of the tab. Treating them as unattributable would
 * understate BGH by a fifth; treating them as their own hospital would invent
 * one.
 *
 * Rows whose Hospitals cell is literal HTML (`<span…>No tags</span>`, 23 rows)
 * or empty are DISCARDED, per MW: they are scraper residue, not appointments
 * with an unknown hospital, so they must not land in a fallback bucket where
 * they would look like real volume.
 */
const APPT_HOSPITAL_RULES = [
  { re: /\(BGH\)|^BHQ(-EN)?$|bangkok hospital(?!\s*\()/i, key: "BGH" },
  { re: /\(BIH\)|international/i, key: "BIH" },
  { re: /\(BHT\)|heart/i,         key: "BHT" },
  { re: /\(WSH\)|cancer|wattanosoth/i, key: "WSH" },
];
const apptBrand = (raw) => {
  const v = String(raw || "").trim();
  if (!v || /<[a-z/]/i.test(v)) return null;      // HTML residue or blank
  // Most specific first: "Bangkok International Hospital" also contains
  // "Bangkok Hospital", so the BGH rule excludes a following "(".
  for (const r of [APPT_HOSPITAL_RULES[1], APPT_HOSPITAL_RULES[2],
                   APPT_HOSPITAL_RULES[3], APPT_HOSPITAL_RULES[0]]) {
    if (r.re.test(v)) return r.key;
  }
  return null;
};

/**
 * Sheet dates arrive as display strings, and the two tabs do not agree on
 * format. Anything that is not a real date in range is skipped rather than
 * coerced — a bad parse landing on the 1st of the month would silently move
 * volume between reporting periods.
 */
const apptDay = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);          // D/M/YYYY or M/D/YYYY
  if (m) {
    const a = +m[1], b = +m[2];
    // Ambiguous below 13; the sheet is Thai-authored, so day-first.
    const day = a, mon = b;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${m[3]}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};

const NOT_SPECIFIED = "N/S";

/**
 * GBP KEYWORD RANKINGS — a third sheet, one tab per hospital (MW).
 *
 * Columns, from MW's screenshot: A locationName, B keyword, C month_week,
 * D address, E rank, F avg monthly searches, G createdAt.
 *
 * This sits ALONGSIDE the GBP keyword card, not instead of it (CONTEXT open
 * item 1): that card answers "what did people search to find the listing", this
 * one answers "where do we rank for the keywords we care about". Different
 * questions, and one cannot substitute for the other.
 */
const GBPKW_SHEET_ID = process.env.GBPKW_SHEET_ID || "1nUbrinZKLc1JIkK1O9B0NC-7T30YYbOJ7cTEmxFDL5M";

/**
 * `month_week` is a display label like `2026-July`, so the range has to be
 * turned into the set of labels it covers rather than compared as dates.
 */
const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];
function monthWeekLabels(from, to) {
  const out = new Set();
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  let y = fy, m = fm;
  // Bounded: a range spanning more than two years is not a monthly report.
  for (let i = 0; i < 36 && (y < ty || (y === ty && m <= tm)); i++) {
    out.add(`${y}-${MONTH_NAMES[m - 1]}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * YOUTUBE — read from a Sheet a HUMAN maintains, two YouTube Studio exports.
 *
 * The Apps Script that used to write this sheet is GONE (deleted Aug 2026), and
 * so is `youtube-to-sheet.gs` from this repo. It could never work: it ran as a
 * fixed identity and the channel is a BRAND ACCOUNT, so it queried MW's personal
 * channel and wrote 398 days of zeros while reporting success.
 *
 * WHY A PERSON AND NOT AN API. Every automated route is closed —
 * bangkokhospital.com is not Workspace so an "Internal" OAuth client is
 * impossible; "External + Testing" expires refresh tokens after seven days;
 * a service account cannot read a channel at all (Content Partners only); and
 * "External + Production" was tried and the Brand Account grant still failed.
 * A browser shows an account picker, so a human can BE the brand account for the
 * length of one export. That is the only door that opens. See CONTEXT §12.
 *
 * The tabs are `Daily` (Studio's DATE view) and `Videos` (its CONTENT view with
 * a hand-added Month column). Columns are read BY NAME — see `buildYouTube`.
 */
const YT_SHEET_ID = process.env.YT_SHEET_ID || "1o0n44IioDyEvAlNt_Tf11SxD11mDpkzlfABbBSbJZus";

const BETTERAI_SHEET_ID = process.env.BETTERAI_SHEET_ID || "1jOz2XYry-D28z_Eg6w3oIHao1c61OrGTa5jD7Hz21oQ";

/**
 * BETTER CLUB — membership revenue attribution, from its own Sheet.
 *
 * The hospital sends one xlsx a month listing every Better Club member matched
 * to an HN, with that member's revenue for the month and two flags: first visit
 * this month, and returning after a two-year gap. An Apps Script in the
 * spreadsheet normalises it (`BetterClub_Normalize.gs`) and DELETES the imported
 * tab, because the raw export carries names, emails and phone numbers.
 *
 * Two tabs are read here, both BY HEADER NAME:
 *   `Summary`         — one row per month, every figure the headline cards need.
 *   `Rev_Attribution` — one row per member-month, needed only for cohorts.
 *
 * NO PII REACHES THIS SERVICE. `HN_ID` is a salted SHA-256 digest of the
 * hospital number written by the Apps Script; it is stable across months, so
 * cohort retention works, and it is not reversible to an HN. Name, email and
 * phone are never written to the sheet at all.
 *
 * `MonthYear` is TEXT in `yyyy-MM` form, not a date. Sheets stores dates as
 * timezone-less serials, so a Date on the 1st at midnight lands in the previous
 * month whenever the writer's timezone is behind the spreadsheet's — the first
 * load shifted all seven months back by one and displayed January as December
 * 2025. Text cannot drift. `monthKeyCell` below still tolerates a Date so a
 * hand-edited row does not take the section down.
 */
const BCLUB_SHEET_ID = process.env.BCLUB_SHEET_ID || "1DPUqMUo9q4MVd5tqryWFGKhI9MSVsyWdjBF0Un62zfs";
const BCLUB_SUMMARY_TAB = "Summary";
const BCLUB_DETAIL_TAB = "Rev_Attribution";
/**
 * The registration count, in its OWN tab that the normaliser never writes.
 *
 * It cannot live in `Summary`: `rebuildSummary_` clears and rewrites that tab on
 * every import, so a hand-entered column there would be silently wiped the next
 * time a month was loaded — a number that disappears without an error is worse
 * than one that was never there.
 *
 * Two columns, `MonthYear` and `NewRegisters`, read by header name. Fetched in a
 * SEPARATE call from the other two because `values:batchGet` fails the WHOLE
 * request with a 400 if any range names a tab that does not exist, and this tab
 * is optional by design.
 */
const BCLUB_REGISTER_TAB = "Registers";

/**
 * The member roster. `Registered at` on this tab IS the registers stage.
 *
 * THIS IS WHY THE USER ID WORK HAPPENED (MW: "we are doing this user id thing
 * to get who is new registers"). The third funnel stage was empty because
 * nothing in this service knew when anyone joined. `Members` now holds 51,166
 * rows of `User ID` + `Registered at`, so counting registrations by month is a
 * `GROUP BY` — no hand-entered tab, no GA4 event to instrument, no upstream ask.
 *
 * The `Registers` tab above stays supported as an override for months that
 * predate the roster, but it is no longer the primary source.
 */
const BCLUB_MEMBER_TAB = "Members";

/**
 * BETTER AI — the agentic assistant's conversion funnel, from its own Sheet.
 *
 * Two tabs, both daily, both read by HEADER NAME and never by position: the
 * headers are Thai and the export has already grown from 15 columns to 23 in
 * the tabs we do not use, so a positional read is a time bomb.
 *   `สรุปรายวัน`      — one row per day, every counter (cols A-N).
 *   `รายวันแยกภาษา`  — one row per day PER LANGUAGE (cols A-N).
 *
 * THE PERCENTAGE COLUMNS ARE IGNORED ON PURPOSE. Both tabs carry ready-made
 * `%` columns, and they are computed over the SHEET's whole history. This report
 * runs on a chosen window, so a borrowed percentage would disagree with the
 * counts printed beside it. Every rate here is derived from the counts that
 * survive the date filter.
 *
 * The funnel is Sessions -> advised -> appointment clicked -> appointment
 * completed. The last step is expressed against CLICKS, not sessions, because
 * that is the only one the assistant is actually being judged on: of the people
 * it persuaded to start booking, how many finished.
 */
async function buildBetterAi(from, to) {
  const T_DAILY = "สรุปรายวัน", T_LANG = "รายวันแยกภาษา";
  let res;
  try {
    res = await sheetBatchGet(BETTERAI_SHEET_ID, [`'${T_DAILY}'!A1:N`, `'${T_LANG}'!A1:N`]);
  } catch (e) {
    return { available: false, error: String((e && e.message) || e) };
  }
  const vals = (i) => (res[i] && res[i].values) || [];
  const daily = vals(0), lang = vals(1);
  if (!daily.length) return { available: false, error: "no rows in " + T_DAILY };

  const headOf = (rows) => (rows[0] || []).map((h) => String(h == null ? "" : h).trim());
  const colOf = (head) => (name) => {
    const want = String(name).trim();
    const exact = head.indexOf(want);
    if (exact >= 0) return exact;
    // Trailing units and stray spaces creep into these headers; a prefix match
    // recovers "Sessions " and "ได้รับคำแนะนำ (คน)" without matching anything else.
    const pfx = head.findIndex((h) => h.startsWith(want));
    return pfx >= 0 ? pfx : -1;
  };
  const n = (v) => {
    if (typeof v === "number") return v;
    const x = parseFloat(String(v == null ? "" : v).replace(/[, ]/g, ""));
    return isFinite(x) ? x : 0;
  };
  /**
   * A cell in this column has arrived as an ISO string, as a Thai-formatted
   * date and as a Sheets serial, depending on how the tab was last edited.
   * All three resolve here; anything else drops the row rather than being
   * guessed at, because a mis-parsed date silently moves revenue between months.
   */
  const iso = (v) => {
    if (v == null || v === "") return "";
    if (typeof v === "number" && v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) {
      let y = +m[3]; if (y > 2400) y -= 543;
      return `${y}-${String(+m[2]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
    }
    const t = Date.parse(s);
    return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
  };

  const dH = headOf(daily), dC = colOf(dH);
  const D = {
    date: dC("วันที่"), sessions: dC("Sessions"), advice: dC("ได้รับคำแนะนำ"),
    click: dC("กดนัดหมาย"), done: dC("นัดหมายสำเร็จ"),
    rt: dC("นัด realtime"), nrt: dC("นัดไม่ realtime"),
    doctor: dC("ดูโปรไฟล์แพทย์"), center: dC("ดูศูนย์รักษา"), pkg: dC("ดูแพ็กเกจ"),
    article: dC("ดูบทความ"), cart: dC("เพิ่มลงตะกร้า"),
  };
  const missing = Object.keys(D).filter((k) => D[k] < 0);
  if (missing.length) {
    return { available: false,
             error: `${T_DAILY} is missing column(s): ${missing.join(", ")} — headers seen: ${dH.join(" | ")}` };
  }

  const KEYS = ["sessions","advice","click","done","rt","nrt","doctor","center","pkg","article","cart"];
  const totals = {}; KEYS.forEach((k) => { totals[k] = 0; });
  /**
   * The PREVIOUS window is summed in the same pass. The whole tab is already in
   * memory, so a second date filter is free — and MW wants MoM on the headline
   * card now that the day-coverage note has served its purpose (from next month
   * the sheet is complete, so "28 of 31 days" would always read 31 of 31).
   *
   * Same window LENGTH one period back, from `comparisonWindows`, so a 20-day
   * range compares against 20 days rather than against a calendar month.
   */
  const cw = comparisonWindows(from, to);
  const prevTotals = {}; KEYS.forEach((k) => { prevTotals[k] = 0; });
  const days = [];
  let sheetFrom = "", sheetTo = "";
  for (let r = 1; r < daily.length; r++) {
    const row = daily[r] || [];
    const d = iso(row[D.date]);
    if (!d) continue;                            // the tab's own total rows
    if (!sheetFrom || d < sheetFrom) sheetFrom = d;
    if (!sheetTo || d > sheetTo) sheetTo = d;
    if (d >= cw.prev.from && d <= cw.prev.to) {
      KEYS.forEach((k) => { prevTotals[k] += n(row[D[k]]); });
    }
    if (d < from || d > to) continue;
    const rec = { date: d };
    KEYS.forEach((k) => { rec[k] = n(row[D[k]]); totals[k] += rec[k]; });
    days.push(rec);
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));

  // ---- per language, same window, aggregated across its daily rows
  const languages = [];
  if (lang.length) {
    const lH = headOf(lang), lC = colOf(lH);
    const L = {
      date: lC("วันที่"), code: lC("ภาษา"), sessions: lC("Sessions"),
      advice: lC("ได้รับคำแนะนำ"), click: lC("กดนัดหมาย"), done: lC("นัดหมายสำเร็จ"),
      doctor: lC("ดูโปรไฟล์แพทย์"), pkg: lC("ดูแพ็กเกจ"),
    };
    if (L.date >= 0 && L.code >= 0 && L.sessions >= 0) {
      const by = new Map();
      for (let r = 1; r < lang.length; r++) {
        const row = lang[r] || [];
        const d = iso(row[L.date]);
        if (!d || d < from || d > to) continue;
        const code = String(row[L.code] == null ? "" : row[L.code]).trim().toLowerCase();
        if (!code) continue;
        const cur = by.get(code) || { code, sessions: 0, advice: 0, click: 0, done: 0, doctor: 0, pkg: 0 };
        ["sessions","advice","click","done","doctor","pkg"].forEach((k) => {
          if (L[k] >= 0) cur[k] += n(row[L[k]]);
        });
        by.set(code, cur);
      }
      languages.push(...[...by.values()].sort((a, b) => b.sessions - a.sessions));
    }
  }

  const rate = (a, b) => (b > 0 ? a / b : null);
  /**
   * `dayGaps` mirrors YouTube's: the number of days in the window the sheet has
   * no row for. The tab is written by a scheduled job, and a job that stopped
   * running produces a report that is simply smaller — with nothing to say so.
   */
  const spanDays = Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
  return {
    available: true,
    source: "agentic-sheet",
    totals,
    rates: {
      advice: rate(totals.advice, totals.sessions),
      click: rate(totals.click, totals.sessions),
      done: rate(totals.done, totals.sessions),
      close: rate(totals.done, totals.click),
      realtime: rate(totals.rt, totals.rt + totals.nrt),
    },
    days,
    languages,
    prevTotals,
    /**
     * MoM per counter. `null` rather than 0 when the previous window has none —
     * "no basis for comparison" and "no change" are different statements, and
     * the first month this section runs is entirely the former.
     */
    mom: KEYS.reduce((o, k) => {
      o[k] = prevTotals[k] > 0 ? (totals[k] - prevTotals[k]) / prevTotals[k] : null;
      return o;
    }, {}),
    prevWindow: cw.prev,
    coverage: { daysWithData: days.length, daysInRange: spanDays,
                dayGaps: Math.max(0, spanDays - days.length),
                sheetFrom, sheetTo },
  };
}



/**
 * YOUTUBE, from two YouTube Studio exports pasted into one Sheet (v3.131.0).
 *
 * WHY A HUMAN IS THE CREDENTIAL. The channel is a Brand Account. Apps Script
 * and the server both run as a FIXED identity and can only ask about the
 * identity they are — which is why the old job returned 398 days of zeros while
 * reporting success. A browser shows an account picker, so a person can BE the
 * brand account for the length of one export. It is the only door that opens.
 *
 * TWO TABS, TWO STUDIO VIEWS:
 *   `Daily`  — Studio's DATE view: one row per day with every metric. This is
 *              what makes MoM and YoY possible, and it is why the Content view
 *              alone was not enough.
 *   `Videos` — Studio's CONTENT view for one month, with a `Month` column added
 *              by hand. Content exports carry NO date of their own, so without
 *              that column June's report would happily show July's videos.
 *
 * COLUMNS ARE READ BY NAME. Four real exports came back with four different
 * column orders as metrics were switched on and off. `col()` is
 * exact-match-then-prefix, which is what separates `Likes` from `Dislikes`
 * sitting immediately before it, and still resolves `Comments added` and
 * `Watch time (hours)`.
 *
 * STUDIO TRUNCATES EVERY TABLE TO 500 ROWS and keeps the TOP 500 by the sorted
 * metric — the last row literally reads "Showing top 500 results". A 577-day
 * range therefore loses its 76 quietest days with no error, so `dayGaps` counts
 * the days actually present against the days the window should contain and the
 * slide says so. This is the only way a too-wide export announces itself.
 */
async function buildYouTube(from, to) {
  const res = await sheetBatchGet(YT_SHEET_ID, ["'Daily'!A1:Z", "'Videos'!A1:Z"]);
  const vals = (i) => (res[i] && res[i].values) || [];
  const daily = vals(0), vids = vals(1);
  if (!daily.length) return { available: false, source: "studio-export" };

  const headOf = (rows) => (rows[0] || []).map((h) => String(h || "").trim().toLowerCase());
  const colOf = (head) => (name) => {
    const want = name.toLowerCase();
    const exact = head.indexOf(want);
    if (exact >= 0) return exact;
    const pfx = head.findIndex((h) => h.startsWith(want));
    return pfx >= 0 ? pfx : -1;
  };

  const dHead = headOf(daily), dCol = colOf(dHead);
  const cDate = dCol("date");
  const M = {
    views: dCol("views"),
    likes: dCol("likes"),
    comments: dCol("comments"),
    shares: dCol("shares"),
    subsNet: dCol("subscribers"),
    hoursWatched: dCol("watch time"),
  };
  /**
   * WATCH TIME UNITS ARE VERIFIED, not assumed. Studio exports this column as
   * hours or minutes depending on the view and they differ by 60x, which is an
   * extra zero on an executive slide. If the header does not say "hours" the
   * metric is dropped rather than guessed.
   */
  if (M.hoursWatched >= 0 && !dHead[M.hoursWatched].includes("hour")) M.hoursWatched = -1;

  const present = [], missing = [];
  for (const k of Object.keys(M)) (M[k] >= 0 ? present : missing).push(k);

  /**
   * Rows are indexed by date so the three windows are three lookups rather than
   * three passes. A `Total` row, if someone leaves one in, has no parseable date
   * and drops out here — it must never be summed alongside the days it totals.
   */
  const byDate = new Map();
  for (const r of daily.slice(1)) {
    const d = apptDay(r[cDate]);
    if (d) byDate.set(d, r);
  }
  const allDates = [...byDate.keys()].sort();

  const cw = comparisonWindows(from, to);
  const sumWindow = (a, b) => {
    const out = { days: 0 };
    for (const k of Object.keys(M)) out[k] = M[k] >= 0 ? 0 : null;
    for (const [d, r] of byDate) {
      if (d < a || d > b) continue;
      out.days += 1;
      for (const k of Object.keys(M)) if (M[k] >= 0) out[k] += n(r[M[k]]);
    }
    if (out.hoursWatched !== null) out.hoursWatched = Math.round(out.hoursWatched);
    return out;
  };
  const cur = sumWindow(from, to);
  const prev = sumWindow(cw.prev.from, cw.prev.to);
  const yoy = sumWindow(cw.yoy.from, cw.yoy.to);

  /**
   * CHANGE IS null WHEN THE BASELINE IS ABSENT, not zero and not 100%.
   *
   * A month with no rows in the sheet is "we have not got that data", which is
   * a different statement from "it was zero and has grown infinitely". Reporting
   * the second as the first is how a partially-backfilled sheet produces a
   * slide full of triumphant growth.
   */
  const pctOf = (a, b, hasBase) => (hasBase && b ? (a - b) / b : null);
  const deltas = (base, baseDays) => {
    const out = {};
    for (const k of Object.keys(M)) {
      out[k] = (M[k] >= 0 && baseDays) ? pctOf(cur[k], base[k], true) : null;
    }
    return out;
  };

  /**
   * DAY-COUNT GUARD. Studio's 500-row cap silently drops the quietest days, so
   * a window that should hold 31 days and holds 28 is under-reported by three
   * days nobody asked about. Counted, not trusted.
   */
  const expected = cw.days;
  const dayGaps = Math.max(0, expected - cur.days);

  /**
   * COVERAGE COMES FROM THE FILE, not from the report's date range. A pasted
   * sheet has no way to announce that nobody pasted this month; the slide states
   * the range it actually found and whether that range reaches the report period.
   */
  const covered = allDates.length
    ? { from: allDates[0], to: allDates[allDates.length - 1] } : null;
  const stale = !covered || covered.to < from || covered.from > to;

  const series = [...byDate.entries()]
    .filter(([d]) => d >= from && d <= to)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, r]) => ({ d, v: M.views >= 0 ? n(r[M.views]) : 0 }));

  /**
   * TOP VIDEOS for the report month only, matched on the hand-added `Month`
   * column. Studio may write it as a date (2026-07-01) or someone may type
   * "2026-07", so both are reduced to a YYYY-MM key — a routine that only works
   * when the person formats the cell correctly is not a routine.
   */
  const monthKey = String(from).slice(0, 7);
  const vHead = headOf(vids), vCol = colOf(vHead);
  const vMonth = vCol("month"), vId = vCol("content"), vTitle = vCol("video title");
  /**
   * PUBLISH DATE IS OPTIONAL, because it is a column someone has to switch on
   * in Studio. Read by name like everything else, and simply absent from the
   * payload when the export does not carry it — the slide then omits the column
   * rather than printing ten dashes and inviting the question. `colOf` is
   * exact-then-prefix, so "Video publish time" resolves from "video publish".
   */
  const vPub = vCol("video publish");
  const VM = { views: vCol("views"), hoursWatched: vCol("watch time"),
    shares: vCol("shares"), likes: vCol("likes"), comments: vCol("comments") };
  if (VM.hoursWatched >= 0 && !vHead[VM.hoursWatched].includes("hour")) VM.hoursWatched = -1;
  const mKey = (v) => {
    const s = String(v == null ? "" : v).trim();
    const d = apptDay(s);
    return d ? d.slice(0, 7) : (/^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null);
  };
  const videoRows = vids.slice(1)
    .filter((r) => vId >= 0 && String(r[vId] || "").trim()
      && String(r[vId]).trim().toLowerCase() !== "total"
      && (vMonth < 0 || mKey(r[vMonth]) === monthKey))
    .map((r) => ({
      id: String(r[vId]).trim(),
      /**
       * THE THUMBNAIL IS ONLY OFFERED WHEN THE ID LOOKS LIKE AN ID.
       *
       * Studio's CONTENT view puts the eleven-character video id in this
       * column, which is what makes `i.ytimg.com` thumbnails possible at all.
       * But a hand-maintained sheet is a hand-maintained sheet: if someone
       * pastes the title view instead, `id` is a sentence, and building a
       * thumbnail URL from it would give ten broken images with no clue why.
       * Checked against the id grammar rather than assumed.
       */
      thumb: /^[A-Za-z0-9_-]{11}$/.test(String(r[vId]).trim()) ? String(r[vId]).trim() : null,
      published: vPub >= 0 ? (apptDay(r[vPub]) || null) : null,
      title: String(vTitle >= 0 ? (r[vTitle] || "") : "").trim(),
      views: VM.views >= 0 ? n(r[VM.views]) : null,
      hours: VM.hoursWatched >= 0 ? Math.round(n(r[VM.hoursWatched])) : null,
      shares: VM.shares >= 0 ? n(r[VM.shares]) : null,
      likes: VM.likes >= 0 ? n(r[VM.likes]) : null,
      comments: VM.comments >= 0 ? n(r[VM.comments]) : null,
    }))
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, 10);

  return {
    source: "studio-export",
    available: cur.days > 0 || videoRows.length > 0,
    totals: cur,
    prev, yoy,
    mom: deltas(prev, prev.days),
    yoyChange: deltas(yoy, yoy.days),
    present, missing,
    covered, stale,
    expectedDays: expected, foundDays: cur.days, dayGaps,
    videosMonth: monthKey,
    videosHavePublished: vPub >= 0,
    series: { metric: M.views >= 0 ? "Views" : null, rows: series },
    videos: { rows: videoRows },
  };
}

async function buildGbpKeywords(from, to) {
  const tabs = BRAND_KEYS;
  const ranges = tabs.map((t) => `'${t}'!A2:G`);
  const res = await sheetBatchGet(GBPKW_SHEET_ID, ranges);
  const want = monthWeekLabels(from, to);
  const byBrand = {};
  let outOfRange = 0;

  tabs.forEach((brand, i) => {
    const rows = (res[i] && res[i].values) || [];
    /**
     * A keyword can appear once per LOCATION within a tab, so rank is averaged
     * across locations rather than summed — summing ranks would be meaningless
     * and averaging is what the sheet's own decimal ranks already represent.
     * Search volume is a property of the keyword, not the location, so the
     * maximum is taken rather than a total (adding it would multiply one number
     * by the location count).
     */
    const agg = new Map();
    for (const r of rows) {
      const kw = String(r[1] || "").trim(); if (!kw) continue;
      const mw = String(r[2] || "").trim();
      if (!want.has(mw)) { outOfRange++; continue; }
      const rank = parseFloat(String(r[4] || "").replace(/,/g, ""));
      if (!isFinite(rank)) continue;
      const vol = n(String(r[5] || "").replace(/,/g, ""));
      const e = agg.get(kw) || { keyword: kw, rankSum: 0, rankN: 0, volume: 0, locations: 0 };
      e.rankSum += rank; e.rankN++; e.locations++;
      e.volume = Math.max(e.volume, vol);
      agg.set(kw, e);
    }
    const list = [...agg.values()].map((e) => ({
      keyword: e.keyword,
      rank: Math.round((e.rankSum / e.rankN) * 100) / 100,
      volume: e.volume, locations: e.locations,
    }));
    byBrand[brand] = {
      // Best rank first: the question is where we stand, and rank 1 is the top.
      rows: list.sort((a, b) => a.rank - b.rank || b.volume - a.volume).slice(0, 20),
      keywords: list.length,
      top3: list.filter((k) => k.rank <= 3).length,
      top10: list.filter((k) => k.rank <= 10).length,
      // Volume is only meaningful where the tool actually reported it; a great
      // many rows carry 0, and averaging those in would understate the rest.
      withVolume: list.filter((k) => k.volume > 0).length,
      avgRank: list.length
        ? Math.round((list.reduce((a, k) => a + k.rank, 0) / list.length) * 100) / 100 : null,
    };
  });
  return { byBrand, months: [...want], outOfRange };
}

async function buildAppointments(from, to) {
  const rows = await sheetBatchGet(APPT_SHEET_ID, [
    "Realtime!C2:C", "Realtime!T2:T", "Realtime!U2:U",
    "'Non Realtime'!B2:B", "'Non Realtime'!P2:P", "'Non Realtime'!S2:S",
    "Total Amounts!A1:I",
  ]);
  const col = (i) => (rows[i] && rows[i].values ? rows[i].values.map((r) => (r && r[0]) || "") : []);
  const [rtLoc, rtHosp, rtDate, nrDate, nrSpec, nrHosp] = [0, 1, 2, 3, 4, 5].map(col);
  const amounts = (rows[6] && rows[6].values) || [];

  const blank = () => ({ realtime: 0, nonRealtime: 0, realtimeRev: 0, nonRealtimeRev: 0,
    rtMix: new Map(), nrMix: new Map() });
  const per = { BHQ: blank() };
  for (const b of BRANDS) per[b.key] = blank();
  let discarded = 0, outOfRange = 0;

  const inRange = (d) => d && d >= from && d <= to;
  const bump = (mix, label) => {
    const k = String(label || "").trim() || NOT_SPECIFIED;
    mix.set(k, (mix.get(k) || 0) + 1);
  };

  for (let i = 0; i < rtDate.length; i++) {
    const day = apptDay(rtDate[i]);
    if (!inRange(day)) { if (day) outOfRange++; continue; }
    const bk = apptBrand(rtHosp[i]);
    if (!bk) { discarded++; continue; }
    per[bk].realtime++; bump(per[bk].rtMix, rtLoc[i]);
    per.BHQ.realtime++; bump(per.BHQ.rtMix, rtLoc[i]);
  }
  for (let i = 0; i < nrDate.length; i++) {
    const day = apptDay(nrDate[i]);
    if (!inRange(day)) { if (day) outOfRange++; continue; }
    const bk = apptBrand(nrHosp[i]);
    if (!bk) { discarded++; continue; }
    per[bk].nonRealtime++; bump(per[bk].nrMix, nrSpec[i]);
    per.BHQ.nonRealtime++; bump(per.BHQ.nrMix, nrSpec[i]);
  }

  /**
   * Revenue is MONTHLY, per hospital: B–E Realtime for BGH/BIH/BHT/WSH, F–I the
   * same four Non Realtime. MW's spec said "col B" and "col F" because MW was
   * describing the BGH page; mapping by brand is what makes the other three
   * hospitals correct rather than all showing BGH's money.
   *
   * A month counts when it falls inside the range. The sheet has no finer
   * grain, so a part-month range still gets that whole month — stated on the
   * card, because revenue that does not move with the dates looks like a bug.
   */
  const order = ["BGH", "BIH", "BHT", "WSH"];
  let revMonths = 0;
  for (const r of amounts.slice(1)) {
    const day = apptDay(r[0]);
    if (!day) continue;
    const ym = day.slice(0, 7);
    if (ym < from.slice(0, 7) || ym > to.slice(0, 7)) continue;
    revMonths++;
    order.forEach((k, idx) => {
      const rt = n(String(r[1 + idx] || "").replace(/,/g, ""));
      const nr = n(String(r[5 + idx] || "").replace(/,/g, ""));
      per[k].realtimeRev += rt; per[k].nonRealtimeRev += nr;
      per.BHQ.realtimeRev += rt; per.BHQ.nonRealtimeRev += nr;
    });
  }

  const topMix = (mix) => {
    const total = [...mix.values()].reduce((a, v) => a + v, 0);
    return { total,
      rows: [...mix.entries()].map(([label, cases]) => ({ label, cases,
        share: total ? cases / total : null }))
        .sort((a, b) => b.cases - a.cases).slice(0, 8),
      distinct: mix.size };
  };
  const byScope = {};
  for (const k of Object.keys(per)) {
    const p = per[k];
    byScope[k] = { realtime: p.realtime, nonRealtime: p.nonRealtime,
      completes: p.realtime + p.nonRealtime,
      realtimeRev: p.realtimeRev, nonRealtimeRev: p.nonRealtimeRev,
      revenue: p.realtimeRev + p.nonRealtimeRev,
      rtMix: topMix(p.rtMix), nrMix: topMix(p.nrMix) };
  }
  return { byScope, discarded, outOfRange, revMonths,
    notSpecified: NOT_SPECIFIED };
}

const ECOM_TAB = process.env.ECOM_TAB || "Orders";



/**
 * Sales channels grouped the way the business thinks about them, supplied by
 * the marketing team. This matters because a handful of B2B and Special
 * Campaign orders are enormous — three "Agent" orders alone were ฿8.3M in
 * July — so mixing them into per-channel averages destroys the comparison.
 * The e-commerce view therefore defaults to Online only.
 */
const CHANNEL_TYPE = {
  "Shopee": "Online", "Lazada": "Online", "Health Plaza": "Online", "Line Chatbot": "Online",
  "Line Shopping": "Online", "Shop.BeDee": "Online", "Bangkok Hospital Website": "Online",
  "HPC 1": "Offline", "เปียโน": "Offline", "เวชระเบียน": "Offline", "ทันตกรรม": "Offline",
  "Contact Center": "Offline", "เว็บไซต์": "Offline", "พลาซ่า": "Offline",
  "BHT IPD / OPD": "Offline", "ชีววัฒนะ": "Offline", "Website (Special)": "Offline",
  "ตึกวัฒโนสถ": "Offline",
  "Agent": "B2B", "SME&COP": "B2B", "การตลาดกลุ่มลูกค้าองค์กร": "B2B", "DR PHARMA": "B2B",
  "SAVE DRUG": "B2B", "Insurance": "B2B",
  "Partnership": "Special Campaign", "Free Trial": "Special Campaign",
  "Run with the Flow": "Special Campaign",
  "คูปองอภินันทนาการ": "Complementary", "Complementary (Discount Coupon)": "Complementary",
  "Better Club": "Complementary",
  "Extra": "Extra",
};
const channelType = (ch) => CHANNEL_TYPE[String(ch || "").trim()] || "Unclassified";

async function gcsRead(objectName, bucket = BENCH_BUCKET) {
  if (!bucket) return null;
  const token = await gcpAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GCS read ${res.status}`);
  return res.json();
}

async function gcsWrite(objectName, value, bucket = BENCH_BUCKET) {
  if (!bucket) return false;
  const token = await gcpAccessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  return res.ok;
}

// -------------------------------------------------------------------- /api/gbp
/**
 * Google Business Profile reviews per listing.
 *
 * Star rating arrives as an enum string (FIVE/FOUR/...), not a number, so it is
 * mapped explicitly; numeric forms are accepted too in case the connector
 * changes. Reviews are bucketed by review_create_time rather than the generic
 * date field, because a review's own timestamp is what belongs on the timeline.
 */
const GBP_LISTINGS = [
  { key: "BGH",    title: "Bangkok Hospital" },
  { key: "BIH",    title: "Bangkok International Hospital (Brain x Bone)" },
  { key: "BHT",    title: "Bangkok Heart Hospital" },
  { key: "WSH",    title: "Bangkok Cancer Hospital Wattanosoth" },
  { key: "Dental", title: "Dental Center | Bangkok Hospital" },
  { key: "JMS",    title: "Japanese Medical Services (JMS) バンコク病院日本人専門クリニック" },
];

const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 };
const starOf = (v) => {
  const raw = String(v || "").trim().toUpperCase();
  return STAR_MAP[raw] || null;
};

function monthsBetween(fromISO, toISO) {
  const out = [];
  const a = new Date(fromISO + "T00:00:00Z");
  const b = new Date(toISO + "T00:00:00Z");
  let cur = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
  while (cur <= b) {
    out.push({
      key: `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`,
      label: cur.toLocaleString("en", { month: "short", year: "2-digit", timeZone: "UTC" }),
    });
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return out;
}

async function buildGbp(from, to) {
  const recentFrom = (() => {
    const d = new Date(to + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 60);
    const f = d.toISOString().slice(0, 10);
    return f > from ? f : from;
  })();

  const { data, errors } = await runJobs({
    reviews: windsor("google_my_business",
      ["review_create_time", "location_title", "review_star_rating"], from, to),
    totals: windsor("google_my_business",
      ["location_title", "review_total_count", "review_average_rating_total"], from, to),
    profile: windsor("google_my_business",
      ["location_title", "impressions", "call_clicks", "website_clicks", "direction_requests"], from, to),
    recent: windsor("google_my_business",
      ["review_create_time", "location_title", "review_star_rating", "review_comment", "review_reviewer", "review_reply_comment"],
      recentFrom, to),
  });

  if (data.reviews === null) {
    const e = new Error(`Google Business Profile unavailable: ${errors.reviews}`);
    e.status = 502; throw e;
  }

  const months = monthsBetween(from, to);
  const titleToKey = new Map(GBP_LISTINGS.map((l) => [l.title, l.key]));

  // Any listing the account returns that isn't in the configured list still gets
  // a tab, so a newly added profile can't silently vanish from the report.
  const seenTitles = new Set();
  for (const r of data.reviews) if (r.location_title) seenTitles.add(r.location_title);
  for (const r of data.totals || []) if (r.location_title) seenTitles.add(r.location_title);
  const listings = [
    ...GBP_LISTINGS.filter((l) => seenTitles.has(l.title)),
    ...[...seenTitles].filter((t) => !titleToKey.has(t)).map((t) => ({ key: t.slice(0, 14), title: t, unlisted: true })),
  ];

  const blankMonth = () => ({ s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, count: 0, ratingSum: 0 });
  const per = new Map(listings.map((l) => [l.title, {
    ...l,
    months: new Map(months.map((m) => [m.key, { ...m, ...blankMonth() }])),
    periodCount: 0, periodRatingSum: 0,
    stars: { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 },
    allTimeCount: null, allTimeRating: null,
    impressions: null, calls: null, websiteClicks: null, directions: null,
    recent: [],
  }]));

  let unparsedStars = 0;
  for (const r of data.reviews) {
    const L = per.get(r.location_title);
    if (!L) continue;
    const star = starOf(r.review_star_rating);
    if (!star) { unparsedStars++; continue; }
    const mk = String(r.review_create_time || "").slice(0, 7);
    const bucket = L.months.get(mk);
    if (bucket) {
      bucket[`s${star}`] += 1;
      bucket.count += 1;
      bucket.ratingSum += star;
    }
    L.stars[`s${star}`] += 1;
    L.periodCount += 1;
    L.periodRatingSum += star;
  }

  for (const r of data.totals || []) {
    const L = per.get(r.location_title);
    if (!L) continue;
    L.allTimeCount = n(r.review_total_count);
    L.allTimeRating = n(r.review_average_rating_total);
  }
  for (const r of data.profile || []) {
    const L = per.get(r.location_title);
    if (!L) continue;
    L.impressions = n(r.impressions);
    L.calls = n(r.call_clicks);
    L.websiteClicks = n(r.website_clicks);
    L.directions = n(r.direction_requests);
  }
  for (const r of data.recent || []) {
    const L = per.get(r.location_title);
    if (!L) continue;
    L.recent.push({
      at: r.review_create_time || null,
      star: starOf(r.review_star_rating),
      comment: String(r.review_comment || "").slice(0, 400),
      reviewer: r.review_reviewer || null,
      replied: Boolean(String(r.review_reply_comment || "").trim()),
    });
  }

  const out = listings.map((l) => {
    const L = per.get(l.title);
    const series = months.map((m) => L.months.get(m.key));

    /**
     * Running all-time rating at the END of each month — the number that shows
     * whether the profile is improving, unlike a per-month average which swings
     * on a single bad review.
     *
     * Reviews predating the selected range still count toward it, so the opening
     * balance is back-solved from the all-time figures: the star-points and count
     * that must have existed before the range = all-time totals minus what the
     * range contains. Google reports the all-time average rounded to one decimal,
     * so the opening balance carries a little imprecision; it shifts the whole
     * line by a fraction of a star and never changes its shape.
     */
    const rangeCount = L.periodCount;
    const rangeSum = L.periodRatingSum;
    const haveAllTime = L.allTimeCount != null && L.allTimeRating != null && L.allTimeCount > 0;
    let priorCount = 0, priorSum = 0, cumulativeBasis = "range-only";
    if (haveAllTime) {
      priorCount = Math.max(0, L.allTimeCount - rangeCount);
      priorSum = Math.max(0, L.allTimeCount * L.allTimeRating - rangeSum);
      cumulativeBasis = priorCount > 0 ? "all-time" : "range-covers-all";
    }
    let runCount = priorCount, runSum = priorSum;
    for (const m of series) {
      runCount += m.count;
      runSum += m.ratingSum;
      m.cumRating = runCount ? +(runSum / runCount).toFixed(3) : null;
      m.cumCount = runCount;
    }
    const recent = L.recent.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const negatives = recent.filter((r) => r.star && r.star <= 3);
    return {
      key: l.key, title: l.title, unlisted: Boolean(l.unlisted),
      allTimeCount: L.allTimeCount, allTimeRating: L.allTimeRating,
      periodCount: L.periodCount,
      periodRating: L.periodCount ? L.periodRatingSum / L.periodCount : null,
      stars: L.stars,
      series,
      cumulativeBasis, priorCount,
      impressions: L.impressions, calls: L.calls,
      websiteClicks: L.websiteClicks, directions: L.directions,
      recent: recent.slice(0, 25),
      recentNegatives: negatives.length,
      recentUnreplied: recent.filter((r) => !r.replied).length,
    };
  }).sort((a, b) => n(b.allTimeCount) - n(a.allTimeCount));

  return {
    range: { from, to }, recentFrom,
    listings: out,
    months,
    unparsedStars,
    unavailable: Object.keys(errors), errors,
    syncedAt: new Date().toISOString(),
  };
}

app.get("/api/gbp", requireTab("gbp"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`gbp:${from}:${to}`, req.query.refresh === "1", () => buildGbp(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "gbp_failed", { error: String(err.message || err) });
    res.status(err.status || 500).json({ error: err.message || "GBP report failed" });
  }
});

// ------------------------------------------------------------- /api/benchmark
/**
 * Rolling efficiency benchmarks.
 *
 * A benchmark is only meaningful as a comparison, so this returns the last 12
 * COMPLETE calendar months plus trailing 3/6/12-month windows, and compares the
 * most recent complete month against each. Partial months are excluded on both
 * sides — comparing 3 days of August against a full-month average would make
 * every metric look spectacular.
 *
 * Window ratios are derived from summed totals, not averaged from monthly
 * ratios: averaging ratios lets a tiny month distort the figure as much as a
 * large one.
 */
function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }

function completeMonthsBack(anchorISO, count) {
  const a = new Date(anchorISO + "T00:00:00Z");
  // The anchor's own month is treated as incomplete unless the anchor is its last day.
  const lastOfAnchorMonth = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0));
  const anchorMonthComplete = a.getUTCDate() === lastOfAnchorMonth.getUTCDate();
  const end = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + (anchorMonthComplete ? 1 : 0), 0));
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    months.push({
      key: monthKey(first),
      label: first.toLocaleString("en", { month: "short", year: "2-digit", timeZone: "UTC" }),
      from: first.toISOString().slice(0, 10),
      to: last.toISOString().slice(0, 10),
    });
  }
  return months;
}

const derive = (t) => {
  const o = { ...t };
  o.costPerVisit    = t.spend && t.visits    ? t.spend / t.visits    : null;
  o.costPerKeyEvent = t.spend && t.keyEvents ? t.spend / t.keyEvents : null;
  o.costPerContact  = t.spend && t.contacts  ? t.spend / t.contacts  : null;
  o.costPerLead     = t.spend && t.leads     ? t.spend / t.leads     : null;
  o.costPerMessage  = t.spend && t.messages  ? t.spend / t.messages  : null;
  o.cpm             = t.impressions ? (t.spend / t.impressions) * 1000 : null;
  o.cpc             = t.spend && t.clicks    ? t.spend / t.clicks    : null;
  o.visitsPerK      = t.spend ? t.visits    / (t.spend / 1000) : null;
  o.keyEventsPerK   = t.spend ? t.keyEvents / (t.spend / 1000) : null;
  o.leadsPerK       = t.spend ? t.leads     / (t.spend / 1000) : null;
  o.messagesPerK    = t.spend ? t.messages  / (t.spend / 1000) : null;
  o.roas            = t.spend ? t.revenue   / t.spend : null;
  return o;
};

const BLANK = () => ({
  spend: 0, impressions: 0, clicks: 0, landingPageViews: 0, leads: 0, messages: 0,
  visits: 0, keyEvents: 0, contacts: 0, revenue: 0, purchases: 0,
});

const META_MONTHLY_FIELDS = [
  "date", "account_name", "spend", "impressions", "clicks",
  "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d", "actions_post_engagement", "actions_landing_page_view",
];
const META_CAMPAIGN_FIELDS = [
  "account_name", "campaign", "campaign_objective", "spend", "impressions", "clicks",
  "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d", "actions_post_engagement",
];
const leadsOf = (r) => n(r.actions_lead);
const msgsOf = (r) => n(r.actions_onsite_conversion_messaging_conversation_started_7d);

/** Leading YYMMDD-NN code in a campaign name, or null. */
const codeStem = (name) => {
  const m = String(name || "").match(/^(\d{6}-\d{1,3})/);
  return m ? m[1].toLowerCase() : null;
};

async function buildBenchmark(anchorISO) {
  const months = completeMonthsBack(anchorISO, 12);
  if (!months.length) throw new Error("No complete months available before the anchor date.");
  const from = months[0].from, to = months[months.length - 1].to;
  const win = (count) => {
    const slice = months.slice(-count);
    return { from: slice[0].from, to: slice[slice.length - 1].to, months: slice.length };
  };
  const W = { m3: win(3), m6: win(6), m12: win(12) };

  const { data, errors } = await runJobs({
    metaMonthly: windsor("facebook", META_MONTHLY_FIELDS, from, to),
    metaCampaigns: windsor("facebook", META_CAMPAIGN_FIELDS, from, to),
    ga4m3: ga4Compat(["session_manual_campaign_name"], ["sessions", "purchase_revenue"], W.m3.from, W.m3.to),
    ga4m6: ga4Compat(["session_manual_campaign_name"], ["sessions", "purchase_revenue"], W.m6.from, W.m6.to),
    ga4m12: ga4Compat(["session_manual_campaign_name"], ["sessions", "purchase_revenue"], W.m12.from, W.m12.to),
    ga4Monthly: ga4Compat(["date"], ["sessions", "purchase_revenue"], from, to),
    keM3: ga4KeyEvents(["session_manual_campaign_name"], W.m3.from, W.m3.to),
    keM6: ga4KeyEvents(["session_manual_campaign_name"], W.m6.from, W.m6.to),
    keM12: ga4KeyEvents(["session_manual_campaign_name"], W.m12.from, W.m12.to),
    keMonthly: ga4KeyEvents(["date"], from, to),
  });

  if (data.metaMonthly === null) {
    const e = new Error(`Meta Ads unavailable: ${errors.metaMonthly}`);
    e.status = 502; throw e;
  }

  // ---- campaign -> account + goal, and each account's code stems ----
  const campaignInfo = new Map();
  const accountGoals = new Map();   // account -> goal -> totals
  const accountStems = new Map();   // account -> Set(code stem)
  for (const r of data.metaCampaigns || []) {
    const acct = r.account_name || "Unknown";
    const goal = goalOf(r.campaign_objective, r.campaign);
    campaignInfo.set(r.campaign, { account: acct, goal, objective: r.campaign_objective || null });
    if (!accountGoals.has(acct)) accountGoals.set(acct, new Map());
    const gm = accountGoals.get(acct);
    if (!gm.has(goal)) gm.set(goal, { goal, ...BLANK() });
    const g = gm.get(goal);
    g.spend += n(r.spend); g.impressions += n(r.impressions); g.clicks += n(r.clicks);
    g.leads += leadsOf(r); g.messages += msgsOf(r);
    const stem = codeStem(r.campaign);
    if (stem) {
      if (!accountStems.has(acct)) accountStems.set(acct, new Set());
      accountStems.get(acct).add(stem);
    }
  }

  // ---- monthly series per account, plus an "all" roll-up ----
  const monthIndex = new Map(months.map((m) => [m.key, m]));
  const seriesByAccount = new Map();
  const ensure = (acct) => {
    if (!seriesByAccount.has(acct)) {
      seriesByAccount.set(acct, new Map(months.map((m) => [m.key, { ...m, ...BLANK() }])));
    }
    return seriesByAccount.get(acct);
  };
  for (const r of data.metaMonthly) {
    const k = String(r.date || "").slice(0, 7);
    if (!monthIndex.has(k)) continue;
    for (const acct of [r.account_name || "Unknown", "__all__"]) {
      const m = ensure(acct).get(k);
      m.spend += n(r.spend); m.impressions += n(r.impressions); m.clicks += n(r.clicks);
      m.leads += leadsOf(r); m.messages += msgsOf(r);
      m.landingPageViews += n(r.actions_landing_page_view);
    }
  }
  /**
   * Declared BEFORE the monthly loop below, which reads `keMonthly`.
   *
   * These sat under that loop until v3.100.0 and threw "Cannot access
   * 'keMonthly' before initialization" on every cold build — the same temporal
   * dead zone class as v3.12.1. It survived because the test GCS stub answered
   * every read with a stored object, so `buildBenchmark` never once ran in the
   * suite; the endpoint returned a cached 200 and looked healthy.
   */
  const EMPTY_KE = { total: 0, byKey: new Map(), byName: new Map(), byKeyEvent: new Map(), rows: [], failed: true };
  const keMonthly = data.keMonthly || EMPTY_KE;

  // Site-side metrics exist only in total, so they're attached to the roll-up.
  if (data.ga4Monthly !== null) for (const r of data.ga4Monthly) {
    const k = String(r.date || "").slice(0, 7);
    if (!monthIndex.has(k)) continue;
    const m = ensure("__all__").get(k);
    const dk = ga4JoinKey(["date"], r, false);
    m.visits += n(r.sessions); m.keyEvents += keMonthly.byKey.get(dk) || 0;
    m.contacts += keMonthly.byKeyEvent.get(`${dk}\u0000contact_us`) || 0;
    m.revenue += n(r.purchase_revenue);
  }

  /** GA4 rows for a window, attributed to an account via campaign code stems. */
  const ga4ForAccount = (rows, stems, kew) => {
    const t = BLANK();
    if (rows === null) return t;
    for (const r of rows) {
      const name = norm(r.session_manual_campaign_name);
      if (!name) continue;
      if (stems && ![...stems].some((st) => name.startsWith(st))) continue;
      const ck = ga4JoinKey(["session_manual_campaign_name"], r, false);
      t.visits += n(r.sessions);
      t.keyEvents += kew.byKey.get(ck) || 0;
      t.contacts += kew.byKeyEvent.get(`${ck}\u0000contact_us`) || 0;
      t.revenue += n(r.purchase_revenue);
    }
    return t;
  };

  const windowRows = { m3: data.ga4m3, m6: data.ga4m6, m12: data.ga4m12 };
  const windowKe = { m3: data.keM3 || EMPTY_KE, m6: data.keM6 || EMPTY_KE, m12: data.keM12 || EMPTY_KE };

  function buildAccount(acct) {
    const isAll = acct === "__all__";
    const series = months.map((m) => derive(ensure(acct).get(m.key)));
    const active = series.filter((m) => m.spend > 0 || m.visits > 0);
    const stems = isAll ? null : (accountStems.get(acct) || new Set());

    const windows = {};
    for (const [key, wdef] of Object.entries(W)) {
      const slice = series.slice(-wdef.months).filter((m) => m.spend > 0 || m.visits > 0);
      if (!slice.length) { windows[key] = null; continue; }
      const t = slice.reduce((a, m) => {
        for (const f of Object.keys(BLANK())) a[f] += m[f];
        return a;
      }, BLANK());
      // Site metrics for a single account come from the code-matched window pull,
      // not from the monthly series (which only carries them in the roll-up).
      if (!isAll) {
        const g = ga4ForAccount(windowRows[key], stems, windowKe[key]);
        t.visits = g.visits; t.keyEvents = g.keyEvents; t.contacts = g.contacts; t.revenue = g.revenue;
      }
      windows[key] = { months: slice.length, requested: wdef.months, avgMonthlySpend: t.spend / slice.length, ...derive(t) };
    }

    const latest = active.length ? active[active.length - 1] : null;
    const goals = isAll
      ? [...[...accountGoals.values()].reduce((acc, gm) => {
          for (const [g, v] of gm.entries()) {
            if (!acc.has(g)) acc.set(g, { goal: g, ...BLANK() });
            const t = acc.get(g);
            for (const f of Object.keys(BLANK())) t[f] += v[f];
          }
          return acc;
        }, new Map()).values()]
      : [...(accountGoals.get(acct) || new Map()).values()];

    return {
      account: isAll ? "All accounts" : acct,
      id: acct,
      series, windows, latestMonth: latest ? { key: latest.key, label: latest.label } : null,
      spend3m: windows.m3 ? windows.m3.spend : 0,
      spend12m: windows.m12 ? windows.m12.spend : 0,
      goals: goals.map((g) => {
        const def = GOAL_DEFS[g.goal] || GOAL_DEFS.unclassified;
        const d2 = derive(g);
        const resultCount = g[def.result] || 0;
        const per = def.perThousand ? resultCount / 1000 : resultCount;
        return {
          goal: g.goal, label: def.label, resultLabel: def.resultLabel, source: def.source,
          spend: g.spend, impressions: g.impressions, clicks: g.clicks,
          leads: g.leads, messages: g.messages,
          resultCount, costPerResult: g.spend && per ? g.spend / per : null,
          resultsPerK: g.spend ? per / (g.spend / 1000) : null,
          cpm: d2.cpm, cpc: d2.cpc,
        };
      }).sort((a, b) => b.spend - a.spend),
    };
  }

  // Accounts with any spend in the 12 months, busiest 3 months first.
  const accountNames = [...seriesByAccount.keys()].filter((a) => a !== "__all__");
  const accounts = accountNames.map(buildAccount)
    .filter((a) => a.spend12m > 0)
    .sort((a, b) => b.spend3m - a.spend3m);
  const all = buildAccount("__all__");

  const METRICS = [
    { id: "costPerVisit", label: "Cost per visit", money: true, lowerIsBetter: true },
    { id: "costPerContact", label: "Cost per contact", money: true, lowerIsBetter: true },
    { id: "costPerLead", label: "Cost per lead", money: true, lowerIsBetter: true },
    { id: "costPerMessage", label: "Cost per conversation", money: true, lowerIsBetter: true },
    { id: "cpm", label: "CPM", money: true, lowerIsBetter: true },
    { id: "keyEventsPerK", label: "Key events per ฿1,000", money: false, lowerIsBetter: false },
    { id: "roas", label: "Revenue per ฿1 spend", money: false, lowerIsBetter: false },
  ];
  const comparisonFor = (a) => {
    const latest = a.series.filter((m) => m.spend > 0 || m.visits > 0).slice(-1)[0];
    if (!latest) return null;
    return METRICS.map((mt) => {
      const cur = latest[mt.id];
      const vs = {};
      for (const [k, w] of Object.entries(a.windows)) {
        const base = w ? w[mt.id] : null;
        vs[k] = (cur == null || base == null || base === 0) ? null : { base, deltaPct: ((cur - base) / base) * 100 };
      }
      return { ...mt, current: cur, vs };
    }).filter((m) => m.current != null || Object.values(m.vs).some((v) => v));
  };

  all.comparison = comparisonFor(all);
  for (const a of accounts) a.comparison = comparisonFor(a);

  return {
    anchor: anchorISO,
    coverage: { from, to, completeMonths: months.length, monthsWithData: all.series.filter((m) => m.spend > 0 || m.visits > 0).length },
    all, accounts,
    unavailable: Object.keys(errors), errors,
    computedAt: new Date().toISOString(),
  };
}

app.get("/api/benchmark", requireTab("benchmark"), async (req, res) => {
  const anchor = isoDate(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  const refresh = req.query.refresh === "1";
  const months = completeMonthsBack(anchor, 1);
  const stamp = months.length ? months[0].key : anchor;
  const objectName = `benchmark/${stamp}.json`;
  try {
    if (!refresh) {
      const stored = await gcsRead(objectName).catch(() => null);
      if (stored) return res.json({ ...stored, cached: true, storedFor: stamp, store: "gcs" });
    }
    // Long TTL: the answer can't change until the month rolls over.
    const out = await withCache(`benchmark:${stamp}`, refresh, () => buildBenchmark(anchor), 7 * 24 * 3600 * 1000);
    gcsWrite(objectName, out.value).catch((e) => logJson("WARNING", "benchmark_store_failed", { error: String(e.message || e) }));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec, storedFor: stamp, store: BENCH_BUCKET ? "gcs" : "memory" });
  } catch (err) {
    logJson("ERROR", "benchmark_failed", { error: String(err.message || err) });
    res.status(err.status || 500).json({ error: err.message || "Benchmark failed" });
  }
});

// -------------------------------------------------------------- /api/untagged
/**
 * Tagging audit. Quantifies what the campaign view cannot see:
 *
 *  - traffic arriving with a campaign value that isn't a usable code, split by
 *    cause (a bare platform ID means the ad link carried no utm_campaign; a
 *    placeholder means a template variable was never substituted);
 *  - ad spend on campaigns whose names carry no code that matches any tagged
 *    utm_campaign, i.e. money that can never be joined to an outcome.
 *
 * The point is to turn "tagging is a bit messy" into a figure someone can act on.
 */
const PLACEHOLDER_RE = /(__|\{\{|\}\}|%%|\[\[)/;
const PAID_MEDIUM_AUDIT_RE = /(cpc|ppc|paid|display|banner|video)/i;

function classifyCampaignValue(code, medium) {
  const c = String(code || "").trim();
  const lc = c.toLowerCase();
  if (!c || lc === "(not set)" || lc === "(none)") {
    return PAID_MEDIUM_AUDIT_RE.test(String(medium || "")) ? "paid_untagged" : null;
  }
  if (NON_CAMPAIGN.has(lc)) return null;              // organic/referral: fine
  if (isPlatformId(c)) return "platform_id";
  if (PLACEHOLDER_RE.test(c)) return "placeholder";
  if (looksLikeCode(c)) return null;                   // properly coded
  return "no_code";                                    // named, but not to convention
}

const AUDIT_LABELS = {
  platform_id: "Bare platform ID — the ad link had no utm_campaign, so GA4 fell back to the platform's internal campaign ID",
  placeholder: "Unsubstituted placeholder — a template variable reached production without being replaced",
  paid_untagged: "Paid traffic with no campaign at all",
  no_code: "Named campaign that doesn't follow the YYMMDD-NN convention, so it can't be matched or dated",
};

async function buildUntagged(from, to) {
  const { data, errors } = await runJobs({
    ga4: ga4Compat(["session_manual_campaign_name", "session_manual_source", "session_manual_medium"],
      ["sessions"], from, to),
    keyEvents: ga4KeyEvents(["session_manual_campaign_name", "session_manual_source", "session_manual_medium"], from, to),
    meta: windsor("facebook", ["campaign", "account_name", "campaign_objective", "impressions", "clicks", "spend",
      "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d"], from, to),
    // Google Ads campaign names follow the same YYMMDD-NN code convention as
    // Meta, so they key into the existing campaign analysis without any new
    // matching logic.
    gads: windsor("google_ads", ["campaign", "account_name", "impressions", "clicks", "spend"], from, to),
  });

  if (data.ga4 === null) {
    const e = new Error(`GA4 unavailable: ${errors.ga4}`);
    e.status = 502; throw e;
  }

  const keIdx = data.keyEvents || { total: 0, byKey: new Map(), byName: new Map(), byKeyEvent: new Map(), rows: [], failed: true };

  // ---- traffic side ----
  let taggedVisits = 0, taggedKeyEvents = 0;
  const buckets = new Map();
  const codesSeen = new Set();
  for (const r of data.ga4) {
    const visits = n(r.sessions);
    const ke = keIdx.byKey.get(ga4JoinKey(
      ["session_manual_campaign_name", "session_manual_source", "session_manual_medium"], r, false)) || 0;
    const kind = classifyCampaignValue(r.session_manual_campaign_name, r.session_manual_medium);
    if (kind === null) {
      if (looksLikeCode(r.session_manual_campaign_name)) {
        taggedVisits += visits; taggedKeyEvents += ke;
        codesSeen.add(norm(r.session_manual_campaign_name));
      }
      continue;
    }
    if (!buckets.has(kind)) buckets.set(kind, { kind, label: AUDIT_LABELS[kind], visits: 0, keyEvents: 0, examples: [] });
    const b = buckets.get(kind);
    b.visits += visits; b.keyEvents += ke;
    const ex = String(r.session_manual_campaign_name || "(not set)");
    if (b.examples.length < 6 && !b.examples.includes(ex)) b.examples.push(ex);
  }
  const issues = [...buckets.values()].sort((a, b) => b.visits - a.visits);
  const untaggedVisits = issues.reduce((a, b) => a + b.visits, 0);
  const untaggedKeyEvents = issues.reduce((a, b) => a + b.keyEvents, 0);

  // ---- spend side ----
  let spendTotal = null, spendUnmatched = null, unmatchedCampaigns = null, spendUnmatchedSiteOutcome = 0;
  let spendByPlatform = null;
  if (data.meta !== null || data.gads !== null) {
    const agg = new Map();
    const add = (r, platform) => {
      const name = r.campaign;
      if (!name) return;
      const key = `${platform}|${name}`;
      if (!agg.has(key)) agg.set(key, {
        name, platform, account: r.account_name || "",
        objective: r.campaign_objective || null,
        // Google Ads reports no objective, so its goal is inferred from the name
        // alone — the same fallback the Meta path uses when the field is absent.
        goal: goalOf(r.campaign_objective, name),
        impressions: 0, clicks: 0, spend: 0, leads: 0, messages: 0,
      });
      const a = agg.get(key);
      a.impressions += n(r.impressions); a.clicks += n(r.clicks); a.spend += n(r.spend);
      a.leads += n(r.actions_lead);
      a.messages += n(r.actions_onsite_conversion_messaging_conversation_started_7d);
    };
    if (data.meta !== null) for (const r of data.meta) add(r, "Meta");
    if (data.gads !== null) for (const r of data.gads) add(r, "Google Ads");

    spendByPlatform = ["Meta", "Google Ads"].map((p) => {
      const rows = [...agg.values()].filter((c) => c.platform === p);
      return { platform: p, spend: rows.reduce((a, c) => a + c.spend, 0),
               clicks: rows.reduce((a, c) => a + c.clicks, 0),
               impressions: rows.reduce((a, c) => a + c.impressions, 0),
               campaigns: rows.length,
               available: p === "Meta" ? data.meta !== null : data.gads !== null };
    }).filter((p) => p.available);
    const all = [...agg.values()];
    spendTotal = all.reduce((a, c) => a + c.spend, 0);
    // A Meta campaign is joinable if its leading code prefixes a tagged utm value.
    const unmatched = all.filter((c) => {
      const m = String(c.name).match(/^(\d{6}-\d{1,3})/);
      if (!m) return true;                                  // no code in the name at all
      const stem = norm(m[1]);
      for (const code of codesSeen) if (code.startsWith(stem)) return false;
      return true;
    });
    spendUnmatched = unmatched.reduce((a, c) => a + c.spend, 0);
    /**
     * Attach each campaign's own result metric. Untagged spend on a lead form or
     * message ad is NOT lost measurement — Meta counts those results itself. Only
     * traffic-objective campaigns genuinely lose their outcome when the utm is
     * missing, because the outcome happens on the website.
     */
    unmatchedCampaigns = unmatched.map((c) => {
      const def = GOAL_DEFS[c.goal] || GOAL_DEFS.unclassified;
      const raw = c[def.result] || 0;
      const per = def.perThousand ? raw / 1000 : raw;
      return {
        ...c, goalLabel: def.label, resultLabel: def.resultLabel, resultSource: def.source,
        resultCount: raw, costPerResult: c.spend && per ? c.spend / per : null,
        // Google reports no in-platform result, so a Google campaign without a
        // utm has genuinely lost its outcome whatever its objective.
        measurableWithoutUtm: c.platform === "Meta" && def.source === "Meta",
      };
    }).sort((a, b) => b.spend - a.spend).slice(0, 30);
    const siteOutcome = unmatchedCampaigns.filter((c) => !c.measurableWithoutUtm);
    spendUnmatchedSiteOutcome = siteOutcome.reduce((a, c) => a + c.spend, 0);
  }

  return {
    range: { from, to },
    traffic: {
      taggedVisits, untaggedVisits,
      taggedKeyEvents, untaggedKeyEvents,
      untaggedShare: (taggedVisits + untaggedVisits) ? (untaggedVisits / (taggedVisits + untaggedVisits)) * 100 : null,
      issues,
    },
    spend: {
      total: spendTotal, unmatched: spendUnmatched,
      unmatchedShare: spendTotal ? (spendUnmatched / spendTotal) * 100 : null,
      // The subset that actually loses its outcome: site-measured goals only.
      unmatchedSiteOutcome: spendUnmatchedSiteOutcome,
      unmatchedSiteOutcomeShare: spendTotal ? (spendUnmatchedSiteOutcome / spendTotal) * 100 : null,
      unmatchedCampaigns,
      byPlatform: spendByPlatform,
    },
    taggedCodes: codesSeen.size,
    errors,
    syncedAt: new Date().toISOString(),
  };
}

app.get("/api/untagged", requireTab("audit"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`untagged:${from}:${to}`, req.query.refresh === "1", () => buildUntagged(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "untagged_failed", { error: String(err.message || err) });
    res.status(err.status || 500).json({ error: err.message || "Tagging audit failed" });
  }
});

// ------------------------------------------------------------------ AI (v2)

async function anthropic(prompt, { system, maxTokens = 1500 } = {}) {
  const res = await fetch(ANTHROPIC_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, stopReason: json.stop_reason };
}

function extractJson(text) {
  let t = String(text).trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), sa = t.indexOf("[");
  const start = sa !== -1 && (sa < s || s === -1) ? sa : s;
  if (start === -1) throw new Error("No JSON found in model response");
  const body = t.slice(start);
  try { return JSON.parse(body); } catch (_) {}
  let inStr = false, esc = false, stack = [], lastGood = -1, lastStack = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); continue; }
    if (c === "}" || c === "]") { stack.pop(); continue; }
    if (c === "," && stack.length >= 1) { lastGood = i; lastStack = stack.slice(); }
  }
  if (lastGood === -1 || !lastStack) throw new Error("Model response was truncated and could not be repaired");
  return JSON.parse(body.slice(0, lastGood) + lastStack.reverse().join(""));
}

const META_BASE = "http://metadata.google.internal/computeMetadata/v1";
const META_HDR = { "Metadata-Flavor": "Google" };
let _projectId = null, _token = { value: null, exp: 0 };

async function gcpProjectId() {
  if (_projectId) return _projectId;
  const r = await fetch(`${META_BASE}/project/project-id`, { headers: META_HDR });
  _projectId = (await r.text()).trim();
  return _projectId;
}
async function gcpAccessToken() {
  if (_token.value && Date.now() < _token.exp - 60000) return _token.value;
  const r = await fetch(`${META_BASE}/instance/service-accounts/default/token`, { headers: META_HDR });
  if (!r.ok) throw new Error(`metadata token HTTP ${r.status}`);
  const j = await r.json();
  _token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _token.value;
}
async function modelArmorScreen(text) {
  if (!MA_ENABLED) return { skipped: true, flagged: false };
  try {
    const project = await gcpProjectId();
    const token = await gcpAccessToken();
    const url = `https://modelarmor.${MA_LOCATION}.rep.googleapis.com/v1/projects/${project}/locations/${MA_LOCATION}/templates/${MA_TEMPLATE}:sanitizeUserPrompt`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_prompt_data: { text } }),
    });
    if (!r.ok) { logJson("WARNING", "model_armor_error", { status: r.status }); return { flagged: false }; }
    const j = await r.json();
    return { flagged: j?.sanitizationResult?.filterMatchState === "MATCH_FOUND" };
  } catch (e) {
    logJson("WARNING", "model_armor_exception", { error: String(e.message || e) });
    return { flagged: false };
  }
}

// ---------------------------------------------------------------- /api/topic

async function buildTopic(topic, from, to) {
  const langList = Object.entries(LOCALES).map(([k, v]) => `${k.toUpperCase()} (${v})`).join(", ");
  const expandPrompt =
    `A hospital marketing team wants the search terms patients type into Google for the clinical topic "${topic}".\n` +
    `Cover these languages, each in its own script: ${langList}.\n` +
    `For each language include the medical name, common lay terms, related conditions and procedures, and frequent misspellings. 5-10 terms per language. Keep each term short — what a person actually types.\n` +
    `Return ONLY minified JSON, no prose, no code fences, exactly this shape:\n` +
    `{"TH":["term"],"EN":["term"],"ZH":["term"],"JA":["term"],"AR":["term"],"DE":["term"],"MY":["term"],"VN":["term"],"KM":["term"],"ID":["term"]}`;

  const expandRes = await anthropic(expandPrompt, { maxTokens: 8000 });
  let expanded;
  try { expanded = extractJson(expandRes.text); }
  catch (e) {
    throw new Error(expandRes.stopReason === "max_tokens"
      ? "The term-expansion response was cut off. Try a narrower topic."
      : `Could not parse term expansion: ${e.message}`);
  }
  const terms = [];
  for (const [lang, list] of Object.entries(expanded)) {
    if (!Array.isArray(list)) continue;
    for (const t of list) if (typeof t === "string" && t.trim()) terms.push({ term: t.trim(), lang: lang.toLowerCase() });
  }
  if (!terms.length) throw new Error("Term expansion returned no usable terms.");

  // Search Console is pulled as TWO narrower requests rather than one
  // query x page x country cross product. That combination multiplies row count
  // enormously on a site this size and was large enough to OOM the container
  // (surfacing as a Cloud Run 503). Each call below is one dimension narrower.
  const { data: scData, errors: scErrors } = await runJobs({
    byPage: gscQuery(["query", "page"], from, to),
    byCountry: gscQuery(["query", "country"], from, to),
  });
  if (scData.byPage === null) {
    throw new Error(`Search Console unavailable: ${scErrors.byPage}`);
  }
  const scRows = scData.byPage;

  const normTerms = terms.map((t) => ({ ...t, n: norm(t.term) })).filter((t) => t.n.length >= 2);
  const matchedMap = new Map();
  const matchedTerms = new Set();
  for (const r of scRows) {
    const q = r.query || "";
    const nq = norm(q);
    if (!nq) continue;
    const hit = normTerms.find((t) => nq.includes(t.n) || t.n.includes(nq));
    if (!hit) continue;
    matchedTerms.add(hit.term);
    if (!matchedMap.has(q)) {
      const fromUrl = localeFromPath(r.page);
      const guessed = fromUrl || scriptGuess(q);
      matchedMap.set(q, {
        query: q, clicks: 0, impressions: 0, posW: 0,
        lang: guessed || "en",
        langSource: fromUrl ? "url" : (guessed ? "script" : "assumed"),
        topPage: r.page || null,
      });
    }
    const m = matchedMap.get(q);
    m.clicks += n(r.clicks);
    m.impressions += n(r.impressions);
    m.posW += n(r.position) * n(r.impressions);
  }

  const matched = [...matchedMap.values()].map((m) => ({
    query: m.query, clicks: m.clicks, impressions: m.impressions,
    position: m.impressions ? +(m.posW / m.impressions).toFixed(1) : null,
    lang: m.lang, langSource: m.langSource, topPage: m.topPage,
  })).sort((a, b) => b.impressions - a.impressions);

  const byLang = {};
  for (const m of matched) {
    const L = m.lang;
    byLang[L] = byLang[L] || { lang: L, name: LOCALES[L] || L, queries: 0, clicks: 0, impressions: 0 };
    byLang[L].queries++; byLang[L].clicks += m.clicks; byLang[L].impressions += m.impressions;
  }

  // Country rollup from the second, narrower call.
  const byCountry = {};
  if (scData.byCountry !== null) {
    for (const r of scData.byCountry) {
      if (!matchedMap.has(r.query || "")) continue;
      const c = r.country || "??";
      byCountry[c] = byCountry[c] || { country: c, clicks: 0, impressions: 0 };
      byCountry[c].clicks += n(r.clicks); byCountry[c].impressions += n(r.impressions);
    }
  }

  const gaps = terms.filter((t) => !matchedTerms.has(t.term));

  let clusters = [], clusterNote = "";
  if (matched.length) {
    const pool = matched.slice(0, 100);
    const prompt =
      `Below are numbered Google search queries (multiple languages) a hospital ranks for, all related to "${topic}".\n\n` +
      pool.map((m, i) => `${i}: ${m.query}`).join("\n") +
      `\n\nGroup them into 3-7 clinical sub-topics. Refer to queries ONLY by number.\n` +
      `Return ONLY minified JSON: {"clusters":[{"label":"<short English label>","idx":[0,3]}]}`;
    try {
      const cRes = await anthropic(prompt, { maxTokens: 4000 });
      const parsed = extractJson(cRes.text);
      clusters = (parsed.clusters || []).filter((c) => c && c.label && Array.isArray(c.idx))
        .map((c) => ({ label: String(c.label), queries: c.idx.map((i) => pool[Number(i)]).filter(Boolean).map((m) => m.query) }))
        .filter((c) => c.queries.length);
    } catch (e) {
      logJson("WARNING", "clustering_failed", { error: String(e.message || e) });
      clusterNote = "Sub-topic grouping unavailable this run; the query table below is complete.";
    }
  }

  return {
    topic, range: { from, to },
    summary: {
      matchedQueries: matched.length,
      totalClicks: matched.reduce((a, m) => a + m.clicks, 0),
      totalImpressions: matched.reduce((a, m) => a + m.impressions, 0),
      languages: Object.keys(byLang).length,
      countries: Object.keys(byCountry).length,
      termsGenerated: terms.length,
    },
    expandedTerms: terms,
    matched: matched.slice(0, 200),
    clusters, clusterNote,
    byLanguage: Object.values(byLang).sort((a, b) => b.impressions - a.impressions),
    byCountry: Object.values(byCountry).sort((a, b) => b.impressions - a.impressions).slice(0, 15),
    gaps,
    syncedAt: new Date().toISOString(),
  };
}

app.post("/api/topic", requireTab("topics"), async (req, res) => {
  const { topic, from, to } = req.body || {};
  if (!topic || typeof topic !== "string") return res.status(400).json({ error: "topic (string) required" });
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
  try {
    const screen = await modelArmorScreen(topic);
    if (screen.flagged) {
      logJson("WARNING", "topic_blocked_by_model_armor", { topic });
      return res.status(422).json({ error: "This topic was blocked by content screening. Try rephrasing." });
    }
    const out = await withCache(`topic:${norm(topic)}:${from}:${to}`, req.body.refresh === true,
      () => buildTopic(topic, from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "topic_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Topic exploration failed" });
  }
});

// ---------------------------------------------------------------- meta/infra

/** Who am I, and what may I see? The client builds its nav from this. */
// ------------------------------------------------------------ /api/audiences

/**
 * Meta Audience Set Analytics. Groups paid ad sets by their (normalised) name,
 * because the team's discipline of reusing saved-audience names across
 * campaigns makes the name the audience's identity. adset_targeting would be
 * the true identity, but Meta refuses it at account scale ("reduce the amount
 * of data"), so names it is — "– Copy" suffixes are collapsed into the parent.
 *
 * "First-degree action" ranking: each ad set row is classified by its
 * campaign's objective token (lead / message / otherwise traffic), and the
 * audience's primary cost-per uses the class where it spent the most, so a
 * lead audience is judged on cost/lead and a traffic audience on cost/LPV
 * rather than everything being forced through one metric.
 */
function normAudienceName(name) {
  return String(name || "").replace(/\s*[–-]\s*copy\s*\d*$/i, "").replace(/\s+/g, " ").trim();
}
/**
 * Objective class decides which cost-per is the audience's real KPI.
 * "ecommerce" covers Collaborative Ads (CPAS): those ads send people into the
 * Shopee/Lazada app, so landing_page_view is near-zero by design and judging
 * them on cost/LPV is meaningless. Meta reports their conversions under the
 * catalog_segment_* fields instead, which only return numbers for the CPAS
 * account (null everywhere else) — verified 2026-08-14.
 */
/**
 * Objective class decides which cost-per is the audience's real KPI.
 *
 * Read from Meta's own `adsset_optimization_goal` — what the ad set was
 * actually told to buy — never from campaign names, which are free text and
 * lie. `campaign_objective` is NOT a safe substitute either: the WhatsApp sets
 * report campaign_objective OUTCOME_TRAFFIC while their optimization goal is
 * CONVERSATIONS, so the campaign field would have them judged on landing page
 * views they were never buying. Optimization goal first, campaign objective
 * only as a fallback when it is missing.
 */
const GOAL_CLASS = {
  LANDING_PAGE_VIEWS: "traffic",
  LINK_CLICKS: "clicks",
  LEAD_GENERATION: "lead",
  QUALITY_LEAD: "lead",
  CONVERSATIONS: "message",
  OFFSITE_CONVERSIONS: "ecommerce",
  POST_ENGAGEMENT: "engagement",
  PAGE_LIKES: "engagement",
  THRUPLAY: "engagement",
  REACH: "awareness",
  IMPRESSIONS: "awareness",
  AD_RECALL_LIFT: "awareness",
};
const CAMPAIGN_OBJECTIVE_CLASS = {
  OUTCOME_TRAFFIC: "traffic",
  OUTCOME_LEADS: "lead",
  OUTCOME_SALES: "ecommerce",
  OUTCOME_ENGAGEMENT: "engagement",
  OUTCOME_AWARENESS: "awareness",
};
function classifyObjective(row) {
  const goal = String(row && row.adsset_optimization_goal || "").toUpperCase();
  if (GOAL_CLASS[goal]) return GOAL_CLASS[goal];
  const obj = String(row && row.campaign_objective || "").toUpperCase();
  if (CAMPAIGN_OBJECTIVE_CLASS[obj]) return CAMPAIGN_OBJECTIVE_CLASS[obj];
  return "traffic";
}

// An audience needs enough delivery before its cost-per means anything. Without
// this a set that spent ฿0 and recorded one stray lead ranks as the cheapest
// audience in the account, which is a false winner, not an insight.
const MIN_RANK_IMPRESSIONS = 1000;
/**
 * Meta campaign names carry the YYMMDD-NN code as a prefix (e.g.
 * "260701-13_BGH_Better Club…"), which is the same code GA4 sees in
 * utm_campaign. Names without one (agency-run flights like
 * "aiq_bhq_ig_message_saudi") simply get no GA4 match.
 */
function codeFromCampaignName(name) {
  const m = String(name || "").match(/(\d{6}-\d{2})/);
  return m ? m[1] : null;
}

async function buildAudiences(from, to) {
  const BASE_FIELDS = ["adset_id", "adset_name", "campaign", "account_name", "spend",
    "impressions", "reach", "actions_link_click", "actions_landing_page_view",
    "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d", "actions_post_engagement",
    // Meta's own percentile diagnostics against competing advertisers.
    "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking",
    // What the ad set was told to buy — this decides its KPI. Do not remove:
    // without these every row silently falls back to "traffic"/per LPV.
    "adsset_optimization_goal", "campaign_objective"];
  const CATALOG_FIELDS = ["catalog_segment_actions_omni_purchase",
    "catalog_segment_value_purchase", "catalog_segment_actions_omni_add_to_cart"];

  /**
   * Null is not zero: if Meta is down this run, say so with a 200 + unavailable
   * flag instead of a 500, matching every other view.
   *
   * Meta's insights API also rejects requests it considers too heavy at account
   * scale — asking for adset_targeting across these six accounts returns
   * "Please reduce the amount of data you're asking for". The catalog_segment
   * fields are the next-heaviest part and only matter for the one CPAS account,
   * so if the full pull fails, retry without them rather than losing the whole
   * tab: CPAS purchase metrics degrade, everything else lives.
   */
  let rows = null, catalogAvailable = true;
  try {
    rows = await windsor("facebook", [...BASE_FIELDS, ...CATALOG_FIELDS], from, to);
  } catch (e) {
    logJson("WARNING", "audiences_full_pull_failed_retrying_without_catalog", { error: String(e.message || e) });
    catalogAvailable = false;
    try {
      rows = await windsor("facebook", BASE_FIELDS, from, to);
    } catch (e2) {
      logJson("WARNING", "audiences_meta_unavailable", { error: String(e2.message || e2) });
      rows = null;
    }
  }
  if (rows === null) return { audiences: null, unavailable: true };

  /**
   * GA4 key events per utm_campaign. GA4 has no concept of an ad set, so a
   * campaign's key events can only be APPORTIONED across the audiences that ran
   * in it — by each audience's share of landing page views (the closest thing
   * to "visits this audience sent"), falling back to spend share where LPV is
   * not a meaningful measure, i.e. CPAS. The estimate is labelled as such in
   * the UI and never enters the ranking. 9 metrics, inside GA4's limit of 10.
   */
  let ga4ByCode = null;
  try {
    const ga4 = await ga4Compat(["session_manual_campaign_name"], ["sessions", "engaged_sessions"], from, to);
    const keCode = await ga4KeyEvents(["session_manual_campaign_name"], from, to);
    if (ga4) {
      ga4ByCode = new Map();
      for (const r of ga4) {
        const code = codeFromCampaignName(r.session_manual_campaign_name);
        if (!code) continue;
        if (!ga4ByCode.has(code)) ga4ByCode.set(code, { visits: 0, keyEvents: 0 });
        const e = ga4ByCode.get(code);
        e.visits += n(r.sessions);
        e.keyEvents += keCode.byKey.get(ga4JoinKey(["session_manual_campaign_name"], r, false)) || 0;
      }
    }
  } catch (e) {
    logJson("WARNING", "audiences_ga4_unavailable", { error: String(e.message || e) });
  }

  /**
   * Which ad accounts are Collaborative Ads (CPAS) accounts.
   *
   * Detected at ACCOUNT level from rows that actually report a positive catalog
   * metric, because CPAS is an account-level arrangement with the marketplace
   * partner. An earlier per-row check (`field !== null`) classified EVERY row
   * as CPAS the moment the catalog fields went missing from the pull, since
   * `undefined !== null` is true — so the whole account was judged on cost per
   * purchase and every cost/result went blank. Requiring a positive number
   * means a missing or null field can only ever fail towards the safe default.
   */
  const num_ = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const cpasAccounts = new Set();
  for (const r of rows) {
    if (!r.account_name) continue;
    if (num_(r.catalog_segment_actions_omni_purchase) > 0
      || num_(r.catalog_segment_value_purchase) > 0
      || num_(r.catalog_segment_actions_omni_add_to_cart) > 0) {
      cpasAccounts.add(String(r.account_name));
    }
  }

  // Campaign-wide LPV and spend, used as the denominator when splitting a
  // campaign's GA4 key events across the audiences that ran inside it.
  const campTotals = new Map();
  for (const r of rows) {
    const cname = String(r.campaign || "(unnamed)");
    if (!campTotals.has(cname)) campTotals.set(cname, { lpv: 0, spend: 0 });
    const ct = campTotals.get(cname);
    ct.lpv += n(r.actions_landing_page_view);
    ct.spend += n(r.spend);
  }

  const map = new Map();
  for (const r of rows) {
    const name = normAudienceName(r.adset_name);
    if (!name) continue;
    if (!map.has(name)) map.set(name, {
      name, spend: 0, impressions: 0, reach: 0, clicks: 0, lpv: 0, leads: 0, messages: 0,
      purchases: 0, revenue: 0, atc: 0, engagements: 0, accounts: new Set(),
      rankSpend: { quality: new Map(), engagement: new Map(), conversion: new Map() },
      campaigns: new Map(), goals: new Map(),
      spendByClass: { lead: 0, message: 0, traffic: 0, ecommerce: 0, engagement: 0, awareness: 0, clicks: 0 },
    });
    const a = map.get(name);
    const spend = n(r.spend);
    const purchases = n(r.catalog_segment_actions_omni_purchase);
    const revenue = n(r.catalog_segment_value_purchase);
    const atc = n(r.catalog_segment_actions_omni_add_to_cart);
    const isCpasAccount = r.account_name ? cpasAccounts.has(String(r.account_name)) : false;
    a.spend += spend;
    a.impressions += n(r.impressions);
    a.reach += n(r.reach);
    a.clicks += n(r.actions_link_click);
    a.lpv += n(r.actions_landing_page_view);
    a.leads += n(r.actions_lead);
    a.messages += n(r.actions_onsite_conversion_messaging_conversation_started_7d);
    a.purchases += purchases; a.revenue += revenue; a.atc += atc;
    a.engagements += n(r.actions_post_engagement);
    // Rankings are categorical per ad set, so weight each value by the spend
    // behind it and report the heaviest — one cheap ad set shouldn't set the
    // rating for an audience that ran ฿50k elsewhere. UNKNOWN means Meta had
    // too little delivery to rate it, so it is never counted as a rating.
    for (const [key, field] of [["quality", "quality_ranking"],
      ["engagement", "engagement_rate_ranking"], ["conversion", "conversion_rate_ranking"]]) {
      const v = String(r[field] || "UNKNOWN");
      if (v === "UNKNOWN" || v === "null") continue;
      a.rankSpend[key].set(v, (a.rankSpend[key].get(v) || 0) + spend);
    }
    if (r.account_name) a.accounts.add(String(r.account_name));
    a.spendByClass[classifyObjective(r)] += spend;
    // Only goals with real delivery count. An ad set that exists but spent ฿0
    // in the range would otherwise add a second key here and flag the whole
    // audience "mixed" on the strength of a campaign that never ran.
    if (r.adsset_optimization_goal && (spend > 0 || n(r.impressions) > 0)) {
      a.goals.set(String(r.adsset_optimization_goal),
        (a.goals.get(String(r.adsset_optimization_goal)) || 0) + spend);
    }
    const cname = String(r.campaign || "(unnamed)");
    if (!a.campaigns.has(cname)) a.campaigns.set(cname, {
      campaign: cname, account: r.account_name || null, code: codeFromCampaignName(cname),
      goals: new Map(),
      spend: 0, impressions: 0, clicks: 0, lpv: 0, leads: 0, messages: 0, purchases: 0, revenue: 0, engagements: 0,
    });
    const c = a.campaigns.get(cname);
    if (!c.account && r.account_name) c.account = String(r.account_name);
    if (r.adsset_optimization_goal && (spend > 0 || n(r.impressions) > 0)) {
      c.goals.set(String(r.adsset_optimization_goal),
        (c.goals.get(String(r.adsset_optimization_goal)) || 0) + spend);
    }
    c.spend += spend; c.impressions += n(r.impressions); c.clicks += n(r.actions_link_click);
    c.lpv += n(r.actions_landing_page_view); c.leads += n(r.actions_lead);
    c.messages += n(r.actions_onsite_conversion_messaging_conversation_started_7d);
    c.purchases += purchases; c.revenue += revenue; c.engagements += n(r.actions_post_engagement);
  }

  const per = (cost, count) => (count > 0 ? cost / count : null);
  const topRank = (m) => (m.size ? [...m.entries()].sort((x, y) => y[1] - x[1])[0][0] : null);
  const rate = (num_, den) => (den > 0 ? num_ / den : null);
  const audiences = [...map.values()].map((a) => {
    const cls = Object.entries(a.spendByClass).sort((x, y) => y[1] - x[1])[0][0];
    const cpm = a.impressions > 0 ? (a.spend / a.impressions) * 1000 : null;
    const primary =
      cls === "lead"       ? { kpi: "lead",     label: "per lead",     count: a.leads,       cost: per(a.spend, a.leads) } :
      cls === "message"    ? { kpi: "message",  label: "per msg",      count: a.messages,    cost: per(a.spend, a.messages) } :
      cls === "ecommerce"  ? { kpi: "purchase", label: "per purchase", count: a.purchases,   cost: per(a.spend, a.purchases) } :
      cls === "clicks"     ? { kpi: "click",    label: "per click",    count: a.clicks,      cost: per(a.spend, a.clicks) } :
      cls === "engagement" ? { kpi: "engage",   label: "per engmt",    count: a.engagements, cost: per(a.spend, a.engagements) } :
      // A reach buy is not trying to produce visits at all, so it is priced on
      // CPM. Scoring it per LPV says nothing about whether it did its job.
      cls === "awareness"  ? { kpi: "cpm",      label: "CPM (reach buy)", count: a.impressions, cost: cpm } :
                             { kpi: "lpv",      label: "per LPV",      count: a.lpv,         cost: per(a.spend, a.lpv) };
    return {
      name: a.name,
      uses: [...a.campaigns.values()].filter((c) => c.spend > 0 || c.impressions > 0).length,
      accounts: [...a.accounts].sort(),
      spend: a.spend, impressions: a.impressions, reach: a.reach, clicks: a.clicks,
      lpv: a.lpv, leads: a.leads, messages: a.messages,
      purchases: a.purchases, revenue: a.revenue, atc: a.atc,
      isCpas: cls === "ecommerce",
      rankings: {
        quality: topRank(a.rankSpend.quality),
        engagement: topRank(a.rankSpend.engagement),
        conversion: topRank(a.rankSpend.conversion),
      },
      cpm,
      objective: topRank(a.goals),
      objectiveClass: cls,
      /**
       * An audience can be reused across ad sets bought on different goals —
       * Cancer_20-60 split its July spend 50/50 between lead generation and
       * traffic. The headline row uses the goal carrying the MOST SPEND, not
       * the most recent campaign: recency lets a small late test relabel an
       * audience that spent heavily on something else, whereas spend share
       * reflects what the budget was actually buying. Where the split is close
       * no single label is honest, so the mix is exposed and the row is
       * flagged; the per-campaign goals sit in the expansion.
       */
      objectiveMix: (() => {
        if (a.goals.size <= 1) return null;
        const total = [...a.goals.values()].reduce((x, y) => x + y, 0) || 1;
        return [...a.goals.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([goal, spend]) => ({ goal, spend, share: spend / total }));
      })(),
      cpc: per(a.spend, a.clicks),
      // Link CTR, not all-clicks CTR: the `clicks` field counts every click on
      // the ad including reactions and profile taps, which inflates it badly
      // (see CONTEXT.md) — actions_link_click is the outbound click.
      ctr: rate(a.clicks, a.impressions),
      // Of the people who clicked the link, how many actually arrived. Low
      // values mean accidental clicks, a slow page, or a broken destination.
      lpvRate: rate(a.lpv, a.clicks),
      // Approximate: reach is summed across ad sets, so a person hit by the
      // same audience in two campaigns counts twice. Directional, not exact.
      frequency: rate(a.impressions, a.reach),
      costPerLpv: per(a.spend, a.lpv),
      costPerLead: per(a.spend, a.leads),
      costPerMessage: per(a.spend, a.messages),
      costPerPurchase: per(a.spend, a.purchases),
      roas: a.spend > 0 && a.revenue > 0 ? a.revenue / a.spend : null,
      lowVolume: a.impressions < MIN_RANK_IMPRESSIONS,
      primary,
    campaigns: [...a.campaigns.values()]
      // Rows with no spend and no impressions are ad sets that existed in the
      // range but never delivered. They render as a line of dashes and inflate
      // the Uses count, so they are dropped rather than shown as empty.
      .filter((c) => c.spend > 0 || c.impressions > 0)
      .map((c) => {
        // Each campaign is priced on ITS OWN goal, not the audience's dominant
        // one — that is the whole point of showing the split for a mixed set.
        const goal = topRank(c.goals);
        const k = GOAL_CLASS[String(goal || "").toUpperCase()] || "traffic";
        const cp =
          k === "lead"       ? { label: "per lead",  cost: per(c.spend, c.leads) } :
          k === "message"    ? { label: "per msg",   cost: per(c.spend, c.messages) } :
          k === "ecommerce"  ? { label: "per purch", cost: per(c.spend, c.purchases) } :
          k === "clicks"     ? { label: "per click", cost: per(c.spend, c.clicks) } :
          k === "engagement" ? { label: "per engmt", cost: per(c.spend, c.engagements) } :
          k === "awareness"  ? { label: "CPM",       cost: c.impressions > 0 ? (c.spend / c.impressions) * 1000 : null } :
                               { label: "per LPV",   cost: per(c.spend, c.lpv) };
        return { ...c, goal, goals: undefined, costPerResult: cp.cost, resultLabel: cp.label };
      })
      .sort((x, y) => y.spend - x.spend),
    };
  });
  // Default order: cheapest primary result first. Two tiers sink below the
  // ranked list — sets too small to judge, then sets that spent money without
  // ever producing their primary action.
  const tier = (a) => (a.lowVolume ? 2 : a.primary.cost === null ? 1 : 0);
  audiences.sort((x, y) => {
    const tx = tier(x), ty = tier(y);
    if (tx !== ty) return tx - ty;
    if (tx === 0) return x.primary.cost - y.primary.cost;
    return y.spend - x.spend;
  });
  const totals = audiences.reduce((t, a) => ({
    sets: t.sets + 1, spend: t.spend + a.spend, impressions: t.impressions + a.impressions,
    clicks: t.clicks + a.clicks, lpv: t.lpv + a.lpv, leads: t.leads + a.leads,
    messages: t.messages + a.messages, purchases: t.purchases + a.purchases, revenue: t.revenue + a.revenue,
  }), { sets: 0, spend: 0, impressions: 0, clicks: 0, lpv: 0, leads: 0, messages: 0, purchases: 0, revenue: 0 });
  totals.ctr = rate(totals.clicks, totals.impressions);
  return { audiences, totals, catalogAvailable };
}

app.get("/api/audiences", requireTab("audiences"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (!WINDSOR_API_KEY) return res.status(500).json({ error: "Server missing WINDSOR_API_KEY" });
  try {
    const out = await withCache(`audiences:${from}:${to}`, req.query.refresh === "1", () => buildAudiences(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "audiences_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Audiences failed" });
  }
});

// ------------------------------------------------------------ /api/ecommerce

/**
 * Reads the normalised Orders tab from Google Sheets using the Cloud Run
 * service account. The sheet must be shared with that account as a Viewer and
 * the Sheets API enabled on the project.
 */
let ecomRowCache = { at: 0, rows: null };
const ECOM_ROWS_TTL_MS = 5 * 60 * 1000;

async function ecomRows(force) {
  const fresh = !force && ecomRowCache.rows && (Date.now() - ecomRowCache.at) < ECOM_ROWS_TTL_MS;
  if (fresh) return ecomRowCache.rows;
  const rows = await fetchEcomRows();
  ecomRowCache = { at: Date.now(), rows };
  return rows;
}

async function fetchEcomRows() {
  if (!ECOM_SHEET_ID) throw new Error("ECOM_SHEET_ID is not set");
  const token = await gcpAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(ECOM_SHEET_ID)}`
    + `/values/${encodeURIComponent(ECOM_TAB)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    throw new Error(`sheets HTTP ${r.status} ${body}`);
  }
  const j = await r.json();
  const values = j.values || [];
  if (values.length < 2) return [];
  // Columns are resolved by header name, never by position: the normaliser has
  // changed its column count before, and a positional read would silently
  // return the wrong field rather than fail.
  const head = values[0].map((h) => String(h || "").trim());
  const at = (name) => head.indexOf(name);
  const need = ["purchase_date", "channel", "price", "order_id"];
  const missing = need.filter((c) => at(c) === -1);
  if (missing.length) throw new Error(`Orders tab missing column(s): ${missing.join(", ")}`);
  const idx = {};
  ["purchase_date","channel","price","order_id","package_name","sku","center","payment_method",
   "txn_fee_alloc","comm_fee_alloc","net_revenue","coupon_status","is_valid_sale",
   "email_key","discount_pct","full_price"].forEach((c) => { idx[c] = at(c); });
  return values.slice(1).map((row) => {
    const g = (c) => (idx[c] === -1 ? "" : (row[idx[c]] === undefined ? "" : row[idx[c]]));
    return {
      date: String(g("purchase_date") || "").slice(0, 10),
      channel: String(g("channel") || "").trim() || "(unknown)",
      orderId: String(g("order_id") || ""),
      pkg: String(g("package_name") || ""),
      sku: String(g("sku") || ""),
      center: String(g("center") || ""),
      // Written by the normaliser from the master via the SKU, so it fills in as
      // SKUs are confirmed: 1% of 2024 rows, 9% of 2026. Shown when present,
      // never substituted for the Thai name, which is always there.
      english: String(g("english_name") || ""),
      method: String(g("payment_method") || ""),
      price: n(g("price")),
      txn: n(g("txn_fee_alloc")),
      comm: n(g("comm_fee_alloc")),
      couponStatus: String(g("coupon_status") || ""),
      valid: String(g("is_valid_sale") || "").toUpperCase() !== "FALSE",
      customer: String(g("email_key") || ""),
      fullPrice: n(g("full_price")),
      type: channelType(g("channel")),
    };
  }).filter((r) => r.date);
}

/**
 * The two comparison windows every e-commerce view offers.
 *
 * "Previous" is the equally long span immediately before the selected range, so
 * a 31-day selection compares against the 31 days before it — that is the
 * period-on-period read, and it is labelled MoM because a month is the usual
 * selection, not because it is always a calendar month.
 * "Year ago" is the same calendar dates one year earlier, which is the honest
 * comparison for a seasonal business.
 */
function comparisonWindows(from, to) {
  const d0 = new Date(`${from}T00:00:00Z`), d1 = new Date(`${to}T00:00:00Z`);
  const days = Math.round((d1 - d0) / 86400000) + 1;
  const prevTo = new Date(d0); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
  const yoyFrom = new Date(d0); yoyFrom.setUTCFullYear(yoyFrom.getUTCFullYear() - 1);
  const yoyTo = new Date(d1); yoyTo.setUTCFullYear(yoyTo.getUTCFullYear() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    days,
    prev: { from: iso(prevFrom), to: iso(prevTo) },
    yoy: { from: iso(yoyFrom), to: iso(yoyTo) },
  };
}

/** Revenue keyed by an arbitrary grouping, over a date window. */
function revenueBy(rows, win, keyFn) {
  const m = new Map();
  let total = 0;
  for (const r of rows) {
    if (r.date < win.from || r.date > win.to) continue;
    total += r.price;
    const k = keyFn(r);
    m.set(k, (m.get(k) || 0) + r.price);
  }
  return { total, byKey: m };
}

const pctChange = (now, then) => (then > 0 ? (now - then) / then : null);

async function buildEcommerce(from, to, scope) {
  const all = await ecomRows();
  const inRange = all.filter((r) => r.date >= from && r.date <= to);
  // Online is the default because B2B and Special Campaign orders are few and
  // enormous; including them silently would make every channel average wrong.
  const rows = scope === "all" ? inRange : inRange.filter((r) => r.type === "Online");
  if (!rows.length) {
    return { empty: true, scope: scope || "online", rangeHas: all.length, first: all.length ? all.map(r=>r.date).sort()[0] : null,
             last: all.length ? all.map(r=>r.date).sort().slice(-1)[0] : null };
  }
  const orders = new Set(), customers = new Map();
  let revenue = 0, fees = 0, redeemed = 0, mapped = 0;
  const byChannel = new Map(), byDay = new Map(), byPkg = new Map(), byCenter = new Map();

  for (const r of rows) {
    revenue += r.price; fees += r.txn + r.comm;
    orders.add(r.orderId);
    if (r.couponStatus === "ใช้งานแล้ว") redeemed++;
    if (r.sku) mapped++;
    if (r.customer) {
      if (!customers.has(r.customer)) customers.set(r.customer, { orders: new Set(), channels: new Set(), rev: 0 });
      const c = customers.get(r.customer);
      c.orders.add(r.orderId); c.channels.add(r.channel); c.rev += r.price;
    }
    const ch = byChannel.get(r.channel) || { channel: r.channel, revenue: 0, fees: 0, coupons: 0, redeemed: 0, orders: new Set() };
    ch.revenue += r.price; ch.fees += r.txn + r.comm; ch.coupons++; ch.orders.add(r.orderId);
    if (r.couponStatus === "ใช้งานแล้ว") ch.redeemed++;
    byChannel.set(r.channel, ch);

    const d = byDay.get(r.date) || { date: r.date, total: 0, byChannel: {} };
    d.total += r.price; d.byChannel[r.channel] = (d.byChannel[r.channel] || 0) + r.price;
    byDay.set(r.date, d);

    const p = byPkg.get(r.pkg) || { name: r.pkg, revenue: 0, units: 0, center: r.center };
    p.revenue += r.price; p.units++; if (!p.center && r.center) p.center = r.center;
    byPkg.set(r.pkg, p);

    // Centre is only meaningful for rows whose SKU has been confirmed; the rest
    // are grouped as unmapped so the gap is visible instead of silently absent.
    const key = r.center || "(unmapped)";
    const cc = byCenter.get(key) || { center: key, revenue: 0, coupons: 0 };
    cc.revenue += r.price; cc.coupons++;
    byCenter.set(key, cc);
  }

  const channels = [...byChannel.values()]
    .map((c) => ({ channel: c.channel, revenue: c.revenue, fees: c.fees, coupons: c.coupons,
      orders: c.orders.size, aov: c.orders.size ? c.revenue / c.orders.size : 0,
      takeRate: c.revenue ? c.fees / c.revenue : null,
      redemption: c.coupons ? c.redeemed / c.coupons : null }))
    .sort((a, b) => b.revenue - a.revenue);

  const custList = [...customers.values()];
  const topCustomer = custList.sort((a, b) => b.rev - a.rev)[0] || null;

  // Every channel type present in range, so the view can say what is excluded.
  const types = new Map();
  for (const r of inRange) {
    const t = types.get(r.type) || { type: r.type, revenue: 0, coupons: 0 };
    t.revenue += r.price; t.coupons++; types.set(r.type, t);
  }

  const cw = comparisonWindows(from, to);
  const inScope = (r) => scope === "all" || r.type === "Online";
  const scoped = all.filter(inScope);
  const prevRev = revenueBy(scoped, cw.prev, (r) => r.channel);
  const yoyRev = revenueBy(scoped, cw.yoy, (r) => r.channel);
  const prevCentre = revenueBy(scoped, cw.prev, (r) => r.center || "(unmapped)");
  const yoyCentre = revenueBy(scoped, cw.yoy, (r) => r.center || "(unmapped)");
  for (const c of channels) {
    c.prevRevenue = prevRev.byKey.get(c.channel) || 0;
    c.yoyRevenue = yoyRev.byKey.get(c.channel) || 0;
    c.mom = pctChange(c.revenue, c.prevRevenue);
    c.yoy = pctChange(c.revenue, c.yoyRevenue);
  }
  const centreList = [...byCenter.values()].sort((a, b) => b.revenue - a.revenue);
  for (const c of centreList) {
    c.prevRevenue = prevCentre.byKey.get(c.center) || 0;
    c.yoyRevenue = yoyCentre.byKey.get(c.center) || 0;
    c.mom = pctChange(c.revenue, c.prevRevenue);
    c.yoy = pctChange(c.revenue, c.yoyRevenue);
  }

  return {
    scope: scope === "all" ? "all" : "online",
    types: [...types.values()].sort((a, b) => b.revenue - a.revenue),
    compare: {
      windows: cw,
      prev: { revenue: prevRev.total, change: pctChange(revenue, prevRev.total) },
      yoy: { revenue: yoyRev.total, change: pctChange(revenue, yoyRev.total) },
    },
    totals: {
      revenue, fees, net: revenue - fees, orders: orders.size, coupons: rows.length,
      aov: orders.size ? revenue / orders.size : 0,
      couponsPerOrder: orders.size ? rows.length / orders.size : 0,
      takeRate: revenue ? fees / revenue : null,
      redemption: rows.length ? redeemed / rows.length : null,
      packages: byPkg.size,
      mappedShare: rows.length ? mapped / rows.length : 0,
    },
    channels,
    channelOrder: channels.map((c) => c.channel),
    daily: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    packages: [...byPkg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 12),
    centers: centreList,
    customers: {
      count: customers.size,
      repeat: custList.filter((c) => c.orders.size > 1).length,
      multiChannel: custList.filter((c) => c.channels.size > 1).length,
      revenuePer: customers.size ? revenue / customers.size : 0,
      topShare: topCustomer && revenue ? topCustomer.rev / revenue : 0,
      topOrders: topCustomer ? topCustomer.orders.size : 0,
    },
  };
}

app.get("/api/ecommerce", requireTab("ecom"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const scope = req.query.scope === "all" ? "all" : "online";
    const out = await withCache(`ecom:${scope}:${from}:${to}`, req.query.refresh === "1",
      () => buildEcommerce(from, to, scope));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecommerce_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "E-commerce failed" });
  }
});

/**
 * Centres, seen the way a centre owner would ask about their own business:
 * how much did we sell, through which channel, at what discount, and how much
 * of it has actually been redeemed. Presented as one table across all centres
 * rather than a per-centre drilldown, so the whole picture is comparable.
 *
 * Unredeemed coupons matter more here than anywhere else in the dashboard:
 * a sold coupon is revenue booked, but only a redeemed one is a patient who
 * walked in and might convert into further care.
 */
async function buildCentres(from, to, scope) {
  const all = await ecomRows();
  const inRange = all.filter((r) => r.date >= from && r.date <= to);
  const rows = scope === "all" ? inRange : inRange.filter((r) => r.type === "Online");
  if (!rows.length) return { empty: true, scope: scope || "online", rangeHas: all.length };

  const centres = new Map();
  const channelSet = new Set();
  let revenue = 0;

  for (const r of rows) {
    revenue += r.price;
    channelSet.add(r.channel);
    const key = r.center || "Unmapped";
    const c = centres.get(key) || {
      centre: key, revenue: 0, coupons: 0, redeemed: 0, orders: new Set(),
      listPrice: 0, discounted: 0, byChannel: {}, unitsByChannel: {}, packages: new Map(),
    };
    c.revenue += r.price;
    c.coupons++;
    c.orders.add(r.orderId);
    if (r.couponStatus === "ใช้งานแล้ว") c.redeemed++;
    // Discount depth only counts rows where the master knows a list price.
    if (r.fullPrice > 0) { c.listPrice += r.fullPrice; c.discounted += r.price; }
    c.byChannel[r.channel] = (c.byChannel[r.channel] || 0) + r.price;
    // Coupons alongside revenue, so the cross-tab can be read by VALUE or by
    // VOLUME (MW). They tell different stories: a centre can be a small share
    // of baht and a large share of transactions, and picking one silently
    // decides which of those the reader is allowed to notice.
    c.unitsByChannel[r.channel] = (c.unitsByChannel[r.channel] || 0) + 1;
    const p = c.packages.get(r.pkg) || { name: r.pkg, revenue: 0, units: 0 };
    p.revenue += r.price; p.units++;
    c.packages.set(r.pkg, p);
    centres.set(key, c);
  }

  /**
   * CHANNEL COLUMNS ARE ORDERED BY SIZE, NOT ALPHABETICALLY (MW).
   *
   * Alphabetical put Bangkok Hospital Website first and Shopee — 54% of the
   * biggest centre — last, off the right edge of the viewport. The reader had
   * to scroll past the small channels to reach the one that matters.
   *
   * Ordered by REVENUE even when the table is showing volume, deliberately: the
   * columns must not reshuffle when the toggle is flipped, or comparing the two
   * views means re-finding every column.
   */
  const chanRevenue = new Map();
  for (const c of centres.values()) {
    for (const [ch, v] of Object.entries(c.byChannel)) {
      chanRevenue.set(ch, (chanRevenue.get(ch) || 0) + v);
    }
  }
  const channels = [...channelSet]
    .sort((a, b) => (chanRevenue.get(b) || 0) - (chanRevenue.get(a) || 0) || a.localeCompare(b));
  const list = [...centres.values()].map((c) => {
    const top = Object.entries(c.byChannel).sort((a, b) => b[1] - a[1])[0];
    const best = [...c.packages.values()].sort((a, b) => b.revenue - a.revenue)[0];
    return {
      centre: c.centre,
      revenue: c.revenue,
      share: revenue ? c.revenue / revenue : 0,
      coupons: c.coupons,
      orders: c.orders.size,
      avgPrice: c.coupons ? c.revenue / c.coupons : 0,
      redemption: c.coupons ? c.redeemed / c.coupons : null,
      // Revenue sitting on coupons nobody has used yet.
      unredeemedValue: c.revenue * (1 - (c.coupons ? c.redeemed / c.coupons : 0)),
      discountDepth: c.listPrice > 0 ? 1 - c.discounted / c.listPrice : null,
      topChannel: top ? top[0] : "",
      topChannelShare: top && c.revenue ? top[1] / c.revenue : 0,
      concentration: top && c.revenue ? top[1] / c.revenue : 0,
      topPackage: best ? best.name : "",
      topPackageUnits: best ? best.units : 0,
      byChannel: c.byChannel,
      unitsByChannel: c.unitsByChannel,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const cwC = comparisonWindows(from, to);
  const inScopeC = (r) => scope === "all" || r.type === "Online";
  const scopedC = all.filter(inScopeC);
  const pC = revenueBy(scopedC, cwC.prev, (r) => r.center || "Unmapped");
  const yC = revenueBy(scopedC, cwC.yoy, (r) => r.center || "Unmapped");
  for (const c of list) {
    c.prevRevenue = pC.byKey.get(c.centre) || 0;
    c.yoyRevenue = yC.byKey.get(c.centre) || 0;
    c.mom = pctChange(c.revenue, c.prevRevenue);
    c.yoy = pctChange(c.revenue, c.yoyRevenue);
  }

  return {
    scope: scope === "all" ? "all" : "online",
    compare: { windows: cwC,
      prev: { revenue: pC.total, change: pctChange(revenue, pC.total) },
      yoy: { revenue: yC.total, change: pctChange(revenue, yC.total) } },
    channels,
    centres: list,
    totals: {
      revenue,
      centres: list.length,
      coupons: rows.length,
      // Kept in the payload but no longer shown: coupon status is not updated
      // in real time and the team cannot act on it yet, so leading with it
      // would imply a decision nobody can make.
      unredeemedValue: list.reduce((a, c) => a + c.unredeemedValue, 0),
      unmappedShare: revenue
        ? (centres.get("Unmapped") ? centres.get("Unmapped").revenue / revenue : 0) : 0,
    },
  };
}

/**
 * PACKAGES — one row per product, for the whole history.
 *
 * KEYED ON PACKAGE NAME, NEVER ON SKU. The master re-codes a package every promo
 * cycle (0101-2604, 0101-2608) with no effective dates, so grouping by SKU would
 * split one product into a row per cycle. It also would not work: SKU is filled
 * on 3% of 2024 rows, 7% of 2025 and 12% of 2026, while `package_name` is 100%
 * across all three. The name IS the product here. MW: "if name is the name then
 * use them as one — never mind the promo codes."
 *
 * SKU is still read, but only for the English name and to SAY how many distinct
 * codes a package has been sold under — a package with four is a naming problem
 * worth seeing, not a reason to split the row.
 */
async function buildPackages(from, to, scope) {
  const all = await ecomRows();
  const inRange = all.filter((r) => r.date >= from && r.date <= to);
  const rows = scope === "all" ? inRange : inRange.filter((r) => r.type === "Online");
  if (!rows.length) return { empty: true, scope: scope || "online", rangeHas: all.length };

  const pkgs = new Map();
  let revenue = 0;

  for (const r of rows) {
    revenue += r.price;
    const key = r.pkg || "(no name)";
    const p = pkgs.get(key) || {
      name: key, revenue: 0, units: 0, orders: new Set(), redeemed: 0,
      listPrice: 0, discounted: 0, centres: new Set(), channels: {},
      skus: new Set(), english: "",
    };
    p.revenue += r.price;
    p.units++;
    p.orders.add(r.orderId);
    if (r.couponStatus === "ใช้งานแล้ว") p.redeemed++;
    // Discount depth only counts rows where the master knows a list price;
    // averaging over rows without one would understate every discount.
    if (r.fullPrice > 0) { p.listPrice += r.fullPrice; p.discounted += r.price; }
    if (r.center) p.centres.add(r.center);
    if (r.sku) p.skus.add(r.sku);
    if (!p.english && r.english) p.english = r.english;
    p.channels[r.channel] = (p.channels[r.channel] || 0) + r.price;
    pkgs.set(key, p);
  }

  const cw = comparisonWindows(from, to);
  const inScope = (r) => scope === "all" || r.type === "Online";
  const scoped = all.filter(inScope);
  const prev = revenueBy(scoped, cw.prev, (r) => r.pkg || "(no name)");
  const yoy = revenueBy(scoped, cw.yoy, (r) => r.pkg || "(no name)");

  const list = [...pkgs.values()].map((p) => {
    const top = Object.entries(p.channels).sort((a, b) => b[1] - a[1])[0];
    const prevRevenue = prev.byKey.get(p.name) || 0;
    const yoyRevenue = yoy.byKey.get(p.name) || 0;
    return {
      name: p.name,
      english: p.english || "",
      revenue: p.revenue,
      share: revenue ? p.revenue / revenue : 0,
      units: p.units,
      orders: p.orders.size,
      avgPrice: p.units ? p.revenue / p.units : 0,
      /**
       * Redemption and discount are NULL rather than 0 when nothing supports
       * them. A package with no list price in the master has an unknown
       * discount, which is a different statement from a 0% discount.
       */
      redemption: p.units ? p.redeemed / p.units : null,
      discountDepth: p.listPrice > 0 ? 1 - p.discounted / p.listPrice : null,
      centre: p.centres.size === 1 ? [...p.centres][0] : (p.centres.size ? "(several)" : ""),
      centreCount: p.centres.size,
      topChannel: top ? top[0] : "",
      topChannelShare: top && p.revenue ? top[1] / p.revenue : 0,
      // How many promo codes this one product has been sold under.
      skuCount: p.skus.size,
      prevRevenue, yoyRevenue,
      mom: pctChange(p.revenue, prevRevenue),
      yoy: pctChange(p.revenue, yoyRevenue),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  /**
   * Concentration, because "we sell 978 packages" and "eight of them are 80% of
   * the money" are the same fact told two ways, and only the second is useful
   * when deciding what to promote.
   */
  let cum = 0, top80 = 0;
  for (const p of list) { cum += p.revenue; top80++; if (revenue && cum >= revenue * 0.8) break; }

  return {
    scope: scope || "online",
    packages: list.slice(0, 200),
    totals: {
      revenue,
      packages: list.length,
      units: rows.length,
      top80,
      top80Share: list.length ? top80 / list.length : 0,
      // Packages carrying more than one promo code — a naming problem, surfaced.
      multiSku: list.filter((p) => p.skuCount > 1).length,
      noSku: list.filter((p) => p.skuCount === 0).length,
    },
  };
}

app.get("/api/ecommerce/packages", requireTab("ecompackages"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const scope = req.query.scope === "all" ? "all" : "online";
    const out = await withCache(`ecompkg:${scope}:${from}:${to}`, req.query.refresh === "1",
      () => buildPackages(from, to, scope));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecom_packages_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Packages failed" });
  }
});

app.get("/api/ecommerce/centres", requireTab("ecomcentre"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const scope = req.query.scope === "all" ? "all" : "online";
    const out = await withCache(`ecomcentre:${scope}:${from}:${to}`, req.query.refresh === "1",
      () => buildCentres(from, to, scope));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecom_centres_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Centres failed" });
  }
});

/**
 * Channel analysis: how each channel performs over time and what it is
 * distinctively good at.
 *
 * "Good at" is answered with an affinity index rather than a raw share. A
 * channel selling mostly Check-Up packages is not interesting if everyone sells
 * mostly Check-Up. The index compares the channel's mix against the overall
 * mix, so 2.0 means that centre is twice as concentrated here as it is across
 * the business — that is what makes a channel distinctive.
 */
async function buildChannels(from, to, scope) {
  const all = await ecomRows();
  const inRange = all.filter((r) => r.date >= from && r.date <= to);
  const rows = scope === "all" ? inRange : inRange.filter((r) => r.type === "Online");
  if (!rows.length) return { empty: true, scope: scope || "online", rangeHas: all.length };

  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
  const overallCentre = new Map();
  let revenue = 0;
  for (const r of rows) {
    revenue += r.price;
    const k = r.center || "Unmapped";
    overallCentre.set(k, (overallCentre.get(k) || 0) + r.price);
  }

  const ch = new Map();
  for (const r of rows) {
    const c = ch.get(r.channel) || {
      channel: r.channel, type: r.type, revenue: 0, fees: 0, coupons: 0,
      orders: new Set(), customers: new Set(), byMonth: new Map(),
      centres: new Map(), packages: new Map(),
    };
    c.revenue += r.price; c.fees += r.txn + r.comm; c.coupons++;
    c.orders.add(r.orderId);
    if (r.customer) c.customers.add(r.customer);
    const m = r.date.slice(0, 7);
    c.byMonth.set(m, (c.byMonth.get(m) || 0) + r.price);
    const ck = r.center || "Unmapped";
    c.centres.set(ck, (c.centres.get(ck) || 0) + r.price);
    const p = c.packages.get(r.pkg) || { name: r.pkg, revenue: 0, units: 0 };
    p.revenue += r.price; p.units++;
    c.packages.set(r.pkg, p);
    ch.set(r.channel, c);
  }

  const half = Math.floor(months.length / 2);
  const channels = [...ch.values()].map((c) => {
    const series = months.map((m) => c.byMonth.get(m) || 0);
    // Momentum compares the two halves of the selected range rather than the
    // last two months, which would swing wildly on a single promotion.
    const firstHalf = series.slice(0, half).reduce((a, b) => a + b, 0);
    const lastHalf = series.slice(half).reduce((a, b) => a + b, 0);
    const affinity = [...c.centres.entries()].map(([centre, rev]) => {
      const chShare = c.revenue ? rev / c.revenue : 0;
      const allShare = revenue ? (overallCentre.get(centre) || 0) / revenue : 0;
      return { centre, revenue: rev, share: chShare, index: allShare > 0 ? chShare / allShare : null };
    }).filter((a) => a.revenue > 0).sort((a, b) => (b.index || 0) - (a.index || 0));
    return {
      channel: c.channel, type: c.type, revenue: c.revenue, fees: c.fees,
      coupons: c.coupons, orders: c.orders.size, customers: c.customers.size,
      aov: c.orders.size ? c.revenue / c.orders.size : 0,
      avgPrice: c.coupons ? c.revenue / c.coupons : 0,
      takeRate: c.revenue ? c.fees / c.revenue : null,
      couponsPerOrder: c.orders.size ? c.coupons / c.orders.size : 0,
      series,
      momentum: firstHalf > 0 ? (lastHalf - firstHalf) / firstHalf : null,
      firstHalf, lastHalf, delta: lastHalf - firstHalf,
      activeMonths: series.filter((v) => v > 0).length,
      bestAt: affinity.slice(0, 3),
      topPackages: [...c.packages.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 3),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  // Channel names absent from CHANNEL_TYPE fall into "Unclassified", which is a
  // taxonomy gap, not a customer segment. Surfacing the names lets it be fixed
  // rather than quietly averaged into the analysis.
  const unclassified = [...new Map(inRange.filter((r) => r.type === "Unclassified")
    .map((r) => [r.channel, 0])).keys()].map((name) => ({
      name,
      revenue: inRange.filter((r) => r.channel === name).reduce((a, r) => a + r.price, 0),
    })).sort((a, b) => b.revenue - a.revenue);

  const cwH = comparisonWindows(from, to);
  const scopedH = all.filter((r) => scope === "all" || r.type === "Online");
  const pH = revenueBy(scopedH, cwH.prev, (r) => r.channel);
  const yH = revenueBy(scopedH, cwH.yoy, (r) => r.channel);
  for (const c of channels) {
    c.prevRevenue = pH.byKey.get(c.channel) || 0;
    c.yoyRevenue = yH.byKey.get(c.channel) || 0;
    c.mom = pctChange(c.revenue, c.prevRevenue);
    c.yoy = pctChange(c.revenue, c.yoyRevenue);
  }

  const mid = months[half] || null;
  return {
    scope: scope === "all" ? "all" : "online",
    unclassified,
    compare: { windows: cwH,
      prev: { revenue: pH.total, change: pctChange(revenue, pH.total) },
      yoy: { revenue: yH.total, change: pctChange(revenue, yH.total) } },
    // Where the range was cut for momentum and the bridge, so the UI can label
    // the two periods honestly instead of saying "before" and "after".
    split: { index: half, firstFrom: months[0] || null, firstTo: months[half-1] || null,
             lastFrom: mid, lastTo: months[months.length-1] || null },
    months, revenue, channels,
    monthly: months.map((m) => ({
      month: m,
      total: channels.reduce((a, c) => a + c.series[months.indexOf(m)], 0),
      byChannel: Object.fromEntries(channels.map((c) => [c.channel, c.series[months.indexOf(m)]])),
    })),
  };
}

app.get("/api/ecommerce/channels", requireTab("ecomchannels"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const scope = req.query.scope === "all" ? "all" : "online";
    const out = await withCache(`ecomch:${scope}:${from}:${to}`, req.query.refresh === "1",
      () => buildChannels(from, to, scope));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecom_channels_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Channels failed" });
  }
});

/**
 * Channel migration: do customers who start online later buy offline, and
 * vice versa.
 *
 * Definitions matter here, so they are stated rather than implied:
 *  · A customer is a stable hashed key. Rows without one cannot take part, and
 *    the response reports how many were excluded on that basis.
 *  · Only customers with purchases on two or more DIFFERENT DATES count. Two
 *    coupons in one basket are one shopping decision, not a migration.
 *  · Their FIRST purchase sets the origin type; every later purchase of a
 *    different type is a switch, dated to the month it happened.
 *  · This is ALWAYS computed across all channel types. Restricting to online
 *    would make the question unanswerable.
 */
async function buildMigration(from, to) {
  const all = await ecomRows();
  const rows = all.filter((r) => r.date >= from && r.date <= to);
  if (!rows.length) return { empty: true, rangeHas: all.length };

  const noKey = rows.filter((r) => !r.customer).length;
  const byCustomer = new Map();
  for (const r of rows) {
    if (!r.customer) continue;
    if (!byCustomer.has(r.customer)) byCustomer.set(r.customer, []);
    byCustomer.get(r.customer).push(r);
  }

  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
  const flow = new Map();          // "Online→Offline" => count of customers
  // Switches are counted by the TYPE they moved TO, so the chart can be
  // coloured with the same palette used for types everywhere else.
  const monthly = new Map();
  months.forEach((m) => monthly.set(m, { month: m, byType: {}, total: 0 }));

  // Movement between online storefronts is a different question from moving
  // off the internet entirely, and gets its own matrix.
  const onlineFlow = new Map();
  const onlineChannelsSeen = new Set();
  let onlineMulti = 0, onlineSingle = 0;

  let multiDate = 0, switchers = 0, loyal = 0;
  const originCounts = new Map(), originSwitched = new Map();

  for (const [, list] of byCustomer) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const dates = [...new Set(list.map((r) => r.date))];
    if (dates.length < 2) continue;         // one shopping trip is not a migration
    multiDate++;
    const origin = list[0].type;
    originCounts.set(origin, (originCounts.get(origin) || 0) + 1);

    // The first purchase on a different type, if any, is the migration event.
    const jump = list.find((r) => r.type !== origin);
    if (!jump) { loyal++; continue; }
    switchers++;
    originSwitched.set(origin, (originSwitched.get(origin) || 0) + 1);
    const key = `${origin}→${jump.type}`;
    flow.set(key, (flow.get(key) || 0) + 1);
    const m = monthly.get(jump.date.slice(0, 7));
    if (m) { m.byType[jump.type] = (m.byType[jump.type] || 0) + 1; m.total++; }
  }

  // Second pass: within-online movement, over the same returning customers.
  for (const [, list] of byCustomer) {
    const online = list.filter((r) => r.type === "Online");
    if (!online.length) continue;
    const dates = [...new Set(online.map((r) => r.date))];
    if (dates.length < 2) { if (online.length) onlineSingle++; continue; }
    online.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const first = online[0].channel;
    onlineChannelsSeen.add(first);
    const moved = online.find((r) => r.channel !== first);
    if (!moved) { onlineSingle++; continue; }
    onlineMulti++;
    onlineChannelsSeen.add(moved.channel);
    const k = `${first}→${moved.channel}`;
    onlineFlow.set(k, (onlineFlow.get(k) || 0) + 1);
  }

  const flows = [...flow.entries()]
    .map(([k, count]) => ({ from: k.split("→")[0], to: k.split("→")[1], count }))
    .sort((a, b) => b.count - a.count);

  const origins = [...originCounts.entries()].map(([type, customers]) => ({
    type, customers, switched: originSwitched.get(type) || 0,
    switchRate: customers ? (originSwitched.get(type) || 0) / customers : 0,
  })).sort((a, b) => b.customers - a.customers);

  const unclassified = [...new Map(rows.filter((r) => r.type === "Unclassified")
    .map((r) => [r.channel, 0])).keys()].map((name) => ({
      name,
      revenue: rows.filter((r) => r.channel === name).reduce((a, r) => a + r.price, 0),
    })).sort((a, b) => b.revenue - a.revenue);

  const onlineFlows = [...onlineFlow.entries()]
    .map(([k, count]) => ({ from: k.split("→")[0], to: k.split("→")[1], count }))
    .sort((a, b) => b.count - a.count);

  return {
    months,
    unclassified,
    monthly: months.map((m) => monthly.get(m)),
    online: {
      channels: [...onlineChannelsSeen].sort(),
      flows: onlineFlows,
      switchers: onlineMulti,
      loyal: onlineSingle,
      switchRate: (onlineMulti + onlineSingle) ? onlineMulti / (onlineMulti + onlineSingle) : 0,
    },
    flows, origins,
    totals: {
      customers: byCustomer.size,
      // Bought on exactly one date and never came back. Without this the four
      // headline figures look like they should sum to the customer count, and
      // they cannot: switchers and stayers are both subsets of the returners.
      onceOnly: byCustomer.size - multiDate,
      returning: multiDate,
      switchers, loyal,
      switchRate: multiDate ? switchers / multiDate : 0,
      rowsWithoutKey: noKey,
      coverage: rows.length ? 1 - noKey / rows.length : 1,
    },
  };
}

app.get("/api/ecommerce/migration", requireTab("ecommigration"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`ecommig:${from}:${to}`, req.query.refresh === "1",
      () => buildMigration(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecom_migration_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Migration failed" });
  }
});

/**
 * Churn: which channels and centres are losing customers.
 *
 * Definitions, stated because they decide the answer:
 *  · Reference date is the END of the selected range, not today, so the view is
 *    reproducible when someone looks at an older window.
 *  · A customer is CHURNED if their most recent purchase is more than `window`
 *    days before that reference date. 365 is the default because a health
 *    check-up is an annual purchase — a shorter window would call an ordinary
 *    annual customer lost.
 *  · Churn is attributed to the channel and centre of their LAST purchase. That
 *    is where the relationship ended, which is the actionable place, even if
 *    they were acquired somewhere else.
 *  · One-and-done (a single purchase ever) is reported separately from lapsed
 *    (bought repeatedly, then stopped). They are different problems: the first
 *    is an acquisition-quality issue, the second is a retention issue.
 *  · Always spans every channel type. Restricting to online would count a
 *    customer who simply moved to the clinic as lost.
 */
async function buildChurn(from, to, windowDays) {
  const all = await ecomRows();
  const rows = all.filter((r) => r.date >= from && r.date <= to);
  if (!rows.length) return { empty: true, rangeHas: all.length };

  const ref = new Date(`${to}T00:00:00Z`);
  const cutoff = new Date(ref); cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const byCustomer = new Map();
  let noKey = 0;
  for (const r of rows) {
    if (!r.customer) { noKey++; continue; }
    let c = byCustomer.get(r.customer);
    if (!c) { c = { purchases: 0, dates: new Set(), first: r, last: r, revenue: 0 }; byCustomer.set(r.customer, c); }
    c.purchases++; c.dates.add(r.date); c.revenue += r.price;
    if (r.date < c.first.date) c.first = r;
    if (r.date >= c.last.date) c.last = r;
  }

  const chan = new Map(), centre = new Map(), byMonth = new Map();
  let churned = 0, active = 0, oneAndDone = 0, lapsed = 0, lostRevenue = 0;

  const bump = (map, key, isChurn, cust) => {
    let e = map.get(key);
    if (!e) { e = { name: key, customers: 0, churned: 0, active: 0, lostRevenue: 0, oneAndDone: 0 }; map.set(key, e); }
    e.customers++;
    if (isChurn) {
      e.churned++; e.lostRevenue += cust.revenue;
      if (cust.dates.size === 1) e.oneAndDone++;
    } else e.active++;
  };

  for (const [, c] of byCustomer) {
    const isChurn = c.last.date < cutoffIso;
    if (isChurn) {
      churned++; lostRevenue += c.revenue;
      if (c.dates.size === 1) oneAndDone++; else lapsed++;
      const m = c.last.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) || 0) + 1);
    } else active++;
    // Attributed to where they were last seen.
    bump(chan, c.last.channel || "(unknown)", isChurn, c);
    bump(centre, c.last.center || "Unmapped", isChurn, c);
  }

  const shape = (map) => [...map.values()].map((e) => ({
    ...e,
    churnRate: e.customers ? e.churned / e.customers : 0,
    avgLostValue: e.churned ? e.lostRevenue / e.churned : 0,
    oneAndDoneShare: e.churned ? e.oneAndDone / e.churned : 0,
  })).sort((a, b) => b.churned - a.churned);

  const months = [...byMonth.keys()].sort();
  return {
    windowDays, referenceDate: to, cutoff: cutoffIso,
    totals: {
      customers: byCustomer.size, churned, active,
      churnRate: byCustomer.size ? churned / byCustomer.size : 0,
      oneAndDone, lapsed, lostRevenue,
      avgLostValue: churned ? lostRevenue / churned : 0,
      rowsWithoutKey: noKey,
      coverage: rows.length ? 1 - noKey / rows.length : 1,
    },
    channels: shape(chan),
    centres: shape(centre),
    lastSeen: months.map((m) => ({ month: m, customers: byMonth.get(m) })),
  };
}

app.get("/api/ecommerce/churn", requireTab("ecomchurn"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  const windowDays = Math.min(Math.max(parseInt(req.query.window, 10) || 365, 30), 1095);
  try {
    const out = await withCache(`ecomchurn:${windowDays}:${from}:${to}`, req.query.refresh === "1",
      () => buildChurn(from, to, windowDays));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecom_churn_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Churn failed" });
  }
});

/**
 * The monthly one-pager: a fixed month against the same month a year earlier,
 * plus year-to-date, laid out to be printed rather than explored.
 *
 * The month comes from the END of the selected range, so choosing LM gives last
 * month without a second control. YTD runs 1 January of that year to the end of
 * the month, and its comparison is the identical span a year back — not the full
 * prior year, which would flatter every figure.
 */
/**
 * THE REPORT HONOURS THE DATE RANGE (MW: "if it is set to be 15 Aug -> 31 Aug
 * then it's 15 Aug to 31 Aug").
 *
 * It used to take only `to`, throw away `from`, and report the whole calendar
 * month — so the picker said one thing and the page did another, silently. Now
 * the selected window IS the window.
 *
 * The comparison is the same SPAN one year earlier, not the same calendar
 * month, because that is the only honest counterpart to an arbitrary range:
 * seventeen days must compare against seventeen days or the change figure is
 * meaningless. Year-to-date runs from 1 January to the chosen `to`, and its
 * counterpart to the same day last year.
 *
 * A day-of-month that does not exist a year earlier (29 February) is clamped to
 * that month's last day rather than rolling into March, which is what
 * `new Date()` would do and what would quietly shift a window.
 */
function yearBefore(iso) {
  const y = +iso.slice(0, 4) - 1, m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

async function buildMonthly(from, to, scope) {
  const all = await ecomRows();
  const rows = scope === "all" ? all : all.filter((r) => r.type === "Online");
  const y = +to.slice(0, 4), m = +to.slice(5, 7);
  const prevFrom = yearBefore(from), prevTo = yearBefore(to);
  const win = {
    month: { from, to },
    ytd: { from: `${y}-01-01`, to },
    monthPrev: { from: prevFrom, to: prevTo },
    ytdPrev: { from: `${y - 1}-01-01`, to: prevTo },
  };
  const month = to.slice(0, 7);

  const agg = (w) => {
    const orders = new Set();
    let revenue = 0, units = 0;
    for (const r of rows) {
      if (r.date < w.from || r.date > w.to) continue;
      revenue += r.price; units++; orders.add(r.orderId);
    }
    return { revenue, units, orders: orders.size, aov: orders.size ? revenue / orders.size : 0 };
  };
  const groupBy = (w, keyFn) => {
    const g = new Map();
    for (const r of rows) {
      if (r.date < w.from || r.date > w.to) continue;
      const k = keyFn(r);
      const e = g.get(k) || { revenue: 0, units: 0 };
      e.revenue += r.price; e.units++;
      g.set(k, e);
    }
    return g;
  };

  const mtd = agg(win.month), mtdPrev = agg(win.monthPrev);
  const ytd = agg(win.ytd), ytdPrev = agg(win.ytdPrev);

  const cNow = groupBy(win.month, (r) => r.center || "Unmapped");
  const cPrev = groupBy(win.monthPrev, (r) => r.center || "Unmapped");
  const centreNames = [...new Set([...cNow.keys(), ...cPrev.keys()])];
  const centres = centreNames.map((name) => ({
    name,
    revenue: (cNow.get(name) || {}).revenue || 0,
    revenuePrev: (cPrev.get(name) || {}).revenue || 0,
    units: (cNow.get(name) || {}).units || 0,
    unitsPrev: (cPrev.get(name) || {}).units || 0,
  })).sort((a, b) => b.revenue - a.revenue);

  const chNow = groupBy(win.month, (r) => r.channel);
  const chTotal = [...chNow.values()].reduce((a, e) => a + e.revenue, 0);
  const channels = [...chNow.entries()]
    .map(([name, e]) => ({ name, revenue: e.revenue, units: e.units,
      share: chTotal ? e.revenue / chTotal : 0 }))
    .sort((a, b) => b.revenue - a.revenue);

  /**
   * THE LABEL TELLS THE TRUTH ABOUT THE WINDOW. A full calendar month still
   * reads "August 2026" — that is the normal case and the nicer wording. Any
   * other range spells out its dates, so a seventeen-day report can never be
   * mistaken for a month.
   */
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const wholeMonth = from === `${month}-01` && to === `${month}-${String(lastDay).padStart(2, "0")}`;
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const human = (iso) => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
  return {
    month,
    monthLabel: wholeMonth
      ? new Date(Date.UTC(y, m - 1, 1))
          .toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
      : `${human(from)} \u2013 ${human(to)}`,
    wholeMonth,
    scope: scope === "all" ? "all" : "online",
    windows: win,
    mtd: { ...mtd, prev: mtdPrev, change: pctChange(mtd.revenue, mtdPrev.revenue),
           unitsChange: pctChange(mtd.units, mtdPrev.units),
           aovChange: pctChange(mtd.aov, mtdPrev.aov) },
    ytd: { ...ytd, prev: ytdPrev, change: pctChange(ytd.revenue, ytdPrev.revenue) },
    centres, channels,
    empty: mtd.revenue === 0 && mtdPrev.revenue === 0,
  };
}

app.get("/api/ecommerce/monthly", requireTab("ecommonthly"), async (req, res) => {
  const { to } = req.query;
  if (!isoDate(to)) return res.status(400).json({ error: "to must be YYYY-MM-DD" });
  /**
   * `from` is optional so an old link still resolves, and defaults to the first
   * of `to`'s month — the behaviour this endpoint used to have unconditionally.
   * The cache key carries BOTH dates: keying on the month alone would have
   * served a full-month payload to a seventeen-day request, which is the exact
   * class of silent-wrong-data the version-keyed caches exist to prevent.
   */
  const from = isoDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
  if (from > to) return res.status(400).json({ error: "from must not be after to" });
  try {
    const scope = req.query.scope === "all" ? "all" : "online";
    const out = await withCache(`ecommonthly:${scope}:${from}:${to}`, req.query.refresh === "1",
      () => buildMonthly(from, to, scope));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecom_monthly_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Monthly report failed" });
  }
});

/**
 * ROAS: what the Meta budget was actually pointed at, and what the storefronts
 * earned.
 *
 * Built on two fields Meta reports directly rather than on campaign names:
 *
 *  · `website_destination_url` — where the click lands. A `/package/` page is a
 *    purchase page; a `/content/` page is an article. This is the difference
 *    between an ad meant to sell and an ad meant to inform, and no amount of
 *    reading campaign names establishes it reliably.
 *  · `adsset_optimization_goal` — what Meta was told to buy. OFFSITE_CONVERSIONS
 *    is a purchase ad by definition; LEAD_GENERATION and CONVERSATIONS never
 *    reach a storefront at all.
 *
 * Verified against July 2026: NOT ONE ad pointed at shopee.co.th or
 * lazada.co.th. The earlier name-matching therefore attributed marketplace
 * revenue to campaigns that never linked to a marketplace. Those storefronts
 * are reached through CPAS and Instant Experience instead, so the honest answer
 * for them is "no direct link", not a fabricated ratio.
 */
/**
 * The three ad accounts that exist to sell on a marketplace, by account id.
 *
 * Matching on the id rather than the name is deliberate: an account rename would
 * silently drop it from the report, and the ids were given by the marketing team
 * so they are authoritative. Every baht in one of these accounts was spent
 * selling on that storefront — no campaign name to interpret, no landing page to
 * inspect, and CPAS ads that point at a Facebook Instant Experience are covered
 * by definition rather than by exception.
 *
 * Everything else in Meta is hospital marketing and is deliberately out of scope
 * here; mixing it in was what made the earlier version unreadable.
 */
const ECOM_AD_ACCOUNTS = [
  { id: "663327782377238", name: "Bangkok Hospital x Lazada", channel: "Lazada" },
  { id: "859997291728794", name: "BHQ Shopee x EGG",          channel: "Shopee" },
  { id: "523705615907093", name: "BHQ Shopee x ADA",          channel: "Shopee" },
];

async function buildRoas(from, to) {
  const ids = ECOM_AD_ACCOUNTS.map((a) => a.id);
  const [rows, ads] = await Promise.all([
    ecomRows(),
    windsor("facebook",
      ["account_id", "account_name", "campaign", "adset_name", "date", "spend", "impressions",
       "actions_link_click"],
      from, to, { filters: [{ field: "account_id", operation: "in", value: ids }] })
      .catch((e) => {
        logJson("WARNING", "roas_meta_unavailable", { error: String(e.message || e) });
        return null;
      }),
  ]);
  if (ads === null) return { metaUnavailable: true };

  // Revenue per storefront per month, from the normalised sheet.
  const rev = new Map();
  const months = new Set();
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    const m = r.date.slice(0, 7);
    months.add(m);
    rev.set(`${m}|${r.channel}`, (rev.get(`${m}|${r.channel}`) || 0) + r.price);
  }

  const perAccount = new Map();
  for (const a of ECOM_AD_ACCOUNTS) {
    perAccount.set(a.id, { ...a, spend: 0, impressions: 0, clicks: 0,
                           campaigns: new Map(), byMonth: new Map() });
  }
  for (const r of ads) {
    const acc = perAccount.get(String(r.account_id || ""));
    // LOAD-BEARING. Windsor accepts `filters` and ignores it (proven on the GA4
    // connector 21 Aug 2026, see the GA4 Data API block above), so assume the
    // account_id filter above does nothing and all 15 ad accounts arrive here.
    // This line is what keeps ROAS to the three storefront accounts. The old
    // comment claimed a filter miss "should never reach here" — it always does.
    if (!acc) continue;
    const date = String(r.date || "").slice(0, 10);
    if (!date) continue;
    const m = date.slice(0, 7);
    months.add(m);
    const sp = n(r.spend), imp = n(r.impressions), clk = n(r.actions_link_click);
    acc.spend += sp; acc.impressions += imp; acc.clicks += clk;
    acc.byMonth.set(m, (acc.byMonth.get(m) || 0) + sp);
    if (r.account_name) acc.liveName = String(r.account_name);

    // A campaign counts as active in the range if it spent anything in it.
    const name = String(r.campaign || "(unnamed campaign)");
    const c = acc.campaigns.get(name) ||
      { campaign: name, spend: 0, impressions: 0, clicks: 0, dates: new Set(), first: date, last: date,
        adsets: new Map() };
    c.spend += sp; c.impressions += imp; c.clicks += clk;
    // A Set, because the feed returns one row per campaign x ad set x date:
    // incrementing a counter multiplied the day count by the number of ad sets.
    if (sp > 0) c.dates.add(date);
    if (date < c.first) c.first = date;
    if (date > c.last) c.last = date;

    // Ad set name is the audience in practice, so a campaign can be opened to
    // see which audiences carried it.
    const aname = String(r.adset_name || "(unnamed ad set)");
    const as = c.adsets.get(aname) || { adset: aname, spend: 0, impressions: 0, clicks: 0, dates: new Set() };
    as.spend += sp; as.impressions += imp; as.clicks += clk;
    if (sp > 0) as.dates.add(date);
    c.adsets.set(aname, as);
    acc.campaigns.set(name, c);
  }

  const monthList = [...months].sort();
  const accounts = [...perAccount.values()].map((a) => {
    const revenue = monthList.reduce((x, m) => x + (rev.get(`${m}|${a.channel}`) || 0), 0);
    const campaigns = [...a.campaigns.values()]
      .filter((c) => c.spend > 0)             // only what actually ran in the range
      .map((c) => ({ ...c,
        days: c.dates.size, dates: undefined,
        cpc: c.clicks > 0 ? c.spend / c.clicks : null,
        cpm: c.impressions > 0 ? (c.spend / c.impressions) * 1000 : null,
        adsets: [...c.adsets.values()]
          .filter((a) => a.spend > 0)
          .map((a) => ({ ...a,
            days: a.dates.size, dates: undefined,
            cpc: a.clicks > 0 ? a.spend / a.clicks : null,
            cpm: a.impressions > 0 ? (a.spend / a.impressions) * 1000 : null,
            share: c.spend > 0 ? a.spend / c.spend : 0 }))
          .sort((x, y) => y.spend - x.spend) }))
      .sort((x, y) => y.spend - x.spend);
    return {
      id: a.id, account: a.liveName || a.name, channel: a.channel,
      spend: a.spend, impressions: a.impressions, clicks: a.clicks,
      revenue, roas: a.spend > 0 ? revenue / a.spend : null,
      cpc: a.clicks > 0 ? a.spend / a.clicks : null,
      active: a.spend > 0,
      campaigns,
      series: monthList.map((m) => ({
        month: m,
        spend: a.byMonth.get(m) || 0,
        revenue: rev.get(`${m}|${a.channel}`) || 0,
      })),
    };
  }).sort((x, y) => y.spend - x.spend);

  // One storefront can have two accounts, so revenue is summed over DISTINCT
  // storefronts — otherwise Shopee's revenue would be counted twice.
  const liveChannels = [...new Set(accounts.filter((a) => a.active).map((a) => a.channel))];
  const totalSpend = accounts.reduce((x, a) => x + a.spend, 0);
  const totalRev = liveChannels.reduce((x, ch) =>
    x + monthList.reduce((y, m) => y + (rev.get(`${m}|${ch}`) || 0), 0), 0);

  return {
    months: monthList,
    accounts,
    channels: liveChannels,
    totals: {
      spend: totalSpend, revenue: totalRev,
      roas: totalSpend > 0 ? totalRev / totalSpend : null,
      activeAccounts: accounts.filter((a) => a.active).length,
      campaigns: accounts.reduce((x, a) => x + a.campaigns.length, 0),
      // Ad-delivery totals. These are the figures the tab leads on, because
      // unlike the revenue ratio they describe only what the ads themselves
      // did. Summed from the accounts so they cannot drift from the cards.
      clicks: accounts.reduce((x, a) => x + (a.clicks || 0), 0),
      impressions: accounts.reduce((x, a) => x + (a.impressions || 0), 0),
      cpc: (() => {
        const c = accounts.reduce((x, a) => x + (a.clicks || 0), 0);
        return c > 0 ? totalSpend / c : null;
      })(),
    },
  };
}

app.get("/api/ecommerce/roas", requireTab("ecomroas"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`ecomroas:${from}:${to}`, req.query.refresh === "1",
      () => buildRoas(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "ecom_roas_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "ROAS failed" });
  }
});

/**
 * Google Ads, newly connected in place of LINE. Deliberately a plain read to
 * start with — accounts, campaigns and a monthly trend — because nothing is yet
 * known about how these campaigns are structured or named beyond the fact that
 * they carry the same YYMMDD-NN codes as Meta.
 */
async function buildGoogleAds(from, to) {
  const rows = await windsor("google_ads",
    ["date", "account_name", "campaign", "adgroup", "campaign_type", "conversions",
     "spend", "impressions", "clicks"], from, to)
    .catch((e) => {
      logJson("WARNING", "gads_unavailable", { error: String(e.message || e) });
      return null;
    });
  if (rows === null) return { unavailable: true };

  const accounts = new Map(), campaigns = new Map(), months = new Map();
  let spend = 0, impressions = 0, clicks = 0;
  for (const r of rows) {
    const sp = n(r.spend), imp = n(r.impressions), clk = n(r.clicks);
    spend += sp; impressions += imp; clicks += clk;

    const an = String(r.account_name || "(unnamed)");
    const a = accounts.get(an) || { account: an, spend: 0, impressions: 0, clicks: 0, campaigns: new Set() };
    a.spend += sp; a.impressions += imp; a.clicks += clk;
    if (r.campaign) a.campaigns.add(String(r.campaign));
    accounts.set(an, a);

    const cn = String(r.campaign || "(unnamed)");
    const c = campaigns.get(cn) ||
      { campaign: cn, account: an, type: r.campaign_type || null,
        spend: 0, impressions: 0, clicks: 0, conversions: 0,
        dates: new Set(), groups: new Map(),
        // The leading code is what lets a Google campaign join the Campaign tab.
        code: (String(r.campaign || "").match(/^(\d{6}-\d{1,3})/) || [])[1] || null };
    c.spend += sp; c.impressions += imp; c.clicks += clk;
    c.conversions += n(r.conversions);
    if (!c.type && r.campaign_type) c.type = r.campaign_type;
    if (r.date) c.dates.add(String(r.date).slice(0, 10));

    // Ad group is Google's equivalent of Meta's ad set, so a campaign opens the
    // same way on both platforms.
    const gn = String(r.adgroup || "(no ad group)");
    const g = c.groups.get(gn) ||
      { group: gn, spend: 0, impressions: 0, clicks: 0, conversions: 0, dates: new Set() };
    g.spend += sp; g.impressions += imp; g.clicks += clk; g.conversions += n(r.conversions);
    if (r.date) g.dates.add(String(r.date).slice(0, 10));
    c.groups.set(gn, g);
    campaigns.set(cn, c);

    if (r.date) {
      const m = String(r.date).slice(0, 7);
      const mm = months.get(m) || { month: m, spend: 0, impressions: 0, clicks: 0 };
      mm.spend += sp; mm.impressions += imp; mm.clicks += clk;
      months.set(m, mm);
    }
  }

  const shape = (o) => ({ ...o,
    ctr: o.impressions > 0 ? o.clicks / o.impressions : null,
    cpc: o.clicks > 0 ? o.spend / o.clicks : null,
    cpm: o.impressions > 0 ? (o.spend / o.impressions) * 1000 : null });

  const campaignList = [...campaigns.values()]
    .map((c) => shape({ ...c, days: c.dates.size, dates: undefined,
      groups: [...c.groups.values()]
        .filter((g) => g.spend > 0)
        .map((g) => shape({ ...g, days: g.dates.size, dates: undefined,
          share: c.spend > 0 ? g.spend / c.spend : 0 }))
        .sort((x, y) => y.spend - x.spend) }))
    .sort((a, b) => b.spend - a.spend);

  return {
    totals: shape({ spend, impressions, clicks,
      conversions: campaignList.reduce((a, c) => a + c.conversions, 0),
      accounts: accounts.size, campaigns: campaignList.length,
      coded: campaignList.filter((c) => c.code).length }),
    accounts: [...accounts.values()]
      .map((a) => shape({ ...a, campaigns: a.campaigns.size }))
      .sort((a, b) => b.spend - a.spend),
    campaigns: campaignList,
    monthly: [...months.values()].map(shape).sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

app.get("/api/google-ads", requireTab("gads"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`gads:${from}:${to}`, req.query.refresh === "1", () => buildGoogleAds(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "gads_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Google Ads failed" });
  }
});

// ---------------------------------------------------------- /api/better-club

/**
 * A sheet cell to a number, tolerating every way this one has arrived.
 *
 * BELT AND BRACES BESIDE `unformatted: true`. The raw-value request is the fix;
 * this is here because a single cell typed as text (`'2,923`, or pasted with a
 * ฿) comes back as a string even in UNFORMATTED_VALUE mode, and the global
 * `n()` would floor it to 0 rather than fail. A silent zero in a revenue column
 * is the worst outcome available — it looks like a real figure.
 */
function bnum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v == null || v === "") return 0;
  const raw = String(v).trim();
  const neg = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[฿,\s()]/g, "");
  if (!/\d/.test(cleaned)) return 0;
  const x = Number(cleaned);
  if (!Number.isFinite(x)) return 0;
  return neg ? -x : x;
}

/**
 * `2026-07` as written, a Date, or a Sheets serial.
 *
 * The serial branch exists because `unformatted: true` turns any cell the sheet
 * thinks is a date into a number — so a hand-edited MonthYear that Sheets
 * coerced to a date would arrive as 46204 rather than as text and drop the whole
 * month silently.
 */
function monthKeyCell(v) {
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const m = /^(\d{4})-(\d{2})/.exec(String(v == null ? "" : v).trim());
  return m ? `${m[1]}-${m[2]}` : "";
}

/**
 * A count map to a ranked list, with everything below `minCell` and everything
 * past `topN` folded into "Other".
 *
 * `minCell` is a DISCLOSURE control, not a tidiness one. A nationality with one
 * member, printed next to a revenue figure, names a patient — so small groups
 * are merged rather than shown. `Other` keeps the total honest, which a simple
 * truncation would not.
 */
function bclubTopN(map, topN, minCell) {
  const rows = [...map.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, r) => a + r[1], 0);
  const blank = map.get("") || 0;
  const keep = [], merged = [];
  rows.forEach((r, i) => { (i < topN && r[1] >= minCell ? keep : merged).push(r); });
  const otherN = merged.reduce((a, r) => a + r[1], 0);
  const out = keep.map(([name, n]) => ({ name, members: n, share: total ? n / total : null }));
  if (otherN) {
    out.push({ name: "Other", members: otherN, share: total ? otherN / total : null,
               groups: merged.length, suppressed: true });
  }
  return { rows: out, total, notRecorded: blank, distinct: rows.length, minCell };
}

const bclubLabel = (key) => {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${MONTH_NAMES[+m[2] - 1]} ${m[1]}` : key;
};

/** The month keys a date range touches, oldest first. */
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  for (let i = 0; i < 36 && (y < ty || (y === ty && m <= tm)); i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * BETTER CLUB.
 *
 * THE WHOLE SERIES IS RETURNED, not just the selected range. Seven monthly
 * points is the entire dataset, and a membership programme is only legible as a
 * trend — a single month's "2,923 paid members" says nothing without the 2,202
 * it grew from. The selected range picks out which month the headline cards and
 * the concentration figures describe; it does not clip the chart.
 *
 * TWO THINGS ARE DERIVED HERE RATHER THAN READ FROM `Summary`, because the sheet
 * cannot know them:
 *
 *  · COHORT RETENTION. Of the members who first paid in month M, how many paid
 *    again in each later month. This needs the per-member tab, and it is the one
 *    question the programme exists to answer: acquisition is already visible,
 *    whereas whether acquired members come back is not.
 *  · REVENUE CONCENTRATION. What share of a month's revenue the top 1% and top
 *    10% of members account for. ARPU alone hides this, and it matters: at high
 *    concentration a handful of large bills move the average, so an ARPU
 *    movement is noise rather than a trend.
 *
 * `ARPU_New` is reported WITH its member count for exactly that reason. It ran
 * ฿18,154 in January and ฿45,070 in June against a stable overall ARPU, and June
 * had only 189 new members — small-sample movement, not a step change.
 */
async function buildBetterClub(from, to) {
  let res;
  try {
    res = await sheetBatchGet(BCLUB_SHEET_ID, [
      `'${BCLUB_SUMMARY_TAB}'!A1:P`,
      `'${BCLUB_DETAIL_TAB}'!A1:I`,
    ], { unformatted: true });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return {
      available: false,
      error: msg,
      fix: msg.includes("403")
        ? "Share the Better Club spreadsheet with the Cloud Run service account (Viewer)."
        : msg.includes("404")
          ? `Spreadsheet not found — check BCLUB_SHEET_ID and that tabs named "${BCLUB_SUMMARY_TAB}" and "${BCLUB_DETAIL_TAB}" exist.`
          : "See the error text above.",
    };
  }

  /**
   * The register tab is optional, so a missing tab must degrade to "no source"
   * rather than take the section down. Deliberately not folded into the
   * batchGet above: one bad range fails all of them.
   */
  const registers = await sheetBatchGet(BCLUB_SHEET_ID, [`'${BCLUB_REGISTER_TAB}'!A1:B`], { unformatted: true })
    .then((r) => (r[0] && r[0].values) || [])
    .catch(() => null);

  /**
   * The roster, read in the same optional way. Columns A:N covers `User ID`
   * through `Register Channel`; the hashed join keys sit to the right of that
   * and are deliberately NOT fetched — this service has no use for them and
   * should not hold them.
   */
  const members = await sheetBatchGet(BCLUB_SHEET_ID, [`'${BCLUB_MEMBER_TAB}'!A1:N`], { unformatted: true })
    .then((r) => (r[0] && r[0].values) || [])
    .catch(() => null);

  const vals = (i) => (res[i] && res[i].values) || [];
  const summary = vals(0), detail = vals(1);
  if (summary.length < 2) {
    return { available: false, error: `no rows in ${BCLUB_SUMMARY_TAB} — run "Better Club > Rebuild Summary" in the spreadsheet` };
  }

  // Columns by name. The normaliser has already changed this tab's column count
  // once, and a positional read would return the wrong figure rather than fail.
  const sHead = summary[0].map((h) => String(h == null ? "" : h).trim());
  const at = (name) => sHead.indexOf(name);
  const NEED = ["MonthYear", "PaidHNs", "Revenue", "NewPaidHNs", "RevFromNewPaidHNs"];
  const missing = NEED.filter((c) => at(c) === -1);
  if (missing.length) {
    return { available: false,
             error: `${BCLUB_SUMMARY_TAB} is missing column(s): ${missing.join(", ")} — headers seen: ${sHead.join(" | ")}` };
  }
  const SC = {};
  ["MonthYear","PaidHNs","Revenue","NewPaidHNs","RevFromNewPaidHNs","OldPaidHNs",
   "RevFromOldPaidHNs","Returned2Y","RevFromReturned2Y","ARPU","ARPU_New","ARPU_Old",
  ].forEach((c) => { SC[c] = at(c); });

  const months = [];
  for (let r = 1; r < summary.length; r++) {
    const row = summary[r] || [];
    const key = monthKeyCell(row[SC.MonthYear]);
    if (!key) continue;                                  // blank or a stray note row
    const g = (c) => (SC[c] === -1 ? 0 : bnum(row[SC[c]]));
    const paidHns = g("PaidHNs"), revenue = g("Revenue");
    const newHns = g("NewPaidHNs"), newRev = g("RevFromNewPaidHNs");
    const oldHns = SC.OldPaidHNs === -1 ? paidHns - newHns : g("OldPaidHNs");
    const oldRev = SC.RevFromOldPaidHNs === -1 ? revenue - newRev : g("RevFromOldPaidHNs");
    months.push({
      month: key, label: bclubLabel(key),
      paidHns, revenue, newHns, newRev, oldHns, oldRev,
      ret2y: g("Returned2Y"), ret2yRev: g("RevFromReturned2Y"),
      // Rates are recomputed from the counts rather than read from the sheet, so
      // a stale Summary row cannot print a percentage that disagrees with the
      // numbers beside it.
      arpu: paidHns ? revenue / paidHns : null,
      arpuNew: newHns ? newRev / newHns : null,
      arpuOld: oldHns ? oldRev / oldHns : null,
      newHnShare: paidHns ? newHns / paidHns : null,
      newRevShare: revenue ? newRev / revenue : null,
    });
  }
  if (!months.length) return { available: false, error: `no readable month rows in ${BCLUB_SUMMARY_TAB}` };
  months.sort((a, b) => (a.month < b.month ? -1 : 1));

  /**
   * WHICH MONTH THE CARDS DESCRIBE. The latest month the range touches that the
   * sheet actually has. A range ending mid-month before the export has arrived
   * would otherwise show a headline of zeros beside a chart full of data, which
   * reads as a broken tab rather than as a month not yet loaded.
   */
  const inRange = monthsBetween(from, to);
  const have = new Set(months.map((m) => m.month));
  const wanted = inRange.filter((k) => have.has(k));
  const selKey = wanted.length ? wanted[wanted.length - 1] : months[months.length - 1].month;
  const selIdx = months.findIndex((m) => m.month === selKey);
  const selected = months[selIdx];
  const prev = selIdx > 0 ? months[selIdx - 1] : null;
  const pending = inRange.filter((k) => !have.has(k));

  // ---- per-member detail: cohorts and concentration
  let cohorts = null, concentration = null, detailNote = null;
  if (detail.length > 1) {
    const dHead = detail[0].map((h) => String(h == null ? "" : h).trim());
    const dAt = (name) => dHead.indexOf(name);
    /**
     * `User ID` IS THE COHORT KEY NOW, with `HN_ID` as the fallback.
     *
     * HN only exists once someone has visited, so an HN-keyed cohort silently
     * excludes every member who has not — the exact population the programme
     * cares about. User ID comes from registration and covers everyone.
     */
    const D = {
      month: dAt("MonthYear"), user: dAt("User ID"), hn: dAt("HN_ID"),
      rev: dAt("Revenue"), seg: dAt("Segment"),
    };
    D.id = D.user > -1 ? D.user : D.hn;
    if (D.month === -1 || D.id === -1) {
      detailNote = `${BCLUB_DETAIL_TAB} is missing MonthYear or HN_ID — cohorts unavailable.`;
    } else {
      const paidIn = new Map();      // month -> Set of HN_ID
      const newIn = new Map();       // month -> Set of HN_ID first paying that month
      const revIn = new Map();       // month -> Map of HN_ID -> revenue
      const selRevs = [];
      let blankId = 0;

      for (let r = 1; r < detail.length; r++) {
        const row = detail[r] || [];
        const key = monthKeyCell(row[D.month]);
        if (!key) continue;
        const id = String(row[D.id] == null ? "" : row[D.id]).trim();
        const rev = D.rev === -1 ? 0 : bnum(row[D.rev]);
        if (key === selKey) selRevs.push(rev);
        // A blank HN_ID means that row came from an export with HN already
        // stripped. It still counts toward revenue, but it cannot be tracked
        // across months, so it is excluded from cohorts rather than treated as
        // one enormous member who never returns.
        if (!id) { blankId++; continue; }
        if (!paidIn.has(key)) { paidIn.set(key, new Set()); revIn.set(key, new Map()); }
        paidIn.get(key).add(id);
        revIn.get(key).set(id, (revIn.get(key).get(id) || 0) + rev);
        if (String(row[D.seg] == null ? "" : row[D.seg]).trim().toLowerCase() === "new") {
          if (!newIn.has(key)) newIn.set(key, new Set());
          newIn.get(key).add(id);
        }
      }

      const keys = months.map((m) => m.month).filter((k) => paidIn.has(k));
      if (keys.length) {
        cohorts = {
          months: keys,
          labels: keys.map(bclubLabel),
          rows: keys.map((ck) => {
            const cohort = newIn.get(ck) || new Set();
            const later = keys.filter((k) => k > ck);
            return {
              cohort: ck, label: bclubLabel(ck), size: cohort.size,
              retained: later.map((k) => {
                const paid = paidIn.get(k) || new Set();
                const revMap = revIn.get(k) || new Map();
                let count = 0, revenue = 0;
                cohort.forEach((id) => {
                  if (paid.has(id)) { count++; revenue += revMap.get(id) || 0; }
                });
                return { month: k, count, revenue, rate: cohort.size ? count / cohort.size : null };
              }),
            };
          }).filter((r) => r.size > 0),
        };
        if (!cohorts.rows.length) cohorts = null;

        /**
         * MONTH-ON-MONTH REPEAT RATE, separate from cohorts: of everyone who
         * paid last month, how many paid again this month. Cohorts answer "do
         * the members we acquired stick"; this answers "is the paying base
         * holding", which is the figure that moves revenue next month.
         */
        const prevKey = prev && prev.month;
        if (prevKey && paidIn.has(prevKey) && paidIn.has(selKey)) {
          const before = paidIn.get(prevKey), now = paidIn.get(selKey);
          let kept = 0;
          before.forEach((id) => { if (now.has(id)) kept++; });
          concentration = { repeatFromPrev: before.size ? kept / before.size : null,
                            keptCount: kept, prevBase: before.size };
        }
      }

      // Revenue concentration in the selected month.
      if (selRevs.length) {
        const sorted = selRevs.slice().sort((a, b) => b - a);
        const total = sorted.reduce((a, b) => a + b, 0);
        const shareOfTop = (frac) => {
          const k = Math.max(1, Math.round(sorted.length * frac));
          const s = sorted.slice(0, k).reduce((a, b) => a + b, 0);
          return { members: k, revenue: s, share: total ? s / total : null };
        };
        concentration = {
          ...(concentration || {}),
          month: selKey, members: sorted.length, revenue: total,
          top1: shareOfTop(0.01), top10: shareOfTop(0.10),
          median: sorted[Math.floor(sorted.length / 2)] || 0,
        };
      }
      if (blankId) {
        detailNote = `${num0(blankId)} member-months carry no HN_ID (imported before HN was retained) — those are in the revenue totals but not in the cohort table.`;
      }
    }
  } else {
    detailNote = `${BCLUB_DETAIL_TAB} is empty — cohorts and concentration unavailable.`;
  }

  /**
   * THE FUNNEL PANELS FROM MW'S LOOKER REPORT (SS1):
   * Google Impressions -> Total users -> Better Club new registers -> new paid HNs.
   *
   * Pulled over the SHEET'S OWN SPAN, not the selected range, because the panel
   * is a seven-month trend — the same reason the tables below show every month.
   *
   * BOTH ARE FILTERED TO THE FOUR HOSPITALS — BGH, BIH, BHT, WSH (MW: "the
   * google imp, GA4 must filter down to BGH, BIH, BHT, WSH only").
   *
   * The first version pulled them GROUP-WIDE, all 27 branches and the whole
   * domain, and labelled that honestly as B+. Honest, but wrong: a funnel whose
   * top two stages count 27 branches and whose bottom two count four is not a
   * funnel, and the conversion rate read off it is meaningless — the numerator
   * and the denominator describe different hospitals.
   *
   * So the default branch filter now applies to both: `gscQuery` matches
   * `GSC_BRANCH_REGEX` on the page path, `ga4RunReport` gets `withBranch(null)`,
   * which is the same four-segment regex on the landing page. This is the
   * standing BHQ-vs-B+ rule, and this section had broken it.
   *
   * Each is wrapped: a Search Console or GA4 failure must leave the sheet-based
   * cards standing rather than take the tab down, exactly as YouTube and Better
   * AI are wrapped in runJobs.
   */
  const seriesFrom = `${months[0].month}-01`;
  const lastKey = months[months.length - 1].month;
  const [ly, lm] = lastKey.split("-").map(Number);
  const seriesTo = new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10);

  const byMonth = (rows, dateOf, valueOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = String(dateOf(r) || "").slice(0, 7);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + bnum(valueOf(r)));
    }
    return m;
  };

  const [impr, users] = await Promise.all([
    // No `noBranchFilter`, so GSC_BRANCH_REGEX applies: BGH, BIH, BHT, WSH only.
    gscQuery(["date"], seriesFrom, seriesTo)
      .then((rows) => byMonth(rows, (r) => r.date, (r) => r.impressions))
      .catch((e) => { logJson("WARNING", "bclub_gsc_unavailable", { error: String(e.message || e) }); return null; }),
    // `withBranch(null)` is the same four-segment regex on the GA4 landing page.
    ga4RunReport({
      dimensions: ["date"], metrics: ["totalUsers"], from: seriesFrom, to: seriesTo,
      dimensionFilter: withBranch(null),
    })
      .then((rows) => byMonth(rows, (r) => ga4Date(r.date), (r) => r.totalUsers))
      .catch((e) => { logJson("WARNING", "bclub_ga4_unavailable", { error: String(e.message || e) }); return null; }),
  ]);

  /**
   * Registers, if the tab exists and has a readable header. A month present in
   * the tab but blank stays null rather than becoming 0: a zero would draw a
   * trough on the funnel and compute a 0% conversion, both of which look like
   * findings.
   */
  /**
   * REGISTRATIONS FROM THE ROSTER, which is what the User ID work bought.
   *
   * One pass over `Members` gives four things the funnel needs and could not
   * have before: how many people joined each month, how many of them have since
   * become patients, how long that took, and what the membership is made of.
   *
   * `In snapshot` = N rows are TOMBSTONES — members who have left the roster.
   * They stay in the historical registration counts, because they did register
   * that month and rewriting history when someone leaves would make last
   * quarter's numbers change silently. They are excluded from the CURRENT
   * membership composition, because they are not current members.
   */
  let memberStats = null;
  if (members && members.length > 1) {
    const mHead = members[0].map((h) => String(h == null ? "" : h).trim());
    const mAt = (name) => mHead.indexOf(name);
    const M = {
      id: mAt("User ID"), reg: mAt("Registered at"), live: mAt("In snapshot"),
      hasHn: mAt("Has HN"), first: mAt("First paid month"), lag: mAt("Months to first visit"),
      nat: mAt("Nationality"), country: mAt("Contact Country"), city: mAt("Contact City"),
      household: mAt("Household type"), channel: mAt("Register Channel"),
    };
    if (M.id > -1 && M.reg > -1) {
      const regByMonth = new Map();      // month -> { joined, converted, ... }
      const regOfUser = new Map();       // User ID -> registration month
      // Blanks are counted under "" and reported as `notRecorded`, NOT dropped:
      // 16% of the real roster has no nationality, and silently excluding those
      // rows would inflate every share by a sixth.
      const bump = (map, key) => { map.set(key, (map.get(key) || 0) + 1); };
      const nat = new Map(), country = new Map(), city = new Map(),
            household = new Map(), channel = new Map();
      let total = 0, live = 0, everPaid = 0, lagSum = 0, lagN = 0;
      const lags = [];

      for (let r = 1; r < members.length; r++) {
        const row = members[r] || [];
        const id = String(row[M.id] == null ? "" : row[M.id]).trim();
        if (!id) continue;
        total++;
        const isLive = M.live === -1 || String(row[M.live] || "").trim().toUpperCase() !== "N";
        if (isLive) live++;

        const rk = monthKeyCell(row[M.reg]);
        const paid = M.hasHn > -1 && String(row[M.hasHn] || "").trim().toUpperCase() === "Y";
        if (paid) everPaid++;
        const lg = M.lag === -1 ? null : (row[M.lag] === "" || row[M.lag] == null ? null : bnum(row[M.lag]));
        if (paid && lg !== null) { lagSum += lg; lagN++; lags.push(lg); }

        if (rk) {
          regOfUser.set(id, rk);
          if (!regByMonth.has(rk)) {
            regByMonth.set(rk, { joined: 0, converted: 0, lagSum: 0, lagN: 0, revenue: 0 });
          }
          const a = regByMonth.get(rk);
          a.joined++;
          if (paid) { a.converted++; if (lg !== null) { a.lagSum += lg; a.lagN++; } }
        }

        // Composition describes CURRENT members only.
        if (isLive) {
          if (M.nat > -1) bump(nat, String(row[M.nat] || "").trim());
          if (M.country > -1) bump(country, String(row[M.country] || "").trim());
          if (M.city > -1) bump(city, String(row[M.city] || "").trim());
          if (M.household > -1) bump(household, String(row[M.household] || "").trim());
          if (M.channel > -1) bump(channel, String(row[M.channel] || "").trim());
        }
      }

      /**
       * REVENUE BY THE MONTH THE MEMBER JOINED, not the month they spent.
       *
       * MW: "Avg months to first visit - remove rather put money if if make
       * sense." It does: a cohort's registration count and its conversion rate
       * say nothing about whether the people recruited that month were worth
       * recruiting. Every baht any member has ever spent lands against the month
       * they signed up, which is the figure that makes two intakes comparable.
       *
       * Only counts what `Rev_Attribution` holds, so it is revenue to date over
       * the loaded months — a recent cohort has had less time to spend, and the
       * table says so.
       */
      if (detail && detail.length > 1 && regOfUser.size) {
        const dh = detail[0].map((h) => String(h == null ? "" : h).trim());
        const uCol = dh.indexOf("User ID"), rCol = dh.indexOf("Revenue");
        if (uCol > -1 && rCol > -1) {
          for (let r = 1; r < detail.length; r++) {
            const row = detail[r] || [];
            const uid = String(row[uCol] == null ? "" : row[uCol]).trim();
            if (!uid) continue;
            const rk = regOfUser.get(uid);
            if (!rk) continue;                       // spender is not in the roster
            const a = regByMonth.get(rk);
            if (a) a.revenue += bnum(row[rCol]);
          }
        }
      }

      lags.sort((a, b) => a - b);
      memberStats = {
        total, live, tombstoned: total - live, everPaid,
        everPaidShare: total ? everPaid / total : null,
        meanMonthsToFirst: lagN ? lagSum / lagN : null,
        medianMonthsToFirst: lags.length ? lags[Math.floor(lags.length / 2)] : null,
        byMonth: [...regByMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([k, a]) => ({
            month: k, joined: a.joined, converted: a.converted,
            conversion: a.joined ? a.converted / a.joined : null,
            meanMonthsToFirst: a.lagN ? a.lagSum / a.lagN : null,
            revenue: a.revenue,
            revenuePerMember: a.joined ? a.revenue / a.joined : null,
            revenuePerPatient: a.converted ? a.revenue / a.converted : null,
          })),
        /**
         * SMALL CELLS ARE FOLDED INTO "Other".
         *
         * "Icelandic, 1 member" beside a revenue figure identifies a patient.
         * Nationality is a sensitive attribute and this is a hospital, so the
         * bar sits higher here than it would for a traffic source.
         */
        nationality: bclubTopN(nat, 12, 5),
        country: bclubTopN(country, 10, 5),
        city: bclubTopN(city, 10, 5),
        household: bclubTopN(household, 8, 5),
        channel: bclubTopN(channel, 6, 1),
      };
    }
  }

  let regBy = null, registerSource = null, registerNote = null;
  if (memberStats && memberStats.byMonth.length) {
    regBy = new Map(memberStats.byMonth.map((m) => [m.month, m.joined]));
    registerSource = `Total ${num0(memberStats.total)} members`;
  } else if (registers === null) {
    registerNote = `No "${BCLUB_REGISTER_TAB}" tab in the spreadsheet yet.`;
  } else if (registers.length < 2) {
    registerNote = `The "${BCLUB_REGISTER_TAB}" tab is empty.`;
  } else {
    const rHead = registers[0].map((h) => String(h == null ? "" : h).trim());
    const rMonth = rHead.findIndex((h) => /^month/i.test(h));
    const rCount = rHead.findIndex((h) => /register/i.test(h));
    if (rMonth === -1 || rCount === -1) {
      registerNote = `The "${BCLUB_REGISTER_TAB}" tab needs a MonthYear column and a NewRegisters column — headers seen: ${rHead.join(" | ")}`;
    } else {
      regBy = new Map();
      for (let r = 1; r < registers.length; r++) {
        const row = registers[r] || [];
        const key = monthKeyCell(row[rMonth]);
        const raw = row[rCount];
        if (!key || raw === "" || raw == null) continue;
        regBy.set(key, bnum(raw));
      }
      if (regBy.size) registerSource = `${BCLUB_REGISTER_TAB} tab`;
      else registerNote = `The "${BCLUB_REGISTER_TAB}" tab has no readable month rows yet.`;
    }
  }

  const funnel = months.map((m) => {
    const reg = regBy ? (regBy.get(m.month) ?? null) : null;
    return {
      month: m.month, label: m.label,
      impressions: impr ? (impr.get(m.month) ?? null) : null,
      users: users ? (users.get(m.month) ?? null) : null,
      registers: reg,
      newPaidHns: m.newHns,
      // The conversion MW's Looker report leads on: of the people who joined
      // Better Club that month, the share who became paying members.
      registerToPaid: reg > 0 ? m.newHns / reg : null,
    };
  });

  return {
    available: true,
    sheetId: BCLUB_SHEET_ID,
    range: { from, to },
    months, selected, prev, pending,
    cohorts, concentration, detailNote,
    funnel, memberStats,
    funnelScope: {
      impressions: impr ? "BGH, BIH, BHT, WSH" : null,
      users: users ? "BGH, BIH, BHT, WSH" : null,
      note: "Impressions and users are filtered to the four hospitals, matching the Better Club figures beside them.",
    },
    /**
     * Register-to-paid is the figure MW's Looker report leads on — 3.6% in March
     * against 18.2% in July. It is computed ONLY from a real source: the
     * optional `Registers` tab. With no tab, `registerSource` is null and the
     * stage renders empty, rather than a number being typed in to fill the gap.
     */
    registerSource, registerNote,
  };
}

app.get("/api/better-club", requireTab("bclub"), async (req, res) => {
  const { from, to } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  try {
    const out = await withCache(`bclub:${from}:${to}`, req.query.refresh === "1",
      () => buildBetterClub(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "bclub_failed", { error: String(err.message || err) });
    res.status(500).json({ error: err.message || "Better Club failed" });
  }
});

/**
 * Page performance for one URL the person types in.
 *
 * GA4 records the landing page as a path, so a pasted URL is reduced to its
 * path before matching — host, protocol, query and fragment are all stripped.
 * Matching is by PREFIX so a page with query-string variants or a trailing
 * slash still collects, which is what someone pasting a link expects.
 */
function pagePath(input) {
  let p = String(input || "").trim();
  if (!p) return "";
  const hadScheme = /^https?:\/\//i.test(p);
  p = p.replace(/^https?:\/\//i, "");
  // Only strip a host when there actually is one: with a scheme, or when the
  // first segment looks like a domain. "th/bangkok" is a path, not a host.
  if (hadScheme || /^[^/]*\.[a-z]{2,}(:\d+)?(\/|$)/i.test(p)) p = p.replace(/^[^/]*/, "");
  p = p.split("#")[0].split("?")[0];
  if (!p.startsWith("/")) p = "/" + p;
  return p.replace(/\/+$/, "") || "/";
}


/**
 * GA4 writes "(not set)" where Windsor wrote an empty string. Left as-is it
 * would render as a real source called "(not set)" and be counted as a tagged
 * campaign, so it is normalised back to empty here.
 */
const ga4Val = (v) => {
  const s = String(v ?? "").trim();
  return s === "(not set)" || s === "(none)" ? "" : s;
};

async function buildPage(url, from, to) {
  const path = pagePath(url);
  if (!path) return { empty: true, reason: "no path" };

  /**
   * Filtered SERVER-SIDE, for real this time.
   *
   * BEGINS_WITH is deliberately broader than we need: it also matches a sibling
   * like "/th/x/foo-2" when the path is "/th/x/foo". That is fine and cheap —
   * match() below narrows it to the page and its children exactly as before.
   * The point of the server-side filter is volume, not precision.
   */
  const dimensionFilter = {
    filter: { fieldName: GA4_LANDING_DIM, stringFilter: { matchType: "BEGINS_WITH", value: path } },
  };
  const keyEventFilter = {
    andGroup: { expressions: [
      dimensionFilter,
      { filter: { fieldName: "eventName", inListFilter: { values: KEY_EVENT_NAMES } } },
    ] },
  };

  const sessionsBy = (dims, f, t) => ga4RunReport({
    dimensions: [GA4_LANDING_DIM, ...dims], metrics: ["sessions", "engagedSessions"],
    from: f, to: t, dimensionFilter,
  });
  // Key events must be counted per eventName and summed, so that `login` stays
  // out. Adding eventName to the sessions report instead would multiply
  // sessions across events, so these are separate reports merged by key.
  const keyEventsBy = (dims, f, t) => ga4RunReport({
    dimensions: [GA4_LANDING_DIM, ...dims, "eventName"], metrics: ["keyEvents"],
    from: f, to: t, dimensionFilter: keyEventFilter,
  });

  /**
   * WHERE THEY GO NEXT (MW).
   *
   * GA4's Data API has no "next page" dimension — path exploration is an
   * Explore-only feature. `pageReferrer` is the way round it: it holds the URL
   * whose link was clicked to reach the current page, and it populates for
   * INTERNAL navigation as well as external traffic. So the pages that follow
   * this one are the pages whose referrer IS this one.
   *
   * Verified as a real Data API dimension (`pageReferrer`, event parameter
   * `page_referrer`) rather than assumed.
   *
   * Three limits, all stated on the card, because this is a proxy and reads
   * like a certainty:
   *   - It is the DOCUMENT REFERRER: the page whose link was clicked, not
   *     necessarily the page viewed immediately before.
   *   - A single-page app does not update it between views, and opening pages
   *     in parallel tabs breaks the chain.
   *   - Exits cannot appear at all. Nothing here says how many people left, so
   *     these are shares of onward clicks, never of visitors.
   */
  const nextPageFilter = {
    andGroup: { expressions: [
      { filter: { fieldName: "pageReferrer",
        stringFilter: { matchType: "CONTAINS", value: path, caseSensitive: false } } },
    ] },
  };
  const nextPagesBy = (f, t) => ga4RunReport({
    dimensions: ["pagePath", "pageReferrer"], metrics: ["screenPageViews"],
    from: f, to: t, limit: 5000, orderBy: "screenPageViews",
    dimensionFilter: nextPageFilter,
  });

  const cw = comparisonWindows(from, to);
  const { data, errors } = await runJobs({
    nextPages: nextPagesBy(from, to),
    dateS: sessionsBy(["date"], from, to),
    dateK: keyEventsBy(["date"], from, to),
    srcS: sessionsBy(["sessionManualSource", "sessionManualMedium"], from, to),
    srcK: keyEventsBy(["sessionManualSource", "sessionManualMedium"], from, to),
    cmpS: sessionsBy(["sessionManualCampaignName"], from, to),
    cmpK: keyEventsBy(["sessionManualCampaignName"], from, to),
    // Same page, same length of range, one year earlier.
    yoyS: sessionsBy([], cw.yoy.from, cw.yoy.to),
    yoyK: keyEventsBy([], cw.yoy.from, cw.yoy.to),
    prevS: sessionsBy([], cw.prev.from, cw.prev.to),
    prevK: keyEventsBy([], cw.prev.from, cw.prev.to),
  });
  if (data.dateS === null) {
    const e = new Error(`GA4 unavailable for this page: ${errors.dateS || "unknown"}`);
    e.status = String(errors.dateS || "").includes("403") ? 403 : 502;
    throw e;
  }

  // BEGINS_WITH is broad, so confirm the row really sits at or beneath the path
  // rather than merely starting with the same characters.
  const match = (lp) => {
    const p = pagePath(lp);
    return p === path || p.startsWith(path + "/");
  };
  const rows = (set) => (set || []).filter((r) => r[GA4_LANDING_DIM] && match(r[GA4_LANDING_DIM]));

  /**
   * Fold a key-event report down to one number per grouping key, then read it
   * back while walking the sessions report. Sessions and key events come from
   * separate reports, so a grouping present in one and absent from the other
   * must contribute zero rather than drop the row.
   */
  const keyIndex = (set, keyFn) => {
    const m = new Map();
    for (const r of rows(set)) {
      const k = keyFn(r);
      if (k === null) continue;
      m.set(k, (m.get(k) || 0) + n(r.keyEvents));
    }
    return m;
  };
  /** Totals for a window, from its paired sessions and key-event reports. */
  const sum = (sSet, kSet) => {
    if (sSet === null) return null;
    const base = rows(sSet).reduce((a, r) => ({
      sessions: a.sessions + n(r.sessions),
      engaged: a.engaged + n(r.engagedSessions),
    }), { sessions: 0, engaged: 0 });
    const keyEvents = rows(kSet).reduce((a, r) => a + n(r.keyEvents), 0);
    return { ...base, keyEvents };
  };

  const now = sum(data.dateS, data.dateK);
  const yoy = sum(data.yoyS, data.yoyK);
  const prev = sum(data.prevS, data.prevK);

  const monthKey = (r) => ga4Date(r.date).slice(0, 7);
  const monthKeyEvents = keyIndex(data.dateK, monthKey);

  /**
   * Per-day series and per-event breakdown. Both come from reports buildPage
   * already fetches (dateS, dateK), so this costs no extra API calls — the data
   * was being aggregated to months and thrown away at day resolution.
   */
  const dayKey = (r) => ga4Date(r.date);
  const dayKeyEvents = keyIndex(data.dateK, dayKey);
  const days = new Map();
  for (const r of rows(data.dateS)) {
    const d = dayKey(r);
    if (!d) continue;
    const e = days.get(d) || { d, visits: 0, engagement: 0, keyEvents: 0 };
    e.visits += n(r.sessions); e.engagement += n(r.engagedSessions);
    days.set(d, e);
  }
  for (const e of days.values()) e.keyEvents = dayKeyEvents.get(e.d) || 0;
  const daily = [...days.values()].sort((a, b) => a.d.localeCompare(b.d));

  // Same shape the Overview key-events card uses, so the client renders it the
  // same way. Restricted to this page's rows, so it sums to totals.keyEvents.
  const pageKeyEvents = new Map();
  for (const r of rows(data.dateK)) {
    pageKeyEvents.set(r.eventName, (pageKeyEvents.get(r.eventName) || 0) + n(r.keyEvents));
  }
  const keyEventBreakdown = KEY_EVENTS
    .map((e) => ({ id: e.name, label: e.label, value: pageKeyEvents.get(e.name) || 0 }))
    .sort((a, b) => b.value - a.value);

  const months = new Map(), variants = new Map();
  for (const r of rows(data.dateS)) {
    const se = n(r.sessions), en = n(r.engagedSessions);
    const m = monthKey(r);
    if (m) {
      const mm = months.get(m) || { month: m, sessions: 0, engaged: 0, keyEvents: 0 };
      mm.sessions += se; mm.engaged += en;
      months.set(m, mm);
    }
    // Normalised so "/x?utm=1" and "/x" are one variant, matching how the
    // Windsor-era landing_page dimension behaved.
    const lp = pagePath(r[GA4_LANDING_DIM]);
    const v = variants.get(lp) || { page: lp, sessions: 0 };
    v.sessions += se;
    variants.set(lp, v);
  }
  for (const mm of months.values()) mm.keyEvents = monthKeyEvents.get(mm.month) || 0;

  /** Group a sessions report, folding in key events from its paired report. */
  const group = (sSet, kSet, keyFn, label) => {
    const keys = keyIndex(kSet, keyFn);
    const m = new Map();
    for (const r of rows(sSet)) {
      const k = keyFn(r);
      if (k === null) continue;
      const e = m.get(k) || { [label]: k, sessions: 0, engaged: 0, keyEvents: 0 };
      e.sessions += n(r.sessions); e.engaged += n(r.engagedSessions);
      m.set(k, e);
    }
    for (const e of m.values()) e.keyEvents = keys.get(e[label]) || 0;
    return [...m.values()];
  };

  const srcKey = (r) => `${ga4Val(r.sessionManualSource) || "(direct)"} / ${ga4Val(r.sessionManualMedium) || "(none)"}`;
  const cmpKey = (r) => ga4Val(r.sessionManualCampaignName) || null;

  const sources = group(data.srcS, data.srcK, srcKey, "source");
  const campaigns = group(data.cmpS, data.cmpK, cmpKey, "campaign");

  const rate = (a, b) => (b > 0 ? a / b : null);
  const shape = (o) => ({ ...o,
    engagementRate: rate(o.engaged, o.sessions),
    keyEventRate: rate(o.keyEvents, o.sessions) });
  const change = (a, b) => (b > 0 ? (a - b) / b : null);

  /**
   * Destinations, keyed by the page landed on. Two exclusions matter:
   *   - the target page itself, which appears when someone reloads or clicks a
   *     link back to the same page, and would otherwise top its own list;
   *   - referrers that merely CONTAIN the path but are not it or beneath it,
   *     since CONTAINS is a coarse server-side filter and a sibling path can
   *     satisfy it.
   */
  const nextMap = new Map();
  let onwardTotal = 0, selfViews = 0, rejectedRefViews = 0;
  for (const r of (data.nextPages || [])) {
    const ref = pagePath(r.pageReferrer);
    if (!(ref === path || ref.startsWith(path + "/"))) {
      /**
       * Counted, not just skipped. `CONTAINS` is coarse: a sibling path and an
       * external URL quoting this path both satisfy it. Dropping them silently
       * meant the guard could be deleted with no assertion noticing — the
       * rejected volume is the only observable proof it is doing work.
       */
      rejectedRefViews += n(r.screenPageViews);
      continue;
    }
    const dest = pagePath(r.pagePath);
    if (!dest) continue;
    const v = n(r.screenPageViews);
    if (dest === ref) { selfViews += v; continue; }
    nextMap.set(dest, (nextMap.get(dest) || 0) + v);
    onwardTotal += v;
  }
  const nextPages = [...nextMap.entries()]
    .map(([p2, views]) => ({ path: p2, views,
      share: onwardTotal ? views / onwardTotal : null }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);

  return {
    path, url,
    windows: cw,
    nextPages: { rows: nextPages, onwardTotal, selfViews, rejectedRefViews,
      available: data.nextPages !== null,
      destinationCount: nextMap.size },
    totals: shape({ ...now,
      pages: variants.size,
      sources: sources.length,
      campaigns: campaigns.length }),
    compare: {
      yoy: yoy && { ...yoy, sessions: yoy.sessions, change: change(now.sessions, yoy.sessions),
                    keyEventChange: change(now.keyEvents, yoy.keyEvents) },
      prev: prev && { ...prev, change: change(now.sessions, prev.sessions),
                      keyEventChange: change(now.keyEvents, prev.keyEvents) },
    },
    monthly: [...months.values()].map(shape).sort((a, b) => (a.month < b.month ? -1 : 1)),
    sources: sources.map(shape).sort((a, b) => b.sessions - a.sessions).slice(0, 15),
    campaigns: campaigns.map(shape).sort((a, b) => b.sessions - a.sessions).slice(0, 15),
    daily,
    keyEventBreakdown,
    variants: [...variants.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 12),
    empty: now.sessions === 0,
  };
}

app.get("/api/page", requireTab("pages"), async (req, res) => {
  const { from, to, url } = req.query;
  if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    const out = await withCache(`page:${pagePath(url)}:${from}:${to}`, req.query.refresh === "1",
      () => buildPage(url, from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
  } catch (err) {
    logJson("ERROR", "page_failed", { error: String(err.message || err) });
    res.status(err.status || 500).json({ error: err.message || "Page analysis failed" });
  }
});

app.get("/api/me", async (req, res) => {
  const email = callerEmail(req);
  const admin = isAdmin(email);
  const allowed = await tabsFor(email);
  const users = admin ? await readAccess() : null;
  res.json({
    email: email || null,
    isAdmin: admin,
    tabs: allowed,
    allTabs: TABS,
    configured: email ? (admin || (users || await readAccess()).some((u) => String(u.email||"").toLowerCase() === email)) : false,
    identitySource: req.header("X-Goog-Authenticated-User-Email") ? "iap" : (DEV_USER ? "dev" : "none"),
    persistence: ACCESS_BUCKET ? "gcs" : "memory-only",
  });
});

app.get("/api/users", requireAdmin, async (_req, res) => {
  const users = await readAccess();
  res.json({
    users, admins: ADMIN_EMAILS, allTabs: TABS, defaultTabs: DEFAULT_TABS,
    persistence: ACCESS_BUCKET ? "gcs" : "memory-only",
  });
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const email = String(req.body && req.body.email || "").trim().toLowerCase();
  const tabs = Array.isArray(req.body && req.body.tabs) ? req.body.tabs.filter((t) => TAB_IDS.includes(t)) : [];
  const note = String(req.body && req.body.note || "").slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "A valid email is required" });
  const users = (await readAccess()).slice();
  const i = users.findIndex((u) => String(u.email || "").toLowerCase() === email);
  const rec = { email, tabs, note, updatedAt: new Date().toISOString(), updatedBy: callerEmail(req) };
  if (i === -1) users.push(rec); else users[i] = { ...users[i], ...rec };
  const { persisted } = await writeAccess(users);
  logJson("INFO", "access_updated", { target: email, tabs, by: rec.updatedBy, persisted });
  res.json({ ok: true, persisted, users });
});

app.delete("/api/users", requireAdmin, async (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });
  if (isAdmin(email)) return res.status(400).json({ error: "Permanent admins are set by deployment config and can't be removed here." });
  const users = (await readAccess()).filter((u) => String(u.email || "").toLowerCase() !== email);
  const { persisted } = await writeAccess(users);
  logJson("INFO", "access_removed", { target: email, by: callerEmail(req), persisted });
  res.json({ ok: true, persisted, users });
});

app.get("/api/version", (_req, res) => res.json({
  version: VERSION, ga4Property: GA4_ACCOUNT,
  // Whether the four-hospital landing-page filter is applied. The client needs
  // it to label its scope pill honestly: with the filter off, every GA4 figure
  // is the whole 27-branch property and must not read as BHQ.
  branchFilter: BRANCH_FILTER_OFF ? "off" : "on",
  cacheTtlSec: CACHE_TTL_MS / 1000, cacheEntries: cache.size,
  modelArmor: MA_ENABLED, locales: LOCALES,
  accessPersistence: ACCESS_BUCKET ? "gcs" : "memory-only",
}));

/**
 * Sheets access self-check. Reports exactly what failed and what to do about it,
 * so a permissions problem is one request away from a diagnosis instead of
 * showing up as mysteriously empty campaign names.
 */
// Returns spreadsheet IDs and the first row of each sheet, which is more than a
// tab-restricted viewer should see. Diagnostics are an admin tool.
app.get("/api/sheets-check", requireAdmin, async (_req, res) => {
  const out = { scope: SHEETS_SCOPE, utmSheet: SHEET_UTM, planSheet: SHEET_PLAN, steps: [] };
  try {
    await sheetsToken();
    out.steps.push({ step: "obtain access token", ok: true });
  } catch (e) {
    out.steps.push({ step: "obtain access token", ok: false, error: e.message,
      fix: "Cloud Run couldn't mint a Sheets-scoped token. Confirm the service is running as a service account and that the Google Sheets API is enabled in this project." });
    return res.status(500).json(out);
  }
  for (const [label, id, range] of [["UTM Builder 2026", SHEET_UTM, "Jul!L1:M5"], ["Content Plan 2026", SHEET_PLAN, "Jul!A1:H3"]]) {
    try {
      const vr = await sheetBatchGet(id, [range]);
      const rows = (vr[0] && vr[0].values) || [];
      out.steps.push({ step: `read ${label}`, ok: true, sampleRows: rows.length, firstRow: rows[0] || null });
    } catch (e) {
      out.steps.push({ step: `read ${label}`, ok: false, error: e.message,
        fix: e.message.includes("403")
          ? `Share the sheet with the Cloud Run service account (Viewer). If your Workspace blocks external sharing, an admin must allowlist that address.`
          : e.message.includes("404")
            ? `Spreadsheet not found — check the ID, and that a tab named "Jul" exists.`
            : "See the error text above." });
    }
  }
  try {
    const ctx = await loadSheetContext(true);
    out.parsed = {
      utmCodesWithLinks: ctx.links.size,
      campaignTopics: ctx.topics.size,
      detectedCodeColumn: ctx.codeCol === null ? null : String.fromCharCode(65 + ctx.codeCol),
      errors: ctx.errors,
    };
  } catch (e) {
    out.parsed = { error: e.message };
  }
  const ok = out.steps.every((s) => s.ok);
  res.status(ok ? 200 : 500).json(out);
});

app.get("/healthz", (_req, res) => res.send("ok"));

// HTML must not be browser-cached, or a deploy leaves stale pages behind.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.set("Cache-Control", "no-cache, must-revalidate");
  } else if (req.path.startsWith("/vendor/")) {
    res.set("Cache-Control", "public, max-age=604800, immutable");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`BHQ War Room v${VERSION} listening on :${PORT}`);
  gcpProjectId().then((id) => console.log(`[init] GCP project: ${id}`)).catch(() => {});
});
