#!/usr/bin/env node
/*
 * Real test against BigQuery, in a throwaway dataset `better_club_test`.
 *   node bq/better_club/test.js > /tmp/bc_test.sql   then run it as one script.
 * Any failed ASSERT stops the script with its message. Success = no error.
 *
 * Fixtures read through the same ingest SQL as production (src → fx_<tab>).
 * Each case has a value that only the correct behaviour produces.
 */
process.env.BC_DATASET = 'better_club_test';
const B = require('./build');
const { TABS, T, cols } = B;

const tab = (name) => TABS.find((t) => t.tab === name);
const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

// fx('read_post', [{user_id: '1', ...}], {header: {event: 'Evnt'}}) → fixture table.
function fx(name, rows, { header = {} } = {}) {
  const c = cols(tab(name));
  const head = Object.fromEntries(c.map((x) => [x.raw, header[x.raw] || x.h]));
  const all = [head, ...rows];
  const typ = c.map((x) => `${x.raw} STRING`).join(', ');
  return `CREATE OR REPLACE TABLE ${T('fx_' + name)} AS SELECT * FROM UNNEST(ARRAY<STRUCT<${typ}>>[
  ${all.map((r) => `(${c.map((x) => sq(r[x.raw])).join(', ')})`).join(',\n  ')}]);`;
}

const CALL = `CALL ${T('ingest')}();`;
const count = (t, n, msg) => `ASSERT (SELECT COUNT(*) FROM ${T(t)}) = ${n} AS '${msg}';`;
const is = (sql, msg) => `ASSERT (${sql}) AS '${msg}';`;

const cust = (id, pts, exp, extra = {}) => ({ user_id: id, register_channel: 'email', gender: 'F',
  dob: '1984-12-07', registered_at: '2025-02-07 11:47:27', has_consented_marketing: 'Yes',
  number_of_daily_check_in_all_time: '0.00', remaining_points: pts, exported_at: exp, ...extra });
const read1 = { user_id: '1', date: '2026-08-03 1:33:22', post_id: '8498', post_type: 'center',
  post_title: 'Men’s Health &#038; Prostate Center', points_earned: '3', email: 'a@x.com', url: 'https://x/1' };

const v1 = [
  fx('customers', [cust('1', '20.00', '2026-11-02 2:05:09'), cust('2', '21.00', '2026-11-02 2:05:09')]),
  fx('better_staff', [{ user_id: '9', dob: '10/16/1978', registered_at: '5/13/2025',
    number_of_daily_check_in_all_time: '12/30/1899', number_of_quiz_answered: '1/1/1900', exported_at: '11/2/2026' }]),
  fx('all_event', [
    { id: '186971', user_id: '1', date_created: '2026-08-02 11:37:58', event_name: 'OT_COMPLETE_PROFILE', event_desc_json: '[]', should_earn_point: '1', point_earned: '10' },
    { id: '186972', user_id: '2', date_created: '2026-08-02 11:41:48', event_name: 'DAILY_LOGIN', event_desc_json: '{"current_streak":3}', should_earn_point: '1', point_earned: '1' }]),
  fx('badge_history', [{ id: '26434', user_id: '1', date_earned: '11/2/2025', date_expired: '12/31/2050', badge_title: 'Starter', badge_type: 'point' }]),
  fx('read_post', [read1, read1, { user_id: '', date: '' }]), // exact duplicate + blank sheet row
  fx('click_cta', [{ user_id: '1', date: '2026-08-03 12:04:45', event: 'CLICK_TOP_CONTACT', url: 'https://x/p' }]),
  fx('quiz_result', [{ user_id: '1', date_created: '2026-08-02 19:06:40', quiz_title: 'main-2026-08-02', question: 'Q?', answer: 'A' }]),
];

