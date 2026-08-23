/**
 * Preloaded stub for outbound HTTP, so every endpoint can be executed against
 * plausible data without touching Windsor, Google or Anthropic.
 *
 *   node --require ./test/mock-fetch.js server.js
 *
 * This exists because `node -c` only proves a file parses. It cannot catch a
 * variable used before its declaration, a wrong field name, or a null deref —
 * all of which reach the browser as a 500. Anything that changes an endpoint
 * should be run through this before shipping.
 */
const realFetch = global.fetch;

/**
 * Application Default Credentials do not exist in CI, and google-auth-library
 * does not route its token fetch through global.fetch, so stubbing fetch alone
 * is not enough. This module is preloaded with --require, before server.js
 * destructures GoogleAuth, so replacing the export here is sufficient.
 */
// The export is a read-only getter, so a plain assignment fails silently.
{
  const gal = require("google-auth-library");
  const MockGoogleAuth = class GoogleAuth {
    constructor(opts = {}) { this.scopes = opts.scopes || []; }
    async getClient() { return { getAccessToken: async () => ({ token: "mock-token" }) }; }
  };
  Object.defineProperty(gal, "GoogleAuth", { value: MockGoogleAuth, writable: true, configurable: true });
  if (gal.GoogleAuth !== MockGoogleAuth) throw new Error("mock-fetch: failed to stub GoogleAuth");
}

const qp = (url, k) => { try { return new URL(url).searchParams.get(k); } catch { return null; } };
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// One row per requested field-set, filled with values shaped like the real ones.
function windsorRows(connector, fields) {
  const f = (fields || "").split(",");
  const has = (x) => f.includes(x);
  const row = {};
  for (const name of f) {
    if (name === "date") row.date = "2026-07-15";
    else if (name === "review_create_time") row.review_create_time = "2026-07-15T10:00:00Z";
    else if (name === "location_title") row.location_title = "Bangkok Hospital";
    else if (name === "review_star_rating") row.review_star_rating = "FIVE";
    else if (name === "account_name") row.account_name = "BGH x ADA";
    else if (name === "campaign") row.campaign = "260701-08_BHT_test_2JUL2026_31JUL2026_Traffic_THB8344";
    else if (name === "campaign_objective") row.campaign_objective = "OUTCOME_TRAFFIC";
    else if (name === "session_manual_campaign_name") row.session_manual_campaign_name = "260701-08_bht_tra";
    else if (name === "session_manual_source") row.session_manual_source = "facebook";
    else if (name === "session_manual_medium") row.session_manual_medium = "paid";
    else if (name === "session_default_channel_group") row.session_default_channel_group = "Paid Social";
    else if (name === "landing_page") row.landing_page = "/th/bangkok-heart/package/x";
    else if (name === "page") row.page = "https://www.bangkokhospital.com/th/content/x";
    else if (name === "query") row.query = "นิ่วในถุงน้ำดี";
    else if (name === "country") row.country = "Thailand";
    else if (name === "item_name") row.item_name = "Heart Screening Package";
    else if (name === "post_message") row.post_message = "See https://bkhos.co/wKBkLa for details";
    else if (name === "permalink_url") row.permalink_url = "https://facebook.com/p/123";
    else if (name === "post_id") row.post_id = "123_456";
    // CONVERSATIONS with campaign_objective OUTCOME_TRAFFIC reproduces the real
    // WhatsApp shape, where the campaign field disagrees with the ad set goal —
    // so the smoke test proves the ad set goal is the one that wins.
    else if (name === "adsset_optimization_goal") row.adsset_optimization_goal = "CONVERSATIONS";
    else if (name === "review_comment") row.review_comment = "Great service";
    else if (name === "review_reviewer") row.review_reviewer = "A. Patient";
    else if (name === "review_reply_comment") row.review_reply_comment = "";
    else if (name === "message_request_id") row.message_request_id = null;
    else if (name === "message_send_time") row.message_send_time = null;
    else if (name === "event_name") row.event_name = "engagement";
    else if (name === "review_average_rating_total") row.review_average_rating_total = 4.7;
    else if (name === "review_total_count") row.review_total_count = 8492;
    else if (name === "position") row.position = 7.4;
    else row[name] = 100;                      // every metric gets a number
  }
  if (has("review_star_rating") && !has("review_count")) row.review_count = 1;
  return [row];
}

