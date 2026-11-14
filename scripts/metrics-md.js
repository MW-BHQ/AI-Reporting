#!/usr/bin/env node
/**
 * docs/metrics.md from public/metrics.json (v3.424.0). The JSON is the one
 * source: the (i) panel on each tab reads it, and this writes the same text as
 * a document the team can read or print. `--check` fails if the doc is stale.
 */
const fs = require("fs");
const path = require("path");
const src = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/metrics.json"), "utf8"));
const out = ["# BHQ War Room · metric dictionary", "",
  "_Generated from `public/metrics.json` by `node scripts/metrics-md.js`. Edit the JSON, not this file._", ""];
for (const [view, m] of Object.entries(src)) {
  if (view.startsWith("_")) continue;
  out.push(`## ${m.title}`, "", "| Metric | What it means | How it is worked out | Source |", "|---|---|---|---|");
  for (const [name, means, how, from] of m.items) out.push(`| ${[name, means, how, from].map((x) => String(x).replace(/\|/g, "\\|")).join(" | ")} |`);
  out.push("");
}
const text = out.join("\n");
const file = path.join(__dirname, "../docs/metrics.md");
if (process.argv.includes("--check")) {
  const ok = fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
  console.log(ok ? "  ok   metrics doc in sync" : "  FAIL metrics doc stale: run node scripts/metrics-md.js");
  process.exit(ok ? 0 : 1);
}
fs.writeFileSync(file, text);
console.log(`wrote ${file}`);
