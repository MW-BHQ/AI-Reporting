/**
 * Cross-Channel Control Room — backend
 * Serves the static dashboard and exposes GET /api/sync?from=&to=
 * which pulls live data from Windsor.ai's REST API across all connectors,
 * in parallel, and returns one aggregated JSON payload.
 *
 * The Windsor API key is read from the WINDSOR_API_KEY env var and never
 * leaves the server. The browser only ever talks to this service.
 */

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(requestLogger);

const PORT = process.env.PORT || 8080;
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const WINDSOR_BASE = "https://connectors.windsor.ai";

// v.2 — Anthropic (Topic Explorer only; never on the /api/sync hot path)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";

// v.2.1 — GCP-native hardening (all optional; app runs without them)
// Model Armor screens the user-typed topic for prompt injection before it
// reaches Claude. Configure MODEL_ARMOR_LOCATION + MODEL_ARMOR_TEMPLATE to turn on.
const MA_LOCATION = process.env.MODEL_ARMOR_LOCATION;   // e.g. "asia-southeast1"
const MA_TEMPLATE = process.env.MODEL_ARMOR_TEMPLATE;   // template id
const MA_ENABLED = Boolean(MA_LOCATION && MA_TEMPLATE);

if (!WINDSOR_API_KEY) {
  console.warn("[warn] WINDSOR_API_KEY is not set — /api/sync will fail until it is.");
}
if (!ANTHROPIC_API_KEY) {
  console.warn("[warn] ANTHROPIC_API_KEY is not set — /api/topic (v.2) will fail until it is.");
}
console.log(`[init] Model Armor screening: ${MA_ENABLED ? "ON (" + MA_LOCATION + "/" + MA_TEMPLATE + ")" : "off"}`);

// ---- helpers -------------------------------------------------------------

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Call one Windsor connector. Returns an array of row objects.
 * Windsor returns { data: [...] } by default (JSON renderer).
 */
async function windsor(connector, fields, from, to) {
  const url =
    `${WINDSOR_BASE}/${connector}` +
    `?api_key=${encodeURIComponent(WINDSOR_API_KEY)}` +
    `&fields=${encodeURIComponent(fields.join(","))}` +
    `&date_from=${from}&date_to=${to}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${connector} → HTTP ${res.status} ${body.slice(0, 180)}`);
  }
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.data || [];
  return rows;
}

/** Detect the script/language of a search query from its characters. */
function detectLang(q = "") {
  if (/[\u0600-\u06FF]/.test(q)) return "AR";
  if (/[\u3040-\u30FF]/.test(q)) return "JA"; // hiragana/katakana → Japanese
  if (/[\u0E00-\u0E7F]/.test(q)) return "TH";
  if (/[\u1000-\u109F]/.test(q)) return "MY"; // Burmese
  if (/[\u1780-\u17FF]/.test(q)) return "KM"; // Khmer
  if (/[\u4E00-\u9FFF]/.test(q)) return "ZH"; // CJK w/o kana → Chinese
  if (/[A-Za-z]/.test(q)) return "EN";
  return "";
}

/** Sum rows into a { key -> {..metrics} } map using a keyFn and metric list. */
function groupSum(rows, keyFn, metrics) {
  const out = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (key === undefined || key === null || key === "") continue;
    if (!out.has(key)) out.set(key, {});
    const acc = out.get(key);
    for (const m of metrics) acc[m] = (acc[m] || 0) + n(r[m]);
  }
  return out;
}

