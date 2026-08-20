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
    else if (name === "account_name") row.account_name = "BHQ Main";
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

global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes("connectors.windsor.ai/google_ads")) {
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
