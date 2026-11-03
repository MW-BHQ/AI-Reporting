/**
 * BigQuery fixtures for Better Club, shaped exactly like the live queries'
 * single JSON cell. MAU is the team's B-point definition (check-in, reward
 * read, quiz). Month figures are the real Aug-Nov 2026 aggregates (counts
 * only, no member data); the smaller blocks are the real October rows.
 *
 * They can tell right from wrong: Sep and Oct satisfy
 * MAU(m) - MAU(m-1) = new + reactivated - lost, August is the baseline
 * (no split), and November is partial (tracking ends 2 Nov).
 */
const M = (month, mau, n, ret, react, base, t, churned, members, joined, came_back, avg_dau) => ({
  month, mau, new_users: n, retained: ret, reactivated: react, baseline: base,
  react_t0: t[0], react_t1: t[1], react_t2: t[2], react_t3: t[3], react_tu: t[4],
  avg_days: 5, churned, members, came_back, avg_dau, joined,
});
const engagement = {
  coverage: { d0: "2026-08-02", d1: "2026-11-02" },
  months: [
    M("2026-08", 246, 125, 0, 0, 121, [0, 0, 0, 0, 0], 0, 50935, 3289, 7, 44.1),
    M("2026-09", 239, 121, 69, 49, 0, [9, 8, 18, 14, 0], 177, 53788, 2853, 10, 40.2),
    M("2026-10", 248, 125, 67, 56, 0, [10, 4, 25, 17, 0], 172, 56877, 3089, 1, 36.4),
    M("2026-11", 50, 6, 38, 6, 0, [2, 0, 1, 0, 3], 210, 56947, 70, 0, 35),
  ],
  segments: [
    ["2026-09", "new", 121, 106, 16, 34, 54, 48, 7, 0],
    ["2026-09", "retained", 69, 69, 53, 58, 59, 17, 22, 0],
    ["2026-09", "reactivated", 49, 44, 8, 11, 21, 20, 3, 0],
    ["2026-10", "new", 125, 105, 21, 37, 62, 56, 7, 0],
    ["2026-10", "retained", 67, 63, 44, 47, 51, 22, 6, 0],
    ["2026-10", "reactivated", 56, 48, 10, 12, 22, 19, 1, 0],
  ].map(([month, status, users, check_in, reward_read, quiz, read, cta, reward, login]) =>
    ({ month, status, users, check_in, reward_read, quiz, read, cta, reward, login })),
  react_first: [
    { month: "2026-10", action: "check_in", users: 48 }, { month: "2026-10", action: "reward_read", users: 5 },
    { month: "2026-10", action: "quiz", users: 3 },
    { month: "2026-09", action: "check_in", users: 43 }, { month: "2026-09", action: "reward_read", users: 4 },
  ],
  depth: [
    { month: "2026-10", bin: "1", users: 176 }, { month: "2026-10", bin: "2-3", users: 24 },
    { month: "2026-10", bin: "4-7", users: 9 }, { month: "2026-10", bin: "8-14", users: 9 },
    { month: "2026-10", bin: "15+", users: 30 },
  ],
  daily: Array.from({ length: 93 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 2 + i)).toISOString().slice(0, 10);
    return { d, dau: 32 + ((i * 7) % 15), any_active: 140 + ((i * 37) % 45) };
  }),
  cohorts: [
    ["2025-Q4", 6300, [13, 12, 19, 5]], ["2026-Q2", 9127, [15, 17, 19, 7]],
    ["2026-07", 2828, [19, 11, 4, 2]], ["2026-08", 3289, [125, 16, 5, 1]],
    ["2026-09", 2853, [null, 121, 20, 2]], ["2026-10", 3089, [null, null, 125, 3]],
  ].flatMap(([cohort, size, act]) => ["2026-08", "2026-09", "2026-10", "2026-11"]
    .map((month, i) => ({ cohort, size, month, active: act[i] })).filter((r) => r.active != null)),
  tags: [
    ["การตรวจคัดกรองมะเร็งเต้านม", 66, 140], ["Better Health Brain", 55, 98], ["ตรวจสุขภาพ", 50, 80],
    ["การรักษา", 49, 77], ["treatment", 47, 70], ["การตรวจวินิจฉัย", 46, 66],
  ].map(([tag, readers, reads]) => ({ month: "2026-10", tag, readers, reads })),
  cta: [
    ["Appointment", 57, 102], ["Cart and packages", 31, 56], ["Contact and chat", 29, 33],
    ["Find a doctor", 16, 20], ["Other", 9, 14],
  ].map(([grp, users, clicks]) => ({ month: "2026-10", grp, users, clicks })),
  rewards: [
    ["BGH_Child Dev", "Health guide", 8, 8, 120, 2], ["ส่วนลด bangkokhospital.com 1,000 บาท", "Coupon", 6, 6, 6, 1],
    ["BGH_Stroke", "Health guide", 5, 5, 75, 0], ["Better Club – E-Discount coupon (500)", "Coupon", 1, 1, 500, 1],
    ["Better Club – E-Discount coupon (1000)", "Coupon", 0, 0, 0, 3],
  ].map(([name, kind, redeemed, members, points, used]) => ({ month: "2026-10", name, kind, redeemed, members, points, used })),
  points: [["2026-08", 12980, 68770, 4], ["2026-09", 12522, 64002, 5], ["2026-10", 8635, 63345, 11], ["2026-11", 634, 3514, 0]]
    .map(([month, earned_activity, earned_all, referrals]) => ({ month, earned_activity, earned_all, referrals })),
  channels: [["Not recorded", 2692, 107], ["chatgpt.com", 105, 1], ["google-reserve", 76, 3], ["facebook / paid", 61, 8],
             ["sms / sms", 55, 1], ["line / richmenu", 13, 3]]
    .map(([channel, joined, active]) => ({ month: "2026-10", channel, joined, active })),
  campaigns: [["rightchoice-google-reserve", "google-reserve", 81, 3], ["260130-03_bgh_tra", "sms / sms", 55, 1],
              ["261001-02_bgh_tra", "facebook / paid", 52, 6], ["260807-05_bgh_tra", "line / richmenu", 5, 3]]
    .map(([campaign, channel, joined, active]) => ({ month: "2026-10", campaign, channel, joined, active })),
  reward_articles: [[533825, "คลำไม่เจอ ไม่ได้แปลว่าไม่มี", 66, "2026-10-01-000000"],
                    [8612, "The Child Development Neuropsychiatric Clinic (CNDC)", 38, "2026-10-16-080000"],
                    [9112, "แพ็กเกจตรวจสุขภาพสมอง Stop Stroke", 38, "2026-10-01-080000"]]
    .map(([post_id, title, readers, launched]) => ({ month: "2026-10", post_id, title, readers, launched })),
  streaks: [["1", 165], ["2-6", 25], ["7", 26]].map(([bin, users]) => ({ month: "2026-10", bin, users })),
  hours: [14, 11, 9, 6, 5, 12, 13, 24, 47, 47, 49, 48, 33, 42, 37, 29, 30, 27, 25, 27, 20, 28, 23, 20]
    .map((users, hour) => ({ month: "2026-10", hour, users, actions: users * 5 })),
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
