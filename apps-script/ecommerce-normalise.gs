/**
 * BHQ E-commerce — monthly order normaliser  ·  v2.12.0
 * =================================================
 *
 * THIS FILE IS THE SOURCE OF TRUTH (v2.12.0). It lives in the War Room repo
 * (apps-script/ecommerce-normalise.gs) and is tested by test/ecom-normalise.js
 * against a real export. The copy inside the Sheet is a deployment: paste this
 * whole file over it (Extensions ▸ Apps Script), never edit it there.
 *
 * SETUP: the package master must exist in THIS spreadsheet as a tab named
 * `Package_Name` (duplicate it from the e-commerce raw data file).
 *
 * MONTHLY WORKFLOW
 *   1. Import the `report_order-*.xlsx` as a tab named `Insert`.
 *   2. Menu: กดตรงนี้ 👆🏻 ▸ Normalise Insert sheet.
 *   3. Clean rows land in `Orders`; `Insert` is deleted on success.
 *   4. Any package the script could not resolve confidently is WRITTEN INTO
 *      `Package_Map` with its best suggestion, so the e-commerce team can
 *      correct it in place. Nothing is silently dropped.
 *
 * HOW PACKAGES ARE RESOLVED
 *   The order export and the package master do not share package names —
 *   "Essence Check-up 15-30 ปี" in the master is "Essence Check Up อายุ 15 - 30 ปี"
 *   in the export — so matching is done on a punctuation-insensitive key, with
 *   price as a tie-breaker. `Package_Map` is the crosswalk and the single place
 *   a human ever edits. Once a row there has a SKU, the script never touches it
 *   again, so corrections are permanent.
 *
 *   Centre, English name, full price and location are read from the master via
 *   the SKU, never copied by hand, so the master stays the source of truth.
 *
 * A KNOWN LIMIT, STATED PLAINLY
 *   The master re-codes a package each promo cycle (0101-2604, 0101-2608) with
 *   no effective dates, so for a historical order there is no way to know which
 *   SKU was live. The script picks the latest SKU dated on or before the order
 *   month and marks the row `review_multi` rather than presenting a guess as
 *   fact. Going forward, ask e-commerce to fill `effective_from` in the master:
 *   this script uses that column automatically as soon as it exists, and those
 *   rows then resolve exactly.
 *
 * PRIVACY
 *   Name, phone and email never reach `Orders`. They become HMAC-SHA256 keys
 *   using a secret pepper in Script Properties — not in any sheet, not in this
 *   file. The same person yields the same key, so repeat-purchase and channel-
 *   switching analysis works, but a key cannot be turned back into a phone
 *   number. A plain hash would not be enough: Thai mobiles are a small enough
 *   space to brute-force. The pepper is what makes reversal impractical.
 *
 * v2.9.0 — added "Find packages missing from Package_Map" (rebuildPackageMap).
 *   Package_Map was only ever written during import, so a map row that was
 *   deleted or lost to a half-finished import orphaned that package forever:
 *   Orders kept the sales and nothing noticed. 27 packages carrying 3,603 order
 *   rows were in that state.
 *
 * v2.11.0 — step 3 (reapplyMapping) no longer times out. It read and rewrote
 *   all ~3 million cells of Orders and hit the six-minute limit, so rows after
 *   the cut-off kept their old SKU. It now reads only the 9 columns it needs in
 *   10,000-row blocks, writes a block only when something changed, and saves
 *   its place at 4½ minutes and carries on by timer. Its report counts every
 *   changed field, not only SKU and status ("Refreshed 0 rows" is gone).
 *
 * v2.12.0 — campaign name and purchase time can no longer go missing (MW: the
 *   Shop.BeDee October file "wouldn't ingest campaign name and order time").
 *   · Both columns are REQUIRED. They used to be optional with a "Continue
 *     anyway?" button, and one click on it wrote every row of the month with
 *     both fields blank, permanently.
 *   · A re-import REPAIRS. A coupon already in Orders was skipped as a
 *     duplicate, so importing the file again — the obvious fix — changed
 *     nothing. Now, when the existing row has a blank campaign_name or
 *     purchase_time and the file has the value, the blank is filled in.
 *   · Time is read as SHOWN in the sheet ("21:17"). A time-only cell comes back
 *     to Apps Script as a Date on 30 Dec 1899, where Bangkok used local mean
 *     time (+6:42), so formatting it could shift the minutes.
 *   · The run counts rows that still have a blank campaign or time and says so
 *     in the closing alert and in Load_Log, instead of passing silently.
 */

// ─────────────────────────────────────────────────────────── configuration

var SHEET_INSERT = 'Insert';
var SHEET_ORDERS = 'Orders';
var SHEET_MAP    = 'Package_Map';
var SHEET_LOG    = 'Load_Log';

/** The package master tab, duplicated into this spreadsheet. */
var MASTER_TAB = 'Package_Name';

var PEPPER_PROP = 'PII_PEPPER';
var FUZZY_CUTOFF = 0.85;   // below this, a name is reported missing rather than guessed

/** Raw export headers (row 4 of the file). */
var COL = {
  campaign:'ชื่อแคมเปญ', channel:'ที่ตั้ง', country:'Country',
  orderId:'หมายเลขสั่งซื้อ', receiptNo:'เลขที่ใบเสร็จ', sellerOrder:'หมายเลขคำสั่งซื้อ (Seller)',
  purchaseDate:'วันที่ซื้อ', purchaseTime:'เวลาที่ซื้อ',
  payStatus:'สถานะการชำระเงิน', orderStatus:'สถานะสั่งซื้อ (Seller)',
  custPhone:'เบอร์โทร', custEmail:'อีเมล',
  packageName:'ชื่อแพ็กเกจ', price:'ราคา/แพ็กเกจ',
  couponNo:'หมายเลขคูปอง', couponExpiry:'วันที่คูปองหมดอายุ',
  couponStatus:'สถานะคูปอง', couponQty:'จำนวนคูปอง',
  discount:'ส่วนลดต่อใบเสร็จ', platformPromo:'Platform Promotion',
  paymentTotal:'ประเภทการชำระเงิน',
  txnFee:'Transaction Fee (บาท)', commFee:'Commission Fee (บาท)'
};

/** Master headers. `effective_from` is optional and used when present. */
var M = {
  campaign:'Campaign', center:'Center', thaiName:'Thai Name', engName:'English Name',
  fullPrice:'Full Price', price:' Price', sku:'Product SKU', location:'Location',
  effectiveFrom:'effective_from'
};

var OUT_HEADERS = [
  'load_batch','order_id','receipt_no','seller_order_id',
  'purchase_date','purchase_time','year_month',
  'channel','country','campaign_name',
  'payment_status','order_status','payment_method',
  'package_name','sku','center','english_name','location',
  'price','full_price','discount_pct',
  'discount_alloc','promo_alloc','txn_fee_alloc','comm_fee_alloc','net_revenue',
  'coupon_no','coupon_status','coupon_expiry',
  'is_valid_sale','is_online','map_status','email_key','phone_key','dedup_key'
];

/**
 * The export can be run unfiltered, in which case it also contains walk-in and
 * offline sales (HPC 1, เวชระเบียน, ทันตกรรม, Contact Center …). Those are real
 * revenue but they are not e-commerce, so each row is tagged and the dashboard
 * can show either. Anything not listed here is treated as offline.
 */
var ONLINE_CHANNELS = ['Shopee', 'Lazada', 'Health Plaza', 'Line Chatbot', 'Line Shopping', 'Shop.BeDee', 'Bangkok Hospital Website'];

/**
 * The full channel taxonomy, mirroring CHANNEL_TYPE in the dashboard. Kept here
 * so validation can name channels the dashboard would silently bucket as
 * "Unclassified" — a name absent from this list is a taxonomy gap, not a
 * customer segment, and it should be visible rather than averaged in.
 */
var KNOWN_CHANNELS = {
  'Shopee':'Online', 'Lazada':'Online', 'Health Plaza':'Online', 'Line Chatbot':'Online',
  'Line Shopping':'Online', 'Shop.BeDee':'Online', 'Bangkok Hospital Website':'Online',
  'HPC 1':'Offline', 'เปียโน':'Offline', 'เวชระเบียน':'Offline', 'ทันตกรรม':'Offline',
  'Contact Center':'Offline', 'เว็บไซต์':'Offline', 'พลาซ่า':'Offline',
  'BHT IPD / OPD':'Offline', 'ชีววัฒนะ':'Offline', 'Website (Special)':'Offline',
  'ตึกวัฒโนสถ':'Offline',
  'Agent':'B2B', 'SME&COP':'B2B', 'การตลาดกลุ่มลูกค้าองค์กร':'B2B', 'DR PHARMA':'B2B',
  'SAVE DRUG':'B2B', 'Insurance':'B2B',
  'Partnership':'Special Campaign', 'Free Trial':'Special Campaign',
  'Run with the Flow':'Special Campaign',
  'คูปองอภินันทนาการ':'Complementary', 'Complementary (Discount Coupon)':'Complementary',
  'Better Club':'Complementary',
  'Extra':'Extra'
};

var LOG_HEADERS = ['run_at','batch','orders','coupon_rows','appended',
                   'skipped_duplicates','new_map_rows','needs_review','notes'];

var MAP_HEADERS = [
  'export_package_name','price','sku','center',
  'status','suggested_sku','alternatives','similarity',
  'first_seen','rows_seen','notes'
];

/** Tidy-up for the master's inconsistent centre names. */
var CENTER_FIX = {
  'gi & liver':'GI and Liver', 'gi and liver':'GI and Liver',
  'med':'MED', 'women/vaccine':'Women', 'vaccine/longevity':'Vaccine',
  'women/cancer':'Women', 'cancer/chest & respiratory':'Cancer',
  'chest & respiratory':'Chest and Respiratory',
  'arthritis and rheumatic':'Arthritis and Rheumatic'
};

// ─────────────────────────────────────────────────────────── menu