/** Call the Anthropic Messages API and return the concatenated text output. */
async function anthropic(prompt, { system, maxTokens = 1500 } = {}) {
  const res = await fetch(ANTHROPIC_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Pull a JSON value out of a model response, tolerating prose/fences. */
function extractJson(text) {
  let t = String(text).trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), sa = t.indexOf("[");
  const start = sa !== -1 && (sa < s || s === -1) ? sa : s;
  const openChar = t[start];
  const closeChar = openChar === "[" ? "]" : "}";
  const end = t.lastIndexOf(closeChar);
  if (start === -1 || end === -1) throw new Error("No JSON found in model response");
  return JSON.parse(t.slice(start, end + 1));
}

/** Normalise text for cross-language substring matching. */
const norm = (s) => String(s || "").toLowerCase().trim();

// ---- GCP-native helpers (metadata server; only used on Cloud Run) --------

const META_BASE = "http://metadata.google.internal/computeMetadata/v1";
const META_HDR = { "Metadata-Flavor": "Google" };
let _projectId = null;
let _token = { value: null, exp: 0 };

async function gcpProjectId() {
  if (_projectId) return _projectId;
  const r = await fetch(`${META_BASE}/project/project-id`, { headers: META_HDR });
  _projectId = (await r.text()).trim();
  return _projectId;
}

/** Access token for the Cloud Run runtime service account, cached to expiry. */
async function gcpAccessToken() {
  if (_token.value && Date.now() < _token.exp - 60000) return _token.value;
  const r = await fetch(`${META_BASE}/instance/service-accounts/default/token`, { headers: META_HDR });
  if (!r.ok) throw new Error(`metadata token HTTP ${r.status}`);
  const j = await r.json();
  _token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _token.value;
}

/**
 * Screen text with Model Armor. Returns { skipped } if not configured,
 * else { flagged: boolean, result }. Fails OPEN on infra error (logs, allows)
 * so a Model Armor outage never takes the feature down — flip to fail-closed
 * by throwing instead if your risk posture requires it.
 */
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
    if (!r.ok) {
      const b = await r.text().catch(() => "");
      logJson("WARNING", "model_armor_error", { status: r.status, body: b.slice(0, 200) });
      return { skipped: false, flagged: false, error: `HTTP ${r.status}` };
    }
    const j = await r.json();
    const flagged = j?.sanitizationResult?.filterMatchState === "MATCH_FOUND";
    return { skipped: false, flagged, result: j.sanitizationResult };
  } catch (e) {
    logJson("WARNING", "model_armor_exception", { error: String(e.message || e) });
    return { skipped: false, flagged: false, error: String(e.message || e) };
  }
}

// ---- structured logging (picked up by Cloud Logging/Trace/Monitoring) ----

function logJson(severity, message, extra = {}) {
  // Cloud Logging parses stdout JSON and maps these fields automatically.
  process.stdout.write(JSON.stringify({ severity, message, ...extra }) + "\n");
}

/** Express middleware: one structured log line per request, trace-correlated. */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", async () => {
    const entry = {
      severity: res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARNING" : "INFO",
      message: `${req.method} ${req.path} ${res.statusCode}`,
      httpRequest: { requestMethod: req.method, requestUrl: req.originalUrl, status: res.statusCode, latency: `${(Date.now() - start) / 1000}s` },
    };
    // Correlate with Cloud Trace using the header Cloud Run injects.
    const tc = req.header("X-Cloud-Trace-Context");
    if (tc && _projectId) {
      const traceId = tc.split("/")[0];
      entry["logging.googleapis.com/trace"] = `projects/${_projectId}/traces/${traceId}`;
    }
    process.stdout.write(JSON.stringify(entry) + "\n");
  });
  next();
}

// ---- the aggregation route ----------------------------------------------

