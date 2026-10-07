/**
 * CALL OUT (v3.360.0) — the parts that decide whether an executive reads a
 * wrong number.
 *
 *   1. verifyText: real figures pass at the precision written; wrong ones fail.
 *      The negative cases are the September hand-written mistakes.
 *   2. mapPdfPages: sections are found by the PDF's own cover pages.
 *   3. buildDocx: a valid zip whose document carries the Thai text and images.
 *   4. The client: tab is granted with `report`, renders, marks numbers,
 *      survives an edit, and exports.
 *
 * Run: node test/callout.js   (smoke.sh runs it)
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const L = require("../public/callout-lib.js");

let failures = 0;
const ok = (name, detail) => console.log(`  ok   ${name.padEnd(34)} ${detail || ""}`);
const fail = (name, detail) => { failures++; console.log(`  FAIL ${name.padEnd(34)} ${detail}`); };
const expect = (name, cond, detail) => (cond ? ok(name, detail) : fail(name, detail));

// ---------------------------------------------------------------- 1. numbers
/** September's real figures, as the server would send them. */
const FACTS = [
  { id: "overview.visibility", value: 68712004, unit: "count" },
  { id: "overview.contact", value: 92231, unit: "count" },
  { id: "ecom.revenue", value: 111712345, unit: "THB" },
  { id: "ecom.revenue.yoy", value: 40.47, unit: "%" },
  { id: "ecom.aov", value: 26512, unit: "THB" },
  { id: "ecom.centreBeauty", value: 2900000, unit: "THB" },
  { id: "ecom.centreBeauty.prevYoy", value: 3000000, unit: "THB" },
  { id: "ecom.centreGI", value: 2800000, unit: "THB" },
  { id: "ecom.centreGI.prevYoy", value: 1100000, unit: "THB" },
  { id: "ecom.centreVaccine.prevYoy", value: 995000, unit: "THB" },
  { id: "betterAi.conversations", value: 1634, unit: "count" },
  { id: "betterAi.closeRate", value: 29.8, unit: "%" },
  { id: "gbp.impressions.delta", value: -5412, unit: "count" },
];
const marks = (t) => L.verifyText(t, FACTS).filter((x) => !x.neutral);
const allOk = (t) => marks(t).every((x) => x.ok);
const anyBad = (t) => marks(t).some((x) => !x.ok);

expect("numbers: millions in Thai", allOk("การมองเห็นทั้งหมด 68.7 ล้านครั้ง"), "68.7 ล้าน ← 68,712,004");
expect("numbers: K suffix", allOk("ติดต่อเรา 92.2K ครั้ง"), "92.2K ← 92,231");
expect("numbers: percent at its decimals", allOk("เพิ่มขึ้น 40.47% YoY"), "40.47%");
expect("numbers: percent rounded", allOk("conversion rate 30%"), "30% ← 29.8");
expect("numbers: rounded thousands", allOk("AOV 26,500 บาท"), "26,500 ← 26,512");
expect("numbers: hedged", allOk("มากกว่า 1,600 ครั้ง"), "กว่า 1,600 ← 1,634");
expect("numbers: a fall written as a size", allOk("ลดลงประมาณ 5.4K ครั้ง"), "5.4K ← −5,412");
expect("numbers: years and small counts", allOk("ปี 2026 / 2569 Top 5 ใน 9 เดือน"), "neutral");
// NEGATIVE: the three mistakes in the hand-written September callout.
expect("numbers: Vaccine 581,000 (wrong)", anyBad("Vaccine จาก 581,000 บาท"), "flagged");
expect("numbers: invented growth 1,117", anyBad("เพิ่มขึ้น 1,117 คน"), "flagged");
expect("numbers: wrong percent", anyBad("เพิ่มขึ้น 45.2% YoY"), "flagged");
expect("numbers: % never matches a count", anyBad("เพิ่มขึ้น 26,512%"), "flagged");
expect("numbers: a count never matches a %", anyBad("นัดหมาย 30 ครั้ง"), "flagged");
expect("numbers: precision is honoured", anyBad("68.9 ล้านครั้ง"), "68.9 ≠ 68.7");
expect("numbers: codes are not figures", marks("BIH2 and A1C").length === 0, "skipped");

