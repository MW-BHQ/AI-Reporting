/**
 * Cross-Channel Control Room — v3
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

// ---------------------------------------------------------------- utilities

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
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
function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS, storedAt: Date.now() });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}
async function withCache(key, refresh, producer) {
  if (!refresh) {
    const hit = cacheGet(key);
    if (hit) return { value: hit.value, cached: true, ageSec: Math.round((Date.now() - hit.storedAt) / 1000) };
  }
  const value = await producer();
  cacheSet(key, value);
  return { value, cached: false, ageSec: 0 };
}

// ------------------------------------------------------------------ windsor

async function windsor(connector, fields, from, to, { accounts, filters } = {}) {
  const params = new URLSearchParams();
  params.set("api_key", WINDSOR_API_KEY);
  params.set("fields", fields.join(","));
  params.set("date_from", from);
  params.set("date_to", to);
  if (accounts) params.set("accounts", Array.isArray(accounts) ? accounts.join(",") : accounts);
  if (filters) params.set("filters", JSON.stringify(filters));

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
    line: windsor("line", ["date", "message__broadcast", "message__targeting", "followers__followers"], from, to),
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
      return n(sumOrNull(data.line, "message__broadcast"))
        + n(sumOrNull(data.line, "message__targeting"))
        + n(sumOrNull(data.line, "message__api_push"));
    })(),
  };

  const lineOpens = sumOrNull(data.lineEvents, "message_unique_impression");
  const lineBasis = lineOpens ? "unique opens"
    : (data.line !== null ? "messages sent · opens not reported by connector" : "unavailable");
  const lineFollowers = data.line === null ? null : Math.max(0, ...data.line.map((r) => n(r.followers__followers)));

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
    { channel: "LINE", impressions: impressions.line, note: lineBasis, sub: lineFollowers ? `${lineFollowers.toLocaleString()} followers` : null },
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

app.get("/api/overview", async (req, res) => {
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
  const rows = await windsor("googleanalytics4",
    ["session_manual_campaign_name", "sessions"], from, to, { accounts: [GA4_ACCOUNT] });
  const list = rows
    .map((r) => ({ code: r.session_manual_campaign_name, visits: n(r.sessions) }))
    .filter((c) => c.code && !NON_CAMPAIGN.has(norm(c.code)))
    .map((c) => ({ ...c, untagged: isPlatformId(c.code) }))
    .sort((a, b) => b.visits - a.visits);
  return {
    range: { from, to },
    campaigns: list.slice(0, 400),
    total: list.length,
    untaggedCount: list.filter((c) => c.untagged).length,
    syncedAt: new Date().toISOString(),
  };
}

app.get("/api/campaigns", async (req, res) => {
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
  };
  // One job per ad platform; unconnected ones fail harmlessly into null.
  for (const p of AD_PLATFORMS) {
    jobs[`ad_${p.id}`] = windsor(p.id, [p.campaignKey, ...AD_METRIC_FIELDS], from, to);
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
      spend: null, spendEstimated: false, costPerVisit: null, costPerContact: null,
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
        spend: null, spendEstimated: false, costPerVisit: null, costPerContact: null,
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
      if (!agg.has(name)) agg.set(name, { name, platform: p.label, impressions: 0, clicks: 0, spend: 0 });
      const a = agg.get(name);
      a.impressions += n(r.impressions);
      a.clicks += n(r.clicks);
      a.spend += n(r.spend);
    }
    const list = [...agg.values()].sort((a, b) => b.impressions - a.impressions);
    adCampaigns.push(...list);
    if (list.length) anyAdMatch = true;
    byPlatform.push({
      platform: p.label, connected: true, matched: list.length,
      impressions: list.reduce((a, c) => a + c.impressions, 0),
      clicks: list.reduce((a, c) => a + c.clicks, 0),
      spend: list.reduce((a, c) => a + c.spend, 0),
    });
  }
  adCampaigns.sort((a, b) => b.impressions - a.impressions);

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
  for (const p of byPlatform) {
    if (!p.connected || !p.spend) continue;
    const hints = PLATFORM_SOURCE_HINTS[p.platform] || [];
    const owned = variants.filter((v) =>
      hints.some((re) => re.test(v.source)) && (PAID_MEDIUM_RE.test(v.medium) || PAID_MEDIUM_RE.test(v.source))
    );
    if (!owned.length) continue;
    const totalVisits = owned.reduce((a, v) => a + v.visits, 0);
    for (const v of owned) {
      const share = owned.length === 1 ? 1 : (totalVisits ? v.visits / totalVisits : 1 / owned.length);
      v.spend = n(v.spend) + p.spend * share;
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

  const totals = {
    impressions: anyAdMatch ? byPlatform.reduce((a, p) => a + n(p.impressions), 0) : null,
    visits: variants.reduce((a, v) => a + v.visits, 0),
    engagement: variants.reduce((a, v) => a + v.engagement, 0),
    keyEvents: variants.reduce((a, v) => a + v.keyEvents, 0),
    contacts: variants.reduce((a, v) => a + v.contacts, 0),
    revenue: variants.reduce((a, v) => a + v.revenue, 0),
    purchases: variants.reduce((a, v) => a + v.purchases, 0),
    spend: byPlatform.some((p) => p.connected && p.spend) ? platformSpend : null,
    clicks: anyAdMatch ? byPlatform.reduce((a, p) => a + n(p.clicks), 0) : null,
  };
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
  if (emptyResult) {
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
    byPlatform, adCampaigns, landingPages,
    unattributedSpend,
    emptyResult, dateHint, launchDate: launch,
    adImpressionsMatched: anyAdMatch,
    notConnected, matchedNone,
    notes,
    errors,
    syncedAt: new Date().toISOString(),
  };
}

app.get("/api/campaign", async (req, res) => {
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

app.post("/api/topic", async (req, res) => {
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

app.get("/api/version", (_req, res) => res.json({
  version: VERSION, ga4Property: GA4_ACCOUNT,
  cacheTtlSec: CACHE_TTL_MS / 1000, cacheEntries: cache.size,
  modelArmor: MA_ENABLED, locales: LOCALES,
}));

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
  console.log(`Control Room v${VERSION} listening on :${PORT}`);
  gcpProjectId().then((id) => console.log(`[init] GCP project: ${id}`)).catch(() => {});
});
