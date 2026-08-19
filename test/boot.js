/**
 * Boots the client in a headless DOM.
 *
 * This exists because a stray duplicate `innerHTML =` once left a template
 * literal unterminated, which is a SYNTAX error: the whole script fails to
 * parse, so every tab renders blank and the date inputs never initialise. Both
 * the smoke test and the static audit passed, because neither one executes the
 * client. Parsing it is the only way to catch that class of break.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const file = path.join(__dirname, "..", "public", "index.html");
const html = fs.readFileSync(file, "utf8");

let failures = 0;
const ok = (n, d) => console.log(`  ok   ${n.padEnd(30)} ${d || ""}`);
const fail = (n, d) => { failures++; console.log(`  FAIL ${n.padEnd(30)} ${d}`); };

// ---- 1. does the inline script even parse?
const start = html.lastIndexOf("<script>");
const end = html.lastIndexOf("</script>");
const js = html.slice(start + 8, end);
try {
  new Function(js);
  ok("client parses", `${Math.round(js.length / 1024)}kb`);
} catch (err) {
  fail("client parses", String(err.message).slice(0, 120));
  console.log(`\n${failures} boot check(s) failed`);
  process.exit(1);
}

// ---- 2. does it run without throwing, and initialise itself?
const errors = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(w) {
    // Enough of a server to get through boot: /api/me decides the tab list.
    w.fetch = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        tabs: ["overview"], allTabs: [], admins: [], defaultTabs: [],
        version: "test", isAdmin: false, users: [],
      }),
      text: () => Promise.resolve("{}"),
    });
    w.print = () => {};
    w.addEventListener("error", (e) => errors.push(e.message || String(e.error)));
    w.addEventListener("unhandledrejection", (e) =>
      errors.push(`unhandled rejection: ${e.reason && e.reason.message}`));
  },
});

setTimeout(() => {
  const d = dom.window.document;
  errors.length ? fail("client runs", errors.slice(0, 2).join(" | ")) : ok("client runs", "no thrown errors");

  // The date range is set during boot; empty inputs mean boot stopped early.
  const from = d.getElementById("from");
  const to = d.getElementById("to");
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(from && from.value) && /^\d{4}-\d{2}-\d{2}$/.test(to && to.value);
  dated ? ok("date range initialised", `${from.value} → ${to.value}`)
        : fail("date range initialised", `from="${from && from.value}" to="${to && to.value}" — boot stopped before setLastMonth()`);

  const nav = d.querySelectorAll(".nav-item[data-view]").length;
  nav > 0 ? ok("nav rendered", `${nav} items`) : fail("nav rendered", "no nav items");

  // Scope is an e-commerce filter and must not appear on Overview.
  const seg = d.getElementById("scopeSeg");
  seg && seg.classList.contains("hidden")
    ? ok("scope hidden on overview", "")
    : fail("scope hidden on overview", "scope switch is visible where it does nothing");

  console.log(failures ? `\n${failures} boot check(s) failed` : "\nclient boots clean");
  process.exit(failures ? 1 : 0);
}, 1200);
