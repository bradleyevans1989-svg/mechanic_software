const { requireOwner } = require('../lib/auth');
const { fromUpload } = require('../lib/sheets');
const imp = require('../lib/importer');

// Import from other workshop software: upload, match columns, check, import.
// Nothing is stored between steps: each step posts the files again (as base64
// in hidden fields) along with the choices so far, and the import re-reads them.

const SLOTS = { customers: ['customers', 'vehicles'], parts: ['parts'] };
const PREVIEW_ROWS = 400;

const kindOf = (v) => (SLOTS[v] ? v : 'customers');
const sourceOf = (v) => (imp.SOURCES[v] ? v : '');

// The uploaded files, read, each with the sheet that holds its data.
function readFiles(body, kind) {
  const files = (body && body.files) || {};
  const out = {};
  for (const slot of SLOTS[kind]) {
    const f = files[slot] || {};
    if (!f.data) continue;
    const read = fromUpload(f.name, f.data);
    if (read.error) return { error: `${f.name || 'That file'}: ${read.error}` };
    const posted = Number.parseInt(f.sheet, 10);
    const sheet = Number.isInteger(posted) && read.sheets[posted] ? posted : imp.pickSheet(read.sheets, slot);
    out[slot] = { name: String(f.name || '').slice(0, 200), data: f.data, sheets: read.sheets, sheet, own: true };
  }
  // One workbook with a vehicles sheet as well as a customers sheet.
  const c = out.customers;
  if (kind === 'customers' && c && !out.vehicles && c.sheets.length > 1) {
    const v = imp.pickSheet(c.sheets, 'vehicles');
    const rows = c.sheets[v].rows;
    const looksLikeVehicles = v !== c.sheet && Math.max(...rows.slice(0, 10).map((r) => r.filter((h) => ['rego', 'registration', 'numberplate', 'vin', 'make', 'model'].includes(imp.norm(h))).length)) >= 2;
    if (looksLikeVehicles) out.vehicles = { ...c, sheet: v, own: false };
  }
  const main = out[SLOTS[kind][0]];
  if (!main) return { error: kind === 'parts' ? 'Choose your parts or stock file.' : 'Choose your customers file.' };
  return { files: out };
}

// Each file's columns: the header row, the mapping, and the data rows under it.
function prepareAll(files, source, map) {
  const out = {};
  for (const [slot, f] of Object.entries(files)) {
    out[slot] = imp.prepare(f.sheets[f.sheet], slot, source, map ? map[slot] || {} : null);
  }
  return out;
}

function optionsFrom(body, kind, source) {
  const s = imp.SOURCES[source];
  if (!body.options) {
    return kind === 'parts'
      ? { sellIncGst: s.sellIncGst, costIncGst: false, markup: 40, setStock: true }
      : { tag: source === 'other' ? 'Imported' : `From ${s.name}` };
  }
  const o = body.options;
  return kind === 'parts'
    ? { sellIncGst: o.sell_inc_gst === '1', costIncGst: o.cost_inc_gst === '1', markup: Math.min(Math.max(parseFloat(o.markup) || 0, 0), 1000), setStock: o.set_stock !== '0' }
    : { tag: String(o.tag || '').replace(/,/g, ' ').trim().slice(0, 40) };
}

// What the mapping needs before going on.
function mappingProblems(kind, prepared) {
  const problems = [];
  if (kind === 'customers') {
    const m = prepared.customers.map;
    if (m.name === undefined && m.first_name === undefined && m.last_name === undefined && m.company === undefined) problems.push('Choose which column has the customer\'s name.');
    if (prepared.vehicles && prepared.vehicles.map.ref === undefined) problems.push('Choose the owner\'s customer ID column in the vehicles file, so each car goes to the right customer.');
    if (prepared.vehicles && m.ref === undefined) problems.push('Choose the customer ID column in the customers file, so vehicles can be linked to it.');
  } else if (prepared.parts.map.description === undefined && prepared.parts.map.code === undefined) {
    problems.push('Choose which column has the part description or part number.');
  }
  return problems;
}

