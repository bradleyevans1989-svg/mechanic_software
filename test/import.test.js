// Import from other workshop software: reading spreadsheets, recognising each
// system's columns, spotting duplicates, and the upload, columns, check, import steps.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { startApp } = require('./helpers');
const sheets = require('../lib/sheets');
const imp = require('../lib/importer');

const SAMPLES = path.join(__dirname, '..', 'docs', 'samples', 'import');
const sample = (name) => fs.readFileSync(path.join(SAMPLES, name));

let t;
let owner;
let other;

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Import Motors', 'import@example.com');
  other = await t.signup('Other Garage', 'other-import@example.com');
});

after(() => t && t.stop());

const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The fields a form would post: hidden and text inputs, and the chosen option of each select.
function formFields(html, action) {
  const start = html.indexOf(`action="${action}"`);
  assert.ok(start >= 0, `no form posting to ${action}`);
  const form = html.slice(start, html.indexOf('</form>', start));
  const fields = {};
  for (const m of form.matchAll(/<input\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0]);
    if (!name || /type="(radio|checkbox|file)"/.test(m[0])) continue;
    fields[unescape(name[1])] = unescape((/value="([^"]*)"/.exec(m[0]) || [])[1] || '');
  }
  for (const m of form.matchAll(/<select\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const chosen = /<option value="([^"]*)" selected/.exec(m[2]) || /<option value="([^"]*)"/.exec(m[2]);
    fields[unescape(m[1])] = chosen ? unescape(chosen[1]) : '';
  }
  return fields;
}

const upload = (slot, name, buf) => ({ [`files[${slot}][name]`]: name, [`files[${slot}][data]`]: buf.toString('base64') });

// Runs the steps the way the pages do; `change` edits the column step's fields.
async function runImport(client, fields, change = (f) => f) {
  const columns = await client.post('/import/columns', fields);
  const columnsHtml = await columns.text();
  assert.equal(columns.status, 200, columnsHtml.slice(0, 500));
  const preview = await client.post('/import/preview', change(formFields(columnsHtml, '/import/preview')));
  const previewHtml = await preview.text();
  assert.equal(preview.status, 200, previewHtml.slice(0, 500));
  const done = await client.post('/import/run', formFields(previewHtml, '/import/run'));
  return { columnsHtml, previewHtml, doneHtml: await done.text(), status: done.status };
}

