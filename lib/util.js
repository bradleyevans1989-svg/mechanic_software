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
  // Postgres integer columns top out at about 2.1 billion.
  return Number.isFinite(n) && Math.abs(n) < 2e9 ? n : null;
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

// Date-only maths in UTC so the server's own timezone never shifts a day.
function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const DEFAULT_TZ = 'Australia/Sydney';

// Wall-clock parts in a workshop's timezone (each workshop sets its own).
function clock(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: tz || DEFAULT_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    return clock(DEFAULT_TZ);
  }
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` };
}

function today(tz) {
  return clock(tz).date;
}

function now(tz) {
  const c = clock(tz);
  return `${c.date} ${c.time}`;
}

function addMonths(iso, months) {
  const [y, m] = iso.split('-').map(Number);
  return isoDate(new Date(Date.UTC(y, m - 1 + months, 1)));
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(Date.UTC(y, m - 1, d + days)));
}

// Monday of the week containing iso.
function mondayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

// 2026-10-14 -> 14/10/2026
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

// A timestamp shown on the workshop's clock: 14/10/2026 3:05 pm
function fmtDateTime(d, tz) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: tz || DEFAULT_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(d)).replace(',', '');
  } catch {
    return String(d);
  }
}

function fmtTime(d, tz) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-AU', { timeZone: tz || DEFAULT_TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
  } catch {
    return String(d);
  }
}

// 95 minutes -> "1h 35m"
function fmtMinutes(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm' : ''}`.trim();
}

// Minutes between two timestamps (an open entry runs to now).
function minutesBetween(start, end) {
  return Math.max(0, Math.round(((end ? new Date(end) : new Date()) - new Date(start)) / 60000));
}

// Time on the clock is billed in quarter hours, rounded up.
function billableHours(minutes) {
  return Math.ceil(minutes / 15) / 4;
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
  addMonths,
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
  DEFAULT_TZ,
  today,
  mondayOf,
  addDays,
  now,
  fmtDate,
  fmtDateTime,
  fmtTime,
  fmtMinutes,
  minutesBetween,
  billableHours,
  vehicleLabel,
  docNumber,
};