/**
 * GA4 Data API runReport.
 *
 * This stub APPLIES the dimensionFilter it is given, unlike Windsor, which
 * accepts one and silently ignores it. That difference is the whole point: the
 * Pages tab shipped in v3.59 believing it had server-side filtering, pulled the
 * entire property on every request, and OOM-killed the container — and every
 * test layer stayed green because the old mock returned a single row whatever
 * was asked of it. A mock that ignores filters cannot tell a working filter
 * from a discarded one, so this one refuses to.
 */
const GA4_PAGES = [
  // One page per brand so the per-brand segment filter is actually exercised;
  // with only bangkok-heart present, three of four brands read zero and a
  // broken filter would look identical to correct output.
  "/th/bangkok/page/a",
  // A second locale in scope, so the language matrix is exercised across
  // columns rather than only ever filling the Thai one.
  "/en/bangkok/page/a-en",
  "/ja/bangkok-heart/page/a-ja",
  "/th/bangkok-bone-brain/page/b",
  "/th/bangkok-cancer/page/c",
  "/th/bangkok-heart/package/x",
  "/th/bangkok-heart/package/x/details",
  "/th/bangkok-heart/package/x-other",   // sibling: BEGINS_WITH catches it, match() must not
  "/th/somewhere-else/page",
  // Section root with a UTM: the segment ends with "?" not "/". An earlier
  // pattern dropped these, excluding every campaign landing on a section root.
  "/th/bangkok-heart?utm_source=facebook",
  // Out-of-scope branches. The War Room watches 4 of the group property's 27,
  // so these must be excluded by the FULL_REGEXP branch filter. If the filter
  // is dropped they reappear and every total silently inflates.
  "/th/samitivej-srinakarin/package/y",
  "/en/phyathai-2/package/z",
];
// Includes login (must be filtered out by the server's inListFilter) and the
// two Better AI events, so a merge that silently returns zero is detectable.
const GA4_EVENTS = ["appointments", "contact_us", "better_ai_start", "better_ai_result", "login"];
const GA4_LANDING_DIM_NAME = process.env.GA4_LANDING_DIM || "landingPagePlusQueryString";

/**
 * GA4 rejects incompatible dimension/metric scope combinations with a 400.
 * `ga4Items` asked for itemViewEvents (EVENT-scoped) alongside itemName and
 * item-scoped metrics, and failed on every run for weeks while this stub
 * happily returned rows. A stub that accepts what the real API refuses is the
 * same failure as one that is more permissive about filters (see the
 * FULL_REGEXP incident) — it certifies code that cannot work.
 */
const GA4_INCOMPATIBLE = [
  { dim: "itemName", metric: "itemViewEvents",
    msg: "Please remove itemViewEvents to make the request compatible for example. The request's dimensions & metrics are incompatible." },
];