module.exports = function (app) {
  app.get('/import', requireOwner, (req, res) => {
    res.render('import/start', { kind: kindOf(req.query.kind), source: sourceOf(req.query.from), SOURCES: imp.SOURCES, error: null });
  });

  // Step 2: what we found in the files, and which column is which.
  app.post('/import/columns', requireOwner, async (req, res) => {
    const kind = kindOf(req.body.kind);
    const read = readFiles(req.body, kind);
    if (read.error) return res.status(400).render('import/start', { kind, source: sourceOf(req.body.source), SOURCES: imp.SOURCES, error: read.error });
    const main = read.files[SLOTS[kind][0]];
    const detected = imp.detectSource(main.sheets[main.sheet].rows[imp.headerRow(main.sheets[main.sheet].rows, SLOTS[kind][0])] || [], SLOTS[kind][0]);
    const source = sourceOf(req.body.source) || detected;
    const keepMap = req.body.map && req.body.remap !== '1';
    const prepared = prepareAll(read.files, source, keepMap ? req.body.map : null);
    res.render('import/columns', {
      kind, source, detected, files: read.files, prepared, KINDS: imp.KINDS, SOURCES: imp.SOURCES,
      options: optionsFrom(keepMap ? req.body : {}, kind, source), problems: [],
    });
  });

  // Step 3: what the import would do, row by row.
  app.post('/import/preview', requireOwner, async (req, res) => {
    const kind = kindOf(req.body.kind);
    const source = sourceOf(req.body.source) || 'other';
    const read = readFiles(req.body, kind);
    if (read.error) return res.status(400).render('import/start', { kind, source, SOURCES: imp.SOURCES, error: read.error });
    const prepared = prepareAll(read.files, source, req.body.map || {});
    const options = optionsFrom(req.body, kind, source);
    const problems = mappingProblems(kind, prepared);
    if (problems.length) {
      return res.status(400).render('import/columns', { kind, source, detected: source, files: read.files, prepared, KINDS: imp.KINDS, SOURCES: imp.SOURCES, options, problems });
    }
    const plan = kind === 'parts'
      ? imp.planParts(prepared.parts, await imp.existingParts(req.db), options)
      : imp.planCustomers(prepared.customers, prepared.vehicles, await imp.existingCustomers(req.db));
    // Problems first, so they're seen before the long tail of new rows.
    const order = { error: 0, skip: 1, existing: 2, update: 2, same: 3, new: 4, vehicle: 4 };
    const rows = plan.rows.slice().sort((a, b) => (order[a.status] - order[b.status]) || (b.warnings.length - a.warnings.length) || (a.file === b.file ? a.line - b.line : a.file ? 1 : -1));
    res.render('import/preview', {
      kind, source, files: read.files, prepared, options, SOURCES: imp.SOURCES,
      counts: plan.counts, rows: rows.slice(0, PREVIEW_ROWS), more: Math.max(rows.length - PREVIEW_ROWS, 0),
    });
  });

  // Step 4: the same plan, worked out again from the same files, saved in one go.
  app.post('/import/run', requireOwner, async (req, res) => {
    const kind = kindOf(req.body.kind);
    const source = sourceOf(req.body.source) || 'other';
    const read = readFiles(req.body, kind);
    if (read.error) return res.status(400).render('import/start', { kind, source, SOURCES: imp.SOURCES, error: read.error });
    const prepared = prepareAll(read.files, source, req.body.map || {});
    const options = optionsFrom(req.body, kind, source);
    if (mappingProblems(kind, prepared).length) return res.redirect(`/import?kind=${kind}`);
    const result = await req.db.tx(async (db) => {
      if (kind === 'parts') {
        const existing = await imp.existingParts(db);
        return imp.applyParts(db, imp.planParts(prepared.parts, existing, options), existing);
      }
      const plan = imp.planCustomers(prepared.customers, prepared.vehicles, await imp.existingCustomers(db));
      return imp.applyCustomers(db, plan, { tag: options.tag, tz: req.tz });
    });
    res.render('import/done', { kind, source, result, options, SOURCES: imp.SOURCES });
  });
};
