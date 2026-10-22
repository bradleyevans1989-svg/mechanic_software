// Parts: suppliers, price files, purchase orders, receiving stock, supplier connectors.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');
const suppliers = require('../lib/suppliers');

let t;
let owner;
let other;
let jobId;

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Parts Motors', 'parts@example.com');
  other = await t.signup('Nosy Garage', 'nosy@example.com');
  await owner.post('/customers', { name: 'Penny Parts', v_rego: 'PART01', v_make: 'Toyota', v_model: 'Hilux' });
  const vehicle = await owner.db.get(`SELECT id FROM vehicles WHERE rego = 'PART01'`);
  jobId = idFrom(await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Brakes' }));
});

after(() => t && t.stop());

test('price file parsing: headers, quotes, GST-inclusive prices', () => {
  const { items, error } = suppliers.priceFileRows('Part No,Description,Trade,RRP\r\nz386,"Oil filter, Ryco",8.80,"$19.80"\n,,,\nDB1234,Brake pads front,55,\n', { incGst: true });
  assert.equal(error, null);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { code: 'Z386', description: 'Oil filter, Ryco', cost_cents: 800, sell_cents: 1800 });
  assert.equal(items[1].sell_cents, 0);
  assert.match(suppliers.priceFileRows('Code,Price\nA,1').error, /description/);
});

test('suppliers: owner adds one with a connector login; secrets are kept but not shown', async () => {
  let res = await owner.post('/suppliers', { name: '' });
  assert.equal(res.status, 400);
  res = await owner.post('/suppliers', { name: 'Burson Penrith', connector: 'burson', phone: '02 4700 0000', email: 'penrith@burson.example' });
  const id = idFrom(res);
  await owner.post(`/suppliers/${id}`, {
    name: 'Burson Penrith', connector: 'burson', email: 'penrith@burson.example', account_no: '12345',
    'config[username]': 'parts', 'config[password]': 'hunter2',
  });
  // Saving again with the password left blank keeps it.
  await owner.post(`/suppliers/${id}`, { name: 'Burson Penrith', connector: 'burson', email: 'penrith@burson.example', account_no: '12345', 'config[username]': 'parts', 'config[password]': '' });
  const s = await owner.db.get('SELECT * FROM suppliers WHERE id = $1', [id]);
  assert.equal(s.account_no, '12345');
  assert.deepEqual(JSON.parse(s.config), { username: 'parts', password: 'hunter2' });
  const page = await owner.get(`/suppliers/${id}`);
  assert.match(page.text, /EzyParts username/);
  assert.doesNotMatch(page.text, /hunter2/);
  assert.equal((await other.get(`/suppliers/${id}`)).status, 404);
});

test('price file import adds and updates parts for the supplier, with markup', async () => {
  const supplier = await owner.db.get(`SELECT id FROM suppliers WHERE name = 'Burson Penrith'`);
  let res = await owner.post(`/suppliers/${supplier.id}/import`, { csv: 'Code,Description,Cost\nZ386,Oil filter Ryco,10\nDB1234,Brake pads front,50\n', markup: '50' });
  assert.match(decodeURIComponent(res.headers.get('location')), /2 new, 0 updated/);
  res = await owner.post(`/suppliers/${supplier.id}/import`, { csv: 'Code,Description,Cost,Sell\nZ386,Oil filter Ryco Z386,12,25\n', markup: '50' });
  assert.match(decodeURIComponent(res.headers.get('location')), /0 new, 1 updated/);
  const filter = await owner.db.get(`SELECT * FROM price_items WHERE code = 'Z386'`);
  assert.equal(filter.cost_cents, 1200);
  assert.equal(filter.unit_cents, 2500);
  assert.equal(filter.supplier_id, supplier.id);
  assert.equal((await owner.db.get(`SELECT unit_cents FROM price_items WHERE code = 'DB1234'`)).unit_cents, 7500);

  const found = await owner.get('/parts?q=brake');
  assert.match(found.text, /DB1234/);
  assert.match(found.text, /Burson Penrith/);
  assert.doesNotMatch((await other.get('/parts?q=brake')).text, /DB1234/);
});

