/**
 * BHQ Signal Room (Cross-Channel Control Room) — v3
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
const TABS = [
  { id: "overview",  label: "Overview" },
  { id: "campaigns", label: "Campaigns" },
  { id: "gbp",       label: "Google Profile" },
  { id: "benchmark", label: "Benchmarks" },
  { id: "audit",     label: "Tagging audit" },
  { id: "topics",    label: "Topic Explorer" },
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

/** Parallel jobs. A failure yields null (not []) so it reads as "unavailable". */
async function runJobs(jobs) {
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map((k) => jobs[k]));
  const data = {}, errors = {};
  settled.forEach((s, i) => {
    const k = names[i];
    if (s.status === "fulfilled") data[k] = s.value;
    else { data[k] = null; errors[k] = String((s.reason && s.reason.message) || s.reason); }
  });
  return { data, errors };
}

function sumOrNull(rows, field) {
  if (rows === null) return null;
  return rows.reduce((a, r) => a + n(r[field]), 0);
}

// --------------------------------------------------------- GA4 field config

const KEY_EVENT_FIELDS = [
  "conversions_add_to_cart",
  "conversions_appointments",
  "conversions_contact_us",
  "conversions_find_doctors",
  "conversions_view_cart",
  "conversions_view_item",
  "conversions_purchase",
];
const KEY_EVENT_LABELS = {
  conversions_add_to_cart: "Add to cart",
  conversions_appointments: "Appointments",
  conversions_contact_us: "Contact us",
  conversions_find_doctors: "Find doctors",
  conversions_view_cart: "View cart",
  conversions_view_item: "View item",
  conversions_purchase: "Purchase",
};
const sumKeyEvents = (r) => KEY_EVENT_FIELDS.reduce((a, f) => a + n(r[f]), 0);

/**
 * GA4's Data API rejects any request asking for more than 10 metrics.
 * This helper makes that limit structural rather than a comment someone can
 * miss: build every GA4 field list through it and an over-limit request fails
 * loudly here at build time instead of as an opaque HTTP 400 from Windsor.
 */
const GA4_METRIC_LIMIT = 10;
function ga4Fields(dimensions, metrics) {
  if (metrics.length > GA4_METRIC_LIMIT) {
    throw new Error(`GA4 request would ask for ${metrics.length} metrics; the API allows ${GA4_METRIC_LIMIT}. Split it into two calls.`);
  }
  return [...dimensions, ...metrics];
}

// Which platform's impressions belong to which GA4 channel group. Units differ
// across platforms; the UI states this rather than implying one true total.
const IMPRESSION_SOURCE_BY_CHANNEL = {
  "paid social": "meta",
  "organic search": "gsc",
  "organic social": "organicSocial",
};

/**
 * Ad platforms queried for campaign-level impressions, clicks and spend.
 * ONLY platforms actually authorised in Windsor belong here — querying
 * unconnected ones just burns requests and litters the UI with "not connected"
 * rows. To add one later (Google Ads, TikTok Ads, LINE Ads) authorise it in
 * Windsor and add a single line below; nothing else needs to change.
 */
const AD_PLATFORMS = [
  { id: "facebook", label: "Meta Ads", campaignKey: "campaign" },
];
const AD_METRIC_FIELDS = ["impressions", "clicks", "spend"];

// utm_source patterns that indicate traffic came from a given ad platform, used
// to attribute spend to a utm variant. Extend alongside AD_PLATFORMS.
const PLATFORM_SOURCE_HINTS = {
  "Meta Ads": [/facebook/i, /meta/i, /(^|[^a-z])fb([^a-z]|$)/i, /instagram/i, /(^|[^a-z])ig([^a-z]|$)/i],
};
const PAID_MEDIUM_RE = /(cpc|ppc|paid|display|video|banner)/i;

// ------------------------------------------------------------- /api/overview

