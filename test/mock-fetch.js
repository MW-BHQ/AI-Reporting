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

  if (u.includes("connectors.windsor.ai")) {
    const connector = u.split("connectors.windsor.ai/")[1].split("?")[0];
    if (process.env.MOCK_FAIL_CONNECTOR === connector) return jsonRes({ error: "simulated failure" }, 500);
    return jsonRes({ data: windsorRows(connector, qp(u, "fields")) });
  }

  if (u.includes("sheets.googleapis.com")) {
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
