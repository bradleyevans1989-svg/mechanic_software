// Small server-drawn SVG charts for the Today page. No chart library and no script needed.
// Colours come from CSS classes in style.css, so the charts follow the brand.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r1 = (n) => Math.round(n * 10) / 10;

// A round number at or above max, for the top of an axis: 1, 2, 2.5, 5 or 10 times a power of ten.
function niceMax(max) {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= max);
}

// $12,300 -> "$12.3k" on an axis.
function shortMoney(cents) {
  const d = cents / 100;
  if (d >= 1e6) return `$${r1(d / 1e6)}m`;
  if (d >= 1e3) return `$${r1(d / 1e3)}k`;
  return `$${Math.round(d)}`;
}

// A smooth line through points that never overshoots between them (monotone cubic).
function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${r1(pts[0][0])},${r1(pts[0][1])}`;
  const n = pts.length;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = `M${r1(pts[0][0])},${r1(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${r1(pts[i][0] + h)},${r1(pts[i][1] + t[i] * h)} ${r1(pts[i + 1][0] - h)},${r1(pts[i + 1][1] - t[i + 1] * h)} ${r1(pts[i + 1][0])},${r1(pts[i + 1][1])}`;
  }
  return d;
}

// Money over time. series: [{ name, cls, values }], all the same length as labels.
function lineChart(labels, series, { id = 'c', width = 640, height = 230 } = {}) {
  const pad = { l: 48, r: 12, t: 12, b: 26 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const top = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const x = (i) => pad.l + (labels.length > 1 ? (i * w) / (labels.length - 1) : w / 2);
  const y = (v) => pad.t + h - (v / top) * h;
  let svg = `<svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(series.map((s) => s.name).join(' and '))} over time">`;
  svg += '<defs>';
  for (const s of series) svg += `<linearGradient id="${id}-${s.cls}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop-${s.cls}" stop-opacity=".32"/><stop offset="1" class="stop-${s.cls}" stop-opacity="0"/></linearGradient>`;
  svg += '</defs>';
  for (let k = 0; k <= 4; k++) {
    const v = (top * k) / 4;
    svg += `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>`;
    svg += `<text class="axis" x="${pad.l - 8}" y="${r1(y(v) + 4)}" text-anchor="end">${shortMoney(v)}</text>`;
  }
  const every = Math.max(1, Math.ceil(labels.length / 7));
  labels.forEach((l, i) => {
    if ((labels.length - 1 - i) % every === 0) svg += `<text class="axis" x="${r1(x(i))}" y="${height - 6}" text-anchor="middle">${esc(l.short)}</text>`;
  });
  for (const s of series) {
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    const line = smoothPath(pts);
    if (s.fill !== false) svg += `<path class="area" fill="url(#${id}-${s.cls})" d="${line}L${r1(x(labels.length - 1))},${pad.t + h}L${r1(x(0))},${pad.t + h}Z"/>`;
    svg += `<path class="line line-${s.cls}" d="${line}"/>`;
    const last = pts[pts.length - 1];
    if (last) svg += `<circle class="dot dot-${s.cls}" cx="${r1(last[0])}" cy="${r1(last[1])}" r="4.5"/>`;
  }
  // Invisible hover targets, one per point in time, with every series' value.
  const band = labels.length > 1 ? w / (labels.length - 1) : w;
  labels.forEach((l, i) => {
    const tip = [l.long, ...series.map((s) => `${s.name}: $${(s.values[i] / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)].join('\n');
    svg += `<rect class="hit" x="${r1(x(i) - band / 2)}" y="${pad.t}" width="${r1(band)}" height="${h}"><title>${esc(tip)}</title></rect>`;
  });
  return svg + '</svg>';
}

// Shares of a whole as a ring. parts: [{ name, cls, value }].
function donut(parts, { size = 180, thickness = 26 } = {}) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const c = size / 2;
  const rad = c - thickness / 2;
  const circ = 2 * Math.PI * rad;
  let svg = `<svg class="donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(parts.map((p) => `${p.name} ${total ? Math.round((p.value / total) * 100) : 0}%`).join(', '))}">`;
  svg += `<circle class="ring" cx="${c}" cy="${c}" r="${r1(rad)}" stroke-width="${thickness}"/>`;
  let at = 0;
  for (const p of parts) {
    if (!total || p.value <= 0) continue;
    const len = (p.value / total) * circ;
    // A small gap between slices, unless one slice is the whole ring.
    const gap = len < circ - 0.5 ? Math.min(3, len / 3) : 0;
    svg += `<circle class="slice slice-${p.cls}" cx="${c}" cy="${c}" r="${r1(rad)}" stroke-width="${thickness}" stroke-dasharray="${r1(len - gap)} ${r1(circ)}" stroke-dashoffset="${r1(-at)}" transform="rotate(-90 ${c} ${c})"><title>${esc(p.name)}</title></circle>`;
    at += len;
  }
  return svg + '</svg>';
}

// Little white bars for a coloured tile.
function bars(values, { width = 110, height = 54 } = {}) {
  const top = Math.max(...values, 0) || 1;
  const n = values.length || 1;
  const bw = Math.min(8, (width / n) * 0.55);
  const step = width / n;
  let svg = `<svg class="tile-bars" viewBox="0 0 ${width} ${height}" aria-hidden="true">`;
  values.forEach((v, i) => {
    // Empty days stay as a faint stub so the run of days still reads.
    const bh = v > 0 ? Math.max(5, (v / top) * height) : 2;
    svg += `<rect${v > 0 ? '' : ' class="none"'} x="${r1(i * step + (step - bw) / 2)}" y="${r1(height - bh)}" width="${r1(bw)}" height="${r1(bh)}" rx="${r1(Math.min(bw, bh) / 2)}"/>`;
  });
  return svg + '</svg>';
}

// A soft wave for a coloured tile: a filled smooth line across the whole tile.
function wave(values, { width = 300, height = 70, line = false } = {}) {
  const vals = values.length > 1 ? values : [0, ...(values.length ? values : [0])];
  const top = Math.max(...vals, 0) || 1;
  const pts = vals.map((v, i) => [(i * width) / (vals.length - 1), height - 6 - (v / top) * (height - 16)]);
  const d = smoothPath(pts);
  return `<svg class="tile-wave${line ? ' as-line' : ''}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${
    line ? `<path class="wave-line" d="${d}"/>` : `<path d="${d}L${width},${height}L0,${height}Z"/>`
  }</svg>`;
}

module.exports = { lineChart, donut, bars, wave, smoothPath, niceMax, shortMoney };
