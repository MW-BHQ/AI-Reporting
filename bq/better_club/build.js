#!/usr/bin/env node
/*
 * Better Club → BigQuery. One config (TABS) generates every SQL file.
 *
 *   node bq/better_club/build.js            writes 00_setup.sql 10_ingest.sql 20_views.sql
 *
 * Model
 *   ext_<tab>   external table over the live sheet (all STRING, header row included)
 *   raw_<tab>   append-only text copy. A row goes in once, keyed by a hash of its
 *               values. Nothing is ever deleted, so a wiped daily sheet loses nothing.
 *   <view>      typed, deduped on the business key. The report reads only these.
 *
 * Adding a tab = add one TABS entry, rebuild, run 00 then 10.
 * Adding a source (e.g. the dev's 2024-2025 dump) = load it into raw_<tab> with
 *   _source set; the views dedupe across sources by key.
 */
const fs = require('fs');
const path = require('path');

const PROJECT = 'ai-reporting-503911';
const DS = process.env.BC_DATASET || 'better_club';
const SHEET = '18jH1m3dpq5SsSIyPyc49374vuo6CPkJ0RElLAIG3FRo';
const T = (n) => `\`${PROJECT}.${DS}.${n}\``;

// Header text → snake_case column name.
const snake = (h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// [header, type, opts]. type: str int num dt date bool json html.
// opts.as renames in the view; opts.drop keeps it in raw but out of the view
// (profile fields repeated on event rows belong to customers).
const PROFILE = [
  ['User ID', 'int'], ['Register Channel', 'str'], ['Username', 'str'], ['Name', 'str'],
  ['Gender', 'str'], ['DOB', 'date'], ['Nationality', 'str'], ['Contact Country', 'str'],
  ['Contact City', 'str'], ['Household type', 'str'], ['Number of quiz answered', 'int'],
  ['Has completed profile', 'bool'], ['Has consented marketing', 'bool'],
  ['Has consented marketing updated at', 'dt'], ['Registered at', 'dt'],
  ['Number of daily check-in (all time)', 'int'],
  ['Number of daily check-in complete (all time)', 'int'],
  ['Number of daily check-in complete this month', 'int'],
  ['Email', 'str'], ['Phone no.', 'str'], ['Last login', 'dt'], ['Remaining points', 'num'],
  ['Points earned this month', 'num'], ['Exported at', 'dt'], ['Signup hospital', 'str'],
  ['Signup language', 'str'], ['Signup source', 'str'], ['Signup SSO app', 'str'],
  ['Signup context', 'str'], ['Signup campaign', 'str'], ['Signup country', 'str'],
  ['Last language', 'str'], ['Last login hospital', 'str'], ['Last login (OTP/passkey)', 'str'],
  ['Login hospitals', 'str'], ['Order hospitals', 'str'],
];
const DROP = { drop: true };

const TABS = [
  { tab: 'customers', cols: PROFILE, view: 'customers', key: ['user_id'],
    // Exported at changes every day; leaving it out of the hash stores a row only
    // when something about the member actually changed.
    hashSkip: ['exported_at'], order: 'exported_at DESC', history: 'customers_history' },
  { tab: 'better_staff', cols: PROFILE, view: 'staff', key: ['user_id'],
    hashSkip: ['exported_at'], order: 'exported_at DESC' },
  { tab: 'all_event', view: 'events', key: ['event_id'], cols: [
    ['id', 'int', { as: 'event_id' }], ['user_id', 'int'], ['date_created', 'dt', { as: 'created_at' }],
    ['event_name', 'str'], ['event_desc_1', 'str'], ['event_desc_2', 'str'],
    ['event_desc_json', 'json'], ['website_url', 'str'], ['linked_post_id', 'int'],
    ['should_earn_point', 'bool'], ['point_earned', 'num']] },
  { tab: 'badge_history', view: 'badges', key: ['badge_row_id'], cols: [
    ['id', 'int', { as: 'badge_row_id' }], ['user_id', 'int'], ['date_earned', 'dt', { as: 'earned_at' }],
    ['date_expired', 'dt', { as: 'expires_at' }], ['badge_title', 'str'], ['badge_type', 'str'],
    ['additional_data', 'json']] },
  { tab: 'read_post', view: 'post_reads', key: ['user_id', 'read_at', 'post_id'], cols: [
    ['User ID', 'int'], ['Date', 'dt', { as: 'read_at' }], ['Post ID', 'int'], ['Post type', 'str'],
    ['Post title', 'html'], ['FPD Tags', 'str'], ['Points Earned', 'num'],
    ...Array.from({ length: 10 }, (_, i) => [`tag_${i + 1}`, 'str']),
    ['Email', 'str', DROP], ['Phone', 'str', DROP], ['Gender', 'str', DROP], ['DOB', 'date', DROP],
    ['URL', 'str']] },
  { tab: 'click_cta', view: 'cta_clicks', key: ['user_id', 'clicked_at', 'event', 'url'], cols: [
    ['User ID', 'int'], ['Date', 'dt', { as: 'clicked_at' }], ['Event', 'str'],
    ['Email', 'str', DROP], ['Phone', 'str', DROP], ['Gender', 'str', DROP], ['DOB', 'date', DROP],
    ['URL', 'str']] },
  { tab: 'quiz_result', view: 'quiz_answers', key: ['user_id', 'answered_at', 'quiz_title', 'question'], cols: [
    ['user_id', 'int'], ['date_created', 'dt', { as: 'answered_at' }],
    ['email', 'str', DROP], ['phone', 'str', DROP], ['gender', 'str', DROP], ['dob', 'date', DROP],
    ['quiz_type', 'str'], ['url', 'str'], ['quiz_title', 'str'], ['question', 'str'], ['answer', 'str']] },
];

// Column letter for sheet_range (1 → A, 27 → AA).
const colLetter = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

const cols = (t) => t.cols.map(([h, type, o = {}]) => ({ h, type, raw: snake(h), name: o.as || snake(h), drop: !!o.drop }));

const PARSE = {
  str: (c) => c, int: (c) => `SAFE_CAST(${T("parse_num")}(${c}) AS INT64)`, num: (c) => `${T("parse_num")}(${c})`,
  dt: (c) => `${T("parse_dt")}(${c})`, date: (c) => `DATE(${T("parse_dt")}(${c}))`,
  bool: (c) => `${T("parse_bool")}(${c})`, json: (c) => `SAFE.PARSE_JSON(${c})`, html: (c) => `${T("decode_html")}(${c})`,
};

function setup() {
  const out = [`-- GENERATED by build.js. Do not edit by hand.
CREATE SCHEMA IF NOT EXISTS \`${PROJECT}.${DS}\` OPTIONS (location = 'asia-southeast1');

-- Numbers. Sheets shows a 0 formatted as a date as 12/30/1899 (serial day 0), so a
-- date-looking value in a number column is turned back into its serial number.
CREATE OR REPLACE FUNCTION ${T('parse_num')}(s STRING) AS (
  COALESCE(
    SAFE_CAST(REPLACE(TRIM(s), ',', '') AS NUMERIC),
    IF(REGEXP_CONTAINS(TRIM(s), r'^\\d{1,2}/\\d{1,2}/\\d{4}$'),
       CAST(DATE_DIFF(SAFE.PARSE_DATE('%m/%d/%Y', TRIM(s)), DATE '1899-12-30', DAY) AS NUMERIC), NULL)));

-- Datetimes, Asia/Bangkok wall clock. Seen formats: 2026-08-03 1:33:22, 2025-02-07,
-- 11/2/2025, 11/2/2025 9:05:00. Single-digit hours are padded first.
CREATE OR REPLACE FUNCTION ${T('parse_dt')}(s STRING) AS ((
  SELECT COALESCE(
    SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', v),
    DATETIME(SAFE.PARSE_DATE('%Y-%m-%d', v)),
    SAFE.PARSE_DATETIME('%m/%d/%Y %H:%M:%S', v),
    DATETIME(SAFE.PARSE_DATE('%m/%d/%Y', v)))
  FROM (SELECT REGEXP_REPLACE(TRIM(s), r' (\\d):', ' 0\\\\1:') AS v)));

CREATE OR REPLACE FUNCTION ${T('parse_bool')}(s STRING) AS (
  CASE UPPER(TRIM(s)) WHEN 'YES' THEN TRUE WHEN '1' THEN TRUE WHEN 'TRUE' THEN TRUE
                      WHEN 'NO' THEN FALSE WHEN '0' THEN FALSE WHEN 'FALSE' THEN FALSE END);

-- Post titles arrive with HTML entities (&#038;).
CREATE OR REPLACE FUNCTION ${T('decode_html')}(s STRING) RETURNS STRING LANGUAGE js AS r"""
  if (s == null) return null;
  return s.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\\d+);/g, (m, d) => String.fromCodePoint(+d))
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
""";

-- One row per tab per run. rows_in_source = 0 means the sheet was not refreshed.
CREATE TABLE IF NOT EXISTS ${T('_ingest_log')} (
  run_at TIMESTAMP, tab STRING, rows_in_source INT64, rows_inserted INT64);
`];
  for (const t of TABS) {
    const c = cols(t);
    out.push(`
-- ${t.tab}
CREATE OR REPLACE EXTERNAL TABLE ${T('ext_' + t.tab)} (
  ${c.map((x) => `${x.raw} STRING`).join(',\n  ')})
OPTIONS (format = 'GOOGLE_SHEETS', skip_leading_rows = 0,
  uris = ['https://docs.google.com/spreadsheets/d/${SHEET}'],
  sheet_range = '${t.tab}!A:${colLetter(c.length)}');

CREATE TABLE IF NOT EXISTS ${T('raw_' + t.tab)} (
  ${c.map((x) => `${x.raw} STRING`).join(',\n  ')},
  _row_hash STRING NOT NULL, _source STRING NOT NULL, _loaded_at TIMESTAMP NOT NULL)
PARTITION BY DATE(_loaded_at) CLUSTER BY _row_hash;`);
  }
  return out.join('\n') + '\n';
}

// Ingest is a stored procedure, so the daily scheduled query is one line:
//   CALL `ai-reporting-503911.better_club.ingest`();
// src(tab) names the table to read; the test points it at fixtures.
function ingest(src = (tab) => T('ext_' + tab), source = 'sheet') {
  const out = [`-- GENERATED by build.js. Do not edit by hand.
-- Safe to re-run any number of times: a row already in raw_* is skipped, and
-- nothing is deleted. Run 00_setup.sql and 20_views.sql first.
CREATE OR REPLACE PROCEDURE ${T('ingest')}()
BEGIN
DECLARE run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
DECLARE n INT64;`];
  for (const t of TABS) {
    const c = cols(t);
    const first = c[0].raw;
    const hashCols = c.filter((x) => !(t.hashSkip || []).includes(x.raw)).map((x) => x.raw);
    out.push(`
-- ${t.tab}: stop if the columns moved. Positional schema would load them silently wrong.
ASSERT (SELECT COUNT(*) FROM ${src(t.tab)}
        WHERE ARRAY_TO_STRING([${c.map((x) => x.raw).join(', ')}], '|') = '${c.map((x) => x.h.replace(/'/g, "\\'")).join('|')}') = 1
  AS '${t.tab}: header row does not match build.js';

SET n = (SELECT COUNT(*) FROM ${src(t.tab)} WHERE NULLIF(TRIM(${first}), '') IS NOT NULL AND ${first} != '${c[0].h}');

MERGE ${T('raw_' + t.tab)} r
USING (
  SELECT *, TO_HEX(SHA256(TO_JSON_STRING(STRUCT(${hashCols.join(', ')})))) AS _h FROM (
    SELECT ${c.map((x) => `NULLIF(TRIM(${x.raw}), '') AS ${x.raw}`).join(', ')}
    FROM ${src(t.tab)}
    WHERE NULLIF(TRIM(${first}), '') IS NOT NULL AND ${first} != '${c[0].h}')
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY _h) = 1
) s
ON r._row_hash = s._h
WHEN NOT MATCHED THEN INSERT (${c.map((x) => x.raw).join(', ')}, _row_hash, _source, _loaded_at)
  VALUES (${c.map((x) => 's.' + x.raw).join(', ')}, s._h, '${source}', run_at);

INSERT ${T('_ingest_log')} VALUES (run_at, '${t.tab}', n, @@row_count);`);
  }
  // Keys must parse, or dedup silently merges different rows. Data is already in
  // raw_* when this fails, so fixing the parser and re-running loses nothing.
  for (const t of TABS) {
    out.push(`
ASSERT (SELECT COUNT(*) FROM ${T(t.view)} WHERE ${t.key.map((k) => `${k} IS NULL`).join(' OR ')}) = 0
  AS '${t.view}: a key column did not parse - see build.js PARSE';`);
  }
  out.push('END;');
  return out.join('\n') + '\n';
}

function views() {
  const out = ['-- GENERATED by build.js. Do not edit by hand.'];
  const sel = (t) => cols(t).filter((x) => !x.drop).map((x) => `${PARSE[x.type](x.raw)} AS ${x.name}`).join(',\n    ');
  for (const t of TABS) {
    const order = t.order ? `${t.order}, _loaded_at DESC` : '_loaded_at DESC';
    out.push(`
-- ${t.view}: one row per ${t.key.join(' + ')}, latest wins.
CREATE OR REPLACE VIEW ${T(t.view)} AS
SELECT * FROM (
  SELECT
    ${sel(t)},
    _source, _loaded_at
  FROM ${T('raw_' + t.tab)})
WHERE TRUE
QUALIFY ROW_NUMBER() OVER (PARTITION BY ${t.key.join(', ')} ORDER BY ${order}) = 1;`);
    if (t.history) {
      out.push(`
-- ${t.history}: every version of a member we have seen (a row per change).
CREATE OR REPLACE VIEW ${T(t.history)} AS
SELECT
    ${sel(t)},
    _source, _loaded_at
FROM ${T('raw_' + t.tab)};`);
    }
  }
  out.push(`
-- Members with a staff flag. Reports exclude is_staff by default.
CREATE OR REPLACE VIEW ${T('members')} AS
SELECT c.*, s.user_id IS NOT NULL AS is_staff
FROM ${T('customers')} c LEFT JOIN ${T('staff')} s USING (user_id);`);
  return out.join('\n') + '\n';
}

module.exports = { TABS, setup, ingest, views, cols, snake, colLetter, T, DS, PROJECT };

if (require.main === module) {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, '00_setup.sql'), setup());
  fs.writeFileSync(path.join(dir, '10_ingest.sql'), ingest());
  fs.writeFileSync(path.join(dir, '20_views.sql'), views());
  console.log(`wrote 00_setup.sql 10_ingest.sql 20_views.sql for ${PROJECT}.${DS}`);
}
