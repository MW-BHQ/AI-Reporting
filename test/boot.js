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
  /**
   * All nine, because the AI card renders one scorecard per key event and a
   * short list would silently produce a short grid. Three are zero on purpose:
   * a key event that did not fire still gets a card.
   */
  const allNineEvents = [
    { id: "view_item", label: "View item", value: 1500 },
    { id: "contact_us", label: "Contact us", value: 812 },
    { id: "appointments", label: "Appointments", value: 336 },
    { id: "find_doctors", label: "Find doctors", value: 266 },
    { id: "add_to_cart", label: "Add to cart", value: 15 },
    { id: "view_cart", label: "View cart", value: 11 },
    { id: "purchase", label: "Purchase", value: 0 },
    { id: "better_ai_start", label: "Better AI start", value: 0 },
    { id: "better_ai_result", label: "Better AI result", value: 0 },
  ];
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
      keywords: { rows: [{ keyword: "hospital near me", users: 300, below: null }],
        brandCount: 4, brandUsers: 900, totalUsers: 1200 } })),
    gbp: { available: true,
      byBrand: KEYS.map((k) => ({ key: k, label: k, impressions: 1000, calls: 10, website: 5, directions: 20,
        listings: [k], reviews: { count: 3, stars: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 }, avg: 4.7 } })),
      shared: null, unlisted: null,
      reviewsByBrand: KEYS.map((k) => ({ key: k, label: k, count: 12, avg: 4.6,
        stars: { 1: 0, 2: 1, 3: 1, 4: 3, 5: 7 }, replyRate: 0.75, replied: 9,
        lifetime: { total: 900, avg: 4.7 },
        mixToDate: { 1: 1, 2: 1, 3: 2, 4: 5, 5: 11 },
        monthly: [{ month: "2026-06", count: 8, avg: 4.5, s1:0,s2:1,s3:1,s4:2,s5:4 },
                  { month: "2026-07", count: 12, avg: 4.6, s1:1,s2:0,s3:1,s4:3,s5:7 }],
        samples: [{ stars: 5, when: "2026-07-20", reviewer: "A", comment: "excellent care", replied: true },
                  null, { stars: 3, count: 2, comment: null },
                  { stars: 2, when: "2026-07-10", reviewer: "B", comment: "long wait", replied: false }, null],
        })) },
    facebook: {
      page: { impressions: 15561576, organicReach: 900000, engagements: 230339,
        followers: 379931, newFollows: 196 },
      visits: 17600, engaged: 9000, actionsTotal: 9090,
      actions: [{ id: "view_item", label: "View item", value: 7660, mom: 0.1 },
                { id: "contact_us", label: "Contact us", value: 772, mom: -0.05 }],
      byBrand: KEYS.map((k) => ({ key: k, label: k, spend: 253325, reach: 6900661,
        impressions: 7000000, clicks: 123277, engagements: 304989,
        cpr: 0.036, cpe: 0.83, cpc: 2.05, accounts: [k + " x ADA"] })),
      shared: null },
    /**
     * One brand deliberately has NO search-ads data (WSH), so the empty-state
     * path renders rather than only ever the populated one, and the
     * unattributed line is present so its markup is executed too.
     */
    searchAds: { available: true,
      byBrand: KEYS.map((k) => ({ key: k, label: k,
        impressions: k === "WSH" ? 0 : 2750, clicks: k === "WSH" ? 0 : 152,
        spend: k === "WSH" ? 0 : 900, ctr: k === "WSH" ? null : 0.055,
        visits: k === "WSH" ? 0 : 100, actionsTotal: k === "WSH" ? 0 : 8,
        actions: events,
        terms: k === "WSH" ? []
          : [{ term: "bmi", impressions: 500, clicks: 30, spend: 100, ctr: 0.06 }] })),
      unattributed: { impressions: 60900, clicks: 4546, spend: 5800,
        campaigns: ["260710-03_bcm_tra", "rightchoice-google-reserve"] } },
    /**
     * One referrer above the site average and one below, so both the green and
     * red quality branches render. The AI block carries a source GA4 filed
     * under two different channels, which is the case the last column exists
     * for.
     */
    referral: { byBrand: KEYS.map((k) => ({ key: k, label: k,
      referrers: [
        { source: "pantip.com", channel: "Referral", sessions: 400, engaged: 340, actions: 30,
          engagementRate: 0.85, actionsPer100: 7.5, blacklisted: false,
          events: { find_doctors: 12, appointments: 9, contact_us: 5, view_item: 4, add_to_cart: 0 } },
        // Traffic but no actions at all: the "a link, not a referral" case, and
        // it proves a zero renders as 0 rather than blank or NaN.
        { source: "bounce.example", channel: "Referral", sessions: 300, engaged: 60, actions: 1,
          engagementRate: 0.20, actionsPer100: 0.33, blacklisted: false, events: {} },
        { source: "bangkokhospital.com", channel: "Referral", sessions: 900, engaged: 500, actions: 12,
          engagementRate: 0.56, actionsPer100: 1.3, blacklisted: true,
          events: { find_doctors: 3, appointments: 1, contact_us: 8, view_item: 0, add_to_cart: 0 } }],
      referrerCount: 3, blacklistedCount: 1, blacklistActive: true,
      totals: { sessions: 700, engaged: 400, actions: 31, engagementRate: 0.57, actionsPer100: 4.4 },
      totalsAll: { sessions: 1600, engaged: 900, actions: 43, engagementRate: 0.56, actionsPer100: 2.7 },
      ai: { rows: [
          { source: "chatgpt.com", channel: "AI Assistant, Organic Search, Referral", sessions: 120,
            engaged: 100, actions: 14, engagementRate: 0.83, actionsPer100: 11.7,
            events: { view_item: 8, contact_us: 3, appointments: 2, find_doctors: 1 } },
          { source: "perplexity.ai", channel: "AI Assistant", sessions: 30, engaged: 22, actions: 2,
            engagementRate: 0.73, actionsPer100: 6.7, events: { view_item: 2 } }],
        totals: { sessions: 150, engaged: 122, actions: 16, engagementRate: 0.81, actionsPer100: 10.7 },
        actions: allNineEvents,
        // Split across both signals, so the note cannot report one as zero
        // and pass — and 96 + 54 must equal the 150 total.
        nativeSessions: 96, namedSessions: 54,
        referralSessions: 90, referralSessionsAll: 150,
        shareOfReferral: 0.129, shareOfReferralAll: 0.094, siteShare: 0.0075 },
      site: { sessions: 20000, engaged: 11000, actions: 600,
        engagementRate: 0.55, actionsPer100: 3.0 } })) },
    /**
     * `top.favorites` is null and one card has no thumbnail, so the two
     * fallback branches in the Top performances grid are exercised rather than
     * assumed — a missing winner and a missing image are both normal.
     */
    tiktok: { available: true,
      channel: { views: 96941, reach: 17897, profileViews: 1868,
        likes: 1855, comments: 30, shares: 357, bioLinkClicks: 30, phoneClicks: 8,
        daily: [{ d: "2026-07-15", views: 66941 }, { d: "2026-07-16", views: 30000 }],
        accounts: ["Bangkok Hospital"] },
      top: { available: true, videoCount: 4, minRateViews: 100,
        views: { id: "v1", caption: "clinic tour", thumb: "https://cdn.test/v1.jpg",
          views: 12608, likes: 210, comments: 11, shares: 46, favorites: 20 },
        comments: { id: "v1", caption: "clinic tour", thumb: "", views: 12608, comments: 11 },
        shares: { id: "v1", caption: "clinic tour", thumb: "https://cdn.test/v1.jpg", views: 12608, shares: 46 },
        favorites: null,
        likeRate: { id: "v2", caption: "check-up tips", thumb: "", views: 4200, rate: 0.0269 },
        commentRate: { id: "v3", caption: "packages", thumb: "https://cdn.test/v3.jpg", views: 2000, rate: 0.001 },
        shareRate: { id: "v1", caption: "clinic tour", thumb: "https://cdn.test/v1.jpg", views: 12608, rate: 0.0036 },
        favoriteRate: { id: "v3", caption: "packages", thumb: "", views: 2000, rate: 0.006 } } },
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
      /**
       * A slide count alone cannot tell a rendered block from one that fell
       * through to its "unavailable" branch — the section still exists, just
       * empty. These assert the DATA reached the markup.
       */
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const present = (name, needle) => text.includes(needle)
        ? ok(name, "rendered") : fail(name, `"${needle}" missing from the report`);
      present("search ads rendered", "the keywords we bid on");
      present("referral rendered", "Back links, and how good is the traffic");
      /**
       * Checked against THIS table's header row, not the page text: the label
       * "Appointments" appears in several other Actions tables, so deleting a
       * column here still left a loose text match passing.
       */
      (() => {
        const want = ["Source", "Sessions", "Find Doctor", "Appointments",
                      "Contact us", "View Item", "Add to cart"];
        const tables = [...(root ? root.querySelectorAll(".card") : [])]
          .filter(c => (c.textContent || "").includes("Back links, and how good"));
        const tbl = tables.length ? tables[0].querySelector("table") : null;
        if (!tbl) return fail("referral five columns", "back links table not found");
        const got = [...tbl.querySelectorAll("thead th")].map(th => th.textContent.trim());
        got.join("|") === want.join("|")
          ? ok("referral five columns", got.length + " columns in MW's order")
          : fail("referral five columns", `headers are ${got.join(", ")}`);
      })();
      present("referral ai spotlight", "AI assistants (LLMs)");
      present("referral ai source", "chatgpt.com");
      /**
       * The AI card is 10 scorecards (Sessions + all nine key events) in two
       * rows of five, and its table carries the same nine as columns. Queried
       * through the card's own DOM, because these labels appear in other
       * tables too — a loose text match gave a false pass in v3.103.0.
       */
      (() => {
        const card = [...(root ? root.querySelectorAll(".card") : [])]
          .find(c => (c.querySelector(".card-title") || {}).textContent === "AI assistants (LLMs)");
        if (!card) return fail("ai card layout", "AI card not found");
        const rows = [...card.querySelectorAll(".grid.g-5")];
        // `.mini` is the styled scorecard added in v3.105.0; `.stat` is the
        // plain one. Both counted, so restyling cannot silently drop a card.
        const cards = rows.reduce((a, r) => a + r.querySelectorAll(".mini, .stat, .kpi").length, 0);
        const th = [...card.querySelectorAll("thead th")].map(t => t.textContent.trim());
        if (rows.length !== 2) return fail("ai card layout", `${rows.length} scorecard rows, expected 2`);
        if (cards !== 10) return fail("ai card layout", `${cards} scorecards, expected 10`);
        if (th.length !== 11) return fail("ai card layout", `${th.length} columns, expected 11`);
        // The three columns MW removed must be gone from THIS table.
        const banned = th.filter(h => /engagement|actions \/ 100|ga4 channel/i.test(h));
        banned.length
          ? fail("ai card layout", `removed column still present: ${banned.join(", ")}`)
          : ok("ai card layout", "2\u00d75 scorecards, 11 columns, none removed");
      })();
      // The switch must exist, and the blacklisted row must be in the DOM
      // (hidden by CSS) rather than dropped — the toggle has to reveal it.
      present("blacklist switch", "Hide blacklisted referrers");
      present("blacklisted row present", "bangkokhospital.com");
      (() => {
        const wrap = root && root.querySelector('[data-blwrap]');
        const box = root && root.querySelector('[data-blacklist]');
        const row = root && root.querySelector('.bl-row');
        if (!wrap || !box || !row) return fail("blacklist wiring", "wrapper, switch or flagged row missing");
        if (!box.checked) return fail("blacklist wiring", "blacklist is not on by default");
        if (wrap.classList.contains('bl-hidden')) return fail("blacklist wiring", "starts in the off state");
        box.checked = false;
        box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        wrap.classList.contains('bl-hidden')
          ? ok("blacklist wiring", "toggles both ways")
          : fail("blacklist wiring", "switch did not reveal blacklisted rows");
        box.checked = true;
        box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      })();
      // Referral must sit BEFORE Search in MW's sequence.
      text.indexOf("Back links") > 0 && text.indexOf("Back links") < text.indexOf("Search \u00b7 Thai")
        ? ok("referral before search", "ordered")
        : fail("referral before search", "Referral is not ahead of the Search pages");
      // Removed at MW's request in v3.100.1.
      text.includes("not attributed to a hospital")
        ? fail("unattributed card removed", "still rendering")
        : ok("unattributed card removed", "gone");
      present("tiktok channel rendered", "daily reached audience");
      present("tiktok clicks rendered", "Bio link clicks");
      present("tiktok top rendered", "Top like rate");
      /**
       * The presence checks above can pass on a needle that also appears
       * elsewhere, so assert the fallback branches did NOT fire. This pair
       * caught a Search Ads needle that was really matching the GBP block.
       */
      const absent = (name, needle) => text.includes(needle)
        ? fail(name, `fell through to "${needle}"`) : ok(name, "built from data");
      absent("search ads not fallback", "Google Ads is unavailable");
      absent("tiktok not fallback", "TikTok is unavailable");
      // The title must follow the open tab, not read BHQ (MW, v3.100.0).
      /Search Ads · BGH/.test(text)
        ? ok("search ads titled BGH", "per hospital")
        : fail("search ads titled BGH", "title is not per hospital");
      // Nothing above the divider may claim the shared accounts are one
      // hospital's, and the retired slide must be gone.
      text.includes("Organic social")
        ? fail("organic social retired", "superseded slide still renders")
        : ok("organic social retired", "gone");
      /**
       * Platform marks on slide titles, and icons sourced from the SHARED set.
       * Counted through the DOM: a monogram with no `.plogo` wrapper, or a mini
       * card whose label has no <svg>, is the inconsistency MW asked to remove.
       */
      (() => {
        const marks = [...(root ? root.querySelectorAll(".slide-title .plogo") : [])];
        /**
         * Each platform asserted BY NAME. A "6 or more" count passed when the
         * Facebook mark was deleted, because other slides made up the number —
         * a threshold cannot tell which mark went missing.
         */
        const want = ["Google", "Business Profile", "Facebook", "Meta", "TikTok",
                      "Google Ads", "Analytics"];
        const seen = new Set(marks.map(m => m.getAttribute("title")));
        const missing = want.filter(w => !seen.has(w));
        if (missing.length) return fail("platform marks", `no mark for: ${missing.join(", ")}`);
        // Every mark must have both states: a real logo file and the monogram
        // beneath it, so a missing asset degrades instead of leaving a gap.
        const complete = marks.every(m => m.querySelector("img") && m.querySelector("b"));
        if (!complete) return fail("platform marks", "a mark is missing its image or monogram");
        const minis = [...(root ? root.querySelectorAll(".mini") : [])];
        const withIcon = minis.filter(m => m.querySelector(".lab svg")).length;
        // The Sessions card plus nine key events all carry an icon.
        minis.length && withIcon === minis.length
          ? ok("platform marks", `${want.length} platforms, ${minis.length} mini cards all iconed`)
          : fail("platform marks", `${withIcon}/${minis.length} mini cards have a shared icon`);
      })();
      finish();
    }, 500);
  }
}, 1200);

function finish() {
  console.log(failures ? `\n${failures} boot check(s) failed` : "\nclient boots clean");
  process.exit(failures ? 1 : 0);
}