// ---------------------------------------------------------------- 2. PDF map
const cover = (t) => ({ text: `${t} Digital Marketing September 2026` });
const pages = [
  cover("Digital Marketing Performance"), { text: "OVERVIEW BHQ TOFU: Impressions 68.7M" },
  cover("E-Commerce"), { text: "TOTAL SALES (YTD)" }, { text: "DEMOGRAPHIC" },
  cover("Better Club Revenue Attribution"), { text: "REVENUE ATTRIBUTION" }, { text: "BETTER CLUB · SEPTEMBER" },
  cover("Facebook"), { text: "FACEBOOK" },
  cover("SEO Positioning Map"), { text: "" },
  cover("SEO and AI Report by ANGA"), { text: "AI SEO Visibility" }, { text: "ตัวอย่าง" }, { text: "third ANGA page" },
].map((p, i) => ({ n: i + 1, ...p }));
const map = L.mapPdfPages(pages);
expect("pdf: overview page", JSON.stringify(map.overview) === "[2]", JSON.stringify(map.overview));
expect("pdf: one page per section", JSON.stringify(map.betterClub) === "[7]", JSON.stringify(map.betterClub));
expect("pdf: image-only page still mapped", JSON.stringify(map.seoMap) === "[12]", JSON.stringify(map.seoMap));
expect("pdf: ANGA keeps two pages", JSON.stringify(map.aiSeo) === "[14,15]", JSON.stringify(map.aiSeo));
expect("pdf: unknown covers ignored", !("facebook" in map) && Object.keys(map).length === 5, Object.keys(map).join(","));
// The real export letter-spaces every heading (v3.360.0, September PDF).
const spaced = (t) => t.split("").join(" ");
const realMap = L.mapPdfPages([cover(spaced("Better AI")), { text: spaced("BETTER AI BHQ 01 SEP 2026") }].map((p, i) => ({ n: i + 1, text: spaced(p.text) })));
expect("pdf: letter-spaced headings", JSON.stringify(realMap.betterAi) === "[2]", JSON.stringify(realMap));
expect("pdf: content page is not a cover", L.coverTitle("REVENUE ATTRIBUTION Better Club 01 SEP 2026 – 30 SEP 2026 Google impressions › web traffic") === null, "");

// ---------------------------------------------------------------- 3. docx
/** Reads a store-only zip back; also proves the CRCs and offsets are right. */
function unzip(buf) {
  const files = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const crc = buf.readUInt32LE(p + 14), size = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nlen).toString("utf8");
    const data = buf.slice(p + 30 + nlen + xlen, p + 30 + nlen + xlen + size);
    if (zlib.crc32 && zlib.crc32(data) !== crc) throw new Error(`bad crc on ${name}`);
    files[name] = data;
    p += 30 + nlen + xlen + size;
  }
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("no central directory");
  return files;
}
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
try {
  const bytes = L.buildDocx({ title: "Call out (BGH)", sections: [
    { title: "E-Commerce", bullets: ["ยอดขายสะสม 111.7 ล้านบาท <เพิ่มขึ้น> & ดี"], images: [{ b64: PNG_1PX, type: "image/png", w: 1400, h: 787 }] },
  ] });
  const files = unzip(Buffer.from(bytes));
  const doc = files["word/document.xml"].toString("utf8");
  expect("docx: parts present", ["[Content_Types].xml", "_rels/.rels", "word/styles.xml", "word/_rels/document.xml.rels", "word/media/image1.png"]
    .every((f) => files[f]), Object.keys(files).length + " parts");
  expect("docx: Thai text, escaped", doc.includes("ยอดขายสะสม 111.7 ล้านบาท &lt;เพิ่มขึ้น&gt; &amp; ดี"), "");
  expect("docx: image linked", doc.includes('r:embed="rIdImg1"') && files["word/_rels/document.xml.rels"].toString().includes("media/image1.png"), "");
  expect("docx: image keeps aspect", /cx="5486400" cy="3084141"/.test(doc), (doc.match(/cy="\d+"/) || [""])[0]);
  expect("docx: headings styled", (doc.match(/Heading2/g) || []).length === 1 && doc.includes("Heading1"), "");
} catch (e) {
  fail("docx: readable zip", e.message);
}