test('spreadsheet reading: xlsx with dates and numbers, CSV delimiters, Excel XML and HTML "xls"', () => {
  const md = sheets.readSpreadsheet('export.xlsx', sample('mechanicdesk-style-export.xlsx'));
  assert.deepEqual(md.sheets.map((s) => s.name), ['Customers', 'Vehicles', 'Inventory']);
  const vehicles = md.sheets[1].rows;
  assert.deepEqual(vehicles[1].slice(2, 11), ['XYZ789', 'Mazda', 'CX-5', '2020', 'JM0KF4W7A00111111', 'Grey', '61000', '2027-01-20', '2026-11-05']);
  assert.equal(md.sheets[2].rows[1][7], '9.1');

  // Blank rows keep their place, so line numbers match what Excel shows.
  const simple = sheets.readSpreadsheet('list.xlsx', sample('simple-customer-list.xlsx')).sheets[0].rows;
  assert.deepEqual(simple[1], []);
  assert.equal(simple[3][0], 'Jordan Smith');
  assert.equal(simple[3][1], '434567890');

  const semi = sheets.readSpreadsheet('a.csv', Buffer.from('﻿Name;Phone\r\n"Smith; Jo";0412 000 111\r\n'));
  assert.deepEqual(semi.sheets[0].rows, [['Name', 'Phone'], ['Smith; Jo', '0412 000 111']]);
  const tabs = sheets.readSpreadsheet('a.txt', Buffer.from('Name\tRego\nJo\tABC123\n'));
  assert.deepEqual(tabs.sheets[0].rows[1], ['Jo', 'ABC123']);

  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Worksheet ss:Name="Stock"><Table><Row><Cell><Data ss:Type="String">Code</Data></Cell><Cell><Data ss:Type="String">Description</Data></Cell></Row>
    <Row><Cell><Data ss:Type="String">Z386</Data></Cell><Cell ss:Index="2"><Data ss:Type="String">Oil filter &amp; seal</Data></Cell></Row></Table></Worksheet></Workbook>`;
  const ml = sheets.readSpreadsheet('stock.xls', Buffer.from(xml));
  assert.equal(ml.sheets[0].name, 'Stock');
  assert.deepEqual(ml.sheets[0].rows[1], ['Z386', 'Oil filter & seal']);

  const html = sheets.readSpreadsheet('customers.xls', Buffer.from('<html><table><tr><th>Name</th><th>Phone</th></tr><tr><td>Jo &amp; Co</td><td>0412</td></tr></table></html>'));
  assert.deepEqual(html.sheets[0].rows, [['Name', 'Phone'], ['Jo & Co', '0412']]);

  assert.match(sheets.readSpreadsheet('old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])).error, /save it as \.xlsx or CSV/);
  assert.match(sheets.readSpreadsheet('bad.xlsx', Buffer.concat([Buffer.from('PK'), zlib.deflateRawSync('x')])).error, /couldn't be read/);
});

test('recognising each system, the header row and the columns', () => {
  const ws = sheets.readSpreadsheet('c.csv', sample('workshop-software-customers.csv')).sheets[0];
  assert.equal(imp.detectSource(ws.rows[0], 'customers'), 'workshopsoftware');
  const wsv = sheets.readSpreadsheet('v.csv', sample('workshop-software-vehicles.csv')).sheets[0];
  assert.equal(imp.detectSource(wsv.rows[0], 'vehicles'), 'workshopsoftware');
  // The vehicle's own IMPORTED ID isn't mistaken for its owner's.
  assert.equal(imp.prepare(wsv, 'vehicles', 'workshopsoftware').map.ref, 0);
  const wsp = sheets.readSpreadsheet('p.csv', sample('workshop-software-products.csv')).sheets[0];
  assert.equal(imp.detectSource(wsp.rows[0], 'parts'), 'workshopsoftware');
  const md = sheets.readSpreadsheet('m.xlsx', sample('mechanicdesk-style-export.xlsx')).sheets;
  assert.equal(imp.detectSource(md[2].rows[0], 'parts'), 'mechanicdesk');
  assert.equal(imp.pickSheet(md, 'vehicles'), 1);
  assert.equal(imp.pickSheet(md, 'parts'), 2);
  const auxo = ['Customer Type', 'Customer ID', 'First Name', 'Last Name', 'Company Name', 'Mobile Number', 'Phone Number', 'Email Address', 'Billing Address'];
  assert.equal(imp.detectSource(auxo, 'customers'), 'auxo');
  assert.equal(imp.detectSource(['Name', 'Phone', 'Email', 'Rego'], 'customers'), 'other');

  const simple = sheets.readSpreadsheet('s.xlsx', sample('simple-customer-list.xlsx')).sheets[0];
  const p = imp.prepare(simple, 'customers', 'other');
  assert.equal(p.headerIndex, 2);
  assert.deepEqual(
    [p.map.name, p.map.mobile, p.map.email, p.map.rego, p.map.make, p.map.model, p.map.year, p.map.odometer, p.map.rego_due, p.map.next_service_date],
    [0, 1, 2, 4, 5, 6, 7, 8, 9, 10]
  );

  assert.equal(imp.parseDate('22/10/2026').value, '2026-10-22');
  assert.equal(imp.parseDate('1/2/26').value, '2026-02-01');
  assert.equal(imp.parseDate('3 Sept 2025').value, '2025-09-03');
  assert.equal(imp.parseDate('31/02/2026').bad, true);
  assert.equal(imp.cleanPhone('412345678'), '0412345678');
  assert.equal(imp.phoneKey('+61 412 345 678'), imp.phoneKey('0412 345 678'));
});

test('customers and vehicles from Workshop Software: two linked files, duplicates and problems shown first', async () => {
  // Already a customer, with the same mobile and the Hilux on file.
  await owner.post('/customers', { name: 'Sam Taylor', phone: '0412345678', v_rego: '123 ABC', v_make: 'Toyota', v_model: 'Hilux' });

  const fields = {
    kind: 'customers', source: '',
    ...upload('customers', 'Customers.csv', sample('workshop-software-customers.csv')),
    ...upload('vehicles', 'Vehicles.csv', sample('workshop-software-vehicles.csv')),
  };
  const { columnsHtml, previewHtml, doneHtml, status } = await runImport(owner, fields);
  assert.match(columnsHtml, /looks like a Workshop Software export/);
  assert.match(previewHtml, /Already a customer: Sam Taylor \(same phone\)/);
  assert.match(previewHtml, /No customer with ID 1099 in the customers file/);
  assert.match(previewHtml, /isn&#39;t an email address/);
  assert.match(previewHtml, /Import 3 customers and 4 vehicles/);
  // Can't-import rows come before the rest.
  assert.ok(previewHtml.indexOf('No name, phone or email') < previewHtml.indexOf('Priya Sharma'));
  assert.equal(status, 200);
  assert.match(doneHtml, /3 customers and 4 vehicles added; 1 existing customer had blank details filled in/);

  const sam = await owner.db.all(`SELECT * FROM customers WHERE name = 'Sam Taylor'`);
  assert.equal(sam.length, 1);
  assert.equal(sam[0].email, 'sam@example.com');
  assert.equal(sam[0].tags, '');
  assert.equal((await owner.db.get(`SELECT COUNT(*) AS n FROM vehicles WHERE customer_id = $1`, [sam[0].id])).n, 1);

  const brennan = await owner.db.get(`SELECT * FROM customers WHERE name = 'Brennan Plumbing Pty Ltd'`);
  assert.equal(brennan.kind, 'company');
  assert.equal(brennan.phone, '0438 765 432');
  assert.equal(brennan.address, 'Unit 3, 88 Industrial Dr, Brendale QLD 4500');
  assert.equal(brennan.tags, 'From Workshop Software');
  assert.match(brennan.notes, /Other phone: 07 3205 4400/);
  assert.match(brennan.notes, /Contact: Dave Brennan/);
  const vans = await owner.db.all(`SELECT * FROM vehicles WHERE customer_id = $1 ORDER BY rego`, [brennan.id]);
  assert.deepEqual(vans.map((v) => v.rego), ['BRN001', 'BRN002']);
  assert.deepEqual([vans[0].year, vans[0].vin, vans[0].odometer, vans[0].rego_due, vans[0].next_service_date, vans[0].last_service_date],
    ['2015', 'JTFSS22P900111222', 312400, '2026-12-01', '2026-12-20', '2026-09-20']);
  const owners = await owner.db.get(`SELECT COUNT(*) AS n FROM vehicle_owners WHERE vehicle_id = $1`, [vans[0].id]);
  assert.equal(owners.n, 1);
  const megan = await owner.db.get(`SELECT * FROM customers WHERE name = 'Megan O''Connor'`);
  assert.equal(megan.email, '');
  assert.match(megan.notes, /megan.oc@example/);

  // The same files again add nothing.
  const again = await runImport(owner, fields);
  assert.match(again.previewHtml, /Import 0 customers and 0 vehicles/);
  assert.equal((await owner.db.get('SELECT COUNT(*) AS n FROM customers')).n, 4);

  // Another workshop's matching is its own: everything is new there.
  const theirs = await runImport(other, fields);
  assert.match(theirs.doneHtml, /4 customers and 5 vehicles added/);
});

test('one workbook with customers and vehicles sheets, and a hand-made list with repeats', async () => {
  const md = await runImport(owner, { kind: 'customers', ...upload('customers', 'export.xlsx', sample('mechanicdesk-style-export.xlsx')) });
  assert.match(md.columnsHtml, /looks like a MechanicDesk export/);
  assert.match(md.columnsHtml, /export\.xlsx · sheet Vehicles/);
  assert.match(md.doneHtml, /3 customers and 4 vehicles added/);
  const couriers = await owner.db.get(`SELECT * FROM customers WHERE name = 'Sunshine Couriers'`);
  assert.equal(couriers.kind, 'company');
  assert.equal(couriers.tags, 'From MechanicDesk');
  assert.equal((await owner.db.get(`SELECT COUNT(*) AS n FROM vehicles WHERE customer_id = $1`, [couriers.id])).n, 2);

  // No tag this time; the person's own name column is mapped by hand.
  const simple = await runImport(owner, { kind: 'customers', ...upload('customers', 'list.xlsx', sample('simple-customer-list.xlsx')) }, (f) => ({ ...f, 'options[tag]': '' }));
  assert.match(simple.columnsHtml, /didn&#39;t recognise the software/);
  assert.match(simple.previewHtml, /Same customer as line 5/);
  assert.match(simple.previewHtml, /soon isn&#39;t a date/);
  assert.match(simple.doneHtml, /3 customers and 4 vehicles added/);
  const chris = await owner.db.get(`SELECT * FROM customers WHERE name = 'Chris Papadopoulos'`);
  assert.equal(chris.phone, '0411222333');
  assert.equal(chris.tags, '');
  const cars = await owner.db.all(`SELECT * FROM vehicles WHERE customer_id = $1 ORDER BY rego`, [chris.id]);
  assert.deepEqual(cars.map((v) => [v.rego, v.year, v.odometer, v.rego_due]), [['CP1', '2017', 134000, '2027-05-09'], ['CP2', '2012', 180300, '2026-11-20']]);
});

test('the column step insists on a name column, and staff cannot import', async () => {
  const fields = { kind: 'customers', ...upload('customers', 'odd.csv', Buffer.from('Who,Rego\nJo,ABC1\n')) };
  const columns = await owner.post('/import/columns', fields);
  const html = await columns.text();
  const res = await owner.post('/import/preview', formFields(html, '/import/preview'));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Choose which column has the customer&#39;s name/);
  // Mapped by hand, it goes through.
  const ok = await owner.post('/import/preview', { ...formFields(html, '/import/preview'), 'map[customers][name]': '0' });
  assert.match(await ok.text(), /Import 1 customers and 1 vehicles/);

  assert.match((await (await owner.post('/import/columns', { kind: 'customers' })).text()), /Choose your customers file/);
  assert.match((await (await owner.post('/import/columns', { kind: 'parts', ...upload('parts', 'old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) })).text()), /Excel 97-2003/);

  const staffEmail = 'importstaff@example.com';
  await owner.post('/staff', { name: 'Mick', email: staffEmail, password: 'spanner-123', role: 'staff' });
  const staff = t.client();
  const login = await staff.post('/login', { email: staffEmail, password: 'spanner-123' });
  staff.cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await staff.get('/import')).status, 403);
  assert.equal((await staff.post('/import/run', fields)).status, 403);
});

test('parts and stock: Workshop Software products, then a MechanicDesk inventory with suppliers', async () => {
  const ws = await runImport(owner, { kind: 'parts', ...upload('parts', 'Products.csv', sample('workshop-software-products.csv')) });
  assert.match(ws.columnsHtml, /looks like a Workshop Software export/);
  assert.match(ws.previewHtml, /Same part as line 2/);
  assert.match(ws.previewHtml, /Stock was -1, so it starts at 0/);
  assert.match(ws.doneHtml, /5 parts added and 0 updated/);
  const filter = await owner.db.get(`SELECT * FROM price_items WHERE code = 'Z386'`);
  // Workshop Software retail prices include GST; Bay Boss keeps them ex GST.
  assert.deepEqual([filter.description, filter.cost_cents, filter.unit_cents, filter.stock_qty, filter.reorder_level, filter.kind, filter.gst],
    ['Ryco Oil filter', 910, 2268, 12, 4, 'part', true]);
  const labour = await owner.db.get(`SELECT * FROM price_items WHERE code = 'LAB'`);
  assert.equal(labour.kind, 'labour');
  assert.equal(labour.stock_qty, 0);

  // MechanicDesk's sheet updates the oil filter (same part number) and brings its suppliers.
  const md = await runImport(owner, { kind: 'parts', ...upload('parts', 'export.xlsx', sample('mechanicdesk-style-export.xlsx')) }, (f) => ({ ...f, 'options[sell_inc_gst]': '0' }));
  assert.match(md.columnsHtml, /sheet Inventory/);
  assert.match(md.previewHtml, /Updates Z386 Ryco Oil filter/);
  assert.match(md.previewHtml, /New supplier Repco will be added/);
  assert.match(md.doneHtml, /2 parts added and 1 updated, with 2 new suppliers/);
  const updated = await owner.db.get(`SELECT p.*, s.name AS supplier FROM price_items p JOIN suppliers s ON s.id = p.supplier_id WHERE code = 'Z386'`);
  assert.deepEqual([updated.stock_qty, updated.unit_cents, updated.supplier], [8, 2495, 'Repco']);
  assert.equal((await owner.db.get(`SELECT COUNT(*) AS n FROM suppliers`)).n, 2);
  assert.equal((await owner.db.get(`SELECT COUNT(*) AS n FROM price_items WHERE code = 'Z386'`)).n, 1);

  // Leaving stock alone on a re-import.
  await owner.db.run(`UPDATE price_items SET stock_qty = 3 WHERE code = 'Z386'`);
  await runImport(owner, { kind: 'parts', ...upload('parts', 'export.xlsx', sample('mechanicdesk-style-export.xlsx')) }, (f) => ({ ...f, 'options[set_stock]': '0' }));
  assert.equal((await owner.db.get(`SELECT stock_qty FROM price_items WHERE code = 'Z386'`)).stock_qty, 3);
});

test('a supplier price file can be an Excel file too', async () => {
  const supplier = await owner.db.get(`SELECT id FROM suppliers WHERE name = 'Burson'`);
  const res = await owner.post(`/suppliers/${supplier.id}/import`, { file_name: 'burson.xlsx', file_data: sample('mechanicdesk-style-export.xlsx').toString('base64'), markup: '0' });
  // The first sheet is customers, which has no description column.
  assert.match(decodeURIComponent(res.headers.get('location')), /No description column/);
  const csv = Buffer.from('Part No,Description,Trade\nWCO123,Wiper blade 22in Bosch,6.90\nNEW1,Something new,1\n');
  const ok = await owner.post(`/suppliers/${supplier.id}/import`, { file_name: 'burson.csv', file_data: csv.toString('base64'), markup: '100' });
  assert.match(decodeURIComponent(ok.headers.get('location')), /1 new, 1 updated/);
  const wiper = await owner.db.get(`SELECT * FROM price_items WHERE code = 'WCO123'`);
  // The supplier's file updates price and description, never the stock count.
  assert.deepEqual([wiper.cost_cents, wiper.unit_cents, wiper.stock_qty], [690, 1380, 6]);
});
