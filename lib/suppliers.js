const { parseDollars, roundCents } = require('./util');

// Parts supplier connectors.
//
// Every supplier record names a connector. The connector is the only part of the
// app that knows how to talk to that supplier; the rest (catalogue, purchase
// orders, receiving stock) works the same for all of them. A connector is:
//
//   key, name, blurb   what it is, for the supplier form
//   live               true once it really talks to the supplier
//   fields             login details the workshop enters: [{ key, label, secret }]
//   search(ctx, { q, vehicle })
//                      live catalogue lookup: [{ code, description, cost_cents, sell_cents, stock, gst }]
//   placeOrder(ctx, { order, lines, job, vehicle })
//                      sends a purchase order: { sent, reference, message }
//   punchoutUrl(ctx, { job, vehicle, returnUrl })
//                      the supplier's own catalogue, opened for this car; null if none
//   parseReturn(ctx, body)
//                      parts the supplier's catalogue sent back: [{ code, description, qty, cost_cents, sell_cents, gst }]
//
// ctx is { db, supplier, config }: config is the saved login details, and the
// supplier's account number is supplier.account_no.
// All prices are cents ex GST: a connector whose supplier quotes GST-inclusive
// prices (Repco's Navigator does) converts them before handing them back.
//
// Burson and Repco only open their systems to approved software partners. Until
// that access comes through, their connectors work like "manual": the workshop
// imports the supplier's price file and phones or emails the order.

const manual = {
  key: 'manual',
  name: 'Phone, email or counter',
  blurb: 'Orders are printed or emailed to the supplier and marked as ordered by hand. Import their price file to search their parts here.',
  live: false,
  fields: [],
  search: null,
  async placeOrder() {
    return { sent: false, reference: '', message: 'Marked as ordered. Phone or email the order through to the supplier.' };
  },
  punchoutUrl: () => null,
  parseReturn: () => [],
};

// A supplier connector waiting on partner access: login details can be saved now.
const pending = (key, name, blurb, fields) => ({ ...manual, key, name, blurb, fields });

const CONNECTORS = {
  manual,
  burson: pending(
    'burson',
    'Burson EzyParts',
    'Waiting on Burson to approve this software as an EzyParts partner. Until then orders are placed by hand; your login is saved ready.',
    [
      { key: 'username', label: 'EzyParts username' },
      { key: 'password', label: 'EzyParts password', secret: true },
    ]
  ),
  repco: pending(
    'repco',
    'Repco Navigator Pro',
    'Waiting on Repco to approve this software for Navigator Pro. Until then orders are placed by hand; your login is saved ready.',
    [
      { key: 'suffix', label: 'Account suffix' },
      { key: 'site_code', label: 'Site code' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', secret: true },
    ]
  ),
  capricorn: pending(
    'capricorn',
    'Capricorn preferred supplier',
    'Capricorn members order from preferred suppliers by hand for now. Record your member number here.',
    [{ key: 'member_no', label: 'Capricorn member number' }]
  ),
};

function connectorFor(supplier) {
  return CONNECTORS[supplier && supplier.connector] || manual;
}

// Adds or replaces a connector (a real Burson or Repco one, or a fake in tests).
function register(connector) {
  CONNECTORS[connector.key] = { ...manual, ...connector };
}

function readConfig(supplier) {
  try {
    const c = JSON.parse(supplier.config || '{}');
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

// Login details from the supplier form. A blank secret keeps the saved one.
function configFrom(connector, body, previous = {}) {
  const out = {};
  for (const f of connector.fields) {
    const v = String((body.config && body.config[f.key]) ?? '').trim().slice(0, 200);
    out[f.key] = f.secret && !v ? previous[f.key] || '' : v;
  }
  return out;
}

// RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes.
function parseCsv(text) {
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
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// Which column holds what, from the header row of a supplier's price file.
const HEADERS = {
  code: /^(code|part ?(no|number|#)|item ?(code|no|number)?|sku|product ?code|stock ?code)$/i,
  description: /^(desc(ription)?|name|product|item ?description|part ?description)$/i,
  cost: /^(cost|buy|trade|nett?|cost ?price|trade ?price|buy ?price|your ?price|dealer)$/i,
  sell: /^(sell|retail|rrp|list|price|sell ?price|retail ?price|list ?price)$/i,
};

// Turns a supplier's price file into catalogue rows, ex GST.
function priceFileRows(text, { incGst = false } = {}) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return { items: [], error: 'The file is empty.' };
  const col = {};
  head.forEach((h, i) => {
    const name = h.trim();
    for (const [k, re] of Object.entries(HEADERS)) if (col[k] === undefined && re.test(name)) col[k] = i;
  });
  if (col.description === undefined) return { items: [], error: 'No description column found. Name one column "Description".' };
  const exGst = (v) => {
    const cents = Math.max(parseDollars(v), 0);
    return incGst ? roundCents(cents / 1.1) : cents;
  };
  const items = [];
  for (const r of rows.slice(0, 20000)) {
    const description = String(r[col.description] || '').trim().slice(0, 300);
    if (!description) continue;
    items.push({
      code: col.code === undefined ? '' : String(r[col.code] || '').trim().toUpperCase().slice(0, 30),
      description,
      cost_cents: col.cost === undefined ? 0 : exGst(r[col.cost]),
      sell_cents: col.sell === undefined ? 0 : exGst(r[col.sell]),
    });
  }
  return { items, error: items.length ? null : 'No parts found under the header row.' };
}

module.exports = { CONNECTORS, connectorFor, register, readConfig, configFrom, parseCsv, priceFileRows };