const steps = [
  `DROP SCHEMA IF EXISTS \`${B.PROJECT}.better_club_test\` CASCADE;`,
  B.setup(), B.views(), B.ingest((t) => T('fx_' + t), 'test'),

  '-- 1. first load', ...v1, CALL,
  count('raw_read_post', 1, 'identical rows in one load must store once'),
  count('customers', 2, 'customers'), count('staff', 1, 'staff'), count('events', 2, 'events'),
  count('badges', 1, 'badges'), count('post_reads', 1, 'post_reads'),
  count('cta_clicks', 1, 'cta_clicks'), count('quiz_answers', 1, 'quiz_answers'),
  is(`SELECT number_of_daily_check_in_all_time = 0 AND number_of_quiz_answered = 2 FROM ${T('staff')}`, '12/30/1899 in a number column must read as 0, 1/1/1900 as 2'),
  is(`SELECT dob = DATE '1978-10-16' AND registered_at = DATETIME '2025-05-13 00:00:00' FROM ${T('staff')}`, 'M/D/YYYY dates'),
  is(`SELECT read_at = DATETIME '2026-08-03 01:33:22' FROM ${T('post_reads')}`, 'single-digit hour'),
  is(`SELECT post_title = 'Men’s Health & Prostate Center' FROM ${T('post_reads')}`, 'html entities decoded'),
  is(`SELECT earned_at = DATETIME '2025-11-02 00:00:00' FROM ${T('badges')}`, 'badge date is M/D'),
  is(`SELECT INT64(event_desc_json.current_streak) = 3 FROM ${T('events')} WHERE event_id = 186972`, 'event json parsed'),
  is(`SELECT has_consented_marketing AND remaining_points = 20 FROM ${T('customers')} WHERE user_id = 1`, 'bool and number'),
  is(`SELECT COUNT(*) = 0 FROM UNNEST(['email','phone','gender','dob']) c WHERE c IN (SELECT column_name FROM \`${B.PROJECT}.better_club_test\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'post_reads')`, 'profile columns stay out of event views'),

  '-- 2. same sheet again: nothing new', CALL,
  is(`SELECT SUM(rows_inserted) = 0 FROM ${T('_ingest_log')} WHERE run_at = (SELECT MAX(run_at) FROM ${T('_ingest_log')})`, 're-run must insert 0 rows'),
  count('raw_customers', 2, 're-run raw_customers'), count('raw_all_event', 2, 're-run raw_all_event'),

  '-- 3. daily wipe: sheet now holds only yesterday',
  fx('customers', [cust('1', '25.00', '2026-11-03 2:05:00'), cust('2', '21.00', '2026-11-03 2:05:00')]),
  fx('all_event', [{ id: '186999', user_id: '1', date_created: '2026-11-02 08:00:00', event_name: 'DAILY_LOGIN', event_desc_json: '{}' }]),
  fx('read_post', [{ ...read1, email: 'new@x.com' }, { ...read1, post_id: '8532', date: '2026-11-02 9:00:00' }]),
  CALL,
  count('events', 3, 'wiped sheet must not delete history'),
  count('customers', 2, 'one row per member'),
  is(`SELECT remaining_points = 25 FROM ${T('customers')} WHERE user_id = 1`, 'latest export wins'),
  count('customers_history', 3, 'history stores changes only (member 2 unchanged)'),
  count('raw_read_post', 3, 'profile change on an event row is a new raw row'),
  count('post_reads', 2, '...but the same read counts once'),

  '-- 4. empty sheet (header only)',
  ...['customers', 'better_staff', 'all_event', 'badge_history', 'read_post', 'click_cta', 'quiz_result'].map((t) => fx(t, [])),
  CALL,
  count('events', 3, 'empty sheet keeps events'), count('customers', 2, 'empty sheet keeps customers'),
  is(`SELECT LOGICAL_AND(rows_in_source = 0) FROM ${T('_ingest_log')} WHERE run_at = (SELECT MAX(run_at) FROM ${T('_ingest_log')})`, 'log shows an empty sheet'),

  '-- 5. negative: a moved column must stop the run',
  fx('click_cta', [], { header: { event: 'Evnt' } }),
  `BEGIN\n${CALL}\nSELECT ERROR('header guard did not fire');\nEXCEPTION WHEN ERROR THEN\n  ASSERT @@error.message LIKE '%click_cta: header row does not match%' AS 'header guard';\nEND;`,
  fx('click_cta', []),

  '-- 6. negative: a key that will not parse must stop the run',
  fx('quiz_result', [{ user_id: 'abc', date_created: '2026-08-02 19:06:40', quiz_title: 't', question: 'q' }]),
  `BEGIN\n${CALL}\nSELECT ERROR('key guard did not fire');\nEXCEPTION WHEN ERROR THEN\n  ASSERT @@error.message LIKE '%quiz_answers: a key column did not parse - see%' AS 'key guard';\nEND;`,

  "SELECT 'ALL BETTER CLUB BQ TESTS PASSED' AS result;",
];

process.stdout.write(steps.join('\n\n') + '\n');
