/**
 * E-COMMERCE NORMALISER, RUN FOR REAL (v3.420.0).
 *
 * apps-script/ecommerce-normalise.gs is executed in a Node vm against a fake
 * SpreadsheetApp, with test/fixtures/ecom-bedee-oct26.json — MW's
 * Shop_bede_oct_26.xlsx with names, phones and emails replaced — as the
 * `Insert` tab, exactly as Sheets' File ▸ Import lays it out (header on row 4,
 * merged cells holding their value in the top cell only, dates as Date objects
 * in Buddhist years, times as Dates on 30 Dec 1899 that DISPLAY as "21:17").
 *
 * MW: "this file wouldn't ingest campaign name and order time ... make sure it
 * won't happen again." So every case below is about those two fields.
 */
process.env.TZ = 'Asia/Bangkok';
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../apps-script/ecommerce-normalise.gs'), 'utf8');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ecom-bedee-oct26.json'), 'utf8')).rows;

let FAIL = 0;
const expect = (name, ok, got = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(42)} ${ok ? '' : got}`); if (!ok) FAIL++; };

const pad = (n) => String(n).padStart(2, '0');
/** A fixture cell → [value Apps Script gets, text the sheet shows]. */
function cell(v) {
  if (v && v.$d) { const [y, m, d] = v.$d; return [new Date(y, m - 1, d), `${pad(m)}/${pad(d)}/${y}`]; }
  // A time-only cell: Sheets hands Apps Script a Date on 30 Dec 1899 — in
  // Bangkok's 1899 local mean time, so formatting it is unreliable. The test
  // gives it a deliberately WRONG clock time; only the shown text is right.
  if (v && v.$t) { const [h, mi] = v.$t; return [new Date(1899, 11, 30, (h + 23) % 24, (mi + 18) % 60), `${h}:${pad(mi)}`]; }
  return [v, v === '' || v == null ? '' : String(v)];
}

/** Minimal Range/Sheet/Spreadsheet over plain 2-D arrays. */
function makeSheet(name, values, shown) {
  const sh = { name, v: values.map((r) => r.slice()), s: (shown || values.map((r) => r.map((x) => (x == null ? '' : String(x))))).map((r) => r.slice()) };
  const width = () => Math.max(0, ...sh.v.map((r) => r.length));
  const ensure = (r, c) => { while (sh.v.length < r) { sh.v.push([]); sh.s.push([]); } for (const row of [sh.v[r - 1], sh.s[r - 1]]) while (row.length < c) row.push(''); };
  const range = (r, c, nr, nc) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((sh.v[r - 1 + i] || [])[c - 1 + j] ?? ''))),
    getDisplayValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => String((sh.s[r - 1 + i] || [])[c - 1 + j] ?? ''))),
    setValues: (vals) => { vals.forEach((row, i) => row.forEach((x, j) => { ensure(r + i, c + j); sh.v[r - 1 + i][c - 1 + j] = x; sh.s[r - 1 + i][c - 1 + j] = x == null ? '' : String(x); })); return range(r, c, nr, nc); },
    setFontWeight: () => range(r, c, nr, nc), setBackgrounds: () => range(r, c, nr, nc),
    setNumberFormat: () => range(r, c, nr, nc),
  });
  Object.assign(sh, {
    getName: () => name,
    getLastRow: () => { for (let i = sh.v.length; i > 0; i--) if (sh.v[i - 1].some((x) => x !== '' && x != null)) return i; return 0; },
    getLastColumn: () => width(),
    getRange: (r, c, nr = 1, nc = 1) => range(r, c, nr, nc),
    getDataRange: () => range(1, 1, sh.v.length, width()),
    setFrozenRows: () => {},
    appendRow: (row) => { sh.v.push(row.slice()); sh.s.push(row.map(String)); },
  });
  return sh;
}

const OUT_HEADERS_PROBE = /var OUT_HEADERS = (\[[\s\S]*?\]);/.exec(SRC)[1];
const OUT_HEADERS = vm.runInNewContext(OUT_HEADERS_PROBE);
const MAP_HEADERS = vm.runInNewContext(/var MAP_HEADERS = (\[[\s\S]*?\]);/.exec(SRC)[1]);
const LOG_HEADERS = vm.runInNewContext(/var LOG_HEADERS = (\[[\s\S]*?\]);/.exec(SRC)[1]);

/** One fresh "spreadsheet" and a run of normaliseInsert over `insertRows`. */
function run(insertRows, { orders = null, answer = 'YES' } = {}) {
  const sheets = {};
  const add = (sh) => { sheets[sh.getName()] = sh; return sh; };
  const cells = insertRows.map((r) => r.map(cell));
  add(makeSheet('Insert', cells.map((r) => r.map((c) => c[0])), cells.map((r) => r.map((c) => c[1]))));
  add(makeSheet('Orders', orders || [OUT_HEADERS]));
  add(makeSheet('Package_Map', [MAP_HEADERS]));
  add(makeSheet('Load_Log', [LOG_HEADERS]));
  add(makeSheet('Package_Name', [['Thai Name', 'Product SKU', 'Center', ' Price', 'Full Price'], ['ชุดตรวจสุขภาพ ทดสอบ', '0101-2610', 'HDC', 1000, 1200]]));
  const alerts = [];
  const ui = {
    alert: (...a) => { alerts.push(a.filter((x) => typeof x === 'string').join(' | ')); return answer; },
    ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' }, Button: { YES: 'YES', NO: 'NO' },
  };
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => add(makeSheet(n, [])),
    deleteSheet: (sh) => { delete sheets[sh.getName()]; },
    toast: () => {},
  };
  const fmt = (d, tz, f) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour === '24' ? '00' : p.hour).replace('mm', p.minute).replace('ss', p.second);
  };
  const ctx = {
    SpreadsheetApp: { getActive: () => ss, getUi: () => ui, flush: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'test-pepper', setProperty: () => {}, deleteProperty: () => {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },
    Utilities: {
      formatDate: fmt,
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()].map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (s) => Buffer.from(s).toString('base64'), getUuid: () => crypto.randomUUID(),
    },
    ScriptApp: { getProjectTriggers: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.normaliseInsert();
  const o = sheets.Orders;
  const head = o.v[0];
  const rows = o.v.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  return { rows, alerts, insertLeft: !!sheets.Insert, log: sheets.Load_Log.v.slice(1) };
}

const H = FIX[3];
const iCamp = H.indexOf('ชื่อแคมเปญ'), iTime = H.indexOf('เวลาที่ซื้อ');
const timesInFile = FIX.slice(5).filter((r) => r[H.indexOf('หมายเลขสั่งซื้อ')] !== '' && r[iTime] && r[iTime].$t)
  .map((r) => `${pad(r[iTime].$t[0])}:${pad(r[iTime].$t[1])}`);

console.log('--- e-commerce normaliser · Shop.BeDee Oct 2026 (v3.420.0) ---');
const a = run(FIX);
if (!a.rows.length) { console.log("  FAIL nothing imported: " + a.alerts.join(" // ")); process.exit(1); }
expect('imports every coupon row', a.rows.length > 30 && !a.insertLeft, `${a.rows.length} rows`);
expect('campaign on every row', a.rows.every((r) => r.campaign_name === 'Annual campaign'),
  JSON.stringify([...new Set(a.rows.map((r) => r.campaign_name))]));
expect('time on every row, HH:mm', a.rows.every((r) => /^\d{2}:\d{2}$/.test(r.purchase_time)),
  JSON.stringify(a.rows.filter((r) => !/^\d{2}:\d{2}$/.test(r.purchase_time)).slice(0, 3).map((r) => r.purchase_time)));
// The Date handed to the script has the WRONG clock time on purpose: only the
// shown text is right, so reading the Date would fail here.
const firstOrderTime = a.rows.find((r) => r.order_id === '20260010188');
expect('time is what the sheet shows', firstOrderTime && firstOrderTime.purchase_time === '21:17', firstOrderTime && firstOrderTime.purchase_time);
expect('every order time matches the file', new Set(a.rows.map((r) => r.purchase_time)).size === new Set(timesInFile).size,
  `${new Set(a.rows.map((r) => r.purchase_time)).size} vs ${new Set(timesInFile).size}`);
// The merged second coupon of order 1 (row 7) inherits campaign and time.
const o1 = a.rows.filter((r) => r.order_id === '20260010188');
expect('continuation coupon inherits both', o1.length === 2 && o1.every((r) => r.campaign_name && r.purchase_time === '21:17'), JSON.stringify(o1.map((r) => [r.campaign_name, r.purchase_time])));
expect('date is CE', a.rows.every((r) => /^2026-10-\d{2}$/.test(r.purchase_date)), a.rows[0].purchase_date);
expect('no personal data written', !JSON.stringify(a.rows).match(/Customer \d|example\.com|\+6680/));

// Required, not optional: an export without the campaign column stops and writes nothing.
const noCamp = FIX.map((r, i) => (i === 3 ? r.map((h, j) => (j === iCamp ? 'Campaign?' : h)) : r));
const b = run(noCamp);
expect('missing campaign column: stops', b.rows.length === 0 && b.insertLeft, `${b.rows.length} rows written`);
expect('missing campaign column: says so', b.alerts.some((x) => /required columns/.test(x) && x.includes('ชื่อแคมเปญ')), b.alerts.join(' // '));
const noTime = FIX.map((r, i) => (i === 3 ? r.map((h, j) => (j === iTime ? '' : h)) : r));
const c = run(noTime);
expect('missing time column: stops', c.rows.length === 0 && c.alerts.some((x) => x.includes('เวลาที่ซื้อ')), c.alerts.join(' // '));

// A stray space after a header must not lose the column.
const spaced = FIX.map((r, i) => (i === 3 ? r.map((h, j) => (j === iCamp ? h + ' ' : h)) : r));
const d = run(spaced);
expect('header with trailing space still found', d.rows.length === a.rows.length && d.rows.every((r) => r.campaign_name === 'Annual campaign'));

// Re-import REPAIRS rows already in Orders with blank campaign/time, and never overwrites.
const blanked = [OUT_HEADERS, ...a.rows.map((r, i) => OUT_HEADERS.map((h) => {
  if (h === 'campaign_name') return i === 0 ? 'Kept as is' : '';
  if (h === 'purchase_time') return '';
  return r[h];
}))];
const e = run(FIX, { orders: blanked });
expect('re-import appends nothing', e.rows.length === a.rows.length, `${e.rows.length} vs ${a.rows.length}`);
expect('re-import fills blank campaign', e.rows.slice(1).every((r) => r.campaign_name === 'Annual campaign'));
expect('re-import never overwrites', e.rows[0].campaign_name === 'Kept as is', e.rows[0].campaign_name);
expect('re-import fills blank time', e.rows.every((r) => /^\d{2}:\d{2}$/.test(r.purchase_time)));
expect('re-import reports the repair', e.alerts.some((x) => /Filled in on rows already in Orders: \d+ campaign, \d+ time/.test(x)), e.alerts.slice(-1)[0]);

console.log(FAIL ? `\n${FAIL} normaliser check(s) failed` : '\nnormaliser checks clean');
process.exit(FAIL ? 1 : 0);