test('job card to purchase order: order parts on the job, send, receive', async () => {
  const supplier = await owner.db.get(`SELECT id FROM suppliers WHERE name = 'Burson Penrith'`);
  await owner.post(`/jobs/${jobId}`, {
    status: 'in_progress', description: 'Brakes',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '1', 'lines[0][price]': '120', 'lines[0][gst]': '1',
    'lines[1][kind]': 'part', 'lines[1][description]': 'Brake pads front', 'lines[1][qty]': '1', 'lines[1][price]': '75', 'lines[1][gst]': '1',
  });
  assert.match((await owner.get(`/jobs/${jobId}`)).text, /Order ticked parts/);

  let res = await owner.post('/purchase-orders', { supplier_id: supplier.id, job_id: jobId, job_lines: '1' });
  const poId = idFrom(res);
  let po = await owner.db.get('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
  assert.equal(po.status, 'draft');
  assert.match(po.reference, /^J\d+$/);
  let lines = await owner.db.all('SELECT * FROM purchase_order_lines WHERE order_id = $1', [poId]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].code, 'DB1234'); // matched from the price list
  assert.equal(lines[0].cost_cents, 5000);
  assert.equal(lines[0].from_job, true);

  // Add another part from the catalogue: lands on the same draft.
  const filter = await owner.db.get(`SELECT id FROM price_items WHERE code = 'Z386'`);
  res = await owner.post('/purchase-orders/add', { price_item_id: filter.id, job_id: jobId, qty: '2' });
  assert.equal(idFrom(res), poId);
  lines = await owner.db.all('SELECT * FROM purchase_order_lines WHERE order_id = $1 ORDER BY sort', [poId]);
  assert.equal(lines.length, 2);

  const page = await owner.get(`/purchase-orders/${poId}`);
  assert.match(page.text, /Mark as ordered/);
  assert.match(page.text, /mailto:penrith@burson.example/);

  res = await owner.post(`/purchase-orders/${poId}/send`);
  po = await owner.db.get('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
  assert.equal(po.status, 'ordered');
  assert.equal((await owner.db.get('SELECT status FROM jobs WHERE id = $1', [jobId])).status, 'waiting_parts');

  // Half the filters arrive first.
  const filterLine = lines.find((l) => l.code === 'Z386');
  const padsLine = lines.find((l) => l.code === 'DB1234');
  await owner.post(`/purchase-orders/${poId}/receive`, { [`received[l${padsLine.id}]`]: '1', [`received[l${filterLine.id}]`]: '1', add_to_job: '1', supplier_invoice: 'INV-778' });
  po = await owner.db.get('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
  assert.equal(po.status, 'part_received');
  assert.equal(po.supplier_invoice, 'INV-778');
  let jobLines = await owner.db.all('SELECT * FROM line_items WHERE job_id = $1 ORDER BY sort', [jobId]);
  assert.equal(jobLines.length, 3, 'the pads were already on the job; one filter is added');
  assert.equal(jobLines[2].description, 'Oil filter Ryco Z386 (Z386)');
  assert.equal(jobLines[2].unit_cents, 2500);
  assert.equal((await owner.db.get('SELECT status FROM jobs WHERE id = $1', [jobId])).status, 'waiting_parts');

  // Receiving more than is outstanding is capped.
  await owner.post(`/purchase-orders/${poId}/receive`, { [`received[l${filterLine.id}]`]: '5', add_to_job: '1' });
  po = await owner.db.get('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
  assert.equal(po.status, 'received');
  jobLines = await owner.db.all('SELECT * FROM line_items WHERE job_id = $1 ORDER BY sort', [jobId]);
  assert.equal(jobLines.length, 4);
  assert.equal(jobLines[3].qty, 1);
  assert.equal((await owner.db.get('SELECT status FROM jobs WHERE id = $1', [jobId])).status, 'in_progress');
  // Parts for a job don't go into stock.
  assert.equal((await owner.db.get(`SELECT stock_qty FROM price_items WHERE code = 'Z386'`)).stock_qty, 0);

  const events = await owner.db.all('SELECT text FROM job_events WHERE job_id = $1', [jobId]);
  assert.ok(events.some((e) => /Parts ordered from Burson Penrith/.test(e.text)));
  assert.ok(events.some((e) => /Parts received/.test(e.text)));

  // Received orders can't be edited, cancelled or deleted.
  await owner.post(`/purchase-orders/${poId}/delete`);
  assert.ok(await owner.db.get('SELECT id FROM purchase_orders WHERE id = $1', [poId]));

  // Another workshop can't see or touch it.
  assert.equal((await other.get(`/purchase-orders/${poId}`)).status, 404);
  assert.equal((await other.post(`/purchase-orders/${poId}/cancel`)).status, 404);
  assert.doesNotMatch((await other.get('/purchase-orders?show=all')).text, /Burson/);
});

test('stock orders: receiving adds stock, low stock makes reorder drafts', async () => {
  const supplier = await owner.db.get(`SELECT id FROM suppliers WHERE name = 'Burson Penrith'`);
  const filter = await owner.db.get(`SELECT * FROM price_items WHERE code = 'Z386'`);
  await owner.post(`/price-list/${filter.id}`, {
    kind: 'part', code: 'Z386', description: filter.description, price: '25', cost: '12', gst: '1', supplier_id: supplier.id, stock_qty: '1', reorder_level: '3',
  });
  assert.match((await owner.get('/parts')).text, /Low stock/);

  let res = await owner.post('/purchase-orders/reorder');
  const poId = idFrom(res);
  const line = await owner.db.get('SELECT * FROM purchase_order_lines WHERE order_id = $1', [poId]);
  assert.equal(line.qty, 5); // back up to twice the reorder level of 3
  assert.equal((await owner.db.get('SELECT reference FROM purchase_orders WHERE id = $1', [poId])).reference, 'STOCK');

  // Edit the draft: change qty and add a part by hand.
  await owner.post(`/purchase-orders/${poId}`, {
    supplier_id: supplier.id, reference: 'STOCK',
    'lines[0][item]': String(filter.id), 'lines[0][code]': 'Z386', 'lines[0][description]': filter.description, 'lines[0][qty]': '6', 'lines[0][cost]': '11.50', 'lines[0][sell]': '25', 'lines[0][gst]': '1',
    'lines[1][code]': 'wd40', 'lines[1][description]': 'WD-40 300g', 'lines[1][qty]': '2', 'lines[1][cost]': '6', 'lines[1][sell]': '', 'lines[1][gst]': '1',
    'lines[2][description]': '', 'lines[2][qty]': '1',
  });
  const lines = await owner.db.all('SELECT * FROM purchase_order_lines WHERE order_id = $1 ORDER BY sort', [poId]);
  assert.equal(lines.length, 2);
  await owner.post(`/purchase-orders/${poId}/send`);
  await owner.post(`/purchase-orders/${poId}/receive`, { [`received[l${lines[0].id}]`]: '6', [`received[l${lines[1].id}]`]: '2' });

  const after = await owner.db.get(`SELECT * FROM price_items WHERE code = 'Z386'`);
  assert.equal(after.stock_qty, 7);
  assert.equal(after.cost_cents, 1150, 'latest cost is kept');
  const wd = await owner.db.get(`SELECT * FROM price_items WHERE code = 'WD40'`);
  assert.equal(wd.stock_qty, 2, 'new parts go into the price list');
  assert.equal(wd.supplier_id, supplier.id);
  assert.doesNotMatch((await owner.get('/parts')).text, /Low stock/);
});

test('only the owner manages suppliers; staff can order', async () => {
  await owner.post('/staff', { name: 'Spanner Sam', email: 'sam@parts.example', role: 'staff', password: 'wheel-brace' });
  const staff = t.client();
  const res = await staff.post('/login', { email: 'sam@parts.example', password: 'wheel-brace' });
  staff.cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await staff.post('/suppliers', { name: 'Sneaky' })).status, 403);
  const supplier = await owner.db.get(`SELECT id FROM suppliers WHERE name = 'Burson Penrith'`);
  assert.equal((await staff.post(`/suppliers/${supplier.id}/import`, { csv: 'Description\nX' })).status, 403);
  assert.equal((await staff.post('/purchase-orders', { supplier_id: supplier.id })).status, 302);
});

test('a live connector: catalogue search, punch-out return and sending orders go through it', async () => {
  const sent = [];
  suppliers.register({
    key: 'testparts',
    name: 'Test Parts Online',
    live: true,
    fields: [{ key: 'account_no', label: 'Account' }],
    async search(ctx, { q, vehicle }) {
      return [{ code: 'LIVE1', description: `Live ${q} for ${vehicle ? vehicle.rego : 'any car'}`, cost_cents: 999, sell_cents: 1999, stock: 4 }];
    },
    async placeOrder(ctx, { order, lines }) {
      sent.push({ account: ctx.config.account_no, number: order.number, lines: lines.length });
      return { sent: true, reference: 'SUP-42', message: 'Sent to Test Parts.' };
    },
    punchoutUrl: (ctx, { returnUrl }) => `https://parts.example/catalogue?return=${encodeURIComponent(returnUrl)}`,
    parseReturn: (ctx, body) => JSON.parse(body.cart || '[]'),
  });
  const id = idFrom(await owner.post('/suppliers', { name: 'Test Parts', connector: 'testparts' }));
  await owner.post(`/suppliers/${id}`, { name: 'Test Parts', connector: 'testparts', 'config[account_no]': 'ACC9' });

  const found = await owner.get(`/parts?q=rotor&job_id=${jobId}`);
  assert.match(found.text, /Live rotor for PART01/);

  const out = await owner.get(`/suppliers/${id}/punchout?job_id=${jobId}`);
  assert.match(out.location, /^https:\/\/parts\.example\/catalogue\?return=.*punchout%2Freturn%3Fjob_id%3D/);

  const cart = JSON.stringify([{ code: 'r1', description: 'Rotor front', qty: 2, cost_cents: 4000, sell_cents: 8000 }]);
  const back = await owner.get(`/suppliers/${id}/punchout/return?job_id=${jobId}&cart=${encodeURIComponent(cart)}`);
  const poId = idFrom({ headers: { get: () => back.location } });
  const line = await owner.db.get('SELECT * FROM purchase_order_lines WHERE order_id = $1', [poId]);
  assert.equal(line.code, 'R1');
  assert.equal(line.qty, 2);

  assert.match((await owner.get(`/purchase-orders/${poId}`)).text, /Send order/);
  await owner.post(`/purchase-orders/${poId}/send`);
  assert.deepEqual(sent, [{ account: 'ACC9', number: (await owner.db.get('SELECT number FROM purchase_orders WHERE id = $1', [poId])).number, lines: 1 }]);
  assert.equal((await owner.db.get('SELECT supplier_ref FROM purchase_orders WHERE id = $1', [poId])).supplier_ref, 'SUP-42');

  // A manual supplier has no punch-out.
  const manual = await owner.db.get(`SELECT id FROM suppliers WHERE name = 'Burson Penrith'`);
  assert.match((await owner.get(`/suppliers/${manual.id}/punchout`)).location, /^\/parts\?/);
});

test('the new parts tables are under row-level security', async () => {
  const rows = await t.store.system.all(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('suppliers', 'purchase_orders', 'purchase_order_lines')`
  );
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
  // Reading as no workshop sees nothing.
  assert.equal((await t.store.system.get('SELECT COUNT(*) AS n FROM purchase_orders')).n, 0);
});
