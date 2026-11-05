/**
 * BETTER CLUB WATCHDOG — paste into the same Apps Script project as backupAllSheets.
 *
 * Every morning at ~06:30 it checks the "Better Club - Raw Data" sheet. If any tab's
 * newest row is older than the start of YESTERDAY (Bangkok), the export missed data:
 *   1. it re-runs backupAllSheets in a separate execution (its own 6-minute budget),
 *   2. 20 minutes later it checks again; if the sheet is now fresh it loads BigQuery
 *      at once (CALL better_club.ingest — safe to repeat, no duplicates),
 *   3. after 2 failed re-runs in a day it stops and emails you.
 * BigQuery's own 07:00 load still runs as usual.
 *
 * SETUP (once):
 *   - Project Settings → Time zone: (GMT+07:00) Bangkok.
 *   - Services (+) → add "BigQuery API" (identifier: BigQuery).
 *   - Set ALERT_TO below, Save, then run setupBetterClubWatchdog() once and allow access.
 *     (Apps Script fires within ~15 minutes of 06:30.)
 */
const BC_SHEET_ID = '18jH1m3dpq5SsSIyPyc49374vuo6CPkJ0RElLAIG3FRo';
const BC_PROJECT = 'ai-reporting-503911';
const ALERT_TO = 'you@bangkokhospital.com';          // ← who gets the "still stale" email
const BC_MAX_RETRIES = 2;
// Tab → the column holding each row's time. A tab is stale if its newest time is
// before the start of yesterday.
const BC_TABS = {
  all_event: 'date_created',
  read_post: 'Date',
  click_cta: 'Date',
  quiz_result: 'date_created',
  customers: 'Exported at',
};

/** Run once: creates the 06:30 daily check. Safe to run again. */
function setupBetterClubWatchdog() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'ensureBetterClubFresh')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('ensureBetterClubFresh').timeBased().everyDays(1).atHour(6).nearMinute(30).create();
  // Seed the customers row-count check with the last full export (5 Nov 2026).
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('bcCustRows')) {
    props.setProperty('bcCustRows', JSON.stringify({ [Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd')]: 57135 }));
  }
  console.log('Watchdog set: daily at ~06:30 Bangkok');
}

/** The daily check. */
function ensureBetterClubFresh() {
  bcCleanupOneOffs_();
  const stale = bcStaleTabs_();
  if (!stale.length) { console.log('Better Club sheet is fresh'); return; }
  console.warn('Stale tabs: ' + stale.join(', '));
  bcRetry_(stale);
}

/** 20 minutes after a re-run: load BigQuery if fresh, else retry or alert. */
function bcAfterBackup() {
  bcCleanupOneOffs_();
  const stale = bcStaleTabs_();
  if (stale.length) { console.warn('Still stale after re-run: ' + stale.join(', ')); bcRetry_(stale); return; }
  // BigQuery reads the sheet through Drive, so this script's token needs Drive
  // access. Apps Script only asks for it when the code touches Drive: this line
  // is that touch (it also confirms the sheet is reachable).
  DriveApp.getFileById(BC_SHEET_ID).getName();
  BigQuery.Jobs.query({
    query: 'CALL `' + BC_PROJECT + '.better_club.ingest`()',
    useLegacySql: false, location: 'asia-southeast1', timeoutMs: 300000,
  }, BC_PROJECT);
  console.log('Sheet fresh after re-run; BigQuery loaded');
}

// ---------------------------------------------------------------------------

function bcRetry_(stale) {
  const props = PropertiesService.getScriptProperties();
  const key = 'bcRetry_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const tries = Number(props.getProperty(key) || 0);
  if (tries >= BC_MAX_RETRIES) {
    MailApp.sendEmail(ALERT_TO, 'Better Club export still missing data',
      'After ' + tries + ' re-runs of backupAllSheets these tabs still have nothing from yesterday: ' +
      stale.join(', ') + '.\nThe dashboard will show "Daily load missed". Check the backupAllSheets log.');
    return;
  }
  props.setProperty(key, String(tries + 1));
  // Separate executions so each gets its own 6-minute limit.
  bcRemember_(ScriptApp.newTrigger('backupAllSheets').timeBased().after(60 * 1000).create());
  bcRemember_(ScriptApp.newTrigger('bcAfterBackup').timeBased().after(20 * 60 * 1000).create());
}

/**
 * Tabs that look broken: newest row older than the start of yesterday (Bangkok),
 * or — for customers, a full member list every day — more than 5% fewer rows than
 * the biggest count of the past 7 days (5 Nov 2026: the export stopped at 49,999
 * of 57,135 members and still reported success).
 */
function bcStaleTabs_() {
  const ss = SpreadsheetApp.openById(BC_SHEET_ID);
  const cut = new Date(); cut.setHours(0, 0, 0, 0); cut.setDate(cut.getDate() - 1);
  return Object.keys(BC_TABS).filter(tab => {
    const sh = ss.getSheetByName(tab);
    const newest = sh ? bcNewest_(sh, BC_TABS[tab]) : null;
    console.log(tab + ': newest ' + (newest ? newest.toISOString() : 'none') + (sh ? ', rows ' + (sh.getLastRow() - 1) : ''));
    if (!newest || newest < cut) return true;
    if (tab === 'customers' && bcShrunk_(sh.getLastRow() - 1)) return true;
    return false;
  });
}

/** Keeps the last 7 days of customers row counts; true if today's is >5% below the best. */
function bcShrunk_(rows) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const hist = JSON.parse(props.getProperty('bcCustRows') || '{}');
  const weekAgo = Utilities.formatDate(new Date(Date.now() - 7 * 864e5), 'Asia/Bangkok', 'yyyy-MM-dd');
  Object.keys(hist).forEach(d => { if (d < weekAgo) delete hist[d]; });
  const best = Math.max(0, ...Object.values(hist));
  const shrunk = best > 0 && rows < 0.95 * best;
  if (shrunk) console.warn('customers has ' + rows + ' rows, best this week ' + best + ': export looks cut short');
  else hist[today] = Math.max(hist[today] || 0, rows);   // only a healthy count can raise the bar
  props.setProperty('bcCustRows', JSON.stringify(hist));
  return shrunk;
}

function bcNewest_(sh, header) {
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return null;
  const col = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String).indexOf(header) + 1;
  if (!col) return null;
  let max = null;
  sh.getRange(2, col, lastRow - 1, 1).getValues().forEach(([v]) => {
    const d = bcParse_(v);
    if (d && (!max || d > max)) max = d;
  });
  return max;
}

/** Sheet dates come as Date objects or text: 2026-08-03 1:33:22, 11/2/2025, ... */
function bcParse_(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return null;
}

/** One-off triggers do not delete themselves; Apps Script allows only 20. */
function bcRemember_(t) {
  const props = PropertiesService.getScriptProperties();
  const ids = JSON.parse(props.getProperty('bcOneOffs') || '[]');
  ids.push(t.getUniqueId());
  props.setProperty('bcOneOffs', JSON.stringify(ids));
}
function bcCleanupOneOffs_() {
  // Called only at the start of a check, when every earlier one-off has already fired.
  const props = PropertiesService.getScriptProperties();
  const ids = JSON.parse(props.getProperty('bcOneOffs') || '[]');
  if (!ids.length) return;
  ScriptApp.getProjectTriggers().filter(t => ids.includes(t.getUniqueId())).forEach(t => ScriptApp.deleteTrigger(t));
  props.deleteProperty('bcOneOffs');
}