// ---------------------------------------------------------------- 4. client
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const RESULT = {
  brand: "BGH", from: "2026-09-01", to: "2026-09-30", model: "test",
  order: ["overview", "ecom", "aiSeo"],
  titles: { overview: "Overall Digital Marketing Performances", ecom: "E-Commerce", aiSeo: "AI SEO & AI Visibility" },
  facts: FACTS, shotFacts: [{ id: "shot.anga.bh", value: 59, unit: "%", label: "BH ChatGPT", fromShot: true }],
  sections: [
    { id: "ecom", bullets: [{ text: "ยอดขายสะสม 111.7 ล้านบาท เพิ่มขึ้น 40.47% YoY" }, { text: "Vaccine จาก 581,000 บาท" }] },
    { id: "overview", bullets: [{ text: "BHQ ได้รับการมองเห็นทั้งหมด 68.7 ล้านครั้ง" }] },
    { id: "aiSeo", bullets: [{ text: "ChatGPT 59%" }] },
  ],
  checks: ["BGH website sessions YoY 404% — likely a tracking change"],
};
const errors = [];
let posted = null, downloaded = null;
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(w) {
    w.CalloutLib = L;
    w.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes("/api/callout")) posted = JSON.parse(opts.body);
      const body = u.includes("/api/callout") ? RESULT
        : u.includes("/api/me") || !u.includes("/api/") ? { tabs: ["overview", "report"], version: "test", isAdmin: false } : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
    };
    w.confirm = () => true;
    // JSDOM's Blob cannot be read back; keep the bytes the export handed it.
    w.Blob = class { constructor(parts) { this.parts = parts; } };
    w.URL.createObjectURL = (b) => { downloaded = b; return "blob:x"; };
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function () {};
    w.addEventListener("error", (e) => errors.push(e.message || String(e.error)));
    w.addEventListener("unhandledrejection", (e) => errors.push(`rejection: ${e.reason && e.reason.message}`));
  },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(900);
  const d = dom.window.document;
  const nav = d.querySelector('.nav-item[data-view="callout"]');
  expect("client: nav item after WSH", nav && nav.previousElementSibling.dataset.brand === "WSH", "");
  expect("client: AI chip", nav && nav.querySelector(".ai-badge") && nav.querySelector(".ai-badge").textContent.trim() === "AI", "");
  expect("client: granted with report", nav && !nav.classList.contains("hidden"), nav ? nav.className : "missing");
  if (!nav) return finish();
  const before = errors.length;
  nav.click();
  await wait(50);
  expect("client: tab renders", d.getElementById("coGo") && d.getElementById("coBrand"), "");
  d.querySelector('#coBrand button[data-b="BHT"]').click();
  await wait(20);
  d.getElementById("coGo").click();
  await wait(200);
  expect("client: posts brand + dates", posted && posted.brand === "BHT" && /^\d{4}-\d{2}-\d{2}$/.test(posted.from), JSON.stringify(posted && { b: posted.brand, f: posted.from }));
  const body = d.getElementById("coBody");
  const titles = [...body.querySelectorAll(".co-sec h2")].map((h) => h.textContent);
  expect("client: sections in server order", titles.join("|") === "Overall Digital Marketing Performances|E-Commerce|AI SEO & AI Visibility", titles.join("|"));
  expect("client: wrong number marked", body.querySelectorAll(".co-n.bad").length === 1 && body.querySelector(".co-n.bad").textContent === "581,000", "");
  expect("client: right numbers marked", body.querySelectorAll(".co-n.ok").length === 4, `${body.querySelectorAll(".co-n.ok").length} ok`);
  expect("client: tally says what is wrong", /1 of 5 numbers not found/.test(d.getElementById("coTally").textContent), d.getElementById("coTally").textContent);
  expect("client: checks listed", /tracking change/.test(body.textContent), "");
  // The team fixes the wrong figure by hand; the check must follow the edit.
  const bad = [...body.querySelectorAll(".co-b")].find((el) => /581,000/.test(el.textContent));
  bad.textContent = "Vaccine จาก 995K บาท";
  bad.dispatchEvent(new dom.window.Event("blur"));
  await wait(20);
  expect("client: edit is re-checked", /All 5 numbers match/.test(d.getElementById("coTally").textContent), d.getElementById("coTally").textContent);
  // Removing a point removes it from the export.
  d.querySelector('[data-unbullet="aiSeo:0"]').click();
  await wait(20);
  expect("client: empty section disappears", !d.querySelector('[data-sec="aiSeo"]'), "");
  d.getElementById("coExport").click();
  await wait(100);
  if (!downloaded) fail("client: export", "no blob created");
  else {
    const buf = Buffer.from(downloaded.parts[0]);
    const doc = unzip(buf)["word/document.xml"].toString("utf8");
    expect("client: export carries the edit", doc.includes("Vaccine จาก 995K บาท") && !doc.includes("581,000"), "");
    expect("client: export drops removed points", !doc.includes("ChatGPT 59%") && doc.includes("Call out (BHT)"), "");
  }
  const mine = errors.slice(before);
  expect("client: no thrown errors", mine.length === 0, mine.slice(0, 2).join(" | "));
  finish();
})();

function finish() {
  console.log(failures ? `\n${failures} callout check(s) failed` : "\ncallout checks clean");
  process.exit(failures ? 1 : 0);
}
