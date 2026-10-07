/**
 * CALL OUT — the pure half of the tab (v3.360.0).
 *
 * Kept out of index.html on purpose: everything here is a pure function the
 * suite can `require` and test directly (test/callout.js). The browser loads it
 * as a plain script and reads `window.CalloutLib`.
 *
 *   verifyText   every number in a sentence must be a figure the data holds
 *   mapPdfPages  which pages of the exported PDF belong to which section
 *   buildDocx    a .docx with no library: store-only zip + WordprocessingML
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ number check
  /**
   * WHY THIS EXISTS. The September callout was typed by hand from the PDF and
   * carried three wrong figures (Beauty "grew" when it fell, Vaccine and GI
   * swapped with Heart). A model writing the same text can make the same
   * mistake, so no sentence is trusted: every number in it is parsed and
   * looked up in the facts it was written from.
   *
   * A number passes when some fact, at the precision the sentence shows,
   * rounds to it: "68.7 ล้าน" matches 68,712,004; "40.47%" matches 40.472.
   * Hedged numbers ("กว่า 1,600", "ประมาณ 5,400") get 5% slack, because the
   * hedge is the writer saying it is rounded.
   */
  const MULT = { k: 1e3, m: 1e6, b: 1e9, "ล้าน": 1e6, "แสน": 1e5, "หมื่น": 1e4, "พัน": 1e3 };
  const NUM_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s*(?:%|ล้าน|แสน|หมื่น|พัน|[KkMmBb](?![A-Za-z])))?/g;
  const HEDGE_RE = /(ประมาณ|กว่า|ราว|เกือบ|~|about|over|nearly|almost|approx)\s*$/i;

  /** Numbers that are never figures: years, months, small counts in prose. */
  function isNeutral(x, dec, unit, before) {
    if (unit) return false;
    if (dec) return false;
    if (x >= 2000 && x <= 2100) return true;          // 2026
    if (x >= 2540 && x <= 2650) return true;          // 2569 (Buddhist era)
    if (x <= 12) return true;                          // "Top 5", "9 เดือน", "Q3"
    if (/Q$/i.test(before)) return true;
    return false;
  }

  function verifyText(text, facts) {
    const s = String(text || "");
    const list = Array.isArray(facts) ? facts : [];
    const out = [];
    NUM_RE.lastIndex = 0;
    let m;
    while ((m = NUM_RE.exec(s))) {
      const whole = m[1].replace(/,/g, "");
      const dec = m[2] || "";
      const rawUnit = (m[3] || "").trim();
      const unit = rawUnit.toLowerCase();
      const x = Number(whole + (dec ? "." + dec : ""));
      const before = s.slice(Math.max(0, m.index - 14), m.index);
      // A digit glued to a letter is a name or a code (BIH2, A1C), not a figure.
      const prev = s[m.index - 1] || "";
      if (/[A-Za-z]/.test(prev)) continue;
      const tok = { start: m.index, end: m.index + m[0].length, text: m[0], value: x, ok: false, fact: null };
      if (isNeutral(x, dec, unit, before)) { tok.ok = true; tok.neutral = true; out.push(tok); continue; }
      const pct = unit === "%";
      const mult = pct ? 1 : (MULT[unit] || 1);
      const step = Math.pow(10, -dec.length);
      let tol = step / 2 + 1e-9;
      // "26,500" is a rounded figure: its trailing zeros are its precision.
      if (!dec && whole.length > 1) {
        const zeros = whole.length - whole.replace(/0+$/, "").length;
        if (zeros) tol = Math.max(tol, Math.min(Math.pow(10, zeros) / 2, Math.abs(x) * 0.02));
      }
      if (HEDGE_RE.test(before)) tol = Math.max(tol, Math.abs(x) * 0.05);
      for (const f of list) {
        if (f == null || !Number.isFinite(f.value)) continue;
        if ((f.unit === "%") !== pct) continue;
        const v = Math.abs(f.value) / mult;
        if (Math.abs(v - x) <= tol) { tok.ok = true; tok.fact = f; break; }
      }
      out.push(tok);
    }
    return out;
  }

  // ------------------------------------------------------------ PDF mapping
  /**
   * THE EXPORTED PDF IS SPLIT BY ITS OWN COVER PAGES. Every section opens with
   * a cover ("Google Business Profile / Digital Marketing / September 2026"),
   * so the cover's title names every page after it until the next cover. That
   * survives the team adding, removing or reordering pages, which a page-number
   * table would not.
   */
  /**
   * MATCHED WITH ALL WHITESPACE REMOVED. The War Room's own PDF letter-spaces
   * its headings, so pdf.js returns "D i g i t a l   M a r k e t i n g" — a
   * regex on words never matches (caught on the real September file).
   */
  const squash = (t) => String(t || "").replace(/\s+/g, "").toLowerCase();
  const COVER_TAIL = /digitalmarketing[a-z]{3,9}\d{4}$/;   // month name, then year
  const SECTION_COVERS = [
    ["overview",   /^digitalmarketingperformance/, 1],
    ["ecom",       /^e-?commerce/,                 1],
    ["betterClub", /^betterclub/,                  1],
    ["website",    /^websiteperformance/,          1],
    ["gbp",        /^googlebusinessprofile/,       1],
    ["betterAi",   /^betterai/,                    1],
    ["seoMap",     /^seopositioningmap/,           1],
    ["aiSeo",      /^seoandaireport|anga/,         2],
  ];
  /** Sections whose content exists ONLY as a picture, so Claude must read it. */
  const VISUAL_SECTIONS = ["seoMap", "aiSeo"];

  /** A cover is short and ends "Digital Marketing <Month> <Year>". Returns its squashed title. */
  function coverTitle(text) {
    const t = squash(text);
    if (!COVER_TAIL.test(t) || t.length > 90) return null;
    return t.replace(COVER_TAIL, "") || null;
  }

  /** pages: [{ n, text }] in order → { [section]: [n, …] } */
  function mapPdfPages(pages) {
    const out = {};
    let current = null, taken = 0, cap = 0;
    for (const p of pages || []) {
      const title = coverTitle(p.text);
      if (title) {
        const hit = SECTION_COVERS.find(([, re]) => re.test(title));
        current = hit ? hit[0] : null; cap = hit ? hit[2] : 0; taken = 0;
        continue;
      }
      if (current && taken < cap) {
        (out[current] = out[current] || []).push(p.n);
        taken++;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ zip + docx
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const utf8 = (s) => new TextEncoder().encode(s);

  /** Store-only zip. A .docx does not need compression; Word and Google accept it. */
  function zipStore(files) {
    const chunks = [], central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
    const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
    for (const f of files) {
      const name = utf8(f.name);
      const data = typeof f.data === "string" ? utf8(f.data) : f.data;
      const crc = crc32(data);
      const head = [0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
      chunks.push(Uint8Array.from(head), name, data);
      central.push(Uint8Array.from([0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length),
        ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += head.length + name.length + data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = Uint8Array.from([0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length),
      ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    const all = [...chunks, ...central, end];
    const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  const xml = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Characters XML 1.0 forbids; a stray one makes Word refuse the whole file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  function b64ToBytes(b64) {
    if (typeof atob === "function") {
      const bin = atob(b64); const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return Uint8Array.from(Buffer.from(b64, "base64"));
  }

  const FONT = "Tahoma";   // has Thai glyphs on Windows, macOS and in Google Docs
  const run = (t, bold) => `<w:r>${bold ? "<w:rPr><w:b/><w:bCs/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;

  /**
   * doc: { title, sections: [{ title, bullets: [string], images: [{ b64, type, w, h }] }] }
   * Images are scaled to the 6-inch text width, keeping their aspect.
   */
  function buildDocx(doc) {
    const media = [];
    const body = [];
    body.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(doc.title || "Call out")}</w:p>`);
    for (const sec of doc.sections || []) {
      body.push(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run(sec.title)}</w:p>`);
      for (const b of sec.bullets || []) {
        body.push(`<w:p><w:pPr><w:ind w:left="360" w:hanging="360"/><w:spacing w:after="80"/></w:pPr>${run("\u2022\t")}${run(b)}</w:p>`);
      }
      for (const img of sec.images || []) {
        const i = media.length + 1;
        const ext = /png/i.test(img.type) ? "png" : "jpeg";
        media.push({ name: `word/media/image${i}.${ext}`, data: b64ToBytes(img.b64), id: `rIdImg${i}` });
        const cx = 5486400;                                   // 6in in EMU
        const cy = Math.round(cx * (img.h > 0 && img.w > 0 ? img.h / img.w : 0.5625));
        body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
          + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${i}" name="Picture ${i}"/>`
          + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
          + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
          + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
          + `<pic:nvPicPr><pic:cNvPr id="${i}" name="image${i}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>`
          + `<pic:blipFill><a:blip r:embed="rIdImg${i}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
          + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
          + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
          + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
      }
    }
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<w:document ${W} ${R} ${WP}><w:body>${body.join("")}`
      + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`
      + `</w:body></w:document>`;
    const fonts = `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>`
      + `<w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:bidi="th-TH"/></w:rPr></w:rPrDefault>`
      + `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
      + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`
      + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>`
      + `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="200"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="0B2A6B"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>`
      + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>`
      + `<w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="0B2A6B"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>`
      + `</w:styles>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + media.map((m) => `<Relationship Id="${m.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.name.replace("word/", "")}"/>`).join("")
      + `</Relationships>`;
    const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>`
      + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
      + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
      + `</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
      + `</Relationships>`;
    return zipStore([
      { name: "[Content_Types].xml", data: types },
      { name: "_rels/.rels", data: rootRels },
      { name: "word/document.xml", data: document },
      { name: "word/styles.xml", data: styles },
      { name: "word/_rels/document.xml.rels", data: rels },
      ...media.map((m) => ({ name: m.name, data: m.data })),
    ]);
  }

  const api = { verifyText, mapPdfPages, coverTitle, buildDocx, zipStore, crc32, VISUAL_SECTIONS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CalloutLib = api;
})(typeof window !== "undefined" ? window : this);