function ga4Report(body) {
  const dims = (body.dimensions || []).map((d) => d.name);
  const mets = (body.metrics || []).map((m) => m.name);
  for (const rule of GA4_INCOMPATIBLE) {
    if (dims.includes(rule.dim) && mets.includes(rule.metric)) {
      const err = new Error(rule.msg); err.ga4Status = 400; throw err;
    }
  }

  // Read the filter the server actually sent, and honour it — per field, since
  // /api/page filters on the landing page and /api/campaign on the campaign name.
  const flat = [];
  const walk = (e) => {
    if (!e) return;
    if (e.filter) flat.push(e.filter);
    for (const k of ["andGroup", "orGroup"]) if (e[k]) (e[k].expressions || []).forEach(walk);
  };
  walk(body.dimensionFilter);
  const beginsWith = {};       // fieldName -> required prefix
  const regexes = {};          // fieldName -> [RegExp] (the branch filter)
  let allowedEvents = null;
  for (const f of flat) {
    if (f.stringFilter && f.stringFilter.matchType === "BEGINS_WITH") {
      beginsWith[f.fieldName] = f.stringFilter.value;
    }
    /**
     * GA4 semantics, exactly: FULL_REGEXP must match the WHOLE value,
     * PARTIAL_REGEXP matches anywhere. v3.63.0 shipped a prefix pattern as
     * FULL_REGEXP and every GA4 report returned zero rows in production, while
     * this mock passed — because a bare RegExp.test() is a partial match. A
     * stub that is more permissive than the real API certifies broken code.
     */
    if (f.stringFilter && f.stringFilter.matchType === "FULL_REGEXP") {
      (regexes[f.fieldName] = regexes[f.fieldName] || [])
        .push(new RegExp(`^(?:${f.stringFilter.value})$`, f.stringFilter.caseSensitive ? "" : "i"));
    }
    if (f.stringFilter && f.stringFilter.matchType === "PARTIAL_REGEXP") {
      (regexes[f.fieldName] = regexes[f.fieldName] || [])
        .push(new RegExp(f.stringFilter.value, f.stringFilter.caseSensitive ? "" : "i"));
    }
    if (f.inListFilter) allowedEvents = f.inListFilter.values;
  }
  const keep = (field, value) => {
    const p = beginsWith[field];
    if (p && !String(value).toLowerCase().startsWith(String(p).toLowerCase())) return false;
    for (const re of (regexes[field] || [])) if (!re.test(String(value))) return false;
    return true;
  };

  const pages = GA4_PAGES.filter((p) => keep(GA4_LANDING_DIM_NAME, p) && keep("pagePath", p));
  /**
   * The branch filter targets the landing-page dimension, which most reports do
   * not GROUP by — so filtering it has no visible effect on those rows here.
   * To keep its absence detectable, an out-of-scope marker value is emitted
   * whenever no branch regex was sent. Any endpoint whose output contains
   * "OutOfScope" is querying all 27 branches.
   */
  // A report may be branch-scoped via the landing dimension OR via pagePath
  // (page-scoped reports cannot use the session-scoped landing filter).
  const branchFiltered = (regexes[GA4_LANDING_DIM_NAME] || []).length > 0
    || (regexes.pagePath || []).length > 0;
  const marker = branchFiltered ? [] : ["OutOfScope"];

  /**
   * A filter may target a dimension the report does not GROUP by — the branch
   * filter is on the landing page, but the funnel groups by date x channel.
   * Real GA4 still applies it, to the underlying sessions: if no session's
   * landing page matches, the report is empty.
   *
   * Emulating that is what catches a filter that matches nothing. Without it
   * this stub happily returned full rows for the v3.63.0 FULL_REGEXP bug while
   * production went dark.
   */
  const landingIsGrouped = dims.includes(GA4_LANDING_DIM_NAME);
  if (branchFiltered && !landingIsGrouped && pages.length === 0) {
    return { dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: mets.map((name) => ({ name })), rows: [], rowCount: 0 };
  }
  const campaigns = ["260701-08_bht_tra", "(not set)"]
    .filter((c) => keep("sessionManualCampaignName", c));
  const dates = ["20260714", "20260715"];
  const rows = [];
  const emit = (vals) => rows.push({
    dimensionValues: vals.map((value) => ({ value })),
    metricValues: mets.map((m) => ({ value: m === "keyEvents" ? "3" : m === "engagedSessions" ? "60" : "100" })),
  });
  const expand = (i, acc) => {
    if (i === dims.length) return emit(acc);
    const d = dims[i];
    const opts = d === "date" ? dates
      : d === "eventName" ? (allowedEvents || GA4_EVENTS)
      : d === "sessionManualSource" ? ["facebook"]
      : d === "sessionManualMedium" ? ["paid"]
      // Thailand must be present so the render-time exclusion is exercised.
      : d === "country" ? ["Thailand", "Japan", "United States", "Germany", "Singapore", "Cambodia"]
      : d === "sessionManualCampaignName" ? [...campaigns, ...marker]
      // Paid Search must be present or the Google Ads impression mapping
      // (IMPRESSION_SOURCE_BY_CHANNEL) is never exercised.
      : d === "sessionDefaultChannelGroup" ? ["Organic Search", "Paid Social", "Paid Search", ...marker]
      : d === "itemName" ? ["Heart Screening Package", ...marker]
      : d === "pageTitle" ? ["Heart Screening Package", "Annual Check-up", ...marker]
      : d === "pagePath" ? pages
      : pages;
    if (!opts.length) return;
    for (const v of opts) expand(i + 1, [...acc, v]);
  };
  expand(0, []);
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: mets.map((name) => ({ name })),
    rows,
    rowCount: rows.length,
  };
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes("connectors.windsor.ai/google_my_business")) {
    if (process.env.MOCK_FAIL_CONNECTOR === "google_my_business") return jsonRes({ error: "simulated failure" }, 500);
    const want = (new URL(u)).searchParams.get("fields") || "";
    /**
     * All six real listings plus one unknown. Dental must roll into BGH, JMS
     * must land in SHARED, and the unknown must reach the unlisted bucket \u2014
     * with a single "Bangkok Hospital" row none of that mapping was exercised.
     */
    const LOCS = [
      "Bangkok Hospital",
      "Dental Center | Bangkok Hospital",
      "Bangkok International Hospital (Brain x Bone)",
      "Bangkok Heart Hospital",
      "Bangkok Cancer Hospital Wattanosoth",
      "Japanese Medical Services (JMS) \u30d0\u30f3\u30b3\u30af\u75c5\u9662\u65e5\u672c\u4eba\u5c02\u9580\u30af\u30ea\u30cb\u30c3\u30af",
      "Some Other Clinic",
    ];
    if (want.includes("review_star_rating") && !want.includes("review_comment")) {
      return jsonRes({ data: LOCS.map((location_title, i) => ({
        review_create_time: "2026-07-15", location_title, review_star_rating: i % 5 === 0 ? "FOUR" : "FIVE" })) });
    }
    if (want.includes("call_clicks")) {
      return jsonRes({ data: LOCS.map((location_title, i) => ({
        date: "2026-07-15", location_title,
        impressions: 1000 * (i + 1), call_clicks: 10 * (i + 1),
        website_clicks: 5 * (i + 1), direction_requests: 20 * (i + 1),
        business_bookings: 0 })) });
    }
  }

  if (u.includes("searchconsole.googleapis.com")) {
    if (process.env.MOCK_FAIL_GSC === "1") return jsonRes({ error: { message: "simulated GSC failure" } }, 500);
    let body = {};
    try { body = JSON.parse(opts.body || "{}"); } catch { /* empty */ }
    const dims = body.dimensions || [];
    /**
     * GSC returns `page` as a FULL URL. The branch regex must be anchored past
     * the host, because the domain itself contains "bangkok" — an unanchored
     * pattern matches every page and the filter silently does nothing. These
     * fixtures include an out-of-scope branch so that mistake shows up.
     */
    const PAGES = [
      "https://www.bangkokhospital.com/th/bangkok-heart/package/x",
      "https://www.bangkokhospital.com/en/bangkok-cancer/article/y",
      "https://www.bangkokhospital.com/th/samitivej-srinakarin/package/z",
      "https://www.bangkokhospital.com/th/other-branch/page",
    ];
    const groups = body.dimensionFilterGroups || [];
    const pageRes = [];
    for (const g of groups) for (const f of (g.filters || [])) {
      if (f.dimension === "page" && f.operator === "includingRegex") pageRes.push(new RegExp(f.expression));
    }
    const pages = PAGES.filter((p) => pageRes.every((re) => re.test(p)));
    // A page filter with no surviving page means no data, even when the report
    // does not group by page (real GSC filters the underlying rows).
    if (pageRes.length && !pages.length) return jsonRes({ rows: [] });
    const vals = (d) => d === "date" ? ["2026-07-15"]
      : d === "page" ? pages
      : d === "query" ? ["heart checkup", "\u0e42\u0e23\u0e04\u0e2b\u0e31\u0e27\u0e43\u0e08"]
      : d === "country" ? ["tha"] : ["x"];
    const rows = [];
    const walk = (i, keys) => {
      if (i === dims.length) { rows.push({ keys, clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 }); return; }
      for (const v of vals(dims[i])) walk(i + 1, [...keys, v]);
    };
    if (!dims.length) rows.push({ keys: [], clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 });
    else walk(0, []);
    return jsonRes({ rows });
  }

  if (u.includes("analyticsdata.googleapis.com")) {
    if (process.env.MOCK_FAIL_GA4 === "1") return jsonRes({ error: { message: "simulated GA4 failure" } }, 500);
    let body = {};
    try { body = JSON.parse(opts.body || "{}"); } catch { /* fall through to empty */ }
    try { return jsonRes(ga4Report(body)); }
    catch (e) {
      if (e.ga4Status === 400) return jsonRes({ error: { code: 400, message: e.message, status: "INVALID_ARGUMENT" } }, 400);
      throw e;
    }
  }

  if (u.includes("connectors.windsor.ai/facebook?") || /connectors\.windsor\.ai\/facebook[?&]/.test(u)) {
    if (process.env.MOCK_FAIL_CONNECTOR === "facebook") return jsonRes({ error: "simulated failure" }, 500);
    const want = (new URL(u)).searchParams.get("fields") || "";
    if (want.includes("account_name") && !want.includes("campaign")) {
      // Brand-owned, shared, and e-commerce-only accounts, so the registry split
      // in buildReport is verifiable end to end.
      const mk = (account_name, spend) => ({ date: "2026-07-15", account_name, spend,
        impressions: spend * 10, clicks: spend / 2,
        actions_onsite_conversion_total_messaging_connection: 5 });
      return jsonRes({ data: [
        mk("BGH x ADA", 100), mk("BIH x ADA", 80), mk("BHT x ADA", 60),
        mk("BGH x EGG", 50), mk("WSH x ADA", 30),
        mk("BHQ x AIQ", 40), mk("BHQ Inter x ADA", 20),
        mk("BHQ Shopee x EGG", 10),
        mk("Some New Account", 7),   // must land in UNMAPPED, never vanish

      ]});
    }
  }

  if (u.includes("connectors.windsor.ai/google_ads")) {
    // Search-term rows are a different shape from campaign rows; without this
    // branch the report's term table silently renders empty.
    if (((new URL(u)).searchParams.get("fields") || "").includes("search_term")) {
      return jsonRes({ data: [
        { search_term: "เอ็น หัว เข่า พลิก", impressions: 37745, clicks: 646, spend: 4200 },
        { search_term: "เอ็น หัว เข่า ขาด อาการ", impressions: 15695, clicks: 348, spend: 2100 },
        { search_term: "ผ่าตัดถุงน้ำดี", impressions: 2750, clicks: 152, spend: 900 },
        { search_term: "bmi calculator", impressions: 56800, clicks: 4336, spend: 5100 },
      ]});
    }
    return jsonRes({ data: [
      { date:"2026-07-05", account_name:"BGH x ADA", campaign:"260701-08_BGH_Search", adgroup:"Brand", campaign_type:"SEARCH", conversions:4, spend:1200, impressions:5000, clicks:300 },
      { date:"2026-07-05", account_name:"BGH x ADA", campaign:"260701-08_BGH_Search", adgroup:"Generic", campaign_type:"SEARCH", conversions:1, spend:400, impressions:2000, clicks:90 },
      { date:"2026-07-06", account_name:"BHQ X AIQ", campaign:"aiq_bhq_gg_search_uae", adgroup:"UAE", campaign_type:"SEARCH", conversions:0, spend:800, impressions:2000, clicks:120 },
    ]});
  }
  // LINE is disconnected; any call reaching here is a regression.
  if (u.includes("connectors.windsor.ai/line")) {
    return jsonRes({ error: "LINE connector is not connected" }, 400);
  }
  if (u.includes("connectors.windsor.ai")) {
    const connector = u.split("connectors.windsor.ai/")[1].split("?")[0];
    if (process.env.MOCK_FAIL_CONNECTOR === connector) return jsonRes({ error: "simulated failure" }, 500);
    return jsonRes({ data: windsorRows(connector, qp(u, "fields")) });
  }

  if (u.includes("sheets.googleapis.com")) {
    // values.get on the e-commerce Orders tab (no `ranges` param, unlike the
    // batchGet the UTM Builder uses).
    if (u.includes("/values/") && !u.includes("ranges=")) {
      const head = ["load_batch","order_id","receipt_no","seller_order_id","purchase_date",
        "purchase_time","year_month","channel","country","campaign_name","payment_status",
        "order_status","payment_method","package_name","sku","center","english_name","location",
        "price","full_price","discount_pct","discount_alloc","promo_alloc","txn_fee_alloc",
        "comm_fee_alloc","net_revenue","coupon_no","coupon_status","coupon_expiry",
        "is_valid_sale","map_status","email_key","phone_key","dedup_key"];
      const mk = (o) => head.map((h) => (o[h] === undefined ? "" : o[h]));
      return jsonRes({ values: [head,
        mk({ purchase_date:"2026-07-01", channel:"Shopee", order_id:"A", package_name:"Essence",
             sku:"HD25-01", center:"Check-Up", price:5000, txn_fee_alloc:100, comm_fee_alloc:250,
             coupon_status:"ใช้งานแล้ว", is_valid_sale:"TRUE", email_key:"c1", payment_method:"Card" }),
        mk({ purchase_date:"2026-07-01", channel:"Lazada", order_id:"B", package_name:"Dental",
             sku:"", center:"", price:3000, txn_fee_alloc:90, comm_fee_alloc:400,
             coupon_status:"ซื้อคูปอง", is_valid_sale:"TRUE", email_key:"c2", payment_method:"Card" }),
        mk({ purchase_date:"2026-07-02", channel:"Shopee", order_id:"C", package_name:"Superior",
             sku:"HD25-02", center:"Check-Up", price:7000, full_price:14000, txn_fee_alloc:140,
             comm_fee_alloc:350, coupon_status:"ซื้อคูปอง", is_valid_sale:"TRUE", email_key:"c1",
             payment_method:"Card" }),
        mk({ purchase_date:"2026-07-02", channel:"Lazada", order_id:"D", package_name:"Heart",
             sku:"HT25-01", center:"Heart", price:9000, full_price:12000, txn_fee_alloc:180,
             comm_fee_alloc:900, coupon_status:"ใช้งานแล้ว", is_valid_sale:"TRUE", email_key:"c3",
             payment_method:"Card" }),
        // B2B: one huge order that must be excluded from the Online default.
        mk({ purchase_date:"2026-07-03", channel:"Agent", order_id:"E", package_name:"Bulk",
             sku:"HD25-01", center:"Check-Up", price:500000, txn_fee_alloc:0, comm_fee_alloc:0,
             coupon_status:"ซื้อคูปอง", is_valid_sale:"TRUE", email_key:"c9", payment_method:"" }),
        // c1 starts Online (July) then buys Offline in August: one migration.
        mk({ purchase_date:"2026-08-05", channel:"เวชระเบียน", order_id:"F", package_name:"Walkin",
             sku:"HD25-01", center:"Check-Up", price:4000, coupon_status:"ใช้งานแล้ว",
             is_valid_sale:"TRUE", email_key:"c1", payment_method:"Cash" }),
        // c2 buys Online twice on different dates: returning but NOT a switcher.
        mk({ purchase_date:"2026-08-07", channel:"Roadshow 2024", order_id:"H", package_name:"Event",
             sku:"HD25-01", center:"Check-Up", price:1500, coupon_status:"ซื้อคูปอง",
             is_valid_sale:"TRUE", email_key:"c7", payment_method:"Cash" }),
        mk({ purchase_date:"2026-08-06", channel:"Lazada", order_id:"G", package_name:"Dental",
             sku:"", center:"", price:3200, coupon_status:"ซื้อคูปอง",
             is_valid_sale:"TRUE", email_key:"c2", payment_method:"Card" })] });
    }
    // UTM Builder L:P and Content Plan A:H, in the documented column order.
    const ranges = [...new URL(u).searchParams.getAll("ranges")];
    return jsonRes({
      valueRanges: ranges.map((r) => ({
        range: r,
        values: r.includes("!L")
          ? [["260701-08", "https://bkhos.co/wKBkLa", "", "", ""]]
          : [["2026-07-01", "260701-08", "ปรึกษาหมอผ่าตัดหัวใจแผลเล็ก", "", "", "", "", ""]],
      })),
    });
  }

  if (u.includes("storage.googleapis.com")) {
    if (opts.method === "POST") return jsonRes({ ok: true });
    return jsonRes({ users: [{ email: "staff@bangkokhospital.com", tabs: ["overview"] }] });
  }

  if (u.includes("metadata.google.internal")) {
    return { ok: true, status: 200, text: async () => "mock-project", json: async () => ({ access_token: "mock", expires_in: 3600 }) };
  }

  if (u.includes("api.anthropic.com")) {
    return jsonRes({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ TH: ["นิ่วในถุงน้ำดี"], EN: ["gallstones"] }) }],
    });
  }

  return realFetch ? realFetch(url, opts) : jsonRes({}, 404);
};
