const zlib = require('zlib');

// Reads the spreadsheets other workshop software exports: CSV (comma, tab or
// semicolon), Excel .xlsx, and the two "Excel" files older systems write that
// are really text (an HTML table, or Excel 2003 XML). Old binary .xls files
// can't be read; the workshop opens them in Excel and saves as .xlsx or CSV.
//
// Every reader returns { sheets: [{ name, rows }] } with rows as arrays of
// trimmed strings, or { error } with a message for the workshop.

const MAX_ROWS = 50000;

// RFC 4180-ish CSV: quoted fields, doubled quotes, delimiters and newlines inside quotes.
function parseCsv(text, delimiter = ',', { keepBlank = false } = {}) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return keepBlank ? rows : rows.filter((r) => r.some((c) => c.trim()));
}

// Picks the delimiter that splits the first line into the most columns.
function sniffDelimiter(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0];
  let best = ',';
  let most = 0;
  for (const d of [',', '\t', ';', '|']) {
    const n = first.split(d).length;
    if (n > most) { most = n; best = d; }
  }
  return best;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescapeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
};

// Blank rows stay where they are (so line numbers match the spreadsheet), except at the end.
const isBlank = (row) => !row.some((v) => String(v || '').trim());
function trimEnd(rows) {
  let n = rows.length;
  while (n && isBlank(rows[n - 1])) n--;
  return rows.slice(0, n);
}

// The files inside a zip (an .xlsx is one), from its central directory.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 200 * 1024 * 1024 });
      throw new Error('unsupported zip compression');
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Built-in Excel number formats that are dates.
const DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

// Excel's day count (from 1900, with its leap-year bug) to 2026-10-22.
function serialToIso(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// Column letters to a 0-based index: A -> 0, AB -> 27.
function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf) {
  const files = unzip(buf);
  const text = (name) => (files.has(name) ? files.get(name)().toString('utf8') : '');

  const shared = [];
  for (const m of text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Rich text splits a string into runs; phonetic hints (<rPh>) aren't part of it.
    const body = m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '');
    shared.push(unescapeXml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }

  // Which cell styles show a date, so their numbers become dates.
  const styles = text('xl/styles.xml');
  const custom = new Map();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '');
  const isDateFormat = (id) => DATE_FORMATS.has(id) || (custom.has(id) && /[dy]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]/g, '')));
  const xfs = (/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles) || [])[1] || '';
  const dateStyles = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => isDateFormat(Number(attr(m[0], 'numFmtId'))));

  // Sheet names in workbook order, and where each one's XML lives.
  const rels = new Map();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const target = attr(m[0], 'Target') || '';
    rels.set(attr(m[0], 'Id'), target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets = [];
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const path = rels.get(attr(m[0], 'r:id'));
    if (!path || !files.has(path)) continue;
    const xml = files.get(path)().toString('utf8');
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      if (rows.length >= MAX_ROWS) break;
      // Rows are numbered, and empty ones left out: keep the numbering so line numbers match Excel.
      const number = Number(attr(`<row${r[1] || ''}>`, 'r'));
      while (number && rows.length < Math.min(number - 1, MAX_ROWS)) rows.push([]);
      const row = [];
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${c[1]}>`;
        const inner = c[2] || '';
        const ref = attr(tag, 'r');
        const idx = ref ? colIndex(ref) : row.length;
        const type = attr(tag, 't');
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = unescapeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) {
          value = unescapeXml(v);
          if (type !== 'str' && type !== 'e' && dateStyles[Number(attr(tag, 's') || 0)] && /^\d+(\.\d+)?$/.test(value)) value = serialToIso(Number(value));
        }
        row[idx] = value.trim();
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
      rows.push(row);
    }
    sheets.push({ name: attr(m[0], 'name') || `Sheet ${sheets.length + 1}`, rows: trimEnd(rows) });
  }
  return sheets;
}

// Excel 2003 XML ("SpreadsheetML"), which some systems save with an .xls name.
function readSpreadsheetMl(text) {
  const sheets = [];
  for (const ws of text.matchAll(/<(?:ss:)?Worksheet\b([^>]*)>([\s\S]*?)<\/(?:ss:)?Worksheet>/g)) {
    const rows = [];
    for (const r of ws[2].matchAll(/<(?:ss:)?Row\b[^>]*>([\s\S]*?)<\/(?:ss:)?Row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<(?:ss:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:ss:)?Cell>)/g)) {
        const index = /(?:ss:)?Index="(\d+)"/.exec(c[1]);
        if (index) while (row.length < Number(index[1]) - 1) row.push('');
        const data = /<(?:ss:)?Data\b[^>]*>([\s\S]*?)<\/(?:ss:)?Data>/.exec(c[2] || '');
        row.push(data ? unescapeXml(data[1].replace(/<[^>]+>/g, '')).trim().replace(/^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?$/, '$1') : '');
      }
      rows.push(row);
    }
    sheets.push({ name: /(?:ss:)?Name="([^"]*)"/.exec(ws[1])?.[1] || `Sheet ${sheets.length + 1}`, rows: trimEnd(rows) });
  }
  return sheets;
}

// An HTML table saved as .xls, which web apps often hand out as their "Excel" export.
function readHtmlTables(text) {
  const sheets = [];
  for (const t of text.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const r of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        unescapeXml(c[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim()
      );
      rows.push(row);
    }
    sheets.push({ name: `Table ${sheets.length + 1}`, rows: trimEnd(rows) });
  }
  return sheets;
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  const text = buf.toString('utf8');
  // Windows-1252 CSVs from older systems: keep them readable rather than full of U+FFFD.
  return text.includes('�') ? buf.toString('latin1') : text;
}

// A file as uploaded: its name and its bytes.
function readSpreadsheet(name, buf) {
  if (!buf || !buf.length) return { error: 'The file is empty.' };
  try {
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      const sheets = readXlsx(buf);
      return sheets.length ? { sheets } : { error: 'No sheets found in that Excel file.' };
    }
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
      return { error: 'That is an old Excel 97-2003 (.xls) file, which can\'t be read here. Open it in Excel and save it as .xlsx or CSV, then upload that.' };
    }
    const text = decodeText(buf);
    if (/<(?:ss:)?Workbook\b/.test(text.slice(0, 5000))) return { sheets: readSpreadsheetMl(text) };
    if (/<table\b/i.test(text.slice(0, 20000)) && /\.(xls|html?)$/i.test(name || '')) return { sheets: readHtmlTables(text) };
    const rows = trimEnd(parseCsv(text, sniffDelimiter(text), { keepBlank: true }).slice(0, MAX_ROWS)).map((r) => r.map((c) => c.trim()));
    return { sheets: [{ name: String(name || 'CSV').replace(/\.[a-z]+$/i, ''), rows }] };
  } catch {
    return { error: 'That file couldn\'t be read. Upload a CSV or an Excel .xlsx file.' };
  }
}

// Uploads arrive as base64 in a form field (see data-file-into in public/app.js).
function fromUpload(name, base64) {
  const b64 = String(base64 || '').replace(/^data:[^,]*,/, '');
  return readSpreadsheet(String(name || ''), Buffer.from(b64, 'base64'));
}

module.exports = { isBlank, parseCsv, sniffDelimiter, readSpreadsheet, fromUpload, serialToIso, unzip };