app.get("/api/sync", async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(from) || !isoDate.test(to)) {
    return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  }
  if (!WINDSOR_API_KEY) {
    return res.status(500).json({ error: "Server missing WINDSOR_API_KEY" });
  }

  // Each source is independent: one failing must not sink the others.
  const jobs = {
    meta: windsor("facebook", ["date", "account_name", "spend", "impressions", "clicks"], from, to),
    fbOrganic: windsor("facebook_organic", ["date", "page_impressions", "post_engagements"], from, to),
    ttOrganic: windsor("tiktok_organic", ["date", "video_views", "likes", "comments", "shares"], from, to),
    gmb: windsor("google_my_business", ["date", "location_title", "impressions", "call_clicks", "website_clicks", "direction_requests"], from, to),
    scDaily: windsor("searchconsole", ["date", "clicks", "impressions", "position"], from, to),
    scQueries: windsor("searchconsole", ["query", "clicks", "impressions"], from, to),
    line: windsor("line", ["date", "message__broadcast", "message__targeting", "message__api_push", "followers__followers"], from, to),
  };

  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]));
  const R = {};
  const missing = [];
  const errors = [];
  settled.forEach((s, i) => {
    const k = keys[i];
    if (s.status === "fulfilled") {
      R[k] = s.value;
    } else {
      R[k] = [];
      errors.push(`${k}: ${s.reason.message}`);
    }
  });

  // --- Meta Ads ---
  const meta = R.meta || [];
  const metaSpend = meta.reduce((a, r) => a + n(r.spend), 0);
  const metaImpr = meta.reduce((a, r) => a + n(r.impressions), 0);
  const metaClicks = meta.reduce((a, r) => a + n(r.clicks), 0);
  if (!meta.length) missing.push("Meta Ads");
  const byAccount = groupSum(meta, (r) => r.account_name || "Unknown", ["spend", "clicks"]);
  const topAccounts = [...byAccount.entries()]
    .map(([name, v]) => ({ name, spend: v.spend, clicks: v.clicks }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5);

  // --- Organic (FB + TikTok combined) ---
  const fb = R.fbOrganic || [];
  const tt = R.ttOrganic || [];
  const organicImpr =
    fb.reduce((a, r) => a + n(r.page_impressions), 0) +
    tt.reduce((a, r) => a + n(r.video_views), 0);
  const organicEng =
    fb.reduce((a, r) => a + n(r.post_engagements), 0) +
    tt.reduce((a, r) => a + n(r.likes) + n(r.comments) + n(r.shares), 0);
  if (!fb.length && !tt.length) missing.push("Organic social");

  // --- Google My Business ---
  const gmb = R.gmb || [];
  const gmbAction = (r) => n(r.call_clicks) + n(r.website_clicks) + n(r.direction_requests);
  const gmbViews = gmb.reduce((a, r) => a + n(r.impressions), 0);
  const gmbActions = gmb.reduce((a, r) => a + gmbAction(r), 0);
  if (!gmb.length) missing.push("Google My Business");
  const byLoc = new Map();
  for (const r of gmb) {
    const key = r.location_title || "Unknown";
    if (!byLoc.has(key)) byLoc.set(key, { views: 0, actions: 0 });
    const v = byLoc.get(key);
    v.views += n(r.impressions);
    v.actions += gmbAction(r);
  }
  const gmbByLocation = [...byLoc.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.views - a.views);

  // --- Search Console ---
  const scDaily = R.scDaily || [];
  const scClicks = scDaily.reduce((a, r) => a + n(r.clicks), 0);
  const scImpr = scDaily.reduce((a, r) => a + n(r.impressions), 0);
  const scCtr = scImpr ? (scClicks / scImpr) * 100 : 0;
  // impression-weighted average position
  const posWeighted = scDaily.reduce((a, r) => a + n(r.position) * n(r.impressions), 0);
  const scPos = scImpr ? posWeighted / scImpr : 0;
  if (!scDaily.length) missing.push("Search Console");

  const topQueries = (R.scQueries || [])
    .map((r) => ({ q: r.query || "", clicks: n(r.clicks), impr: n(r.impressions), lang: detectLang(r.query || "") }))
    .filter((x) => x.q)
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);

  // --- LINE ---
  const line = R.line || [];
  const lineMsgs = line.reduce(
    (a, r) => a + n(r.message__broadcast) + n(r.message__targeting) + n(r.message__api_push),
    0
  );
  const lineFollowers = line.reduce((a, r) => a + n(r.followers__followers), 0);
  if (!line.length) missing.push("LINE");

  // --- Trend (by date, across sources) ---
  const trendMap = new Map();
  const touch = (d) => {
    if (!trendMap.has(d)) trendMap.set(d, { d, spend: 0, organicEng: 0, gmbViews: 0, scClicks: 0 });
    return trendMap.get(d);
  };
  for (const r of meta) if (r.date) touch(r.date).spend += n(r.spend);
  for (const r of fb) if (r.date) touch(r.date).organicEng += n(r.post_engagements);
  for (const r of tt) if (r.date) touch(r.date).organicEng += n(r.likes) + n(r.comments) + n(r.shares);
  for (const r of gmb) if (r.date) touch(r.date).gmbViews += n(r.impressions);
  for (const r of scDaily) if (r.date) touch(r.date).scClicks += n(r.clicks);
  const trend = [...trendMap.values()].sort((a, b) => a.d.localeCompare(b.d));

  res.json({
    range: { from, to },
    kpi: {
      spend: metaSpend, impressions: metaImpr, clicks: metaClicks,
      organicImpr, organicEng,
      gmbViews, gmbActions,
      scClicks, scImpr, scCtr, scPos,
      lineMsgs, lineFollowers,
    },
    trend,
    topAccounts,
    topQueries,
    gmbByLocation,
    missing,
    errors, // surfaced for debugging; empty in the happy path
    syncedAt: new Date().toISOString(),
  });
});

