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

/** A report payload with every key the renderer reads, one row deep. */
function reportFixture() {
  const KEYS = ["BGH", "BIH", "BHT", "WSH"];
  const events = [{ id: "find_doctors", label: "Find doctors", value: 5 },
                  { id: "view_item", label: "View item", value: 3 }];
  const brand = (key) => ({ key, label: key, sessions: 100, engaged: 60, keyEvents: 8,
    channels: [{ channel: "Organic Search", sessions: 80, engaged: 50 }],
    keyEventBreakdown: events, meta: { spend: 10, impressions: 100, clicks: 5, accounts: [key + " x ADA"] },
    unavailable: false });
  const langRow = { key: "th", label: "Thai", views: 50, sessions: 40, revenue: 0,
    events: { find_doctors: 5, view_item: 3 } };
  const searchRow = { key: "th", label: "Thai", impressions: 900, clicks: 40, visits: 40,
    actionsTotal: 8, actions: events,
    terms: [{ query: "bmi", impressions: 500, clicks: 30, ctr: 0.06, position: 1.2 }] };
  const perBrandMap = (v) => Object.fromEntries([...KEYS, "BHQ"].map((k) => [k, v]));
  return {
    range: { from: "2026-07-01", to: "2026-07-31" },
    bhq: { key: "BHQ", label: "BHQ", sessions: 400, engaged: 240, keyEvents: 32,
      channels: [{ channel: "Organic Search", sessions: 320, engaged: 200 }],
      keyEventBreakdown: events, meta: { spend: 40, impressions: 400, clicks: 20, accounts: ["BGH x ADA"] } },
    brands: KEYS.map(brand),
    usersOverview: { months: ["2026-06", "2026-07"],
      series: KEYS.map((k) => ({ key: k, label: k, data: [90, 100] })),
      total: 400, mom: 0.1, yoy: -0.2,
      byBrand: KEYS.map((k) => ({ key: k, label: k, sessions: 100, mom: 0.1, yoy: -0.2 })),
      windows: { prev: { from: "2026-06-01", to: "2026-06-30" }, yoy: { from: "2025-07-01", to: "2025-07-31" } } },
    countries: KEYS.map((k) => ({ key: k, label: k,
      rows: [{ country: "Japan", sessions: 20, mom: 0.05 }] })),
    channelsByBrand: KEYS.map((k) => ({ key: k, label: k,
      rows: [{ channel: "Organic Search", sessions: 80, mom: 0.02 }] })),
    languageMatrix: { available: true,
      locales: [{ code: "TH", label: "Thai", key: "th" }],
      rows: KEYS.map((k) => ({ key: k, label: k, cells: [{ key: "th", sessions: 40, mom: 0.1 }] })) },
    actionsByLanguage: perBrandMap([langRow]),
    searchByLanguage: perBrandMap([searchRow]),
    gbpDetail: KEYS.map((k) => ({ key: k, label: k, listing: k + " Hospital",
      totals: { impressions: 1000, mobileSearch: 500, mobileMaps: 300, desktopSearch: 150, desktopMaps: 50,
        calls: 10, website: 5, directions: 20 },
      mom: { impressions: 0.1, calls: 0.2, website: -0.1, directions: 0.05 },
      daily: [{ d: "2026-07-14", impressions: 500, mobileSearch: 250, mobileMaps: 150,
        desktopSearch: 75, desktopMaps: 25, calls: 5, website: 2, directions: 10 }],
      keywords: [{ keyword: "hospital near me", impressions: 300 }] })),
    gbp: { available: true,
      byBrand: KEYS.map((k) => ({ key: k, label: k, impressions: 1000, calls: 10, website: 5, directions: 20,
        listings: [k], reviews: { count: 3, stars: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 }, avg: 4.7 } })),
      shared: null, unlisted: null,
      reviewsAll: { count: 12, stars: { 1: 0, 2: 0, 3: 1, 4: 3, 5: 8 }, avg: 4.6 } },
    searchTerms: [{ term: "bmi", impressions: 500, clicks: 30, spend: 100, ctr: 0.06 }],
    social: { facebook: { reach: 1000, engagements: 50 },
      tiktok: { views: 900, likes: 40, comments: 5, shares: 8 } },
    shared: { meta: { spend: 20, impressions: 200, clicks: 10, accounts: ["BHQ x AIQ"] }, note: "shared" },
    unmapped: { spend: 7, impressions: 70, clicks: 3, accounts: ["Some New Account"] },
    unit: "sessions",
  };
}
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
    /**
     * Enough of a server to get through boot AND to render the heaviest view.
     *
     * Rendering only the empty Overview missed a whole class of break: a
     * builder removed while a reference to it survived ("chip is not defined")
     * parses fine, boots fine, and throws the moment real data arrives. The
     * report payload below carries every key the renderer touches, so the
     * template is actually executed end to end.
     */
    const REPORT = reportFixture();
    w.fetch = (url) => {
      const u = String(url || "");
      const body = u.includes("/api/report") ? REPORT : {
        tabs: ["overview", "report"], allTabs: [], admins: [], defaultTabs: [],
        version: "test", isAdmin: false, users: [],
      };
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    };
    w.print = () => {};
    // Chart.js is a CDN script JSDOM does not load, and the app already
    // degrades cleanly. Muting the expected noise keeps a REAL error visible
    // instead of buried in identical stack traces.
    const realErr = w.console.error;
    w.console.error = (...a) => {
      if (String(a[0] || "").includes("chart library unavailable")) return;
      if (String(a[0] || "").startsWith("chart failed")) return;
      realErr.apply(w.console, a);
    };
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

  /**
   * Render the heaviest view for real. Overview with no data exercises almost
   * none of the template; the report renderer is where the removals and
   * refactors land, and a dead identifier there only throws once data arrives.
   */
  const bgh = d.querySelector('.nav-item[data-view="report"][data-brand="BGH"]');
  if (!bgh) {
    fail("report nav present", "no BGH item under Monthly Reports");
    finish();
  } else {
    errors.length = 0;
    bgh.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    setTimeout(() => {
      const root = d.getElementById("viewRoot");
      const html = root ? root.innerHTML : "";
      errors.length ? fail("report renders", errors.slice(0, 2).join(" | "))
                    : ok("report renders", `${Math.round(html.length / 1024)}kb`);
      /^[\s\S]*Something went wrong[\s\S]*$/.test(html)
        ? fail("report has no error state", html.replace(/<[^>]+>/g, " ").slice(0, 120))
        : ok("report has no error state", "");
      const slides = root ? root.querySelectorAll(".slide, .lang-page").length : 0;
      slides >= 8 ? ok("report slides", `${slides} sections`)
                  : fail("report slides", `only ${slides} rendered`);
      finish();
    }, 500);
  }
}, 1200);

function finish() {
  console.log(failures ? `\n${failures} boot check(s) failed` : "\nclient boots clean");
  process.exit(failures ? 1 : 0);
}
