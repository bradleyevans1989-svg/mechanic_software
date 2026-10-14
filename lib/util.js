const LINE_KINDS = ['labour', 'part', 'other'];

// Half away from zero, the same as SQLite's ROUND(), so list totals match page totals.
function roundCents(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function lineTotal(line) {
  return roundCents(line.qty * line.unit_cents);
}

// GST is rounded per line, the way Xero and MYOB work it out, so synced totals match.
function lineGst(line) {
  return line.gst ? roundCents(lineTotal(line) / 10) : 0;
}

function totals(lines) {
  let subtotal = 0;
  let gst = 0;
  for (const l of lines) {
    subtotal += lineTotal(l);
    gst += lineGst(l);
  }
  return { subtotal, gst, total: subtotal + gst };
}

function money(cents) {
  const sign = cents < 0 ? '-' : '';
  return sign + '$' + (Math.abs(cents || 0) / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// "$1,234.50" -> 123450
function parseDollars(s) {
  const n = parseFloat(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? roundCents(n * 100) : 0;
}

function dollars(cents) {
  return ((cents || 0) / 100).toFixed(2);
}

function parseIntOrNull(s) {
  const n = parseInt(String(s ?? '').replace(/[,\s]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Line rows arrive as lines[0][description], lines[1][qty] ... from the editor.
function parseLines(body) {
  const raw = body && body.lines ? Object.values(body.lines) : [];
  return raw
    .map((r) => ({
      kind: LINE_KINDS.includes(r.kind) ? r.kind : 'part',
      description: String(r.description || '').trim(),
      qty: parseFloat(r.qty) || 0,
      unit_cents: parseDollars(r.price),
      gst: r.gst === '0' ? 0 : 1,
    }))
    .filter((l) => l.description || l.unit_cents);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function today() {
  return isoDate(new Date());
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function now() {
  const d = new Date();
  return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 2026-10-14 -> 14/10/2026
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

function vehicleLabel(v) {
  if (!v) return '';
  const name = [v.year, v.make, v.model].filter(Boolean).join(' ');
  return [v.rego ? v.rego.toUpperCase() : '', name].filter(Boolean).join(' · ');
}

function docNumber(doc) {
  return (doc.type === 'quote' ? 'Q' : 'INV-') + doc.number;
}

module.exports = {
  LINE_KINDS,
  roundCents,
  lineTotal,
  lineGst,
  totals,
  money,
  parseDollars,
  dollars,
  parseIntOrNull,
  parseLines,
  isoDate,
  today,
  addDays,
  now,
  fmtDate,
  vehicleLabel,
  docNumber,
};
