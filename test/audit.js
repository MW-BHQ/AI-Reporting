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
    // Anchored to the arrow-function formatter, and GLOBAL: a `const pct`
    // declared earlier in the file used to consume the single replacement and
    // leave the real formatter flagged (hit in v3.100.0). Order must not
    // decide whether this rule passes.
    /const pct = \(v\) => [^;]+;/g,
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

/**
 * A SECOND Y-AXIS MUST BE CONDITIONAL ON A SERIES ASKING FOR IT.
 *
 * `y1` was declared unconditionally in `drawChart`. Chart.js renders an axis
 * with no dataset assigned to it and, having nothing to scale against, labels it
 * 0.0 to 1.0 — so four of the eleven charts carried an empty right-hand scale
 * that reads to an executive as missing data. It shipped for weeks because
 * nothing throws and the chart is otherwise correct.
 *
 * Static rather than a boot check: Chart.js is not available under jsdom, so
 * `drawChart` takes its catch branch there and a rendered-axis assertion would
 * pass whatever the config said.
 */
{
  const dc = html.slice(html.indexOf("function drawChart("));
  const body = dc.slice(0, dc.indexOf("\n}"));
  const declaresY1 = /\by1\s*:/.test(body);
  const guarded = /series\s*\.some\(\s*\(?\s*s\s*\)?\s*=>\s*s\.axis\s*===\s*'y1'\s*\)/.test(body);
  !declaresY1
    ? ok("charts:no-phantom-axis", "drawChart declares no second axis")
    : (guarded
      ? ok("charts:no-phantom-axis", "y1 is declared only when a series requests it")
      : fail("charts:no-phantom-axis",
        "drawChart declares y1 unconditionally — single-series charts will render an empty 0-1 axis"));
}

/**
 * TYPE SCALE — font sizes come from the scale in `:root`, not from one-off px.
 *
 * MW asked for Tailwind-shaped rem steps precisely so a size is changed in one
 * place. A `font-size:13px` dropped into a new block silently opts out of that
 * and drifts from everything around it.
 *
 * Only the report's own component styles are checked; the app chrome, print
 * block and responsive overrides predate the scale and are exempted by name
 * rather than being quietly ignored.
 */
{
  const styleBlock = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  /**
   * ALLOWLIST, not a blocklist. The app chrome still carries 80-odd px sizes
   * that predate the scale, and converting them wholesale in one pass would be
   * a large untested change to screens nobody asked about. This guards the
   * Monthly Reports components that HAVE been migrated, so they cannot drift
   * back; extend the list as other areas move over.
   */
  /**
   * APP CHROME joined the scale in v3.134.0 — brand, nav, rail footer, AI badge.
   *
   * It was left out originally because the scale stopped at 11px and the rail
   * genuinely uses 10px micro-labels, so there was nothing to migrate TO. Adding
   * `--text-3xs` closed that gap; these selectors are now enforced, because the
   * rail is the one place a stray px is least likely to be noticed by eye.
   */
  const SCOPED = /^\s*\.(slide-title|note|stat|mini|cbc|cbc-\w+|card-title|cb-\w+|lang-tab|clang-tab|brand-name|brand-sub|nav-label|nav-group|nav-item|ai-badge|rail-foot|subtitle|dates|btn|status|seg(?![\w-]))\b|^\s*(?:table|h1)\{/;
  /**
   * @media blocks are skipped by tracking brace depth, not by testing the line
   * for "@media" — the overrides live INSIDE the block, on lines that never
   * mention it, so a per-line test reported ten offenders that were all
   * legitimate print and responsive rules.
   */
  const offenders = [];
  let mediaDepth = 0, inMedia = false;
  for (const line of styleBlock.split("\n")) {
    if (/@media/.test(line)) { inMedia = true; mediaDepth = 0; }
    if (inMedia) {
      mediaDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (mediaDepth <= 0) inMedia = false;
      continue;
    }
    if (SCOPED.test(line) && /font-size:\s*[\d.]+px/.test(line)) {
      offenders.push(line.trim().slice(0, 60));
    }
  }
  offenders.length
    ? fail("type:scale", `${offenders.length} px font-size outside the scale: ${offenders[0]}`)
    : ok("type:scale", "report font sizes all come from the rem scale");
}

console.log(failures ? `\n${failures} audit check(s) failed` : "\nstatic audit clean");
process.exit(failures ? 1 : 0);
