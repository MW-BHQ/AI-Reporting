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

// ---------------------------------------------------------------- build stamp
// The client carries its own version so a partial deploy (new server, old page)
// announces itself. That only works if the stamp is bumped with package.json.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const stamp = (html.match(/const CLIENT_BUILD = '([\d.]+)'/) || [])[1];
!stamp ? fail("build stamp", "CLIENT_BUILD not found in index.html")
  : stamp !== pkg.version
    ? fail("build stamp", `index.html says ${stamp}, package.json says ${pkg.version}`)
    : ok("build stamp", `client and package agree at ${stamp}`);

// ---------------------------------------------------------------- release log
// A version bump that silently fails produces a "new" release whose files are
// byte-identical to the last one — git then creates no commit and the deploy
// looks stuck. CONTEXT.md must mention the current version, which only happens
// if the release was actually written up.
const ctx = fs.readFileSync(path.join(root, "CONTEXT.md"), "utf8");
const major = pkg.version.split(".").slice(0, 2).join(".");
ctx.includes(pkg.version) || ctx.includes(`v${major} `)
  ? ok("release documented", `CONTEXT.md mentions ${pkg.version.startsWith(major) ? "v" + major : pkg.version}`)
  : fail("release documented", `CONTEXT.md has no entry for v${pkg.version}`);

// ---------------------------------------------------------------- palette
// The rule worth enforcing is semantic separation, not a particular brand hue:
// a category colour must never be the same as the up/down indicators, because
// green once meant both "Offline" and "improving" on the same screen.
const SEMANTIC = ["2E9E6F", "D9534F"];              // up, down
const typeBlock = html.match(/const TYPE_COLORS = \{([\s\S]*?)\};/);
if (!typeBlock) fail("palette:types", "TYPE_COLORS not found");else {
  const hexes = [...typeBlock[1].matchAll(/#([0-9A-Fa-f]{6})/g)].map((m) => m[1].toUpperCase());
  const clash = hexes.filter((x) => SEMANTIC.includes(x));
  const dupes = hexes.filter((x, i) => hexes.indexOf(x) !== i);
  clash.length ? fail("palette:types", `category reuses an up/down colour: #${clash.join(", #")}`)
    : dupes.length ? fail("palette:types", `duplicate category colours: #${dupes.join(", #")}`)
    : ok("palette:types", `${hexes.length} distinct, none semantic`);
}
// The monthly report is styled from tokens so it stays in step with the rest of
// the app; a stray navy or maroon means the old Looker palette crept back in.
const mrBlock = html.slice(html.indexOf("monthly report (print-first)"), html.indexOf(".dlt{display:inline-block;"));
const strays = [...mrBlock.matchAll(/#(1F3864|9E2A2B|2E4F86|3E66A8)\b/g)].map((m) => m[0]);
strays.length ? fail("palette:monthly", `legacy report hues in the monthly styles: ${[...new Set(strays)].join(", ")}`)
              : ok("palette:monthly", "monthly report uses house tokens");

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

/**
 * Every percentage CHANGE must go through changeText(), which caps runaway
 * values at ">10x". Four renderers formatted this independently until v3.61.1,
 * and the Pages tab shipped "+42867%" as its largest figure because one of them
 * had no cap. A fifth added later would reintroduce it silently.
 *
 * Two formatters are sanctioned and exempt: changeText() itself, and pct(),
 * which renders RATES and SHARES — those legitimately run 0-100% and must not
 * be capped. Bar widths always divide by a max, so they never match.
 */
{
  const exempt = [
    // Anchored to the arrow-function formatter: there are other locals called
    // `pct` earlier in the file, and a loose pattern removes one of those and
    // leaves the real one flagged.
    /const pct = \(v\) => [^;]+;/,
    /function changeText\([\s\S]*?\n\}/,
  ];
  let scan = html;
  for (const re of exempt) scan = scan.replace(re, "");
  const raw = [...scan.matchAll(/\(\s*(?:Math\.abs\()?\s*([A-Za-z_$][\w.$]*)\s*\*\s*100\s*\)?\s*\)\.toFixed\(/g)]
    .map((m) => m[1])
    // Rates, not changes: a CTR or a share legitimately renders as a raw
    // percentage and must not be capped at ">10x".
    // Rates and shares render as raw percentages by definition and must not be
    // capped at ">10x". Matches any identifier ending in Rate/Ratio/Share/Pct
    // as well as the bare names, so replyRate and ctr are both covered.
    .filter((v) => !/^(frac|share|pct)$/i.test(v)
                && !/(ctr|rate|ratio|share|pct)$/i.test(v.split(".").pop()));
  raw.length
    ? fail("change:capped", `percentage change rendered outside changeText(): ${raw.join(", ")}`)
    : ok("change:capped", "all change renderers routed through changeText()");
}


/**
 * A drawChart/drawBars call whose canvas no longer exists is silent at runtime:
 * the helper returns early, no error, no chart, nobody notices. It has happened
 * three times while removing superseded blocks, so it is a check rather than a
 * habit. Template-literal ids are skipped — those are generated per row.
 */
{
  const canvases = new Set([...html.matchAll(/<canvas id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const targets = [...html.matchAll(/draw(?:Chart|Bars)\(\s*['"]([A-Za-z0-9_-]+)['"]/g)].map((m) => m[1]);
  const orphans = [...new Set(targets.filter((t) => !canvases.has(t)))];
  orphans.length
    ? fail("charts:wired", `draw call with no canvas: ${orphans.join(", ")}`)
    : ok("charts:wired", `${targets.length} draw calls all have canvases`);
}

console.log(failures ? `\n${failures} audit check(s) failed` : "\nstatic audit clean");
process.exit(failures ? 1 : 0);