/**
 * THE MENU IS THE INSTRUCTIONS.
 *
 * It used to be nine items in the order they were written, so the four steps of
 * the monthly run were scattered among the one-off repair tools and nobody could
 * tell which was which. Now the monthly run is numbered 1-4 at the top, in the
 * order it must happen, and everything else is either "when you need it" or
 * buried in a submenu that should be opened about once a year.
 *
 * Labels changed; function names did not. Anything already bound to a function
 * name keeps working.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('\u0e01\u0e14\u0e15\u0e23\u0e07\u0e19\u0e35\u0e49 \ud83d\udc46\ud83c\udffb')
    // The monthly run, in order. Do all four, top to bottom.
    .addItem('1 \u00b7 Import the month (Insert \u2192 Orders)', 'normaliseInsert')
    .addItem('2 \u00b7 Find new packages', 'rebuildPackageMap')
    .addItem('3 \u00b7 Apply Package_Map to Orders', 'reapplyMapping')
    .addItem('4 \u00b7 Check the result', 'validateOrders')
    .addSeparator()
    // Useful, but not every month.
    .addItem('Which packages to map first', 'prioritisePackageMap')
    .addItem('Re-try SKUs after the master grows', 'refreshSuggestions')
    .addSeparator()
    /**
     * Setup and repair, in a submenu on purpose. "First-time setup" DELETES the
     * Orders tab when it finds a legacy header, and it sat one click away from
     * the monthly import in the flat menu.
     */
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Setup and repair')
      .addItem('First-time setup (deletes existing tabs)', 'setupSheets')
      .addItem('Upgrade Orders to current schema', 'upgradeOrdersSchema')
      .addItem('Re-derive is_online from channel', 'rederiveIsOnline'))
    .addToUi();
}

/**
 * v1 wrote a narrower Orders sheet and an Unmapped_Packages tab. Appending v2
 * rows onto v1 headers would silently shift every column, so setup refuses to
 * continue until the old tabs are cleared.
 */
function checkLegacy_() {
  var ss = SpreadsheetApp.getActive(), stale = [];
  var old = ss.getSheetByName('Unmapped_Packages');
  if (old) stale.push('Unmapped_Packages (v1 only)');
  var o = ss.getSheetByName(SHEET_ORDERS);
  if (o && o.getLastRow() >= 1) {
    var head = o.getRange(1,1,1,Math.max(1,o.getLastColumn())).getValues()[0];
    if (head.length !== OUT_HEADERS.length || head.indexOf('map_status') === -1) {
      stale.push('Orders (has ' + head.length + ' columns, v2 needs ' + OUT_HEADERS.length + ')');
    }
  }
  var m = ss.getSheetByName(SHEET_MAP);
  if (m && m.getLastRow() >= 1) {
    var mh = m.getRange(1,1,1,Math.max(1,m.getLastColumn())).getValues()[0];
    if (mh.length !== MAP_HEADERS.length) {
      stale.push('Package_Map (has ' + mh.length + ' columns, v2 needs ' + MAP_HEADERS.length + ')');
    }
  }
  var lg = ss.getSheetByName(SHEET_LOG);
  if (lg && lg.getLastRow() >= 1) {
    var lh = lg.getRange(1,1,1,Math.max(1,lg.getLastColumn())).getValues()[0];
    if (lh.length !== LOG_HEADERS.length) {
      stale.push('Load_Log (has ' + lh.length + ' columns, this version writes ' +
                 LOG_HEADERS.length + ' — entries would be shifted)');
    }
  }
  return stale;
}

function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  var stale = checkLegacy_();
  if (stale.length) {
    var go = SpreadsheetApp.getUi().alert('Tabs from the earlier version found',
      stale.join('\n') + '\n\nDelete them and let this version rebuild them?\n' +
      'Rows already imported will be removed — re-import the monthly file afterwards.',
      SpreadsheetApp.getUi().ButtonSet.YES_NO);
    if (go !== SpreadsheetApp.getUi().Button.YES) return;
    ['Unmapped_Packages', SHEET_ORDERS, SHEET_MAP, SHEET_LOG].forEach(function (n) {
      var sh = ss.getSheetByName(n);
      if (sh) ss.deleteSheet(sh);
    });
  }
  ensureSheet_(ss, SHEET_ORDERS, OUT_HEADERS);
  ensureSheet_(ss, SHEET_MAP, MAP_HEADERS);
  ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PEPPER_PROP)) {
    props.setProperty(PEPPER_PROP,
      Utilities.base64Encode(Utilities.getUuid() + Utilities.getUuid() + new Date().getTime()));
  }
  SpreadsheetApp.getUi().alert(
    'Setup complete.\n\n' +
    'Sheets ready: Orders, Package_Map, Load_Log.\n' +
    'A private hashing key was generated in Script Properties.\n\n' +
    'Never delete or regenerate that key — customer keys from earlier months would ' +
    'stop matching newer ones and repeat-customer analysis would break silently.\n\n' +
    'Check MASTER_TAB at the top of the script points at your package master tab.'
  );
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ─────────────────────────────────────────────────────────── small helpers

function pepper_() {
  var p = PropertiesService.getScriptProperties().getProperty(PEPPER_PROP);
  if (!p) throw new Error('No hashing key. Run First-time setup.');
  return p;
}
function hashKey_(v, pep) {
  if (!v) return '';
  return Utilities.computeHmacSha256Signature(String(v), pep)
    .map(function(b){ return ('0'+(b & 0xFF).toString(16)).slice(-2); })
    .join('').substring(0,16);
}
function clean_(v){ return String(v==null?'':v).replace(/^'/,'').trim(); }
function toNum_(v){
  if (typeof v === 'number') return v;
  var s = String(v==null?'':v).replace(/[, ]/g,'').replace(/^'/,'');
  if (s===''||s==='-') return 0;
  var n = parseFloat(s); return isNaN(n)?0:n;
}
function round2_(n){ return Math.round(n*100)/100; }

/** 0894816881 / 66894816881 / +66894816881 must all give ONE key. */
function normPhone_(v){
  var s = String(v==null?'':v).replace(/^'/,'').replace(/\D/g,'');
  if (s.indexOf('66')===0 && s.length>=11) s = '0'+s.substring(2);
  return s.length>=9 ? s : '';
}
function normEmail_(v){ return String(v==null?'':v).trim().toLowerCase(); }

/** Buddhist Era → CE ISO. Handles Date objects, yyyy-mm-dd and dd/mm/yyyy. */
function beToIso_(v){
  if (!v) return '';
  if (Object.prototype.toString.call(v)==='[object Date]'){
    var y=v.getFullYear(); if (y>2400) y-=543;
    return Utilities.formatDate(new Date(y,v.getMonth(),v.getDate()),
      Session.getScriptTimeZone(),'yyyy-MM-dd');
  }
  var a=String(v).match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (a){ var y1=+a[1]; if (y1>2400) y1-=543;
    return y1+'-'+('0'+a[2]).slice(-2)+'-'+('0'+a[3]).slice(-2); }
  var b=String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (b){ var y2=+b[3]; if (y2>2400) y2-=543;
    return y2+'-'+('0'+b[2]).slice(-2)+'-'+('0'+b[1]).slice(-2); }
  return '';
}

/**
 * Purchase time as HH:mm (v2.12.0). The text the sheet SHOWS comes first:
 * "21:17", "9:05", "21:17:00" and "21.17" all read correctly. Only when that
 * is empty is the raw value used — a Date (formatted), or a day fraction
 * (0.887 → 21:17) when the cell arrived as a plain number.
 */
function timeOf_(shown, raw){
  var m = String(shown==null?'':shown).replace(/^'/,'').match(/(\d{1,2})[:.](\d{2})/);
  if (m && +m[1] < 24 && +m[2] < 60) return ('0'+m[1]).slice(-2)+':'+m[2];
  if (Object.prototype.toString.call(raw)==='[object Date]')
    return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'HH:mm');
  if (typeof raw === 'number' && raw >= 0 && raw < 1){
    var mins = Math.round(raw*1440);
    return ('0'+Math.floor(mins/60)).slice(-2)+':'+('0'+(mins%60)).slice(-2);
  }
  return clean_(raw);
}

/**
 * Matching key: lower-case, and every space and punctuation mark removed.
 * The two systems differ only in hyphens, brackets and spacing
 * ("Check-up 15-30 ปี" vs "Check Up อายุ 15 - 30 ปี"), so an exact-string
 * join throws away three quarters of the matches this recovers.
 */
function pkgKey_(s){
  return String(s==null?'':s).toLowerCase().replace(/[^0-9a-z\u0E00-\u0E7F]/g,'');
}

function fixCenter_(c){
  var k = String(c||'').trim().toLowerCase();
  return CENTER_FIX[k] || String(c||'').trim();
}

/** SKUs like 0101-2604 encode a period (Apr 2026). Older ones (BC25-01) do not. */
function skuPeriod_(sku){
  var m = String(sku||'').trim().match(/^\d{3,4}-(\d{2})(\d{2})$/);
  if (!m) return null;
  var yy=+m[1], mm=+m[2];
  return (mm>=1 && mm<=12) ? (2000+yy)*100+mm : null;
}

/** Cheap similarity on the normalised keys: shared bigrams (Dice). */
function similarity_(a,b){
  if (!a||!b) return 0;
  if (a===b) return 1;
  var A={},n=0;
  for (var i=0;i<a.length-1;i++){ var g=a.substr(i,2); A[g]=(A[g]||0)+1; n++; }
  var hit=0,m=0;
  for (var j=0;j<b.length-1;j++){ var h=b.substr(j,2); m++; if (A[h]>0){ A[h]--; hit++; } }
  return (n+m)? (2*hit)/(n+m) : 0;
}

// ─────────────────────────────────────────────────────────── master

function loadMaster_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(MASTER_TAB);
  if (!sh) throw new Error('Package master tab "' + MASTER_TAB + '" not found. ' +
    'Duplicate it into this spreadsheet, or change MASTER_TAB at the top of the script.');
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) throw new Error('Package master is empty.');
  var H = {}; vals[0].forEach(function(h,i){ if (h!=='' && H[h]===undefined) H[h]=i; });
  var need=[M.thaiName, M.sku]; 
  var miss=need.filter(function(k){ return H[k]===undefined; });
  if (miss.length) throw new Error('Package master missing column(s): '+miss.join(', '));

  var byKey = {}, bySku = {};
  for (var r=1;r<vals.length;r++){
    var row=vals[r];
    var name = clean_(row[H[M.thaiName]]);
    if (!name) continue;
    var rec = {
      name: name,
      key: pkgKey_(name),
      price: toNum_(H[M.price]!==undefined ? row[H[M.price]] : ''),
      fullPrice: toNum_(H[M.fullPrice]!==undefined ? row[H[M.fullPrice]] : ''),
      sku: clean_(row[H[M.sku]]),
      center: fixCenter_(H[M.center]!==undefined ? row[H[M.center]] : ''),
      eng: clean_(H[M.engName]!==undefined ? row[H[M.engName]] : ''),
      loc: clean_(H[M.location]!==undefined ? row[H[M.location]] : ''),
      eff: H[M.effectiveFrom]!==undefined ? beToIso_(row[H[M.effectiveFrom]]) : ''
    };
    (byKey[rec.key] = byKey[rec.key] || []).push(rec);
    if (rec.sku) bySku[rec.sku] = rec;
  }
  return { byKey: byKey, bySku: bySku, keys: Object.keys(byKey) };
}

/**
 * Decide the SKU for one (package name, price) seen in an order.
 * Returns a status the team can act on, never a silent guess.
 */
function resolvePackage_(name, price, orderMonth, master) {
  var k = pkgKey_(name);
  var cands = master.byKey[k];

  if (cands && cands.length) {
    var priced = cands.filter(function(c){ return c.price === price; });
    var pool = priced.length ? priced : cands;
    var skus = [];
    pool.forEach(function(c){ if (c.sku && skus.indexOf(c.sku)===-1) skus.push(c.sku); });

    if (!skus.length) {
      return { status:'review_nosku', sku:'', suggested:'', alts:'', sim:1,
               center: pool[0].center, notes:'master row has no SKU' };
    }
    if (skus.length === 1) {
      return { status: priced.length ? 'auto' : 'review_price',
               sku: priced.length ? skus[0] : '', suggested: skus[0], alts:'', sim:1,
               center: pool[0].center,
               notes: priced.length ? '' : 'master price ' + pool[0].price + ' ≠ sold price ' + price };
    }

    // Several SKUs for one package: prefer effective_from when the master has it,
    // otherwise the latest period-coded SKU at or before the order month.
    var dated = pool.filter(function(c){ return c.eff && c.eff <= orderMonth + '-31'; });
    if (dated.length) {
      dated.sort(function(a,b){ return a.eff < b.eff ? 1 : -1; });
      return { status:'auto', sku:dated[0].sku, suggested:dated[0].sku,
               alts:skus.join(', '), sim:1, center:dated[0].center,
               notes:'chosen by effective_from ' + dated[0].eff };
    }
    var om = +orderMonth.replace('-','');
    var best = null;
    skus.forEach(function(s){
      var p = skuPeriod_(s);
      if (p && p <= om && (!best || p > best.p)) best = { p:p, s:s };
    });
    var chosen = best ? best.s : '';
    var cen = '';
    pool.forEach(function(c){ if (c.sku === chosen) cen = c.center; });
    return { status:'review_multi', sku:'', suggested:chosen, alts:skus.join(', '), sim:1,
             center: cen || pool[0].center,
             notes: chosen
               ? 'several SKUs; latest on or before ' + orderMonth + ' suggested. Confirm, or ask e-com for effective_from'
               : 'several SKUs and none carry a period. Needs a human decision' };
  }

  // No exact key: look for the closest name in the master.
  var bestKey='', bestSim=0;
  for (var i=0;i<master.keys.length;i++){
    var s = similarity_(k, master.keys[i]);
    if (s > bestSim){ bestSim = s; bestKey = master.keys[i]; }
  }
  if (bestSim >= FUZZY_CUTOFF) {
    var pool2 = master.byKey[bestKey];
    var skus2 = [];
    pool2.forEach(function(c){ if (c.sku && skus2.indexOf(c.sku)===-1) skus2.push(c.sku); });
    return { status:'review_fuzzy', sku:'', suggested: skus2.length===1?skus2[0]:'',
             alts: skus2.join(', '), sim: Math.round(bestSim*100)/100,
             center: pool2[0].center,
             notes: 'closest master name: ' + pool2[0].name };
  }
  return { status:'missing', sku:'', suggested:'', alts:'', sim: Math.round(bestSim*100)/100,
           center:'', notes:'not found in the package master — ask e-commerce to add it' };
}

// ─────────────────────────────────────────────────────────── crosswalk

function readMap_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_MAP);
  var map = {}, order = [];
  if (!sh || sh.getLastRow() < 2) return { map:map, order:order, sheet:sh };
  sh.getRange(2,1,sh.getLastRow()-1,MAP_HEADERS.length).getValues().forEach(function(r,i){
    var name = clean_(r[0]);
    if (!name) return;
    var k = pkgKey_(name) + '|' + toNum_(r[1]);
    map[k] = { row:i+2, name:name, price:toNum_(r[1]), sku:clean_(r[2]), center:clean_(r[3]),
               status:clean_(r[4]), rows:toNum_(r[9]) };
    order.push(k);
  });
  return { map:map, order:order, sheet:sh };
}