// ---- v.2 Topic Explorer --------------------------------------------------
// POST /api/topic { topic, from, to }
// 1) Claude expands the topic into multilingual ranking terms
// 2) Windsor Search Console returns real query data (deterministic)
// 3) server matches queries to terms
// 4) Claude clusters the matches and the term gaps are flagged
const LANGS = { AR: "Arabic", JA: "Japanese", ZH: "Chinese", MY: "Burmese", KM: "Khmer", TH: "Thai", EN: "English" };

app.post("/api/topic", async (req, res) => {
  const { topic, from, to } = req.body || {};
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!topic || typeof topic !== "string") return res.status(400).json({ error: "topic (string) required" });
  if (!isoDate.test(from) || !isoDate.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
  if (!WINDSOR_API_KEY) return res.status(500).json({ error: "Server missing WINDSOR_API_KEY" });

  try {
    // --- Step 0: screen the user-typed topic (Model Armor, if configured) ---
    const screen = await modelArmorScreen(topic);
    if (screen.flagged) {
      logJson("WARNING", "topic_blocked_by_model_armor", { topic });
      return res.status(422).json({ error: "This topic was blocked by content screening. Try rephrasing.", screened: true });
    }

    // --- Step 1: expand the topic across languages (AI) ---
    const expandPrompt =
      `A hospital marketing team wants every search term related to the clinical topic "${topic}" ` +
      `that patients might type into Google, across these languages: Arabic, Japanese, Chinese, Burmese, Khmer, Thai, English. ` +
      `Include the medical name, common lay terms, related conditions and procedures, and frequent misspellings. ` +
      `Return ONLY minified JSON, no prose, no code fences, shaped exactly as: ` +
      `{"terms":[{"term":"<search term>","lang":"AR|JA|ZH|MY|KM|TH|EN"}]}. ` +
      `Aim for 6-15 terms per language. Keep terms short (what a person actually types).`;
    const expanded = extractJson(await anthropic(expandPrompt, { maxTokens: 2000 }));
    const terms = (expanded.terms || []).filter((t) => t && t.term).map((t) => ({ term: t.term, lang: t.lang || detectLang(t.term) }));

    // --- Step 2: pull real Search Console query data (deterministic) ---
    const scRows = await windsor("searchconsole", ["query", "country", "clicks", "impressions", "position"], from, to);

    // --- Step 3: match queries to expanded terms (deterministic) ---
    const normTerms = terms.map((t) => ({ ...t, n: norm(t.term) })).filter((t) => t.n.length >= 2);
    const matchedMap = new Map(); // query -> {query, clicks, impressions, posW, lang, countries:Set}
    const matchedTermSet = new Set();
    for (const r of scRows) {
      const q = r.query || "";
      const nq = norm(q);
      if (!nq) continue;
      const hit = normTerms.find((t) => nq.includes(t.n) || t.n.includes(nq));
      if (!hit) continue;
      matchedTermSet.add(hit.term);
      if (!matchedMap.has(q)) matchedMap.set(q, { query: q, clicks: 0, impressions: 0, posW: 0, lang: detectLang(q), countries: new Set() });
      const m = matchedMap.get(q);
      m.clicks += n(r.clicks);
      m.impressions += n(r.impressions);
      m.posW += n(r.position) * n(r.impressions);
      if (r.country) m.countries.add(r.country);
    }
    const matched = [...matchedMap.values()]
      .map((m) => ({ query: m.query, clicks: m.clicks, impressions: m.impressions, position: m.impressions ? +(m.posW / m.impressions).toFixed(1) : null, lang: m.lang, countries: [...m.countries] }))
      .sort((a, b) => b.impressions - a.impressions);

    // by-language and by-country rollups
    const byLang = {};
    for (const m of matched) {
      const L = m.lang || "??";
      byLang[L] = byLang[L] || { lang: L, name: LANGS[L] || L, queries: 0, clicks: 0, impressions: 0 };
      byLang[L].queries++; byLang[L].clicks += m.clicks; byLang[L].impressions += m.impressions;
    }
    const byCountry = {};
    for (const r of scRows) {
      const q = r.query || "";
      if (!matchedMap.has(q)) continue;
      const c = r.country || "??";
      byCountry[c] = byCountry[c] || { country: c, clicks: 0, impressions: 0 };
      byCountry[c].clicks += n(r.clicks); byCountry[c].impressions += n(r.impressions);
    }

    // gaps: expanded terms that matched no captured query
    const gaps = terms.filter((t) => !matchedTermSet.has(t.term));

    // --- Step 4: cluster the matched queries into sub-topics (AI) ---
    let clusters = [];
    if (matched.length) {
      const forClustering = matched.slice(0, 120).map((m) => m.query);
      const clusterPrompt =
        `These are real Google search queries a hospital ranks for, related to "${topic}", across multiple languages:\n` +
        JSON.stringify(forClustering) +
        `\nGroup them into 3-7 meaningful clinical sub-topics. Translate/transliterate nothing — keep queries verbatim. ` +
        `Return ONLY minified JSON, no prose, no fences: {"clusters":[{"label":"<short English label>","queries":["<verbatim query>"]}]}. ` +
        `Every query must appear in exactly one cluster.`;
      try {
        const c = extractJson(await anthropic(clusterPrompt, { maxTokens: 2500 }));
        clusters = (c.clusters || []).filter((x) => x && x.label);
      } catch (e) {
        clusters = []; // clustering is a nicety; don't fail the whole request
      }
    }

    res.json({
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
      clusters,
      byLanguage: Object.values(byLang).sort((a, b) => b.impressions - a.impressions),
      byCountry: Object.values(byCountry).sort((a, b) => b.impressions - a.impressions).slice(0, 15),
      gaps,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[/api/topic]", err);
    res.status(500).json({ error: err.message || "Topic exploration failed" });
  }
});

// ---- static + health -----------------------------------------------------

app.get("/healthz", (_req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Control Room listening on :${PORT}`);
  // Warm the project-id cache so trace correlation works on the first request.
  // Harmless no-op off Cloud Run (metadata server simply unreachable).
  gcpProjectId().then((id) => console.log(`[init] GCP project: ${id}`)).catch(() => {});
});
