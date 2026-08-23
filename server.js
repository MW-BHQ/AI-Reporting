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
async function sheetBatchGet(spreadsheetId, ranges) {
  const token = await sheetsToken();
  const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${qs}&majorDimension=ROWS`;
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

async function ga4RunReport({ dimensions, metrics, from, to, dimensionFilter, limit = 100000 }) {
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
  const token = await ga4Token();
  const body = {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit,
    returnPropertyQuota: false,
  };
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;

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
async function gscQuery(dimensions, from, to, { rowLimit = 25000, noBranchFilter = false } = {}) {
  const token = await gscToken();
  const body = {
    startDate: from, endDate: to,
    dimensions,
    rowLimit,
    dataState: "final",
  };
  if (!noBranchFilter && !BRANCH_FILTER_OFF) {
    body.dimensionFilterGroups = [{
      groupType: "and",
      filters: [{ dimension: "page", operator: "includingRegex", expression: GSC_BRANCH_REGEX }],
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
  if (rows.length >= rowLimit) {
    logJson("WARNING", "gsc_rows_truncated", { rowLimit, dimensions, from, to });
  }
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
  { id: "ecom",      label: "E-commerce" },
  { id: "ecomcentre",label: "E-commerce · Centres" },
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
  de: "German", my: "Burmese", vn: "Vietnamese", km: "Khmer", id: "Indonesian",
};

/**
 * Language from a URL locale segment. This is the only reliable method:
 * EN/DE/VN/ID share Latin script and cannot be separated by characters alone.
 */
function localeFromPath(url) {
  if (!url) return null;
  const m = String(url).match(/\/(th|en|zh|ja|ar|de|my|vn|vi|km|id)(?:\/|$|\?)/i);
  if (!m) return null;
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

async function windsor(connector, fields, from, to, { accounts, filters, options } = {}) {
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
  if (rows === null) return null;
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
      metrics: ["keyEvents"],
      from, to,
      // MUST be branch-filtered too. Without this, session metrics cover the
      // four branches and key events cover all 27 — every rate on the dashboard
      // silently inflates, and the merge hides it because unmatched keys are
      // never looked up.
      dimensionFilter: withBranch({ filter: { fieldName: "eventName", inListFilter: { values: KEY_EVENT_NAMES } } }, segments),
    });
    const out = { total: 0, byKey: new Map(), byName: new Map(), byKeyEvent: new Map(), rows: [], failed: false };
    for (const r of raw) {
      const v = n(r.keyEvents);
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
    ga4: ga4Compat(GA4_FUNNEL_DIMS, ["sessions", "engaged_sessions"], from, to),
    keyEvents: ga4KeyEvents(GA4_FUNNEL_DIMS, from, to),
    ga4Ecom: ga4Compat(GA4_FUNNEL_DIMS, GA4_ECOM_METRICS, from, to),
    // Item-scoped metrics cannot be combined with the session-scoped landing
    // page filter — GA4 rejects the pair — so this stays group-wide and is
    // labelled as such in the UI rather than silently implying branch scope.
    ga4Items: ga4Compat(["item_name"],
      ["items_viewed", "items_added_to_cart", "items_purchased", "item_revenue"],
      from, to, { noBranchFilter: true }),
    ga4Month: ga4Compat(["date"], ["purchase_revenue", "ecommerce_purchases"], monthFrom, monthTo),
    meta: windsor("facebook", ["date", "account_name", "spend", "impressions", "clicks",
      // Ad-ATTRIBUTED conversations only. There is no organic Messenger or IG
      // DM metric on any connector Windsor offers (facebook_messenger does not
      // exist; facebook_organic has no messaging fields), so this undercounts
      // real message volume and the UI must say so rather than imply totality.
      "actions_onsite_conversion_total_messaging_connection"], from, to),
    gads: windsor("google_ads", ["date", "account_name", "spend", "impressions", "clicks"], from, to),
    gsc: gscQuery(["date"], from, to),
    gmb: windsor("google_my_business",
      ["date", "location_title", "impressions", "call_clicks", "website_clicks", "direction_requests",
        "business_bookings"], from, to),
    fbOrganic: windsor("facebook_organic", ["date", "page_impressions", "post_engagements"], from, to),
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

  const impressions = {
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
    fbPage: sumOrNull(data.fbOrganic, "page_impressions"),
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
  const offsiteActions = {
    gbpCalls: gmbAction("call_clicks"),
    gbpDirections: gmbAction("direction_requests"),
    gbpBookings: gmbAction("business_bookings"),
    gbpWebsiteClicks: gmbAction("website_clicks"),
    metaMessages: sumOrNull(data.meta, "actions_onsite_conversion_total_messaging_connection"),
  };
  offsiteActions.total = ["gbpCalls", "gbpDirections", "gbpBookings", "metaMessages"]
    .every((k) => offsiteActions[k] === null) ? null
    : ["gbpCalls", "gbpDirections", "gbpBookings", "metaMessages"]
      .reduce((a, k) => a + n(offsiteActions[k]), 0);

  const totals = {
    impressions: (() => {
      const vals = [impressions.meta, impressions.gads, impressions.gsc, impressions.tiktok];
      return vals.every((v) => v === null) ? null : vals.reduce((a, v) => a + n(v), 0);
    })(),
    clicks: (() => {
      const vals = [adClicksByKey.meta, adClicksByKey.gads, adClicksByKey.gsc];
      return vals.every((v) => v === null) ? null : vals.reduce((a, v) => a + n(v), 0);
    })(),
    visits: ga4Available ? funnel.reduce((a, c) => a + c.visits, 0) : null,
    engagement: ga4Available ? funnel.reduce((a, c) => a + c.engagement, 0) : null,
    keyEvents: ga4Available ? funnel.reduce((a, c) => a + c.keyEvents, 0) : null,
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
      const name = r.item_name;
      if (!name || name === "(not set)") continue;
      if (!m.has(name)) m.set(name, { name, views: 0, addToCarts: 0, purchases: 0, revenue: 0 });
      const p = m.get(name);
      p.views += n(r.items_viewed);
      p.addToCarts += n(r.items_added_to_cart);
      p.purchases += n(r.items_purchased);
      p.revenue += n(r.item_revenue);
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue || b.views - a.views).slice(0, 10);
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
  const bothNull = (a, b) => a === null && b === null;
  const addNullable = (a, b) => (bothNull(a, b) ? null : n(a) + n(b));
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
    jobs[`s_${b.key}`] = ga4Compat(["session_default_channel_group"], ["sessions", "engaged_sessions"],
      from, to, { segments: [b.segment] });
    jobs[`k_${b.key}`] = ga4KeyEvents(["session_default_channel_group"], from, to, [b.segment]);
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
  jobs.gbp = windsor("google_my_business",
    ["location_title", "impressions", "call_clicks", "website_clicks", "direction_requests"], from, to);
  jobs.gbpReviews = windsor("google_my_business",
    ["review_create_time", "location_title", "review_star_rating"], from, to);
  jobs.gscLang = gscQuery(["page"], from, to);
  jobs.langSessions = ga4Compat(["landing_page"], ["sessions"], from, to);
  jobs.langKeyEvents = ga4KeyEvents(["landing_page"], from, to);
  const { data } = await runJobs(jobs);

  for (const b of BRANDS) {
    const rows = data[`s_${b.key}`] || [];
    const ke = data[`k_${b.key}`] || { total: 0, byName: new Map(), rows: [] };
    const chan = rows.map((r) => ({
      channel: r.session_default_channel_group || "(unassigned)",
      sessions: n(r.sessions), engaged: n(r.engaged_sessions),
    })).sort((x, y) => y.sessions - x.sessions);
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
  for (const r of (data.gscLang || [])) {
    const l = localeFromPath(r.page); if (!l || !byLang[l]) continue;
    byLang[l].impressions += n(r.impressions); byLang[l].clicks += n(r.clicks);
  }
  for (const r of (data.langSessions || [])) {
    const l = localeFromPath(r.landing_page); if (!l || !byLang[l]) continue;
    byLang[l].sessions += n(r.sessions);
  }
  const keLang = data.langKeyEvents;
  if (keLang && keLang.rows) {
    for (const r of keLang.rows) {
      const l = localeFromPath(r.key); if (!l || !byLang[l]) continue;
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

  // Reviews by star, per brand, plus the month's average.
  const rvBlank = () => ({ count: 0, stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, avg: null });
  const rvByBrand = {}; for (const b of BRANDS) rvByBrand[b.key] = rvBlank();
  const rvAll = rvBlank();
  for (const r of (data.gbpReviews || [])) {
    const st = starOf(r.review_star_rating); if (!st) continue;
    const owner = brandForGbpListing(r.location_title);
    const targets = [rvAll];
    if (owner && owner !== "SHARED") targets.push(rvByBrand[owner]);
    for (const t of targets) { t.count += 1; t.stars[st] += 1; }
  }
  const finishRv = (t) => {
    const tot = Object.entries(t.stars).reduce((a, [k, v]) => a + Number(k) * v, 0);
    t.avg = t.count ? +(tot / t.count).toFixed(2) : null;
    return t;
  };
  finishRv(rvAll); for (const b of BRANDS) finishRv(rvByBrand[b.key]);

  const gbp = {
    byBrand: BRANDS.map((b) => ({ key: b.key, label: b.label, ...gbpByBrand[b.key], reviews: rvByBrand[b.key] })),
    shared: gbpShared.listings.length ? gbpShared : null,
    unlisted: gbpUnlisted.listings.length ? gbpUnlisted : null,
    reviewsAll: rvAll,
    available: data.gbp !== null,
  };

  return {
    range: { from, to },
    bhq,
    gbp,
    languages,
    languagesAvailable: data.gscLang !== null || data.langSessions !== null,
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
  try {
    const out = await withCache(`report:${from}:${to}`, req.query.refresh === "1", () => buildReport(from, to));
    res.json({ ...out.value, cached: out.cached, cacheAgeSec: out.ageSec });
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
  const EMPTY_KE = { total: 0, byKey: new Map(), byName: new Map(), byKeyEvent: new Map(), rows: [], failed: true };
  const windowKe = { m3: data.keM3 || EMPTY_KE, m6: data.keM6 || EMPTY_KE, m12: data.keM12 || EMPTY_KE };
  const keMonthly = data.keMonthly || EMPTY_KE;

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
      listPrice: 0, discounted: 0, byChannel: {}, packages: new Map(),
    };
    c.revenue += r.price;
    c.coupons++;
    c.orders.add(r.orderId);
    if (r.couponStatus === "ใช้งานแล้ว") c.redeemed++;
    // Discount depth only counts rows where the master knows a list price.
    if (r.fullPrice > 0) { c.listPrice += r.fullPrice; c.discounted += r.price; }
    c.byChannel[r.channel] = (c.byChannel[r.channel] || 0) + r.price;
    const p = c.packages.get(r.pkg) || { name: r.pkg, revenue: 0, units: 0 };
    p.revenue += r.price; p.units++;
    c.packages.set(r.pkg, p);
    centres.set(key, c);
  }

  const channels = [...channelSet].sort();
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
async function buildMonthly(month, scope) {
  const all = await ecomRows();
  const rows = scope === "all" ? all : all.filter((r) => r.type === "Online");
  const y = +month.slice(0, 4), m = +month.slice(5, 7);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const win = {
    month: { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` },
    ytd: { from: `${y}-01-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` },
  };
  const prevY = y - 1;
  const prevLast = new Date(Date.UTC(prevY, m, 0)).getUTCDate();
  const pm = `${prevY}-${String(m).padStart(2, "0")}`;
  win.monthPrev = { from: `${pm}-01`, to: `${pm}-${String(prevLast).padStart(2, "0")}` };
  win.ytdPrev = { from: `${prevY}-01-01`, to: `${pm}-${String(prevLast).padStart(2, "0")}` };

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

  return {
    month, monthLabel: new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
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
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : to.slice(0, 7);
  try {
    const scope = req.query.scope === "all" ? "all" : "online";
    const out = await withCache(`ecommonthly:${scope}:${month}`, req.query.refresh === "1",
      () => buildMonthly(month, scope));
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

  const cw = comparisonWindows(from, to);
  const { data, errors } = await runJobs({
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

  return {
    path, url,
    windows: cw,
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
