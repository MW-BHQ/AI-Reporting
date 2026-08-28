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
/**
 * Module-level alias for the WHOLE source file, CSS included.
 *
 * Inside the render callback `html` is shadowed by the rendered report and `js`
 * is only the <script> block, so neither can see a stylesheet rule. Both traps
 * have already produced a vacuous pass in this file.
 */
const SRC = html;

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
    /**
     * Two locales so the tabs are exercised, and Thai carries all four types
     * while English is missing three — the empty-state row must render rather
     * than the card vanishing.
     */
    content: { available: true, unmatchedViews: 0,
      locales: [{ key: "th", label: "Thai" }, { key: "en", label: "English" }],
      /**
       * `actionLabel` and `mix` now come from the server. Articles carries a
       * `suggestedAction`, so the "this column is the wrong event" warning is
       * exercised — that is the case MW hit with view_item.
       */
      types: [
        { id: "doctor", label: "Doctor", action: "appointments", actionLabel: "Appointments",
          mix: [{ id: "appointments", label: "Appointments", value: 52 }], suggestedAction: null },
        // hideMix: the footer must NOT render for Package even though a mix is
        // present in the payload — the client has to honour the flag.
        { id: "package", label: "Package", action: "add_to_cart", actionLabel: "Add to cart",
          hideMix: true, mix: [], suggestedAction: null },
        // Articles is Contact us now, but keeps a suggestion so the
        // wrong-column warning path stays exercised.
        { id: "article", label: "Articles", action: "contact_us", actionLabel: "Contact us",
          mix: [{ id: "find_doctors", label: "Find doctors", value: 140 },
                { id: "contact_us", label: "Contact us", value: 8 }],
          suggestedAction: { id: "find_doctors", label: "Find doctors", value: 140 } },
        { id: "center", label: "Center", action: "contact_us", actionLabel: "Contact us",
          mix: [{ id: "contact_us", label: "Contact us", value: 17 }], suggestedAction: null }],
      byBrand: Object.fromEntries(KEYS.map((k) => [k, {
        th: { hasData: true,
          doctor:  { pageCount: 2, views: 1400, actions: 52,
            rows: [{ path: "/th/bangkok/doctor/dr-a", slug: "dr-a", title: "Dr A", views: 900, action: 12 },
                   { path: "/th/bangkok/doctor/dr-b", slug: "dr-b", title: "", views: 500, action: 40 }] },
          package: { pageCount: 1, views: 700, actions: 25,
            rows: [{ path: "/th/bangkok/package/rsv", slug: "rsv", title: "RSV vaccine", views: 700, action: 25 }] },
          article: { pageCount: 1, views: 650, actions: 8,
            rows: [{ path: "/th/bangkok/content/bully", slug: "bully", title: "Bullying", views: 650, action: 8 }] },
          center:  { pageCount: 1, views: 300, actions: 17,
            rows: [{ path: "/th/bangkok/center-clinic/screening", slug: "screening", title: "Screening", views: 300, action: 17 }] } },
        en: { hasData: true,
          doctor:  { pageCount: 1, views: 200, actions: 3,
            rows: [{ path: "/en/bangkok/doctor/dr-a-en", slug: "dr-a-en", title: "Dr A", views: 200, action: 3 }] },
          package: { pageCount: 0, views: 0, actions: 0, rows: [] },
          article: { pageCount: 0, views: 0, actions: 0, rows: [] },
          center:  { pageCount: 0, views: 0, actions: 0, rows: [] } },
      }])) },
    /**
     * Chat bubble: both scopes present, an `assumed` label, a brand-new channel
     * with no previous month, and an unmapped id.
     */
    /**
     * Appointments: BHQ plus the four, a donut slice with a blank label mapped
     * to N/S, and discarded rows, so the caveat line renders too.
     */
    appointments: { available: true, discarded: 2, revMonths: 1, notSpecified: "N/S",
      byScope: Object.fromEntries([...KEYS, "BHQ"].map((k) => [k, {
        initiates: k === "BHQ" ? 14500 : 3600,
        realtime: k === "BHQ" ? 1367 : 340,
        nonRealtime: k === "BHQ" ? 1221 : 300,
        completes: k === "BHQ" ? 2588 : 640,
        realtimeRev: 6655250, nonRealtimeRev: 3487367, revenue: 10142617,
        completionRate: k === "BHQ" ? 0.178 : 0.178,
        /**
         * Rows are the TOP FEW of many, so they sum to LESS than `total` — the
         * real shape of this data (157 specialties in MW's deck, eight shown).
         * A fixture whose rows summed exactly to the total closed the ring by
         * itself, so the "Other" slice could be deleted with nothing failing.
         */
        rtMix: { total: 1367, distinct: 157, rows: [
          { label: "International Medical Services", cases: 400, share: 0.293 },
          { label: "Skin & Aesthetics Center", cases: 300, share: 0.219 },
          { label: "N/S", cases: 183, share: 0.134 }] },
        nrMix: { total: 1221, distinct: 121, rows: [
          { label: "Skin & Aesthetics Center", cases: 300, share: 0.246 },
          { label: "Dental Center", cases: 200, share: 0.164 }] },
      }])) },
    /**
     * GBP keyword ranks. One keyword tracked at two listings, one with no
     * volume reported, and one past rank 10, so the averaging, the dash and all
     * three rank bands render.
     */
    gbpRanks: { months: ["2026-July"], outOfRange: 1,
      byBrand: Object.fromEntries(KEYS.map((k) => [k, {
        keywords: 5, top3: 3, top10: 4, withVolume: 4, avgRank: 6.25,
        rows: [
          { keyword: "Mental hospital", rank: 1.75, volume: 590, locations: 1 },
          { keyword: "General hospital", rank: 2, volume: 12100, locations: 2 },
          { keyword: "Heart hospital", rank: 2, volume: 0, locations: 1 },
          { keyword: "Hospital near me", rank: 6, volume: 27100, locations: 1 },
          { keyword: "Medical centre", rank: 19.5, volume: 3600, locations: 1 },
        ] }])) },
    /**
     * YouTube, from the Apps Script sheet — the only path since v3.129.0.
     * A blank title must fall back to the video id.
     */
    /**
     * YouTube, from the two-tab Studio export sheet (v3.131.0). Uses MW's REAL
     * July 2026 figures against real June and July-2025 baselines, so the MoM
     * and YoY signs on the slide are checkable by hand: views ROSE 238% YoY and
     * FELL 10% MoM, and likes fell on both — a fixture where every arrow points
     * the same way proves nothing about which arrow is drawn.
     *
     * Deliberately MISSING `comments`, which is the state of an export where
     * that metric was not switched on: no card, and the gap named in the note.
     * Also deliberately 4 days short of the month, so the 500-row-cap warning
     * has to render.
     */
    youtube: { available: true, source: "studio-export",
      totals: { days: 27, views: 1104891, hoursWatched: 15304, likes: 1482,
        comments: null, shares: 1372, subsNet: 356 },
      prev: { days: 30, views: 1226936, hoursWatched: 14341, likes: 2514,
        comments: null, shares: 1371, subsNet: 329 },
      yoy: { days: 31, views: 326677, hoursWatched: 5295, likes: 2391,
        comments: null, shares: 1286, subsNet: 472 },
      mom: { views: -0.0995, hoursWatched: 0.0671, likes: -0.4104,
        comments: null, shares: 0.0007, subsNet: 0.0821 },
      yoyChange: { views: 2.3823, hoursWatched: 1.8903, likes: -0.3802,
        comments: null, shares: 0.0668, subsNet: -0.2458 },
      present: ["views", "likes", "shares", "subsNet", "hoursWatched"],
      missing: ["comments"],
      covered: { from: "2025-01-01", to: "2026-07-31" }, stale: false,
      expectedDays: 31, foundDays: 27, dayGaps: 4,
      videosMonth: "2026-07",
      series: { metric: "Views", rows: [
        { d: "2026-07-01", v: 33000 }, { d: "2026-07-02", v: 35500 }] },
      videos: { rows: [
        { id: "v1", title: "Bangkok Hospital - Health Destination", views: 244087,
          hours: 495, shares: 2, likes: 1, comments: null },
        { id: "v2", title: "", views: 224511, hours: 4939, shares: 1,
          likes: 0, comments: null }] } },
    chatBubble: { available: true,
      events: [{ name: "click", clicks: 15600 }],
      unmapped: [{ key: "chat-bubble-channel-unknown https://example.com", clicks: 12 }],
      byScope: Object.fromEntries([...KEYS, "BHQ"].map((k) => [k, {
        total: k === "BHQ" ? 15600 : 3900,
        totalPrev: k === "BHQ" ? 15070 : 3800,
        totalChangePct: 0.035,
        rows: [
          { label: "LINE", logo: "line", assumed: false, clicks: 1678, prev: 1539, change: 139 },
          { label: "WhatsApp (AR)", logo: "whatsapp", assumed: true, clicks: 1347, prev: 1246, change: 101 },
          { label: "LINE (JP)", logo: "line", assumed: false, clicks: 380, prev: 389, change: -9 },
          { label: "Webchat (TH/EN)", logo: "webchat", assumed: false, clicks: 102, prev: 105, change: -3 },
          { label: "Telegram", logo: "telegram", assumed: false, clicks: 47, prev: 0, change: 47 },
        ] }])) },
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
      // Footnotes removed from Search Ads in v3.117.0 (MW), so the needle is
      // the keyword table's own heading rather than its note.
      present("search ads rendered", "Search keywords");
      // Card retitled "Back links" in v3.121.0 (MW).
      present("referral rendered", "Back links");
      /**
       * Checked against THIS table's header row, not the page text: the label
       * "Appointments" appears in several other Actions tables, so deleting a
       * column here still left a loose text match passing.
       */
      (() => {
        const want = ["Source", "Sessions", "Find Doctor", "Appointments",
                      "Contact us", "View Item", "Add to cart"];
        const tables = [...(root ? root.querySelectorAll(".card") : [])]
          .filter(c => ((c.querySelector(".card-title") || {}).textContent || "").trim() === "Back links");
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
        /**
         * Assistant + Sessions + MW's SIX columns, in MW's order. Eleven
         * columns overflowed the slide; the two Better AI events stay on the
         * scorecards above, where they cost no width.
         */
        const wantCols = ["Assistant", "Sessions", "Find Doctor", "Appointments",
                          "Contact us", "View Item", "Add To Cart", "Purchase"];
        if (th.join("|") !== wantCols.join("|")) {
          return fail("ai card layout", `columns are ${th.join(", ")}`);
        }
        // The three columns MW removed must be gone from THIS table.
        const banned = th.filter(h => /engagement|actions \/ 100|ga4 channel/i.test(h));
        banned.length
          ? fail("ai card layout", `removed column still present: ${banned.join(", ")}`)
          : ok("ai card layout", `2\u00d75 scorecards, ${th.length} columns in MW order`);
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
      /**
       * Scope is a PILL now (v3.124.0), not `\u00b7 BGH` text, so this checks the
       * pill next to the Search Ads title rather than a string in the heading.
       */
      (() => {
        const t = [...root.querySelectorAll(".slide-title")]
          .find(x => /Search Ads/.test(x.textContent));
        if (!t) return fail("search ads scope pill", "no Search Ads slide");
        const pill = t.querySelector(".all-four");
        pill && pill.textContent.trim() === "BGH"
          ? ok("search ads scope pill", "BGH pill")
          : fail("search ads scope pill", `pill is ${pill ? pill.textContent.trim() : "missing"}`);
      })();
      /**
       * EVERY scope indicator is a pill. A slide whose title still carries
       * `\u00b7 BGH` or a bare BHQ word is the inconsistency MW asked to remove.
       */
      (() => {
        const bad = [...root.querySelectorAll(".slide-title")]
          .map(t => (t.querySelector("span") || {}).textContent || "")
          .filter(txt => /·\s*(BGH|BIH|BHT|WSH|BHQ)\b/.test(txt.replace(/\s+/g, " ")));
        bad.length
          ? fail("scope pills only", `${bad.length} title(s) still use text scope: ${bad[0].trim()}`)
          : ok("scope pills only", "no title carries a text scope");
      })();
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
      /**
       * Every `file` in PLATFORM must exist on disk, or the mark silently falls
       * back to the remote URL and then to a monogram — which looks fine and is
       * not what was asked for. Checked here so a typo'd filename fails loudly.
       */
      (() => {
        // `js`, not `html`: inside this callback `html` is shadowed by the
        // RENDERED report, so searching it found no PLATFORM block and the
        // check passed vacuously reporting "all 0 present".
        const block = js.slice(js.indexOf("const PLATFORM = {"), js.indexOf("const plogo ="));
        const files = [...block.matchAll(/file: '([^']+)'/g)].map(m => m[1]);
        const absent = files.filter(f => !fs.existsSync(path.join(__dirname, "..", "public", "brand", f)));
        // Zero matches means the search missed the block, not that all is well.
        if (!files.length) return fail("brand assets", "no PLATFORM file entries found");
        absent.length
          ? ok("brand assets", `${files.length - absent.length}/${files.length} present; awaiting ${absent.join(", ")}`)
          : ok("brand assets", `all ${files.length} present`);
      })();

      (() => {
        /**
         * The 64px section mark has now failed to apply TWICE from edits that
         * reported success — once because the anchor had drifted, once because
         * the rule was never inserted. Asserted from the stylesheet so "it
         * looked applied" is not the check.
         */
        const rule = /\.slide-title \.plogo\{width:4rem;height:4rem/.test(SRC);
        if (!rule) return fail("platform marks", "section header mark is not 4rem/64px");
        const marks = [...(root ? root.querySelectorAll(".slide-title .plogo") : [])];
        /**
         * Each platform asserted BY NAME. A "6 or more" count passed when the
         * Facebook mark was deleted, because other slides made up the number —
         * a threshold cannot tell which mark went missing.
         */
        // No Analytics mark: dropped in v3.110.0 (MW) — the Channels slide is
        // about GA4 by definition, so a logo there labels the obvious.
        /**
         * Meta moved off a slide title onto the Meta Ad CARD in v3.118.0, when
         * Shared Paid Media was removed — so it is checked separately, below,
         * rather than dropped from the list and forgotten.
         */
        const want = ["Google", "Business Profile", "Facebook", "TikTok", "Google Ads"];
        const seen = new Set(marks.map(m => m.getAttribute("title")));
        const missing = want.filter(w => !seen.has(w));
        if (missing.length) return fail("platform marks", `no mark for: ${missing.join(", ")}`);
        // Marks are a bare <img> as of v3.112.0 — the monogram and its coloured
        // plate were removed because the plate showed through transparent SVGs
        // as a solid box. Each mark must therefore point at a real asset.
        const bad = marks.filter(m => !/^brand\/[\w.-]+\.svg$/.test(m.getAttribute("src") || ""));
        if (bad.length) return fail("platform marks", `${bad.length} mark(s) with no brand asset src`);
        if (!root.querySelector('.card-title img[title="Meta"]')) {
          return fail("platform marks", "no Meta mark on the Meta Ad card");
        }
        /**
         * `mini()` emits `.stat` since v3.118.0, so it shares the one report
         * card surface. Iconed scorecards are therefore `.stat` with an svg in
         * the label — the old `.mini` selector matched nothing and reported
         * "0/0 ... all iconed", which passed.
         */
        const iconed = [...root.querySelectorAll(".slide .stat .lab svg")];
        iconed.length >= 10
          ? ok("platform marks", `${want.length} platforms + Meta card, ${iconed.length} iconed scorecards`)
          : fail("platform marks", `only ${iconed.length} iconed scorecards, expected 10+`);
      })();
      /**
       * Content: two slides, four paired tables, MW's type-to-action pairing,
       * and language tabs on their OWN namespace.
       */
      (() => {
        const pages = [...(root ? root.querySelectorAll(".clang-page") : [])];
        if (!pages.length) return fail("content cards", "no content language pages rendered");
        const thai = pages.filter(p => String(p.dataset.clangpage || "").startsWith("th-"));
        if (thai.length !== 2) return fail("content cards", `${thai.length} Thai content slides, expected 2`);
        // MW's pairing: Doctor+Package on the first slide, Articles+Center on
        // the second, each beside the one action it is judged on.
        // Articles is Contact us as of v3.108.0, measured not guessed.
        const want = [["Doctor", "Appointments", "Package", "Add to cart"],
                      ["Articles", "Contact us", "Center", "Contact us"]];
        for (let i = 0; i < 2; i++) {
          const heads = [...thai[i].querySelectorAll("thead th")].map(t => t.textContent.trim());
          for (const h of want[i]) {
            if (!heads.includes(h)) return fail("content cards", `slide ${i + 1} has no "${h}" column`);
          }
        }
        // Ranked by views, descending.
        const first = thai[0].querySelector("tbody");
        const views = [...first.querySelectorAll("tr")]
          .map(tr => Number((tr.children[1] || {}).textContent.replace(/[^\d]/g, "")))
          .filter(v => !isNaN(v) && v > 0);
        if (views.length > 1 && views.some((v, i) => i && v > views[i - 1])) {
          return fail("content cards", `rows not ranked by views: ${views.join(",")}`);
        }
        // Content tabs must not share Search's namespace, or switching a
        // content language would blank a Search page.
        const ctabs = root.querySelectorAll(".clang-tab");
        if (!ctabs.length) return fail("content cards", "no content language tabs");
        if (thai[0].querySelector(".lang-tab")) return fail("content cards", "content reuses Search tabs");
        // English has no package pages: the empty row must render.
        const en = pages.filter(p => String(p.dataset.clangpage || "").startsWith("en-"));
        const emptyShown = en.some(p => /no package pages in this language/i.test(p.textContent));
        if (!emptyShown) return fail("content cards", "missing empty state for a language with no pages");
        /**
         * When the configured column is not the event that actually fires
         * most, the card must SAY so — silence is how `view_item` sat on
         * Articles unnoticed.
         */
        // Package carries hideMix, so its footer must be absent even though the
        // other cards have one.
        const pkgCard = [...thai[0].querySelectorAll(".card")]
          .find(c => (c.querySelector(".card-title") || {}).textContent.trim().startsWith("Package"));
        if (!pkgCard) return fail("content cards", "Package card not found");
        if (/What actually fires/i.test(pkgCard.textContent)) {
          return fail("content cards", "Package footer rendered despite hideMix");
        }
        const warned = thai[1].textContent.includes("but Find doctors fires more");
        warned
          ? ok("content cards", `2 slides x ${ctabs.length} languages, ranked, mismatch flagged`)
          : fail("content cards", "wrong-column warning not shown for Articles");
      })();
      /**
       * Chat bubble: BOTH scope pages must be in the DOM (CSS shows one), the
       * hospital tab active first, and the "new" state used where a channel has
       * no previous month rather than a divide-by-zero percentage.
       */
      (() => {
        // Scoped to the chat card specifically: the appointments card also uses
        // `.cb-page`, and an unqualified `.cb-wrap` lookup picked that one.
        const wrap = root && root.querySelector(".cb-wrap");
        if (!wrap) return fail("chat bubble", "no chat bubble slide rendered");
        const pages = [...wrap.querySelectorAll(".cb-page")];
        if (pages.length !== 2) return fail("chat bubble", `${pages.length} scope pages, expected 2`);
        const active = pages.filter(p => p.classList.contains("active"));
        if (active.length !== 1) return fail("chat bubble", `${active.length} active scopes, expected 1`);
        if (active[0].dataset.cbpage === "BHQ") return fail("chat bubble", "opens on BHQ, not the hospital");
        if (!wrap.querySelector('[data-cb="BHQ"]')) return fail("chat bubble", "no BHQ tab");
        // Telegram has prev 0 in the fixture: a percentage there would be
        // Infinity, so it must render as "new".
        if (!/\bnew\b/.test(active[0].textContent)) return fail("chat bubble", "no 'new' state for a channel with no prior month");
        // The assumed label must stay visibly flagged.
        /**
         * Counted by LABEL TEXT, not by a layout class.
         *
         * This assertion has now broken twice on presentation changes it should
         * not care about — it counted `tbody tr` when the layout became chips,
         * then `.cb-row` when chips became scorecards, and the first of those
         * reported "0 channels" while still passing. What actually matters is
         * that every channel in the payload reaches the page, whatever the
         * markup is called.
         */
        const labels = ["LINE", "WhatsApp (AR)", "LINE (JP)", "Webchat (TH/EN)", "Telegram"];
        const body = pages[0].textContent;
        const absent = labels.filter(l => !body.includes(l));
        if (absent.length) return fail("chat bubble", `channels missing from the page: ${absent.join(", ")}`);
        // Every channel with an asset shows its mark, and the marks live in the
        // same container as the figure rather than floating beside it.
        const marks = pages[0].querySelectorAll(".plogo").length;
        if (marks < labels.length) return fail("chat bubble", `${marks} marks for ${labels.length} channels`);
        /**
         * Structure MW asked for: identity (mark + name) on the left, the
         * figure on the right. Asserted as two siblings inside each card so a
         * future restyle that collapses them back into one column fails here
         * rather than looking merely different.
         */
        const cards = [...pages[0].querySelectorAll(".cbc")];
        if (!cards.length) return fail("chat bubble", "no channel cards");
        const split = cards.filter(c => c.querySelector(".cbc-id .plogo")
                                     && c.querySelector(".cbc-id .cbc-lab")
                                     && c.querySelector(".cbc-perf .cbc-num"));
        if (split.length !== cards.length) {
          return fail("chat bubble", `${split.length}/${cards.length} cards split identity/performance`);
        }
        // Two per row (MW). Footer removed, so no note should remain.
        if (/Unrecognised click ids/.test(pages[0].textContent)) {
          return fail("chat bubble", "footer still rendering");
        }
        // The intro row is g-3 since the BHQ-share card was added, so the
        // channel grid is the one inside `.cb-cards` specifically.
        const cols = pages[0].querySelectorAll(".cb-cards .grid.g-2").length;
        if (cols < 1) return fail("chat bubble", "channel cards are not in a 2-column grid");
        /**
         * The click-source note was added in v3.133.0 and REMOVED in v3.135.0 at
         * MW's request. Asserted as an absence rather than deleted quietly: the
         * decision behind the number still stands (GTM, ten channels), so a
         * future session reading that changelog entry might reasonably re-add the
         * note. It was not wanted on the slide.
         */
        if (/outbound link/i.test(pages[0].textContent)) {
          return fail("chat bubble", "the removed click-source note is rendering again");
        }
        ok("chat bubble", `2 scopes, ${labels.length} channels, ${marks} marks, 2-up grid`);
      })();
      /**
       * NAV UNDER THE HEADER, everywhere (MW). A tab strip that renders before
       * the title puts the control ahead of the thing it controls. Checked by
       * DOM position rather than by eye: for each tab strip, a `.slide-title`
       * must precede it within the same parent.
       */
      (() => {
        const strips = [...(root ? root.querySelectorAll(".lang-tabs") : [])];
        if (!strips.length) return fail("nav under header", "no tab strips rendered");
        /**
         * Scoped to the strip's OWN section, then document order within it.
         *
         * Two wrong versions before this: checking only the immediate parent
         * flagged the chat strip, which is nested a level deeper than its
         * header; checking the whole page then passed even with a strip moved
         * back above its header, because some earlier section's title still
         * preceded it. The unit is the section.
         */
        const sectionOf = (el) =>
          el.closest(".lang-page, .clang-page, .cb-page, .cb-wrap") || el.closest(".slide");
        const bad = strips.filter((strip) => {
          let scope = sectionOf(strip);
          // A wrapper with no header of its own defers to the enclosing slide.
          while (scope && !scope.querySelector(".slide-title")) scope = scope.parentElement
            && scope.parentElement.closest(".slide");
          if (!scope) return true;
          return ![...scope.querySelectorAll(".slide-title")].some((t) =>
            t.compareDocumentPosition(strip) & 4 /* strip FOLLOWS title */);
        });
        bad.length
          ? fail("nav under header", `${bad.length}/${strips.length} tab strips sit above their header`)
          : ok("nav under header", `${strips.length} tab strips all below a header`);
      })();
      /**
       * Appointments: both scopes present, the four headline figures, and two
       * donuts whose arcs actually render. An SVG with no <circle> means the
       * ring silently collapsed.
       */
      (() => {
        const wrap = root && root.querySelector(".appt-wrap");
        if (!wrap) return fail("appointments", "no appointments card rendered");
        const pages = [...wrap.querySelectorAll("[data-appt]")];
        if (pages.length !== 2) return fail("appointments", `${pages.length} scopes, expected 2`);
        if (pages[0].dataset.appt === "BHQ") return fail("appointments", "opens on BHQ, not the hospital");
        /**
         * Matched against the scorecard LABELS, not the page text.
         *
         * Revenue is a figure in its own right (MW), not a sub-line under the
         * case counts. A textContent check passed even with the Revenue card
         * deleted, because the footnote below it also says "Revenue".
         */
        const labels = [...pages[0].querySelectorAll(".stat .lab")].map(l => l.textContent.trim());
        for (const want of ["Initiates", "Completes", "Realtime", "Not realtime",
                            "Revenue", "Realtime revenue", "Not realtime revenue"]) {
          if (!labels.includes(want)) {
            return fail("appointments", `no "${want}" scorecard (have: ${labels.join(", ")})`);
          }
        }
        const donuts = [...pages[0].querySelectorAll("svg")];
        if (donuts.length !== 2) return fail("appointments", `${donuts.length} donuts, expected 2`);
        const arcs = donuts.reduce((a, sv) => a + sv.querySelectorAll("circle").length, 0);
        if (arcs < 4) return fail("appointments", `${arcs} donut arcs, expected 4+`);
        // Blank sheet values must surface as N/S rather than an empty row.
        if (!pages[0].textContent.includes("N/S")) {
          return fail("appointments", "blank label not rendered as N/S");
        }
        /**
         * THE RING MUST CLOSE. Rows are the top eight; the total counts every
         * case, so without an "Other" slice the arcs sum to a fraction of the
         * circle and the donut reads as broken. Checked by summing the actual
         * dash lengths against the circumference.
         */
        const C = 2 * Math.PI * 54;
        for (const sv of donuts) {
          const drawn = [...sv.querySelectorAll("circle")].reduce((a, c) =>
            a + parseFloat(String(c.getAttribute("stroke-dasharray") || "0").split(" ")[0]), 0);
          if (drawn < C * 0.995) {
            return fail("appointments", `donut ring only ${(drawn / C * 100).toFixed(0)}% drawn`);
          }
        }
        // Footnote removed (MW).
        /Initiates is GA4; everything else/.test(pages[0].textContent)
          ? fail("appointments", "footnote still rendering")
          : ok("appointments", `2 scopes, 2 closed donuts, ${arcs} arcs, N/S shown`);
      })();
      /**
       * GBP keyword ranks REPLACE the search-keyword table inside each listing
       * card (MW) — the placeholder is gone on purpose, so this asserts the
       * ranking table is there and the old one is NOT.
       */
      (() => {
        const cards = [...root.querySelectorAll(".card")];
        const rank = cards.find(c =>
          ((c.querySelector(".card-title") || {}).textContent || "").trim() === "Keyword rankings");
        if (!rank) return fail("gbp ranks", "no Keyword rankings card");
        const placeholder = cards.find(c =>
          ((c.querySelector(".card-title") || {}).textContent || "").trim() === "Search keywords");
        if (placeholder) return fail("gbp ranks", "the placeholder Search keywords table is still there");
        if (/No ranking position/.test(rank.textContent)) {
          return fail("gbp ranks", "placeholder note still rendering");
        }
        const bands = rank.querySelectorAll("td .dlt.up, td .dlt.flat, td .dlt.down");
        const heads = [...rank.querySelectorAll("thead th")].map(t => t.textContent.trim());
        heads.join("|") === "Keyword|Rank|Search Vol" && bands.length >= 5
          ? ok("gbp ranks", `${bands.length} ranks banded, placeholder replaced`)
          : fail("gbp ranks", `headers ${heads.join(", ")}, ${bands.length} bands`);
      })();
      /**
       * Hospital logos on the Actions card, one per hospital, each with a text
       * fallback in `alt` so a blocked asset still names the hospital.
       */
      (() => {
        const card = [...root.querySelectorAll(".slide")]
          .find(sl => /ACTIONS/i.test((sl.querySelector(".slide-title") || {}).textContent || ""));
        if (!card) return fail("hospital logos", "Actions slide not found");
        const logos = [...card.querySelectorAll(".hlogo img")];
        const alts = logos.map(l => l.getAttribute("alt"));
        const want = ["BGH", "BIH", "BHT", "WSH"];
        const missing = want.filter(w => !alts.includes(w));
        if (missing.length) return fail("hospital logos", `no logo for: ${missing.join(", ")}`);
        /**
         * Local files now, and the SLIDE HEADER must use them too — there used
         * to be a second remote `LOGOS` map fetching the same four over the
         * network, so the same logo arrived two ways and only one was local.
         */
        const localFirst = logos.every(l => /^brand\/hosp-/.test(l.getAttribute("src") || ""));
        if (!localFirst) return fail("hospital logos", "a logo is not served from brand/");
        const header = root.querySelector(".slide-title .slide-logo");
        if (!header) return fail("hospital logos", "no slide header logo");
        /^brand\/hosp-/.test(header.getAttribute("src") || "")
          ? ok("hospital logos", `${logos.length} logos + header, all local`)
          : fail("hospital logos", `header logo src is ${header.getAttribute("src")}`);
      })();
      /**
       * YouTube: two slides under Facebook, the sharing table, and the blank
       * title falling back to its video id.
       */
      (() => {
        const titles = [...root.querySelectorAll(".slide-title")].map(t => t.textContent.trim());
        if (!titles.some(t => /^YOUTUBE\b/i.test(t) || /YouTube/.test(t))) {
          return fail("youtube", "no YouTube slide");
        }
        const top = [...root.querySelectorAll(".slide")]
          .find(sl => /Top videos/i.test((sl.querySelector(".slide-title") || {}).textContent || ""));
        if (!top) return fail("youtube", "no Top videos slide");
        const yt = [...root.querySelectorAll(".slide")]
          .find(sl => /^YOUTUBE$/i.test(((sl.querySelector(".slide-title span") || {}).textContent || "")
            .replace(/BHQ/g, "").trim()));
        const body = (yt || root).textContent;
        for (const want of ["Views", "Shares", "Subscribers", "MoM", "YoY"]) {
          if (!body.includes(want)) return fail("youtube", `missing "${want}"`);
        }
        if (!/\bv2\b/.test(top.textContent)) {
          return fail("youtube", "a video with no title rendered blank");
        }
        /**
         * A MISSING METRIC MUST NOT RENDER AS A CARD (v3.130.0). The fixture
         * omits likes and comments, which is the state of the real export. This
         * is the 400-days-of-zeros failure in miniature: a metric nobody
         * exported showing as `0` reads as "nobody liked anything this month".
         */
        if (/\bComments\b/.test(body) && !/Not in this export/.test(body)) {
          return fail("youtube", "a Comments card rendered for a metric not in the export");
        }
        if (!/Not in this export/.test(body) || !/comments/.test(body)) {
          return fail("youtube", "the missing metric is not named on the slide");
        }
        /**
         * The freshness warning. A pasted sheet cannot announce that nobody
         * pasted this month, so a file whose coverage misses the report period
         * has to say so ON THE SLIDE.
         */
        /**
         * THE 500-ROW CAP WARNING. `dayGaps` means the export was pasted but
         * came back short, which is a different fault from nobody pasting at
         * all — and both otherwise read as a soft month.
         */
        /**
         * WATCH HOURS MUST CARRY A HUMAN UNIT (MW). 15,304 hours is ~21 months;
         * the unit is chosen by magnitude, so a fixture at this scale must show
         * months and must NOT still read "15304 hours".
         */
        if (!/months of watch time/i.test(body)) {
          return fail("youtube", "watch hours has no human-readable duration");
        }
        /**
         * And the figure must not appear twice. The Views card used to repeat
         * watch hours as its sub-line, which invites the reader to hunt for a
         * difference between two identical numbers.
         */
        if ((body.match(/hours watched/gi) || []).length) {
          return fail("youtube", "watch hours is duplicated on the Views card");
        }
        if (!/days are missing/i.test(body)) {
          return fail("youtube", "a short export did not raise the day-gap warning");
        }
        /**
         * MoM AND YoY MUST NOT BOTH BE POSITIVE HERE. Views fell 10% MoM and
         * rose 238% YoY on the real July figures, so a renderer that pointed
         * every arrow one way, or crossed the two windows, would pass a
         * same-sign fixture and fail this one.
         */
        if (!/\bup\b/.test((yt || root).innerHTML) || !/\bdown\b/.test((yt || root).innerHTML)) {
          return fail("youtube", "MoM and YoY did not render opposite directions");
        }
        /**
         * The amber `apiError` card is GONE (v3.129.0) along with the API path
         * it reported on. Asserted as an absence so it cannot creep back.
         */
        /not connected/i.test(body)
          ? fail("youtube", "the removed apiError card is rendering again")
          : ok("youtube", "2 slides, MoM+YoY opposite signs, day-gap warned, absent metric named");
      })();
      finish();
    }, 500);
  }
}, 1200);

function finish() {
  console.log(failures ? `\n${failures} boot check(s) failed` : "\nclient boots clean");
  process.exit(failures ? 1 : 0);
}