// ─────────────────────────────────────────────────────────── main

function normaliseInsert() {
  var ss = SpreadsheetApp.getActive(), ui = SpreadsheetApp.getUi();
  var src = ss.getSheetByName(SHEET_INSERT);
  if (!src){ ui.alert('No "'+SHEET_INSERT+'" tab. Import the monthly export there first.'); return; }
  var out = ss.getSheetByName(SHEET_ORDERS);
  if (!out){ ui.alert('No "'+SHEET_ORDERS+'" tab. Run First-time setup.'); return; }

  /**
   * Hard stop if the Orders sheet was written by a different version. Appending
   * this version's rows onto an older header silently shifts every column, and
   * the duplicate check then reads the wrong column and re-imports the whole
   * file. That is exactly what happened once, so it is checked at import time
   * rather than trusting setup to have been run.
   */
  var head = out.getLastColumn() ? out.getRange(1,1,1,out.getLastColumn()).getValues()[0] : [];
  var headOk = head.length === OUT_HEADERS.length &&
    OUT_HEADERS.every(function (h, i) { return String(head[i]).trim() === h; });
  if (!headOk) {
    ui.alert('The "' + SHEET_ORDERS + '" tab does not match this version',
      'It has ' + head.length + ' column(s); this version writes ' + OUT_HEADERS.length + '.\n\n' +
      'Delete the Orders tab (and Package_Map, and Unmapped_Packages if present), ' +
      'run First-time setup, then import again.\n\nNothing was changed.',
      ui.ButtonSet.OK);
    return;
  }

  var master;
  try { master = loadMaster_(); }
  catch (e){ ui.alert(String(e.message||e)); return; }

  var range = src.getDataRange();
  var values = range.getValues();
  // What the sheet SHOWS, for the purchase time (see timeOf_).
  var shown = range.getDisplayValues();
  var headerRow = -1;
  for (var r=0;r<Math.min(12,values.length);r++){
    if (values[r].map(function(h){ return String(h).trim(); }).indexOf(COL.orderId) !== -1){ headerRow = r; break; }
  }
  if (headerRow === -1){ ui.alert('Could not find the header row (no "'+COL.orderId+'" column).'); return; }

  // Headers are trimmed: a stray space after a header must not lose its column.
  var H={}; values[headerRow].forEach(function(h,i){
    var k = String(h==null?'':h).trim();
    if (k!=='' && H[k]===undefined) H[k]=i;
  });
  /**
   * Columns that are not fatal but degrade the report if the export was run
   * without them ticked. Losing อีเมล silently produces blank customer keys and
   * every repeat-purchase figure quietly becomes zero, which is worse than an
   * error — so the run stops to ask.
   *
   * Campaign and purchase time are NOT here any more (v2.12.0): they are
   * required below. "Continue anyway" on them blanked a whole month for good.
   */
  var OPTIONAL_COLS = [
    [COL.custEmail,    'customer keys — no repeat purchase or channel-switching analysis'],
    [COL.custPhone,    'phone-based customer key (fallback when email is absent)'],
    [COL.couponStatus, 'coupon redemption — the used-vs-bought split disappears'],
    [COL.discount,     'per-receipt discount'],
    [COL.platformPromo,'platform promotion']
  ];
  var absent = OPTIONAL_COLS.filter(function(c){ return H[c[0]]===undefined; });
  if (absent.length){
    var msg = absent.map(function(c){ return '• ' + c[0] + ' → ' + c[1]; }).join('\n');
    var go = ui.alert('The export is missing some columns',
      msg + '\n\nRe-export with every column ticked, or continue and accept those gaps.\n\n' +
      'Continue anyway?', ui.ButtonSet.YES_NO);
    if (go !== ui.Button.YES) return;
  }

  var missing=[COL.orderId,COL.packageName,COL.price,COL.purchaseDate,COL.channel,
               COL.campaign,COL.purchaseTime]
    .filter(function(k){ return H[k]===undefined; });
  if (missing.length){
    ui.alert('The export is missing required columns',
      missing.map(function(k){ return '• ' + k; }).join('\n') +
      '\n\nRe-export the report with every column ticked, then import again.\n\nNothing was changed.',
      ui.ButtonSet.OK);
    return;
  }

  var subRow = values[headerRow+1] || [];
  var totalCol = H[COL.paymentTotal];
  var methodCols = [];
  for (var c=0;c<subRow.length;c++){
    if (subRow[c] && totalCol!==undefined && c>totalCol){
      methodCols.push({ col:c, name:String(subRow[c]).replace(/\s*\(บาท\)\s*$/,'').trim() });
    }
  }
  var cellOf = function(row,k){ var i=H[k]; return i===undefined?'':row[i]; };

  // pass 1 — forward-fill merged order blocks, one record per coupon
  var records=[], carried=null, carriedShown=null, footer=null;
  for (var i=headerRow+2;i<values.length;i++){
    var row=values[i];
    var first=String(row[0]==null?'':row[0]);
    if (first.indexOf('รวมทั้งสิ้น')===0){          // the export's grand-total row
      footer={ coupons:toNum_(cellOf(row,COL.couponQty)), revenue:toNum_(row[totalCol]) };
      continue;
    }
    if (clean_(cellOf(row,COL.orderId))!==''){ carried=row; carriedShown=shown[i]; }
    if (!carried) continue;
    if (clean_(cellOf(row,COL.packageName))==='' && toNum_(cellOf(row,COL.price))===0) continue;
    records.push({ order:carried, shown:carriedShown, line:row });
  }
  if (!records.length){ ui.alert('No coupon rows found in Insert.'); return; }

  var groups={}, ordering=[];
  records.forEach(function(rec){
    var oid=clean_(cellOf(rec.order,COL.orderId));
    if (!groups[oid]){ groups[oid]=[]; ordering.push(oid); }
    groups[oid].push(rec);
  });

  var mapInfo = readMap_();
  var pep = pepper_();
  var batch = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');

  /**
   * EXISTING ROWS, FOR DE-DUPLICATION AND REPAIR (v2.12.0). Three single
   * columns, read whole — cheap next to the 35-column rows. `seen` maps each
   * dedup_key to its sheet row so a duplicate whose campaign or time is blank
   * can be filled in from this file instead of being skipped untouched.
   */
  var seen = {};
  var lastCol = OUT_HEADERS.indexOf('dedup_key')+1;
  var cCamp = OUT_HEADERS.indexOf('campaign_name')+1, cTime = OUT_HEADERS.indexOf('purchase_time')+1;
  var nOld = Math.max(0, out.getLastRow()-1);
  var oldCamp = [], oldTime = [];
  if (nOld){
    out.getRange(2,lastCol,nOld,1).getValues()
      .forEach(function(v,k){ if (v[0]) seen[v[0]]=k; });
    oldCamp = out.getRange(2,cCamp,nOld,1).getValues();
    oldTime = out.getRange(2,cTime,nOld,1).getDisplayValues();
  }
  var repairedCamp = 0, repairedTime = 0;

  var rowsOut=[], newMapRows=[], touched={}, duplicates=0, couponsIn=0, revenueIn=0;
  var blankCamp=0, blankTime=0;

  ordering.forEach(function(oid){
    var items=groups[oid], o=items[0].order, oShown=items[0].shown;
    var gross=0; items.forEach(function(it){ gross += toNum_(cellOf(it.line,COL.price)); });
    var txn=toNum_(cellOf(o,COL.txnFee)), comm=toNum_(cellOf(o,COL.commFee));
    var disc=toNum_(cellOf(o,COL.discount)), promo=toNum_(cellOf(o,COL.platformPromo));
    var method='';
    for (var m=0;m<methodCols.length;m++){
      if (toNum_(o[methodCols[m].col])>0){ method=methodCols[m].name; break; }
    }
    var payStatus=clean_(cellOf(o,COL.payStatus)), ordStatus=clean_(cellOf(o,COL.orderStatus));
    var emailKey=hashKey_(normEmail_(cellOf(o,COL.custEmail)),pep);
    var phoneKey=hashKey_(normPhone_(cellOf(o,COL.custPhone)),pep);
    var isoDate=beToIso_(cellOf(o,COL.purchaseDate));
    var ym = isoDate ? isoDate.substring(0,7) : '';
    var timeStr = timeOf_(cellOf(oShown,COL.purchaseTime), cellOf(o,COL.purchaseTime));
    var campaign = clean_(cellOf(o,COL.campaign));

    items.forEach(function(it,n){
      var chName=clean_(cellOf(o,COL.channel));
      var isOnline=ONLINE_CHANNELS.indexOf(chName)!==-1;
      var price=toNum_(cellOf(it.line,COL.price));
      var share = gross ? price/gross : 1/items.length;
      var pkg=clean_(cellOf(it.line,COL.packageName));
      var couponNo=clean_(cellOf(it.line,COL.couponNo));
      var couponStatus=clean_(cellOf(it.line,COL.couponStatus));
      var mk = pkgKey_(pkg)+'|'+price;

      // --- resolve the package, adding it to Package_Map the first time it appears
      var entry = mapInfo.map[mk];
      if (!entry){
        var res = resolvePackage_(pkg, price, ym, master);
        entry = { name:pkg, price:price, sku:res.sku, center:res.center||'', status:res.status, rows:0 };
        mapInfo.map[mk] = entry;
        newMapRows.push([pkg, price, res.sku, res.center||'', res.status, res.suggested,
                         res.alts, res.sim, ym, 0, res.notes]);
        entry.newIndex = newMapRows.length-1;
      }
      entry.rows = (entry.rows||0) + 1;
      touched[mk] = true;

      var mrec = entry.sku ? master.bySku[entry.sku] : null;
      var center = entry.center || (mrec ? mrec.center : '');
      var fullPrice = mrec ? mrec.fullPrice : 0;
      var discountPct = (fullPrice>0 && price>0) ? round2_(1 - price/fullPrice) : '';

      var dedupKey = couponNo ? 'C:'+couponNo : 'O:'+oid+'|'+pkg+'|'+price+'|'+n;
      couponsIn++; revenueIn += price;
      if (seen[dedupKey] !== undefined){
        duplicates++;
        // Repair, never overwrite: only a BLANK existing value is filled.
        var k = seen[dedupKey];
        if (typeof k === 'number' && k < nOld){
          if (campaign && clean_(oldCamp[k][0]) === ''){ oldCamp[k][0] = campaign; repairedCamp++; }
          if (timeStr && clean_(oldTime[k][0]) === ''){ oldTime[k][0] = timeStr; repairedTime++; }
        }
        return;
      }
      seen[dedupKey]=true;
      if (!campaign) blankCamp++;
      if (!timeStr) blankTime++;

      var txnA=round2_(txn*share), commA=round2_(comm*share);
      var valid = payStatus==='ชำระเงินแล้ว'
        && ordStatus.toUpperCase().indexOf('CANCEL')===-1
        && couponStatus!=='ยกเลิก';

      rowsOut.push([
        batch, oid, clean_(cellOf(o,COL.receiptNo)), clean_(cellOf(o,COL.sellerOrder)),
        isoDate, timeStr, ym,
        clean_(cellOf(o,COL.channel)), clean_(cellOf(o,COL.country)), campaign,
        payStatus, ordStatus, method,
        pkg, entry.sku, center, mrec?mrec.eng:'', mrec?mrec.loc:'',
        price, fullPrice||'', discountPct,
        round2_(disc*share), round2_(promo*share), txnA, commA, round2_(price-txnA-commA),
        couponNo, couponStatus, beToIso_(cellOf(it.line,COL.couponExpiry)),
        valid, isOnline, entry.status||'', emailKey, phoneKey, dedupKey
      ]);
    });
  });

  // ---- cross-check against the report's own footer before writing
  var notes=[];
  if (footer){
    if (footer.coupons && footer.coupons!==couponsIn)
      notes.push('Coupon count: report '+footer.coupons+' vs parsed '+couponsIn);
    if (footer.revenue && Math.abs(footer.revenue-revenueIn)>1)
      notes.push('Revenue: report '+footer.revenue+' vs parsed '+revenueIn);
  } else notes.push('No footer total row — totals not cross-checked');

  if (notes.length && notes[0].indexOf('vs parsed')!==-1){
    if (ui.alert('Totals differ from the report footer', notes.join('\n')+'\n\nImport anyway?',
        ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  }

  if (rowsOut.length)
    out.getRange(out.getLastRow()+1,1,rowsOut.length,OUT_HEADERS.length).setValues(rowsOut);

  // ---- fill blanks on rows that were already in Orders (column-wide, one write each)
  if (repairedCamp) out.getRange(2,cCamp,nOld,1).setValues(oldCamp);
  if (repairedTime) {
    // Written as text so Sheets does not turn "21:17" back into a time value.
    out.getRange(2,cTime,nOld,1).setNumberFormat('@').setValues(oldTime);
  }
  if (repairedCamp || repairedTime)
    notes.push('Filled in on rows already in Orders: ' + repairedCamp + ' campaign, ' + repairedTime + ' time');
  if (blankCamp || blankTime)
    notes.push('New rows still blank: ' + blankCamp + ' campaign, ' + blankTime + ' time (blank in the export itself)');

  // ---- write new crosswalk rows so the team can see and correct them
  var mapSheet = mapInfo.sheet || ensureSheet_(ss, SHEET_MAP, MAP_HEADERS);
  if (newMapRows.length){
    newMapRows.forEach(function(r,i){
      var k = pkgKey_(r[0])+'|'+toNum_(r[1]);
      r[9] = mapInfo.map[k] ? mapInfo.map[k].rows : 0;
    });
    mapSheet.getRange(mapSheet.getLastRow()+1,1,newMapRows.length,MAP_HEADERS.length)
            .setValues(newMapRows);
  }
  highlightMap_(mapSheet);

  var needsReview = 0;
  Object.keys(mapInfo.map).forEach(function(k){
    var e=mapInfo.map[k];
    if (touched[k] && !e.sku) needsReview++;
  });

  logRun_(batch, ordering.length, couponsIn, rowsOut.length, duplicates,
          newMapRows.length, needsReview, notes.join(' · '));

  ss.deleteSheet(src);

  ui.alert(
    'Import complete\n\n' +
    'Orders:               ' + ordering.length + '\n' +
    'Coupon rows:          ' + couponsIn + '\n' +
    'Appended:             ' + rowsOut.length + '\n' +
    'Skipped duplicates:   ' + duplicates + '\n' +
    'Revenue parsed:       ฿' + revenueIn.toLocaleString() + '\n\n' +
    'New packages added to Package_Map: ' + newMapRows.length + '\n' +
    'Still needing a SKU:               ' + needsReview + '\n\n' +
    (needsReview
      ? 'Open Package_Map — highlighted rows need the e-commerce team to confirm ' +
        'or correct the SKU. Then run "Re-apply Package_Map to Orders".'
      : 'Every package resolved.') +
    (notes.length ? '\n\nNotes: '+notes.join(' · ') : '')
  );
}

/** Amber for rows a human still has to settle; nothing else is coloured. */
function highlightMap_(sh){
  if (!sh || sh.getLastRow()<2) return;
  var n=sh.getLastRow()-1;
  var rng=sh.getRange(2,1,n,MAP_HEADERS.length);
  var vals=rng.getValues();
  var colours=vals.map(function(r){
    var needs = !clean_(r[2]);           // no SKU yet
    var c = needs ? '#FFF4E5' : null;
    return MAP_HEADERS.map(function(){ return c; });
  });
  rng.setBackgrounds(colours);
}

/**
 * STEP 3 · APPLY PACKAGE_MAP TO ORDERS (v2.11.0)
 *
 * Re-reads Package_Map and refreshes sku / center / english_name / location /
 * full_price / discount_pct / map_status on existing Orders rows.
 *
 * WHY IT WAS REWRITTEN: the old version read every column of every Orders row
 * (85,000 × 35, about three million cells) and wrote all of them back, even
 * rows that had not changed — past the six-minute limit, so rows after the
 * cut-off kept their old SKU. This one reads only the 9 columns it needs in
 * 10,000-row blocks, writes a block back only if something in it changed, and
 * at 4½ minutes saves its place and carries on by timer a minute later (first
 * run asks for one extra permission: "run when you are not present").
 */
var REAPPLY_PROP      = 'REAPPLY_STATE';
var REAPPLY_CHUNK     = 10000;
var REAPPLY_BUDGET_MS = 4.5 * 60 * 1000;
var REAPPLY_HANDLER   = 'reapplyMappingContinue';

/** Menu item 3. Always starts from the top; a run already in progress is replaced. */
function reapplyMapping() {
  clearReapplyTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(REAPPLY_PROP);
  reapplyRun_({ next: 2, rows: 0, changed: 0, mapped: 0, unmatched: 0 }, true);
}

/** Called by the timer only — never from the menu. Picks up where the last part stopped. */
function reapplyMappingContinue() {
  clearReapplyTriggers_();
  var raw = PropertiesService.getScriptProperties().getProperty(REAPPLY_PROP);
  if (!raw) return;
  reapplyRun_(JSON.parse(raw), false);
}

function reapplyRun_(st, interactive) {
  var t0 = Date.now();
  var ss = SpreadsheetApp.getActive();
  var props = PropertiesService.getScriptProperties();
  var say = function (msg) {
    if (interactive) { try { SpreadsheetApp.getUi().alert(msg); return; } catch (e) {} }
    ss.toast(msg, 'Step 3 · Apply Package_Map', 30);
  };

  var out = ss.getSheetByName(SHEET_ORDERS);
  if (!out || out.getLastRow() < 2) { say('No rows in Orders.'); return; }
  var master;
  try { master = loadMaster_(); } catch (e) { say(String(e.message || e)); return; }
  var mapInfo = readMap_();

  // Columns by NAME, never by position — and the 8 we read in one go must sit
  // side by side, as they do in the current schema (package_name … discount_pct).
  var head = out.getRange(1, 1, 1, out.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var col = function (name) { return head.indexOf(name) + 1; };
  var cPkg = col('package_name'), cSku = col('sku'), cPrice = col('price'),
      cDisc = col('discount_pct'), cStatus = col('map_status');
  if (!cPkg || !cSku || !cPrice || !cDisc || !cStatus ||
      cSku !== cPkg + 1 || cPrice !== cPkg + 5 || cDisc !== cPkg + 7) {
    say('Orders columns are not in the expected order (package_name, sku, center, english_name, ' +
        'location, price, full_price, discount_pct). Run Setup and repair ▸ Upgrade Orders to ' +
        'current schema, then step 3 again. Nothing was changed.');
    return;
  }

  var last = out.getLastRow();
  var same = function (a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); };

  while (st.next <= last) {
    var n = Math.min(REAPPLY_CHUNK, last - st.next + 1);
    // package_name, sku, center, english_name, location, price, full_price, discount_pct
    var blk  = out.getRange(st.next, cPkg, n, 8).getValues();
    var stat = out.getRange(st.next, cStatus, n, 1).getValues();
    var newBlk = [], newStat = [], dirty = false;

    for (var i = 0; i < n; i++) {
      var r = blk[i], price = toNum_(r[5]);
      var old = r.slice(1, 8);                       // sku … discount_pct
      var e = mapInfo.map[pkgKey_(r[0]) + '|' + price];
      if (!e) {                                      // package not in Package_Map: leave the row alone
        if (clean_(r[0])) st.unmatched++;
        newBlk.push(old); newStat.push([stat[i][0]]);
        continue;
      }
      var mrec = e.sku ? master.bySku[e.sku] : null;
      var full = mrec ? mrec.fullPrice : 0;
      var nv = [
        e.sku,
        e.center || (mrec ? mrec.center : ''),
        mrec ? mrec.eng : '',
        mrec ? mrec.loc : '',
        r[5],                                        // price, written back exactly as read
        full || '',
        (full > 0 && price > 0) ? round2_(1 - price / full) : ''
      ];
      var ns = e.status || '';
      var rowChanged = !same(stat[i][0], ns);
      for (var j = 0; j < nv.length && !rowChanged; j++) if (!same(old[j], nv[j])) rowChanged = true;
      if (rowChanged) { st.changed++; dirty = true; }
      if (e.sku) st.mapped++;
      newBlk.push(nv); newStat.push([ns]);
    }

    if (dirty) {
      out.getRange(st.next, cSku, n, 7).setValues(newBlk);
      out.getRange(st.next, cStatus, n, 1).setValues(newStat);
      SpreadsheetApp.flush();
    }
    st.rows += n;
    st.next += n;

    // Out of time but not done: save the place, carry on in a minute.
    if (st.next <= last && Date.now() - t0 > REAPPLY_BUDGET_MS) {
      props.setProperty(REAPPLY_PROP, JSON.stringify(st));
      ScriptApp.newTrigger(REAPPLY_HANDLER).timeBased().after(60 * 1000).create();
      say('Still working — ' + st.rows.toLocaleString() + ' of ' + (last - 1).toLocaleString() +
          ' rows done.\n\nIt carries on by itself in a minute; a note appears in the sheet when ' +
          'it finishes. Do not run step 3 again in the meantime.');
      return;
    }
  }

  props.deleteProperty(REAPPLY_PROP);
  say('Package_Map applied to Orders.\n\n' +
      'Rows checked:                 ' + st.rows.toLocaleString() + '\n' +
      'Rows changed:                 ' + st.changed.toLocaleString() + '\n' +
      'Rows with a SKU:              ' + st.mapped.toLocaleString() + '\n' +
      'Rows not in Package_Map:      ' + st.unmatched.toLocaleString() +
      (st.unmatched ? '  → run step 2 · Find new packages' : '') + '\n\n' +
      (st.changed ? 'Now open the War Room with ?refresh=1 once.' : 'Nothing needed changing.'));
}

function clearReapplyTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === REAPPLY_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

/** Re-suggests SKUs for crosswalk rows still without one (e.g. after the master grew). */
function refreshSuggestions(){
  var ss=SpreadsheetApp.getActive(), sh=ss.getSheetByName(SHEET_MAP);
  if (!sh || sh.getLastRow()<2){ SpreadsheetApp.getUi().alert('Package_Map is empty.'); return; }
  var master; try { master=loadMaster_(); } catch(e){ SpreadsheetApp.getUi().alert(String(e.message||e)); return; }
  var n=sh.getLastRow()-1;
  var vals=sh.getRange(2,1,n,MAP_HEADERS.length).getValues();
  var updated=0;
  vals.forEach(function(r){
    if (clean_(r[2])) return;                 // a human already settled this one
    var res=resolvePackage_(clean_(r[0]), toNum_(r[1]), String(r[8]||'').substring(0,7), master);
    r[3]=res.center||r[3]; r[4]=res.status; r[5]=res.suggested;
    r[6]=res.alts; r[7]=res.sim; r[10]=res.notes;
    if (res.status==='auto' && res.sku){ r[2]=res.sku; updated++; }
  });
  sh.getRange(2,1,n,MAP_HEADERS.length).setValues(vals);
  highlightMap_(sh);
  SpreadsheetApp.getUi().alert('Suggestions refreshed. '+updated+' row(s) resolved automatically.\n' +
    'Run "Re-apply Package_Map to Orders" to push changes into Orders.');
}

/**
 * Recomputes is_online across every row from the current ONLINE_CHANNELS list.
 *
 * Needed whenever the taxonomy changes — Health Plaza moving to Online meant
 * every historical Health Plaza row still said FALSE. The dashboard derives
 * channel type server-side and never reads this column, so this only keeps the
 * sheet itself honest, but a validation report that understates online traffic
 * is worse than no report.
 */
function rederiveIsOnline() {
  var ss = SpreadsheetApp.getActive(), ui = SpreadsheetApp.getUi();
  var sh = ss.getSheetByName(SHEET_ORDERS);
  if (!sh || sh.getLastRow() < 2) { ui.alert('No data in Orders.'); return; }

  var head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
  var chCol = head.indexOf('channel') + 1, onCol = head.indexOf('is_online') + 1;
  if (!chCol) { ui.alert('Orders has no channel column.'); return; }
  if (!onCol) { ui.alert('Orders has no is_online column — run "Upgrade Orders to current schema" first.'); return; }

  if (ui.alert('Re-derive is_online',
      'Recompute is_online for every row using the current list of ' + ONLINE_CHANNELS.length +
      ' online channels:\n\n' + ONLINE_CHANNELS.join(', ') +
      '\n\nNothing else is touched. Continue?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  var n = sh.getLastRow() - 1;
  var chA1 = colLetter_(chCol);
  var list = ONLINE_CHANNELS.map(function(c){ return '"' + c + '"'; }).join(';');
  // One array formula so Sheets evaluates all rows natively, then frozen to
  // values — reading 85k rows into the script would exceed the time limit.
  sh.getRange(2, onCol).setFormula('=ARRAYFORMULA(IF(' + chA1 + '2:' + chA1 + String(n+1) + '="","",' +
    'ISNUMBER(MATCH(' + chA1 + '2:' + chA1 + String(n+1) + ',{' + list + '},0))))');
  SpreadsheetApp.flush();
  var rng = sh.getRange(2, onCol, n, 1);
  var vals = rng.getValues();
  rng.setValues(vals);

  var online = vals.reduce(function(a,r){ return a + (r[0] === true ? 1 : 0); }, 0);
  ui.alert('Done.\n\n' + online + ' online / ' + (n - online) + ' other, across ' + n + ' rows.');
}

/**
 * Brings an Orders sheet written by an earlier version up to the current
 * schema, without re-importing anything.
 *
 * Columns are inserted at their correct position and back-filled where the
 * value can be derived from data already present — is_online comes from the
 * channel name, so no history is lost. Anything not derivable is left blank
 * rather than guessed. Needed because the import guard refuses to append to a
 * sheet whose header does not match, which would otherwise block next month's
 * load on two years of already-good data.
 */
function upgradeOrdersSchema() {
  var ss = SpreadsheetApp.getActive(), ui = SpreadsheetApp.getUi();
  var sh = ss.getSheetByName(SHEET_ORDERS);
  if (!sh) { ui.alert('No Orders tab.'); return; }

  var head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
  var extra = head.filter(function(h){ return h && OUT_HEADERS.indexOf(h) === -1; });
  if (extra.length) {
    ui.alert('Orders contains column(s) this version does not know: ' + extra.join(', ') +
             '.\n\nRemove or rename them first — upgrading could put data in the wrong place.');
    return;
  }
  var missing = OUT_HEADERS.filter(function(h){ return head.indexOf(h) === -1; });
  if (!missing.length) { ui.alert('Orders already matches the current schema (' + OUT_HEADERS.length + ' columns).'); return; }

  if (ui.alert('Upgrade Orders',
      'Add ' + missing.length + ' missing column(s): ' + missing.join(', ') +
      '\n\nExisting data is untouched; is_online is derived from the channel name.\nContinue?',
      ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  // Walk the target schema and insert wherever the sheet diverges. Only
  // additions are expected, so a single left-to-right pass is enough.
  for (var i = 0; i < OUT_HEADERS.length; i++) {
    var cur = sh.getRange(1, i+1).getValue();
    if (String(cur).trim() === OUT_HEADERS[i]) continue;
    sh.insertColumnBefore(i+1);
    sh.getRange(1, i+1).setValue(OUT_HEADERS[i]).setFontWeight('bold');
  }

  var n = sh.getLastRow() - 1;
  if (n > 0 && missing.indexOf('is_online') !== -1) {
    var newHead = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
    var chCol = newHead.indexOf('channel') + 1, onCol = newHead.indexOf('is_online') + 1;
    if (chCol && onCol) {
      var list = ONLINE_CHANNELS.map(function(c){ return '"' + c + '"'; }).join(';');
      var chA1 = colLetter_(chCol);
      // One array formula lets Sheets evaluate 85k rows natively, then the
      // result is frozen to values so the sheet stays static.
      sh.getRange(2, onCol).setFormula('=ARRAYFORMULA(IF(' + chA1 + '2:' + chA1 + String(n+1) + '="","",' +
        'ISNUMBER(MATCH(' + chA1 + '2:' + chA1 + String(n+1) + ',{' + list + '},0))))');
      SpreadsheetApp.flush();
      var rng = sh.getRange(2, onCol, n, 1);
      rng.setValues(rng.getValues());
    }
  }

  var finalHead = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
  var okNow = finalHead.length === OUT_HEADERS.length &&
    OUT_HEADERS.every(function(h,i){ return finalHead[i] === h; });
  ui.alert(okNow
    ? 'Upgrade complete.\n\nOrders now has ' + OUT_HEADERS.length + ' columns and will accept new imports.'
    : 'Upgrade ran but the header still does not match. Current: ' + finalHead.length +
      ' columns.\nSend this to whoever maintains the script.');
}

/**
 * Ranks the unmapped packages by how much revenue they actually carry in a
 * recent window, so the e-commerce team works the list top-down instead of
 * alphabetically.
 *
 * Two years of history contains packages that were sold twice in 2024 and never
 * again; mapping those is wasted effort. Sales are measured with SUMIFS against
 * Orders so Sheets does the work natively — reading 85k rows into the script
 * exceeds the execution limit.
 */
function prioritisePackageMap() {
  var ss = SpreadsheetApp.getActive(), ui = SpreadsheetApp.getUi();
  var map = ss.getSheetByName(SHEET_MAP), ord = ss.getSheetByName(SHEET_ORDERS);
  if (!map || map.getLastRow() < 2) { ui.alert('Package_Map is empty — run an import first.'); return; }
  if (!ord || ord.getLastRow() < 2) { ui.alert('No data in Orders.'); return; }

  var res = ui.prompt('Prioritise Package_Map',
    'Count sales from which date onward?  (YYYY-MM-DD)\n\n' +
    'Packages sold before 2026 generally have no SKU in the master at all, so 2025-01-01 ' +
    'or 2026-01-01 keeps the list to work that is actually possible.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var cutoff = String(res.getResponseText() || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) { ui.alert('Date must look like 2025-01-01.'); return; }

  var oh = ord.getRange(1,1,1,ord.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
  var need = ['package_name','price','purchase_date'];
  var miss = need.filter(function(c){ return oh.indexOf(c) === -1; });
  if (miss.length) { ui.alert('Orders is missing ' + miss.join(', ')); return; }

  var qn = "'" + SHEET_ORDERS + "'!";
  var NAME = qn + colLetter_(oh.indexOf('package_name')+1) + '2:' + colLetter_(oh.indexOf('package_name')+1);
  var PRICE = qn + colLetter_(oh.indexOf('price')+1) + '2:' + colLetter_(oh.indexOf('price')+1);
  var DATE = qn + colLetter_(oh.indexOf('purchase_date')+1) + '2:' + colLetter_(oh.indexOf('purchase_date')+1);

  var n = map.getLastRow() - 1;
  var mh = map.getRange(1,1,1,Math.max(map.getLastColumn(), MAP_HEADERS.length)).getValues()[0]
    .map(function(h){return String(h).trim();});
  var nameCol = colLetter_(1), priceCol = colLetter_(2);   // Package_Map A and B
  var firstNew = MAP_HEADERS.length + 1;

  map.getRange(1, firstNew, 1, 3)
     .setValues([['coupons_since_' + cutoff, 'revenue_since_' + cutoff, 'priority']])
     .setFontWeight('bold');

  var rowsF = [], revF = [];
  for (var r = 2; r <= n + 1; r++) {
    rowsF.push(['=IF($C' + r + '<>"","", COUNTIFS(' + NAME + ',$A' + r + ',' + PRICE + ',$B' + r +
                ',' + DATE + ',">=' + cutoff + '"))']);
    revF.push(['=IF($C' + r + '<>"","", SUMIFS(' + PRICE + ',' + NAME + ',$A' + r + ',' + PRICE + ',$B' + r +
               ',' + DATE + ',">=' + cutoff + '"))']);
  }
  map.getRange(2, firstNew, n, 1).setFormulas(rowsF);
  map.getRange(2, firstNew+1, n, 1).setFormulas(revF);
  SpreadsheetApp.flush();

  // Freeze to values, then rank by revenue so the team can stop at a sensible point.
  var counts = map.getRange(2, firstNew, n, 2).getValues();
  map.getRange(2, firstNew, n, 2).setValues(counts);

  var scored = [];
  for (var i = 0; i < n; i++) {
    var rev = Number(counts[i][1]) || 0;
    if (rev > 0) scored.push({ i: i, rev: rev });
  }
  scored.sort(function(a,b){ return b.rev - a.rev; });
  var totalRev = scored.reduce(function(a,x){ return a + x.rev; }, 0);
  var rank = new Array(n).fill(['']);
  var cum = 0, within80 = 0;
  scored.forEach(function(x, idx){
    cum += x.rev;
    var pct = totalRev ? cum / totalRev : 0;
    if (pct <= 0.8001) within80++;
    rank[x.i] = ['#' + (idx+1) + (pct <= 0.8001 ? ' · top 80%' : '')];
  });
  map.getRange(2, firstNew+2, n, 1).setValues(rank);

  // Amber the ones that carry the revenue, so the eye lands on them first.
  var bg = rank.map(function(r){ return [/top 80%/.test(r[0]) ? '#FFF4E5' : null]; });
  map.getRange(2, firstNew+2, n, 1).setBackgrounds(bg);
  map.activate();

  ui.alert('Package_Map prioritised\n\n' +
    scored.length + ' unmapped package(s) sold since ' + cutoff + '\n' +
    'Total revenue riding on them: ฿' + Math.round(totalRev).toLocaleString() + '\n\n' +
    'Mapping the top ' + within80 + ' covers 80% of that revenue.\n' +
    'Rows marked "top 80%" are the ones worth doing first; the rest can wait.');
}

/**
 * THE SAFETY NET — finds packages present in Orders but absent from Package_Map.
 *
 * Package_Map is otherwise only ever written during import, at the moment a
 * package is first seen. Nothing re-checks afterwards, so a map row that is
 * deleted, sorted away, or lost to a half-finished import orphans that package
 * forever: Orders keeps the sales and no menu item notices. 27 packages
 * carrying 3,603 order rows were in exactly that state, one of them with 3,175
 * orders on its own.
 *
 * Rows already in the map are never touched, including any SKU a human has
 * confirmed. New rows arrive with a suggestion and a status from the same
 * resolver import uses.
 *
 * AGGREGATION IS DONE BY SHEETS, NOT BY THIS SCRIPT — the same rule
 * validateOrders() follows and for the same reason. A first version read 85,000
 * rows across 13 columns in chunks, about 1.1 million cells, and exceeded the
 * six-minute limit. A QUERY groups the same data natively and hands back only
 * the ~980 distinct packages, so the script reads almost nothing.
 */
function rebuildPackageMap() {
  var ss = SpreadsheetApp.getActive(), ui = SpreadsheetApp.getUi();
  var ord = ss.getSheetByName(SHEET_ORDERS);
  if (!ord || ord.getLastRow() < 2) { ui.alert('No data in Orders.'); return; }

  var master;
  try { master = loadMaster_(); }
  catch (e) { ui.alert(String(e.message || e)); return; }

  var oh = ord.getRange(1, 1, 1, ord.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var need = ['package_name', 'price', 'year_month'];
  var miss = need.filter(function (c) { return oh.indexOf(c) === -1; });
  if (miss.length) { ui.alert('Orders is missing ' + miss.join(', ')); return; }

    /**
   * RANGES ARE BOUNDED TO THE LAST DATA ROW, NOT LEFT OPEN.
   *
   * `N2:N` returns one row per row of the Orders GRID, which is far taller than
   * the data — and a new scratch sheet is only 1,000 rows, so the array had
   * nowhere to expand and every one of the three columns came back #REF!. The
   * script then read an empty sheet and reported "0 order rows", which looked
   * like a broken QUERY and was actually a full one that could not be written
   * down. Bounding the range makes the array exactly as tall as the data.
   */
  var lastOrdRow = ord.getLastRow();
  var q = "'" + SHEET_ORDERS + "'!";
  var colName  = colLetter_(oh.indexOf('package_name') + 1);
  var colPrice = colLetter_(oh.indexOf('price') + 1);
  var colYm    = colLetter_(oh.indexOf('year_month') + 1);
  var NAME  = q + colName  + '2:' + colName  + lastOrdRow;
  var PRICE = q + colPrice + '2:' + colPrice + lastOrdRow;
  var YM    = q + colYm    + '2:' + colYm    + lastOrdRow;

  var tmp = ss.getSheetByName('_rebuild_tmp');
  if (tmp) ss.deleteSheet(tmp);
  tmp = ss.insertSheet('_rebuild_tmp');
  /**
   * And grow the scratch sheet anyway. Bounded ranges make this unnecessary
   * today, but the failure it prevents is silent-looking and expensive to
   * diagnose, and insertRowsAfter on an empty sheet costs nothing.
   */
  var needRows = lastOrdRow + 10;
  if (tmp.getMaxRows() < needRows) {
    tmp.insertRowsAfter(tmp.getMaxRows(), needRows - tmp.getMaxRows());
  }

  /**
   * THE THREE COLUMNS ARE MATERIALISED FIRST, THEN QUERIED.
   *
   * A previous version passed them to QUERY as one inline array,
   * QUERY({NAME, PRICE, ARRAYFORMULA(...)}, ...). That returned a single row
   * instead of ~980, and the run reported "Package_Map is complete" — a wrong
   * answer wearing the face of a right one. Building the columns into the
   * scratch sheet first and querying a plain rectangular range avoids whatever
   * the array form was doing, and leaves the intermediate visible if this ever
   * needs debugging again.
   *
   * year_month is sometimes a real date and sometimes text: "2024-01" typed
   * into a cell is parsed by Sheets as a date and comes back as a serial. Same
   * trap that produced 1,093 phantom month gaps in validateOrders().
   */
  tmp.getRange('A1').setFormula('=ARRAYFORMULA(' + NAME + ')');
  tmp.getRange('B1').setFormula('=ARRAYFORMULA(' + PRICE + ')');
  tmp.getRange('C1').setFormula(
    '=ARRAYFORMULA(IF(ISNUMBER(' + YM + '),TEXT(' + YM + ',"yyyy-mm"),LEFT(' + YM + '&"",7)))');
  SpreadsheetApp.flush();

  var lastA = tmp.getLastRow();
  tmp.getRange('E1').setFormula(
    '=QUERY(A1:C' + lastA + ',' +
    '"select Col1, Col2, count(Col1), min(Col3) ' +
    "where Col1 is not null and Col1 <> '' and Col2 > 0 " +
    "group by Col1, Col2 label count(Col1) '', min(Col3) ''\",0)");
  SpreadsheetApp.flush();

  var pairs = tmp.getRange('E1:H5000').getValues()
    .filter(function (r) { return r[0] !== '' && r[0] !== null; });

  /**
   * A NEAR-EMPTY RESULT IS A BROKEN QUERY, NOT A COMPLETE MAP.
   *
   * Orders holds roughly a thousand distinct packages, so anything under 50
   * means the formula failed — and the previous version reported exactly that
   * as "all already present". The scratch sheet is left in place on failure so
   * the error is readable, instead of being deleted along with the evidence.
   */
  if (pairs.length < 50) {
    var cell = String(tmp.getRange('E1').getValue() || '(blank)');
        ui.alert('The package scan did not work',
      'It returned ' + pairs.length + ' row(s) from ' + (lastA - 1) + ' order rows, ' +
      'which cannot be right.' +
      '\n\nA1 says: ' + String(tmp.getRange('A1').getValue() || '(blank)').substring(0, 60) +
      '\nE1 says: ' + String(tmp.getRange('E1').getValue() || '(blank)').substring(0, 120) +
      '\n\nOrders: ' + lastOrdRow + ' rows used, grid ' + ord.getMaxRows() +
      '\nScratch sheet grid: ' + tmp.getMaxRows() + ' rows' +
      '\n\nIf A1 shows #REF! the three source columns never loaded, so the QUERY ' +
      'had nothing to group — look there first, not at the QUERY.' +
      '\n\nThat tab has been left open. Nothing was changed.',
      ui.ButtonSet.OK);
    tmp.activate();
    return;
  }
  ss.deleteSheet(tmp);

  var mapInfo = readMap_();
  var found = [];
  pairs.forEach(function (r) {
    var pkg = clean_(r[0]);
    var price = toNum_(r[1]);
    /**
     * A zero price is never a real package, and it is also the signature of
     * reading the wrong column — an earlier version was off by one and appended
     * 14 PAYMENT METHODS (Invoice, Thai QR Code, Shopee-Bank Transfer) as
     * packages, every one at ฿0. Filtered in the QUERY and again here.
     */
    if (!pkg || !price) return;
    if (mapInfo.map[pkgKey_(pkg) + '|' + price]) return;
    found.push({ name: pkg, price: price, rows: toNum_(r[2]), ym: String(r[3] || '').substring(0, 7) });
  });

  if (!found.length) {
    ui.alert('Package_Map is complete.\n\n' + pairs.length +
      ' distinct package/price pairs in Orders, all already present.');
    return;
  }

  found.sort(function (a, b) { return b.rows - a.rows; });
  var totalRows = found.reduce(function (a, f) { return a + f.rows; }, 0);
  var preview = found.slice(0, 5).map(function (f) {
    return '• ' + f.rows + ' orders — ' + f.name.substring(0, 45);
  }).join('\n');

  if (ui.alert('Packages missing from Package_Map',
      found.length + ' package(s), ' + totalRows + ' order row(s):\n\n' + preview +
      (found.length > 5 ? '\n…and ' + (found.length - 5) + ' more' : '') +
      '\n\nAppend them with a suggested SKU? Existing rows are not touched.',
      ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  var out = found.map(function (f) {
    var res = resolvePackage_(f.name, f.price, f.ym, master);
    return [f.name, f.price, res.sku, res.center || '', res.status, res.suggested,
            res.alts, res.sim, f.ym, f.rows,
            (res.notes ? res.notes + ' · ' : '') + 'recovered by rebuildPackageMap'];
  });

  var mapSheet = mapInfo.sheet || ensureSheet_(ss, SHEET_MAP, MAP_HEADERS);
  mapSheet.getRange(mapSheet.getLastRow() + 1, 1, out.length, MAP_HEADERS.length).setValues(out);
  /**
   * highlightMap_ repaints the whole map. Wrapped, because if it is what runs
   * out of time the appended rows are already saved, and the run should say so
   * rather than look like a failure that has to be repeated.
   */
  try { highlightMap_(mapSheet); } catch (e) { /* cosmetic only */ }
  mapSheet.activate();

  var resolved = out.filter(function (r) { return r[2]; }).length;
  ui.alert('Added ' + out.length + ' package(s) to Package_Map.\n\n' +
    resolved + ' resolved to a SKU automatically · ' + (out.length - resolved) +
    ' need the e-commerce team.\n\n' +
    'Then run "Re-apply Package_Map to Orders" to push centre and SKU into Orders.');
}

function colLetter_(i){            // 1 -> A, 27 -> AA
  var sLtr = '';
  while (i > 0) { var m = (i - 1) % 26; sLtr = String.fromCharCode(65 + m) + sLtr; i = (i - m - 1) / 26; }
  return sLtr;
}

/**
 * Completeness and integrity check over the whole Orders tab.
 *
 * Aggregation is done with Sheets formulas rather than in JavaScript. Pulling
 * 85k rows into the script — even a single column at a time — exceeds the
 * six-minute limit, because every read has to materialise a sheet of about
 * three million cells. COUNTIF, UNIQUE and QUERY evaluate natively and return
 * only a handful of values, so the script reads almost nothing.
 */
function validateOrders() {
  var ss = SpreadsheetApp.getActive(), ui = SpreadsheetApp.getUi();
  var out = ss.getSheetByName(SHEET_ORDERS);
  if (!out || out.getLastRow() < 2) { ui.alert('No data in Orders.'); return; }

  var head = out.getRange(1,1,1,out.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
  var n = out.getLastRow() - 1;
  var at = {}; head.forEach(function(h,i){ at[h] = i + 1; });

  // Only these make the checks impossible. Anything else simply gets skipped,
  // because a sheet written by an older version is still perfectly valid data.
  var required = ['purchase_date','year_month','channel','price','order_id','dedup_key'];
  var optional = ['sku','email_key','is_online','campaign_name','purchase_time'];
  var missingReq = required.filter(function(c){ return !at[c]; });
  var missingOpt = optional.filter(function(c){ return !at[c]; });
  if (missingReq.length) {
    writeValidation_([['Header','FAIL','missing required column(s): ' + missingReq.join(', ')]]);
    ui.alert('Orders is missing ' + missingReq.join(', ') + ' — cannot validate.');
    return;
  }

  var q = "'" + SHEET_ORDERS + "'!";
  var R = {};
  required.concat(optional).forEach(function(c){
    if (at[c]) R[c] = q + colLetter_(at[c]) + '2:' + colLetter_(at[c]);
  });

  // Scratch sheet: formulas are evaluated by Sheets, then read back as values.
  var tmp = ss.getSheetByName('_validate_tmp');
  if (tmp) ss.deleteSheet(tmp);
  tmp = ss.insertSheet('_validate_tmp');
  /**
   * "2024-01" written into a cell is parsed by Sheets as a date, so year_month
   * comes back as a serial (45292) rather than text — which made every month
   * look like year 4529 and produced 1,093 phantom gaps. This wraps the column
   * so it yields "yyyy-mm" whether the cell holds a date or text.
   */
  var YM = 'ARRAYFORMULA(IF(ISNUMBER(' + R.year_month + '),TEXT(' + R.year_month + ',"yyyy-mm"),' +
           'LEFT(' + R.year_month + '&"",7)))';

  /**
   * Blank campaign / time are counted against rows that HAVE an order id, so
   * the empty grid below the data does not count (v2.12.0).
   */
  var blankOf = function (rng) {
    return rng ? '=COUNTIFS(' + R.order_id + ',"<>",' + rng + ',"")' : '';
  };
  var f = [
    ['=COUNTA(' + R.order_id + ')'],
    ['=COUNTA(' + R.dedup_key + ')-COUNTA(UNIQUE(FILTER(' + R.dedup_key + ',' + R.dedup_key + '<>"")))'],
    ['=COUNTIF(' + R.dedup_key + ',"")'],
    ['=COUNTIF(' + R.channel + ',"")'],
    ['=COUNTIF(' + R.price + ',0)'],
    ['=COUNTIF(' + R.price + ',"<0")'],
    ['=SUM(' + R.price + ')'],
    [R.sku ? '=COUNTIF(' + R.sku + ',"")' : ''],
    [R.email_key ? '=COUNTIF(' + R.email_key + ',"")' : ''],
    [R.is_online ? '=COUNTIF(' + R.is_online + ',TRUE)' : ''],
    ['=IFERROR(INDEX(SORT(UNIQUE(FILTER(' + YM + ',' + YM + '<>""))),1),"")'],
    ['=IFERROR(INDEX(SORT(UNIQUE(FILTER(' + YM + ',' + YM + '<>"")),1,FALSE),1),"")'],
    ['=SUMPRODUCT(--(' + YM + '=""))'],
    ['=COUNTA(UNIQUE(FILTER(' + R.channel + ',' + R.channel + '<>"")))'],
    [blankOf(R.campaign_name)],
    [blankOf(R.purchase_time)],
  ];
  tmp.getRange(1,1,f.length,1).setFormulas(f);
  // Month and channel breakdowns as spilled ranges, off to the side.
  tmp.getRange('C1').setFormula('=QUERY(' + YM + ',"select Col1, count(Col1) where Col1 is not null and Col1 <> \'\' group by Col1 order by Col1 label count(Col1) \'\'",0)');
  tmp.getRange('F1').setFormula('=QUERY(' + R.channel + ',"select Col1, count(Col1) where Col1 is not null group by Col1 order by count(Col1) desc label count(Col1) \'\'",0)');
  SpreadsheetApp.flush();

  var v = tmp.getRange(1,1,f.length,1).getValues().map(function(r){ return r[0]; });
  var monthRows = tmp.getRange('C1:D200').getValues().filter(function(r){ return r[0] !== '' && r[0] !== null; });
  var chanRows  = tmp.getRange('F1:G300').getValues().filter(function(r){ return r[0] !== '' && r[0] !== null; });
  ss.deleteSheet(tmp);

  var rowsCounted = Number(v[0])||0, dups = Number(v[1])||0, blankKey = Number(v[2])||0;
  var noChannel = Number(v[3])||0, zero = Number(v[4])||0, neg = Number(v[5])||0;
  var total = Number(v[6])||0, noSku = Number(v[7])||0, noEmail = Number(v[8])||0;
  var online = Number(v[9])||0, minM = String(v[10]||''), maxM = String(v[11]||'');
  var badMonth = Number(v[12])||0, distinctChannels = Number(v[13])||0;
  var noCamp = Number(v[14])||0, noTime = Number(v[15])||0;

  var rows = [], issues = 0;
  function add(check, verdict, detail){
    rows.push([check, verdict, detail]);
    if (verdict === 'FAIL' || verdict === 'CHECK') issues++;
  }

  add('Header', missingOpt.length ? 'CHECK' : 'OK',
      head.length + ' columns · ' + n + ' data rows' +
      (missingOpt.length ? ' · written by an older version, missing: ' + missingOpt.join(', ') +
        ' — run "Upgrade Orders to current schema"' : ''));

  var log = ss.getSheetByName(SHEET_LOG), expected = null, legacyNote = '';
  if (log && log.getLastRow() > 1) {
    var lh = log.getRange(1,1,1,log.getLastColumn()).getValues()[0].map(String);
    // A v1 log labels only 8 columns while this version writes 9 values, so
    // every value sits one column left of its label. Width is NOT a reliable
    // test — getLastColumn() already reports 9 because a 9th value was written
    // into an unlabelled column — so detect by a label only v1 ever had.
    var isLegacyLog = lh.indexOf('source_rows') !== -1 || lh.indexOf('coupons_in') !== -1;
    var ai = lh.indexOf('appended');
    if (isLegacyLog && ai > 0) ai = ai - 1;
    if (ai >= 0) {
      expected = log.getRange(2, ai+1, log.getLastRow()-1, 1).getValues()
        .reduce(function(a,r){ return a + (Number(r[0])||0); }, 0);
      if (isLegacyLog) legacyNote = ' · Load_Log is the old 8-column layout, so its values were read one column left of their labels';
    }
  }
  add('Row count', expected === null ? 'CHECK' : (expected === n ? 'OK' : 'FAIL'),
      n + ' rows' + (expected === null ? ' · could not read Load_Log'
                                        : ' vs ' + expected + ' appended per Load_Log') + legacyNote);

  add('Duplicate rows', dups ? 'FAIL' : 'OK',
      dups + ' repeated dedup_key' + (blankKey ? ' · ' + blankKey + ' blank' : ''));
  add('Dates', badMonth ? 'FAIL' : 'OK',
      badMonth + ' rows with no usable month · range ' + minM + ' → ' + maxM);

  var present = {};
  monthRows.forEach(function(r){ present[String(r[0])] = Number(r[1])||0; });
  var gaps = [];
  if (minM && maxM) {
    var y = +minM.substring(0,4), mo = +minM.substring(5,7);
    var ey = +maxM.substring(0,4), em = +maxM.substring(5,7);
    while (y < ey || (y === ey && mo <= em)) {
      var key = y + '-' + ('0'+mo).slice(-2);
      if (!present[key]) gaps.push(key);
      mo++; if (mo > 12) { mo = 1; y++; }
    }
  }
  add('Month gaps', gaps.length ? 'CHECK' : 'OK',
      gaps.length ? gaps.length + ' month(s) with no rows: ' + gaps.join(', ')
                  : monthRows.length + ' consecutive months, no gaps');

  add('Price', (zero||neg) ? 'CHECK' : 'OK',
      zero + ' zero · ' + neg + ' negative · total ฿' + Math.round(total).toLocaleString());
  add('Channel', noChannel ? 'FAIL' : 'OK', noChannel + ' blank');
  var unknown = chanRows.map(function(r){ return String(r[0]); })
    .filter(function(c){ return c && !KNOWN_CHANNELS[c]; });
  add('Distinct channels', 'OK', distinctChannels + ' in the data');
  add('Channel taxonomy', unknown.length ? 'CHECK' : 'OK',
      unknown.length
        ? unknown.length + ' name(s) not in the taxonomy — the dashboard groups these as ' +
          '"Unclassified": ' + unknown.join(', ')
        : 'every channel is classified');
  if (R.sku) add('SKU mapped', noSku ? 'CHECK' : 'OK',
      pctTxt_(n-noSku, n) + ' mapped · ' + noSku + ' rows await Package_Map');
  if (R.email_key) add('Customer key', noEmail ? 'CHECK' : 'OK',
      pctTxt_(n-noEmail, n) + ' of rows can join to a customer · ' + noEmail + ' cannot');
  if (R.campaign_name || R.purchase_time) add('Campaign and time', (noCamp || noTime) ? 'CHECK' : 'OK',
      noCamp + ' rows with no campaign · ' + noTime + ' with no purchase time' +
      ((noCamp || noTime) ? ' — re-import those months; v2.12.0 fills blanks on rows already in Orders' : ''));
  if (R.is_online) add('Online split', 'OK', online + ' online / ' + (n-online) + ' other');

  writeValidation_(rows
    .concat([[' ',' ',' '], ['Rows per month','','']])
    .concat(monthRows.map(function(r){ return [String(r[0]), Number(r[1])||0, '']; }))
    .concat([[' ',' ',' '], ['Rows per channel','','']])
    .concat(chanRows.map(function(r){ return [String(r[0]), Number(r[1])||0, '']; })));

  ui.alert('Validation complete\n\n' + n + ' rows checked.\n' +
    (issues ? issues + ' item(s) need attention — see the Validation tab.' : 'Everything passed.'));
}


function pctTxt_(a,b){ return b ? (Math.round(a/b*1000)/10) + '%' : '—'; }

function writeValidation_(rows){
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Validation');
  if (!sh) sh = ss.insertSheet('Validation');
  sh.clear();
  sh.getRange(1,1,1,3).setValues([['check','verdict','detail']]).setFontWeight('bold');
  if (rows.length) sh.getRange(2,1,rows.length,3).setValues(rows);
  sh.setFrozenRows(1);
  sh.setColumnWidth(1,170); sh.setColumnWidth(2,90); sh.setColumnWidth(3,700);
  var vs = sh.getRange(2,2,Math.max(rows.length,1),1);
  vs.setBackgrounds(rows.map(function(r){
    return [r[1]==='FAIL' ? '#FFE3E0' : (r[1]==='CHECK' ? '#FFF4E5' : (r[1]==='OK' ? '#E8F6EF' : null))];
  }));
  sh.activate();
}

function logRun_(batch, orders, coupons, appended, dups, newMap, review, notes){
  var sh=SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
  if (sh) sh.appendRow([new Date(), batch, orders, coupons, appended, dups, newMap, review, notes||'']);
}
