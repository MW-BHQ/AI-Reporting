/**
 * Static audit — the checks that catch this project's recurring bug classes.
 *
 * Every rule here exists because the bug actually happened:
 *   · a Windsor field list silently lost entries during a find-and-replace
 *   · a table gained a column but its colgroup or body did not
 *   · the client kept reading a field the server had stopped sending
 *   · a diagnostic endpoint shipped without an auth guard
 *   · sheet-supplied text was interpolated into an HTML attribute unescaped
 *
 * Run with the smoke test. Exits non-zero on any failure.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

let failures = 0;
const ok = (name, detail) => console.log(`  ok   ${name.padEnd(30)} ${detail || ""}`);
const fail = (name, detail) => { failures++; console.log(`  FAIL ${name.padEnd(30)} ${detail}`); };

// ---------------------------------------------------------------- fields
// A pull that loses a field returns 200 with empty columns, so assert the
// contents of each field list directly.
const REQUIRED_FIELDS = {
  BASE_FIELDS: ["adset_id", "adset_name", "campaign", "account_name", "spend", "impressions",
    "reach", "actions_link_click", "actions_landing_page_view", "actions_lead",
    "actions_post_engagement", "quality_ranking", "engagement_rate_ranking",
    "conversion_rate_ranking", "adsset_optimization_goal", "campaign_objective"],
  CATALOG_FIELDS: ["catalog_segment_actions_omni_purchase", "catalog_segment_value_purchase",
    "catalog_segment_actions_omni_add_to_cart"],
};
for (const [name, expected] of Object.entries(REQUIRED_FIELDS)) {
  const m = server.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) { fail(`fields:${name}`, "declaration not found"); continue; }
  const missing = expected.filter((f) => !m[1].includes(`"${f}"`));
  missing.length ? fail(`fields:${name}`, `missing ${missing.join(", ")}`)
                 : ok(`fields:${name}`, `${expected.length} fields`);
}

// ---------------------------------------------------------------- taxonomy
// Every channel in the data must be classified, or the dashboard silently
// buckets it as "Unclassified" — a taxonomy gap that reads like a segment.
const ctBlock = server.match(/const CHANNEL_TYPE = \{([\s\S]*?)\n\};/);
if (!ctBlock) fail("channel taxonomy", "CHANNEL_TYPE not found");
else {
  const entries = [...ctBlock[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)];
  const types = new Set(entries.map((m) => m[2]));
  const allowed = ["Online", "Offline", "B2B", "Special Campaign", "Complementary", "Extra"];
  const bad = [...types].filter((t) => !allowed.includes(t));
  bad.length ? fail("channel taxonomy", `unknown type(s): ${bad.join(", ")}`)
             : ok("channel taxonomy", `${entries.length} channels across ${types.size} types`);
}

// ---------------------------------------------------------------- tabs
const tabsBlock = server.slice(server.indexOf("const TABS"), server.indexOf("];", server.indexOf("const TABS")));
const tabs = [...tabsBlock.matchAll(/id: "(\w+)"/g)].map((m) => m[1]);
const unwired = tabs.filter((t) =>
  !html.includes(`data-view="${t}"`) || !html.includes(`S.view === '${t}'`));
unwired.length ? fail("tabs wired", `no nav or no route: ${unwired.join(", ")}`)
               : ok("tabs wired", `${tabs.length} tabs have nav + route`);

// ---------------------------------------------------------------- guards
const unguarded = [...server.matchAll(/app\.(?:get|post|delete)\("(\/api\/[^"]+)"\s*,\s*(\w+)/g)]
  .filter(([, route, next]) => !/^require(Tab|Admin)$/.test(next) && !/^\/api\/(me|version)$/.test(route))
  .map(([, route]) => route);
unguarded.length ? fail("route guards", `no auth guard: ${[...new Set(unguarded)].join(", ")}`)
                 : ok("route guards", "every /api route guarded except me + version");

// ---------------------------------------------------------------- caches
const keys = [...server.matchAll(/withCache\(`([^`]+)`/g)].map((m) => m[1]);
const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
const unparam = keys.filter((k) => !k.includes("${"));
dupes.length || unparam.length
  ? fail("cache keys", `${dupes.length} duplicate, ${unparam.length} unparameterised`)
  : ok("cache keys", `${keys.length} distinct, all parameterised`);

// ---------------------------------------------------------------- stale reads
// The client must not read a field the server stopped sending.
const RETIRED = ["repeatShare", "keyEventsEst", "keyEventRate", "viewContent", "vcRate", "vcSuspect"];
const stale = RETIRED.filter((f) => html.includes(`.${f}`) && !server.includes(f));
stale.length ? fail("stale client fields", stale.join(", "))
             : ok("stale client fields", "none");

// ---------------------------------------------------------------- tables
let tableCount = 0;
const misaligned = [];
const re = /<table([^>]*)>([\s\S]*?)<\/table>/g;
let m;
while ((m = re.exec(html))) {
  const body = m[2];
  const headEnd = body.indexOf("</thead>");
  if (headEnd < 0) continue;
  const head = body.slice(0, headEnd);
  const th = (head.match(/<th[ >]/g) || []).length;
  const cols = (body.slice(0, body.indexOf("<thead")).match(/<col[ >]/g) || []).length;
  const afterBody = body.slice(body.indexOf("<tbody"));
  const firstRow = afterBody.slice(0, afterBody.indexOf("</tr>"));
  // Empty-state rows legitimately use colspan and are not a column mismatch.
  if (/colspan=/.test(firstRow)) continue;
  const td = (firstRow.match(/<td/g) || []).length;
  if (!td) continue;
  tableCount++;
  if (th !== td || (cols && cols !== th)) {
    misaligned.push(`th=${th} td=${td}${cols ? ` col=${cols}` : ""} · ${head.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 44)}`);
  }
}
misaligned.length ? fail("table alignment", misaligned.join(" | "))
                  : ok("table alignment", `${tableCount} tables consistent`);

// ---------------------------------------------------------------- escaping
// Upstream text inside an HTML attribute must be escaped or a quote breaks out.
const attrRisk = [];
for (const mm of html.matchAll(/(?:title|data-tip)="([^"]*\$\{[^"]*)"/g)) {
  const expr = mm[1];
  for (const inner of expr.matchAll(/\$\{([^}]*)\}/g)) {
    const code = inner[1];
    if (!/\b(name|goal|centre|center|channel|pkg|package|label|campaign|objective|excerpt)\b/i.test(code)) continue;
    if (/esc\(/.test(code)) continue;
    attrRisk.push(code.trim().slice(0, 56));
  }
}
attrRisk.length ? fail("attribute escaping", attrRisk.join(" | "))
                : ok("attribute escaping", "upstream text escaped in attributes");

console.log(failures ? `\n${failures} audit check(s) failed` : "\nstatic audit clean");
process.exit(failures ? 1 : 0);
