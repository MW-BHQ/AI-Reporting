/**
 * BigQuery fixtures for Better Club, shaped exactly like the live queries'
 * single JSON cell. Month figures are the real Aug-Nov 2026 aggregates
 * (counts only, no member data); the smaller blocks are trimmed.
 *
 * They can tell right from wrong: Sep and Oct satisfy
 * MAU(m) - MAU(m-1) = new + reactivated - churned, August is the baseline
 * (no split), and November is partial (tracking ends 2 Nov).
 */
const M = (month, mau, n, ret, react, base, churned, members, extra = {}) => ({
  month, mau, new_users: n, retained: ret, reactivated: react, baseline: base,
  engaged: Math.round(mau * 0.67), new_engaged: Math.round(n * 0.6),
  react_t1: Math.round(react * 0.15), react_t2: Math.round(react * 0.4),
  react_t3: react - Math.round(react * 0.15) - Math.round(react * 0.4), react_tu: 0,
  avg_days: 1.5, churned, members, came_back: Math.round(n * 0.05),
  avg_dau: 156, avg_engaged_dau: 119, ...extra,
});
const engagement = {
  coverage: { d0: "2026-08-02", d1: "2026-11-02" },
  months: [
    M("2026-08", 3166, 2595, 0, 0, 571, 0, 50935),
    M("2026-09", 2972, 2312, 270, 390, 0, 2896, 53788),
    M("2026-10", 3211, 2495, 255, 461, 0, 2717, 56877),
    M("2026-11", 344, 70, 149, 125, 0, 3062, 56947),
  ],
  segments: [
    ["2026-09", "new", 2312, 106, 1076, 34, 717, 20, 0, 874],
    ["2026-09", "retained", 270, 85, 196, 59, 111, 23, 0, 6],
    ["2026-09", "reactivated", 390, 28, 283, 10, 152, 4, 0, 35],
    ["2026-10", "new", 2495, 105, 1164, 37, 735, 17, 0, 1013],
    ["2026-10", "retained", 255, 77, 185, 48, 114, 7, 0, 4],
    ["2026-10", "reactivated", 461, 34, 335, 11, 202, 0, 0, 27],
  ].map(([month, status, users, check_in, read, quiz, cta, reward, login, signup_only]) =>
    ({ month, status, users, check_in, read, quiz, cta, reward, login, signup_only })),
  react_first: [
    { month: "2026-10", action: "read", users: 278 }, { month: "2026-10", action: "cta", users: 127 },
    { month: "2026-10", action: "none", users: 27 }, { month: "2026-10", action: "check_in", users: 25 },
    { month: "2026-09", action: "read", users: 239 }, { month: "2026-09", action: "cta", users: 92 },
  ],
  depth: [
    { month: "2026-10", bin: "1", users: 1611 }, { month: "2026-10", bin: "2-3", users: 461 },
    { month: "2026-10", bin: "4-7", users: 50 }, { month: "2026-10", bin: "8-14", users: 13 },
    { month: "2026-10", bin: "15+", users: 32 },
  ],
  daily: Array.from({ length: 93 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 2 + i)).toISOString().slice(0, 10);
    return { d, dau: 140 + ((i * 37) % 45), engaged: 105 + ((i * 29) % 30) };
  }),
  cohorts: [
    ["2025-Q4", 6300, [71, 63, 76, 14]], ["2026-Q2", 9127, [92, 92, 97, 22]],
    ["2026-07", 2828, [90, 44, 37, 5]], ["2026-08", 3289, [2595, 152, 48, 12]],
    ["2026-09", 2853, [null, 2312, 134, 17]], ["2026-10", 3089, [null, null, 2495, 77]],
  ].flatMap(([cohort, size, act]) => ["2026-08", "2026-09", "2026-10", "2026-11"]
    .map((month, i) => ({ cohort, size, month, active: act[i] })).filter((r) => r.active != null)),
  tags: [
    ["treatment", 304, 649], ["ตรวจสุขภาพ", 265, 430], ["health", 243, 504], ["diseases", 226, 473],
    ["การผ่าตัด", 203, 635], ["Better Health MED", 202, 422],
  ].map(([tag, readers, reads]) => ({ month: "2026-10", tag, readers, reads })),
  cta: [
    ["Appointment", 729, 1230], ["Contact and chat", 226, 265], ["Cart and packages", 219, 398],
    ["Find a doctor", 103, 117], ["Other", 97, 164],
  ].map(([grp, users, clicks]) => ({ month: "2026-10", grp, users, clicks })),
};

const overview = {
  byMonth: [["2026-03", 1759], ["2026-04", 3869], ["2026-05", 2664], ["2026-06", 2594],
            ["2026-07", 2828], ["2026-08", 3289], ["2026-09", 2853]].map(([month, joined]) => ({ month, joined })),
  totals: { total: 56947, live: 56900 },
  mix: [
    ["channel", "email", 30461], ["channel", "phone", 25470], ["channel", "unknown", 969],
    ["nationality", "THAI (ไทย)", 30100], ["nationality", "", 9000], ["nationality", "MYANMAR (เมียนมา)", 3100],
    ["nationality", "ICELANDIC (ไอซ์แลนด์)", 1],
    ["country", "Thailand", 3915], ["country", "", 50970],
    ["city", "Bangkok", 2073], ["city", "", 50970], ["city", "Dhaka", 479],
    ["household", "", 55000], ["household", "Family", 1200],
  ].map(([f, v, n]) => ({ f, v, n })),
};

module.exports = { engagement, overview };