async function buildOverview(from, to) {
  // GA4 caps a request at 10 metrics, so the pull is split in two and merged.
  // Funnel call: 9 metrics (sessions, page views, 7 key events).
  const ga4FunnelFields = ga4Fields(
    ["date", "session_default_channel_group"],
    ["sessions", "engaged_sessions", ...KEY_EVENT_FIELDS]
  );
  // Commerce call: 5 metrics.
  const ga4EcomFields = ga4Fields(
    ["date", "session_default_channel_group"],
    ["items_viewed", "add_to_carts", "ecommerce_purchases", "purchase_revenue", "transactions"]
  );

  // Month-to-date pulled separately so the forecast is stable no matter which
  // range is being viewed.
  const today = new Date();
  const monthFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const monthTo = today.toISOString().slice(0, 10);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysElapsed = today.getDate();

  const { data, errors } = await runJobs({
    ga4: windsor("googleanalytics4", ga4FunnelFields, from, to, { accounts: [GA4_ACCOUNT] }),
    ga4Ecom: windsor("googleanalytics4", ga4EcomFields, from, to, { accounts: [GA4_ACCOUNT] }),
    ga4Items: windsor("googleanalytics4",
      ga4Fields(["item_name"], ["item_view_events", "items_added_to_cart", "items_purchased", "item_revenue"]),
      from, to, { accounts: [GA4_ACCOUNT] }),
    ga4Month: windsor("googleanalytics4",
      ga4Fields(["date"], ["purchase_revenue", "ecommerce_purchases"]),
      monthFrom, monthTo, { accounts: [GA4_ACCOUNT] }),
    meta: windsor("facebook", ["date", "account_name", "spend", "impressions", "clicks"], from, to),
    gsc: windsor("searchconsole", ["date", "clicks", "impressions", "position"], from, to),
    gmb: windsor("google_my_business",
      ["date", "location_title", "impressions", "call_clicks", "website_clicks", "direction_requests"], from, to),
    fbOrganic: windsor("facebook_organic", ["date", "page_impressions", "post_engagements"], from, to),
    ttOrganic: windsor("tiktok_organic", ["date", "video_views", "likes", "comments", "shares"], from, to),
    line: windsor("line", ["date", "message__broadcast", "message__targeting", "message__api_broadcast",
      "message__api_narrowcast", "message__api_multicast", "message__api_push",
      "followers__followers", "followers__targeted_reaches"], from, to),
    // Separate call: the message-event table carries actual opens/clicks, which
    // is a real impression rather than a send count. LINE returns null for any
    // value under 20, so small sends legitimately come back empty.
    lineEvents: windsor("line", ["date", "message_delivered", "message_unique_impression", "message_unique_click"], from, to),
  });

  const ga4 = data.ga4;
  const ga4Available = ga4 !== null;
  const ecom = data.ga4Ecom;

  const impressions = {
    meta: sumOrNull(data.meta, "impressions"),
    gsc: sumOrNull(data.gsc, "impressions"),
    gmb: sumOrNull(data.gmb, "impressions"),
    organicSocial: (data.fbOrganic === null && data.ttOrganic === null) ? null
      : n(sumOrNull(data.fbOrganic, "page_impressions")) + n(sumOrNull(data.ttOrganic, "video_views")),
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
      c.keyEvents += sumKeyEvents(r);
    }
  }
  // Ad clicks belong to the same channels that have ad impressions.
  const adClicksByKey = { meta: sumOrNull(data.meta, "clicks"), gsc: sumOrNull(data.gsc, "clicks"), organicSocial: null };
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
  const reachOnly = [
    { channel: "Google Business Profile", impressions: impressions.gmb, note: "profile views" },
    { channel: "LINE", impressions: impressions.line, note: lineBasis,
      sub: lineFollowers ? `${lineFollowers.toLocaleString()} followers${lineReachable ? ` · ${lineReachable.toLocaleString()} targetable` : ""}` : null },
  ];

  const totals = {
    impressions: (() => {
      const vals = [impressions.meta, impressions.gsc, impressions.organicSocial];
      return vals.every((v) => v === null) ? null : vals.reduce((a, v) => a + n(v), 0);
    })(),
    clicks: (() => {
      const vals = [adClicksByKey.meta, adClicksByKey.gsc];
      return vals.every((v) => v === null) ? null : vals.reduce((a, v) => a + n(v), 0);
    })(),
    visits: ga4Available ? funnel.reduce((a, c) => a + c.visits, 0) : null,
    engagement: ga4Available ? funnel.reduce((a, c) => a + c.engagement, 0) : null,
    keyEvents: ga4Available ? funnel.reduce((a, c) => a + c.keyEvents, 0) : null,
  };

  const keyEventBreakdown = ga4Available
    ? KEY_EVENT_FIELDS.map((f) => ({ id: f, label: KEY_EVENT_LABELS[f], value: ga4.reduce((a, r) => a + n(r[f]), 0) }))
        .sort((a, b) => b.value - a.value)
    : null;

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
      p.views += n(r.item_view_events);
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
    t.keyEvents += sumKeyEvents(r);
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

  const paid = {
    spend: sumOrNull(data.meta, "spend"),
    impressions: impressions.meta,
    clicks: sumOrNull(data.meta, "clicks"),
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
    totals, funnel, reachOnly, keyEventBreakdown,
    ecommerce, forecast, topProducts,
    paid, topAccounts, search, trend,
    unavailable: Object.keys(errors),
    errors,
    ga4Property: GA4_ACCOUNT,
    syncedAt: new Date().toISOString(),
  };
}

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
    windsor("googleanalytics4", ["session_manual_campaign_name", "sessions"], from, to, { accounts: [GA4_ACCOUNT] }),
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
  const ga4MainFields = ga4Fields(
    ["session_manual_campaign_name", "session_manual_source", "session_manual_medium"],
    ["sessions", "engaged_sessions", ...KEY_EVENT_FIELDS]
  );
  const ga4RevFields = ga4Fields(
    ["session_manual_campaign_name", "session_manual_source", "session_manual_medium"],
    ["purchase_revenue", "ecommerce_purchases"]
  );
  const ga4DailyFields = ga4Fields(
    ["date", "session_manual_campaign_name"],
    ["sessions", ...KEY_EVENT_FIELDS]
  );

  const jobs = {
    ga4: windsor("googleanalytics4", ga4MainFields, from, to, { accounts: [GA4_ACCOUNT] }),
    ga4Rev: windsor("googleanalytics4", ga4RevFields, from, to, { accounts: [GA4_ACCOUNT] }),
    ga4Daily: windsor("googleanalytics4", ga4DailyFields, from, to, { accounts: [GA4_ACCOUNT] }),
    ga4Landing: windsor("googleanalytics4",
      ga4Fields(["session_manual_campaign_name", "landing_page"], ["sessions"]),
      from, to, { accounts: [GA4_ACCOUNT] }),
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
        ["post_id", "post_message", "url", "permalink_url", "post_impressions", "post_clicks", "post_engagements"], pFrom, pTo);
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
    jobs[`ad_${p.id}`] = windsor(p.id, [p.campaignKey, "campaign_objective", ...AD_METRIC_FIELDS,
      "actions_link_click", "actions_landing_page_view",
      "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d"], from, to);
  }
  const { data, errors } = await runJobs(jobs);

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
    v.keyEvents += sumKeyEvents(r);
    v.contacts += n(r.conversions_contact_us);
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
  // Same-day heuristic: the campaign code starts with YYMMDD, and LINE's
  // delivery table does report how many broadcast messages went out per day.
  // A broadcast sent on the campaign's launch date is very likely the campaign
  // broadcast, so surface that day's send volume, clearly labelled as a
  // same-day match rather than a tracked link. Opens/clicks stay unknowable
  // for OA Manager sends (no request IDs).
  let lineSameDay = null;
  const codeDigits = String(code || "").match(/^(\d{2})(\d{2})(\d{2})/);
  if (codeDigits) {
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
        const rows = await windsor("line", ["date", ...flds], codeDate, codeDate);
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

  let lineMessages = null;
  if (lineReqIds.length) {
    try {
      const rows = await windsor("line",
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
      if (!norm(r.session_manual_campaign_name).startsWith(needle)) continue;
      const page = r.landing_page;
      if (!page) continue;
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

  const keyEventBreakdown = KEY_EVENT_FIELDS
    .map((f) => ({ id: f, label: KEY_EVENT_LABELS[f], value: matches.reduce((a, r) => a + n(r[f]), 0) }))
    .sort((a, b) => b.value - a.value);

  let trend = [];
  if (data.ga4Daily !== null) {
    const tm = new Map();
    for (const r of data.ga4Daily) {
      if (!r.date || !norm(r.session_manual_campaign_name).startsWith(needle)) continue;
      if (!tm.has(r.date)) tm.set(r.date, { d: r.date, visits: 0, keyEvents: 0 });
      const t = tm.get(r.date);
      t.visits += n(r.sessions);
      t.keyEvents += sumKeyEvents(r);
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
  "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d", "actions_landing_page_view",
];
const META_CAMPAIGN_FIELDS = [
  "account_name", "campaign", "campaign_objective", "spend", "impressions", "clicks",
  "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d",
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
    ga4m3: windsor("googleanalytics4",
      ga4Fields(["session_manual_campaign_name"], ["sessions", ...KEY_EVENT_FIELDS, "purchase_revenue"]),
      W.m3.from, W.m3.to, { accounts: [GA4_ACCOUNT] }),
    ga4m6: windsor("googleanalytics4",
      ga4Fields(["session_manual_campaign_name"], ["sessions", ...KEY_EVENT_FIELDS, "purchase_revenue"]),
      W.m6.from, W.m6.to, { accounts: [GA4_ACCOUNT] }),
    ga4m12: windsor("googleanalytics4",
      ga4Fields(["session_manual_campaign_name"], ["sessions", ...KEY_EVENT_FIELDS, "purchase_revenue"]),
      W.m12.from, W.m12.to, { accounts: [GA4_ACCOUNT] }),
    ga4Monthly: windsor("googleanalytics4",
      ga4Fields(["date"], ["sessions", ...KEY_EVENT_FIELDS, "purchase_revenue"]),
      from, to, { accounts: [GA4_ACCOUNT] }),
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
    m.visits += n(r.sessions); m.keyEvents += sumKeyEvents(r);
    m.contacts += n(r.conversions_contact_us); m.revenue += n(r.purchase_revenue);
  }

  /** GA4 rows for a window, attributed to an account via campaign code stems. */
  const ga4ForAccount = (rows, stems) => {
    const t = BLANK();
    if (rows === null) return t;
    for (const r of rows) {
      const name = norm(r.session_manual_campaign_name);
      if (!name) continue;
      if (stems && ![...stems].some((st) => name.startsWith(st))) continue;
      t.visits += n(r.sessions); t.keyEvents += sumKeyEvents(r);
      t.contacts += n(r.conversions_contact_us); t.revenue += n(r.purchase_revenue);
    }
    return t;
  };

  const windowRows = { m3: data.ga4m3, m6: data.ga4m6, m12: data.ga4m12 };

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
        const g = ga4ForAccount(windowRows[key], stems);
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
    ga4: windsor("googleanalytics4",
      ga4Fields(["session_manual_campaign_name", "session_manual_source", "session_manual_medium"],
        ["sessions", ...KEY_EVENT_FIELDS]),
      from, to, { accounts: [GA4_ACCOUNT] }),
    meta: windsor("facebook", ["campaign", "account_name", "campaign_objective", "impressions", "clicks", "spend",
      "actions_lead", "actions_onsite_conversion_messaging_conversation_started_7d"], from, to),
  });

  if (data.ga4 === null) {
    const e = new Error(`GA4 unavailable: ${errors.ga4}`);
    e.status = 502; throw e;
  }

  // ---- traffic side ----
  let taggedVisits = 0, taggedKeyEvents = 0;
  const buckets = new Map();
  const codesSeen = new Set();
  for (const r of data.ga4) {
    const visits = n(r.sessions);
    const ke = sumKeyEvents(r);
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
  if (data.meta !== null) {
    const agg = new Map();
    for (const r of data.meta) {
      const name = r.campaign;
      if (!name) continue;
      if (!agg.has(name)) agg.set(name, {
        name, account: r.account_name || "", objective: r.campaign_objective || null,
        goal: goalOf(r.campaign_objective, name),
        impressions: 0, clicks: 0, spend: 0, leads: 0, messages: 0,
      });
      const a = agg.get(name);
      a.impressions += n(r.impressions); a.clicks += n(r.clicks); a.spend += n(r.spend);
      a.leads += n(r.actions_lead);
      a.messages += n(r.actions_onsite_conversion_messaging_conversation_started_7d);
    }
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
        measurableWithoutUtm: def.source === "Meta",
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
    byPage: windsor("searchconsole", ["query", "page", "clicks", "impressions", "position"], from, to),
    byCountry: windsor("searchconsole", ["query", "country", "clicks", "impressions"], from, to),
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
app.get("/api/sheets-check", async (_req, res) => {
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
  console.log(`BHQ Signal Room v${VERSION} listening on :${PORT}`);
  gcpProjectId().then((id) => console.log(`[init] GCP project: ${id}`)).catch(() => {});
});
