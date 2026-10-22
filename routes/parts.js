const { parseDollars, parseIntOrNull, roundCents } = require('../lib/util');
const { nextNumber, getLines, saveLines } = require('../lib/db');
const { getVehicle, logEvent } = require('../lib/records');
const { requireOwner } = require('../lib/auth');
const { CONNECTORS, connectorFor, readConfig, configFrom, priceFileRows } = require('../lib/suppliers');

const PO_STATUSES = {
  draft: 'Draft',
  ordered: 'Ordered',
  part_received: 'Part received',
  received: 'Received',
  cancelled: 'Cancelled',
};

const poNumber = (po) => `PO-${po.number}`;

const PO_SELECT = `
  SELECT o.*, s.name AS supplier_name, s.email AS supplier_email, s.phone AS supplier_phone, s.account_no AS supplier_account,
    j.number AS job_number, j.status AS job_status, v.rego,
    (SELECT COALESCE(SUM(ROUND(l.qty * l.cost_cents)), 0) FROM purchase_order_lines l WHERE l.order_id = o.id) AS cost_cents,
    (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.order_id = o.id) AS line_count
  FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
  LEFT JOIN jobs j ON j.id = o.job_id
  LEFT JOIN vehicles v ON v.id = j.vehicle_id`;

const like = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
const qty = (v, fallback = 1) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : fallback;
};

function supplierFrom(body) {
  const g = (k, n = 200) => String(body[k] ?? '').trim().slice(0, n);
  return {
    name: g('name'),
    connector: CONNECTORS[g('connector')] ? g('connector') : 'manual',
    account_no: g('account_no', 60),
    phone: g('phone', 60),
    email: g('email'),
    notes: g('notes', 2000),
    active: body.active !== '0',
  };
}

// Order rows arrive as lines[0][description], lines[1][qty] ... like the job line editor.
function orderLinesFrom(body) {
  const raw = body && body.lines ? Object.values(body.lines) : [];
  return raw
    .map((r) => ({
      price_item_id: parseIntOrNull(r.item),
      code: String(r.code || '').trim().toUpperCase().slice(0, 30),
      description: String(r.description || '').trim().slice(0, 300),
      qty: qty(r.qty, 0),
      cost_cents: Math.max(parseDollars(r.cost), 0),
      sell_cents: Math.max(parseDollars(r.sell), 0),
      gst: r.gst !== '0',
      from_job: r.from_job === '1',
    }))
    .filter((l) => l.description && l.qty > 0);
}

function orderTotals(lines) {
  let subtotal = 0;
  let gst = 0;
  for (const l of lines) {
    const amount = roundCents(l.qty * l.cost_cents);
    subtotal += amount;
    if (l.gst) gst += roundCents(amount / 10);
  }
  return { subtotal, gst, total: subtotal + gst };
}

module.exports = function (app, { xero }) {
  const getSupplier = (db, id) => db.get('SELECT * FROM suppliers WHERE id = $1', [parseIntOrNull(id)]);
  const getOrder = (db, id) => db.get(`${PO_SELECT} WHERE o.id = $1`, [parseIntOrNull(id)]);
  const getOrderLines = (db, id) => db.all('SELECT * FROM purchase_order_lines WHERE order_id = $1 ORDER BY sort, id', [id]);
  const activeSuppliers = (db) => db.all('SELECT id, name, connector FROM suppliers WHERE active ORDER BY lower(name)');
  const getJob = async (db, id) => {
    const jobId = parseIntOrNull(id);
    return jobId ? db.get('SELECT id, number, status, vehicle_id, description FROM jobs WHERE id = $1', [jobId]) : null;
  };

  // Lines must point at this workshop's own price list items, or at none.
  async function checkItems(db, lines) {
    for (const l of lines) {
      if (l.price_item_id && !(await db.get('SELECT id FROM price_items WHERE id = $1', [l.price_item_id]))) l.price_item_id = null;
    }
    return lines;
  }

  async function saveOrderLines(db, orderId, lines) {
    await db.run('DELETE FROM purchase_order_lines WHERE order_id = $1', [orderId]);
    for (const [i, l] of lines.entries()) {
      await db.run(
        `INSERT INTO purchase_order_lines (order_id, price_item_id, code, description, qty, received_qty, cost_cents, sell_cents, gst, from_job, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [orderId, l.price_item_id || null, l.code, l.description, l.qty, l.received_qty || 0, l.cost_cents, l.sell_cents, l.gst, Boolean(l.from_job), i]
      );
    }
  }

  async function createOrder(db, req, supplierId, jobId, lines) {
    const o = await db.get(
      `INSERT INTO purchase_orders (number, supplier_id, job_id, reference, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, number`,
      [await nextNumber(db, 'po'), supplierId, jobId, '', req.user.id]
    );
    if (jobId) {
      const job = await db.get('SELECT number FROM jobs WHERE id = $1', [jobId]);
      await db.run('UPDATE purchase_orders SET reference = $1 WHERE id = $2', [`J${job.number}`, o.id]);
    }
    await saveOrderLines(db, o.id, lines);
    return o;
  }

  // ---- Suppliers ----

  app.get('/suppliers', async (req, res) => {
    const suppliers = await req.db.all(
      `SELECT s.*,
         (SELECT COUNT(*) FROM price_items p WHERE p.supplier_id = s.id) AS parts,
         (SELECT COUNT(*) FROM purchase_orders o WHERE o.supplier_id = s.id AND o.status IN ('ordered', 'part_received')) AS on_order
       FROM suppliers s ORDER BY s.active DESC, lower(s.name)`
    );
    res.render('parts/suppliers', { suppliers, CONNECTORS, error: null, draft: { connector: 'manual' }, saved: req.query.saved === '1' });
  });

  app.post('/suppliers', requireOwner, async (req, res) => {
    const s = supplierFrom(req.body);
    if (!s.name) {
      const suppliers = await req.db.all('SELECT *, 0 AS parts, 0 AS on_order FROM suppliers ORDER BY active DESC, lower(name)');
      return res.status(400).render('parts/suppliers', { suppliers, CONNECTORS, error: 'Give the supplier a name.', draft: s, saved: false });
    }
    const row = await req.db.get(
      `INSERT INTO suppliers (name, connector, account_no, phone, email, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [s.name, s.connector, s.account_no, s.phone, s.email, s.notes]
    );
    res.redirect(`/suppliers/${row.id}`);
  });

  app.get('/suppliers/:id', async (req, res, next) => {
    const supplier = await getSupplier(req.db, req.params.id);
    if (!supplier) return next();
    const [orders, parts] = await Promise.all([
      req.db.all(`${PO_SELECT} WHERE o.supplier_id = $1 ORDER BY o.created_at DESC LIMIT 50`, [supplier.id]),
      req.db.get('SELECT COUNT(*) AS n FROM price_items WHERE supplier_id = $1', [supplier.id]),
    ]);
    res.render('parts/supplier', {
      supplier,
      config: readConfig(supplier),
      connector: connectorFor(supplier),
      CONNECTORS,
      orders,
      partCount: parts.n,
      PO_STATUSES,
      notice: String(req.query.notice || '').slice(0, 300),
      error: String(req.query.error || '').slice(0, 300),
    });
  });

  app.post('/suppliers/:id', requireOwner, async (req, res, next) => {
    const supplier = await getSupplier(req.db, req.params.id);
    if (!supplier) return next();
    const s = supplierFrom(req.body);
    if (!s.name) return res.redirect(`/suppliers/${supplier.id}?error=${encodeURIComponent('Give the supplier a name.')}`);
    // Login details only change when the connector's own fields were on the form.
    const config = s.connector === supplier.connector ? configFrom(CONNECTORS[s.connector], req.body, readConfig(supplier)) : {};
    await req.db.run(
      `UPDATE suppliers SET name = $1, connector = $2, account_no = $3, phone = $4, email = $5, notes = $6, active = $7, config = $8 WHERE id = $9`,
      [s.name, s.connector, s.account_no, s.phone, s.email, s.notes, s.active, JSON.stringify(config), supplier.id]
    );
    res.redirect(`/suppliers/${supplier.id}?notice=Saved.`);
  });

  // A supplier's price file (CSV) goes into the price list, matched on part code.
  app.post('/suppliers/:id/import', requireOwner, async (req, res, next) => {
    const supplier = await getSupplier(req.db, req.params.id);
    if (!supplier) return next();
    const { items, error } = priceFileRows(req.body.csv, { incGst: req.body.inc_gst === '1' });
    if (error) return res.redirect(`/suppliers/${supplier.id}?error=${encodeURIComponent(error)}`);
    const markup = Math.min(Math.max(parseFloat(req.body.markup) || 0, 0), 1000);
    let added = 0;
    let updated = 0;
    await req.db.tx(async (db) => {
      for (const i of items) {
        const sell = i.sell_cents || roundCents(i.cost_cents * (1 + markup / 100));
        const existing = i.code
          ? await db.get('SELECT id FROM price_items WHERE supplier_id = $1 AND code = $2', [supplier.id, i.code])
          : await db.get('SELECT id FROM price_items WHERE supplier_id = $1 AND lower(description) = lower($2)', [supplier.id, i.description]);
        if (existing) {
          await db.run('UPDATE price_items SET description = $1, cost_cents = $2, unit_cents = $3 WHERE id = $4', [i.description, i.cost_cents, sell, existing.id]);
          updated++;
        } else {
          await db.run(
            `INSERT INTO price_items (kind, code, description, unit_cents, cost_cents, supplier_id) VALUES ('part', $1, $2, $3, $4, $5)`,
            [i.code, i.description, sell, i.cost_cents, supplier.id]
          );
          added++;
        }
      }
    });
    res.redirect(`/suppliers/${supplier.id}?notice=${encodeURIComponent(`Price file imported: ${added} new, ${updated} updated.`)}`);
  });

  app.post('/suppliers/:id/delete', requireOwner, async (req, res, next) => {
    const supplier = await getSupplier(req.db, req.params.id);
    if (!supplier) return next();
    // Suppliers with orders are kept for the history, just hidden.
    const used = await req.db.get('SELECT id FROM purchase_orders WHERE supplier_id = $1 LIMIT 1', [supplier.id]);
    if (used) await req.db.run('UPDATE suppliers SET active = false WHERE id = $1', [supplier.id]);
    else await req.db.run('DELETE FROM suppliers WHERE id = $1', [supplier.id]);
    res.redirect('/suppliers');
  });

  // Opens the supplier's own catalogue for this car, when its connector has one.
  app.get('/suppliers/:id/punchout', async (req, res, next) => {
    const supplier = await getSupplier(req.db, req.params.id);
    if (!supplier) return next();
    const job = await getJob(req.db, req.query.job_id);
    const connector = connectorFor(supplier);
    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const url = await connector.punchoutUrl(
      { db: req.db, supplier, config: readConfig(supplier) },
      {
        job,
        vehicle: job && job.vehicle_id ? await getVehicle(req.db, job.vehicle_id) : null,
        returnUrl: `${base}/suppliers/${supplier.id}/punchout/return${job ? `?job_id=${job.id}` : ''}`,
      }
    );
    if (!url) return res.redirect(`/parts?job_id=${job ? job.id : ''}&notice=${encodeURIComponent(`${supplier.name} can't be searched online yet.`)}`);
    res.redirect(url);
  });

  // Parts sent back from the supplier's catalogue become a draft order.
  // (A GET back keeps the login cookie; a cross-site POST needs the connector to carry its own token.)
  app.all('/suppliers/:id/punchout/return', async (req, res, next) => {
    if (!['GET', 'POST'].includes(req.method)) return next();
    const supplier = await getSupplier(req.db, req.params.id);
    if (!supplier) return next();
    const job = await getJob(req.db, req.query.job_id);
    const parts = await connectorFor(supplier).parseReturn({ db: req.db, supplier, config: readConfig(supplier) }, { ...req.query, ...req.body });
    const lines = parts
      .map((p) => ({ code: String(p.code || '').toUpperCase().slice(0, 30), description: String(p.description || '').slice(0, 300), qty: qty(p.qty), cost_cents: p.cost_cents || 0, sell_cents: p.sell_cents || 0, gst: p.gst !== false }))
      .filter((l) => l.description);
    if (!lines.length) return res.redirect(`/parts?job_id=${job ? job.id : ''}&notice=${encodeURIComponent('Nothing came back from the supplier.')}`);
    const order = await req.db.tx(async (db) => {
      const o = await createOrder(db, req, supplier.id, job ? job.id : null, lines);
      if (job) await logEvent(db, job.id, req.user.id, 'parts', `${lines.length} part${lines.length === 1 ? '' : 's'} picked from ${supplier.name} on PO-${o.number}`);
      return o;
    });
    res.redirect(`/purchase-orders/${order.id}`);
  });

  // ---- Parts catalogue ----

  app.get('/parts', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const supplierId = parseIntOrNull(req.query.supplier);
    const job = await getJob(req.db, req.query.job_id);
    const suppliers = await activeSuppliers(req.db);
    const items = q
      ? await req.db.all(
          `SELECT p.*, s.name AS supplier_name FROM price_items p LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE p.active AND p.kind = 'part' AND (p.description ILIKE $1 OR p.code ILIKE $1) AND ($2::integer IS NULL OR p.supplier_id = $2)
           ORDER BY (p.code ILIKE $1) DESC, lower(p.description) LIMIT 100`,
          [like(q), supplierId]
        )
      : [];
    // Suppliers whose connector can search their live catalogue.
    const live = [];
    const problems = [];
    if (q) {
      const vehicle = job && job.vehicle_id ? await getVehicle(req.db, job.vehicle_id) : null;
      for (const s of suppliers) {
        const connector = connectorFor(s);
        if (!connector.live || !connector.search || (supplierId && supplierId !== s.id)) continue;
        try {
          const full = await getSupplier(req.db, s.id);
          for (const r of await connector.search({ db: req.db, supplier: full, config: readConfig(full) }, { q, vehicle })) {
            live.push({ ...r, supplier_id: s.id, supplier_name: s.name });
          }
        } catch (err) {
          problems.push(`${s.name}: ${err.message}`);
        }
      }
    }
    const low = await req.db.all(
      `SELECT p.*, s.name AS supplier_name FROM price_items p LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.active AND p.reorder_level > 0 AND p.stock_qty <= p.reorder_level ORDER BY lower(p.description) LIMIT 200`
    );
    res.render('parts/catalogue', {
      q, supplierId, job, suppliers, items, live, problems, low,
      notice: String(req.query.notice || '').slice(0, 300),
    });
  });

  // ---- Purchase orders ----

  app.get('/purchase-orders', async (req, res) => {
    const show = ['open', 'received', 'all'].includes(req.query.show) ? req.query.show : 'open';
    const where = show === 'open' ? `o.status IN ('draft', 'ordered', 'part_received')` : show === 'received' ? `o.status = 'received'` : 'true';
    const orders = await req.db.all(`${PO_SELECT} WHERE ${where} ORDER BY o.created_at DESC LIMIT 500`);
    res.render('parts/orders', { orders, show, PO_STATUSES, suppliers: await activeSuppliers(req.db) });
  });

  // A new order: blank, or from parts already on a job card.
  app.post('/purchase-orders', async (req, res) => {
    const supplier = await getSupplier(req.db, req.body.supplier_id);
    if (!supplier) return res.redirect('/suppliers');
    const job = await getJob(req.db, req.body.job_id);
    const picked = new Set([].concat(req.body.job_lines || []).map(String));
    const order = await req.db.tx(async (db) => {
      const lines = [];
      if (job) {
        for (const [i, l] of (await getLines(db, 'job', job.id)).entries()) {
          if (!picked.has(String(i)) || l.kind !== 'part') continue;
          // The price list knows the part's code and what it costs.
          const item = await db.get(
            `SELECT * FROM price_items WHERE lower(description) = lower($1) ORDER BY (supplier_id = $2) DESC NULLS LAST LIMIT 1`,
            [l.description, supplier.id]
          );
          lines.push({
            price_item_id: item ? item.id : null,
            code: item ? item.code : '',
            description: l.description,
            qty: l.qty,
            cost_cents: item ? item.cost_cents : 0,
            sell_cents: l.unit_cents,
            gst: l.gst,
            from_job: true,
          });
        }
      }
      const o = await createOrder(db, req, supplier.id, job ? job.id : null, lines);
      if (job) await logEvent(db, job.id, req.user.id, 'parts', `Parts order PO-${o.number} started with ${supplier.name}`);
      return o;
    });
    res.redirect(`/purchase-orders/${order.id}`);
  });

  // "Order" from the catalogue: onto this supplier's draft for the same job, or a new one.
  app.post('/purchase-orders/add', async (req, res) => {
    const item = await req.db.get('SELECT * FROM price_items WHERE id = $1', [parseIntOrNull(req.body.price_item_id)]);
    const supplier = await getSupplier(req.db, req.body.supplier_id || (item && item.supplier_id));
    if (!supplier) return res.redirect(`/parts?notice=${encodeURIComponent('Pick a supplier for that part first.')}`);
    const job = await getJob(req.db, req.body.job_id);
    const line = item
      ? { price_item_id: item.id, code: item.code, description: item.description, cost_cents: item.cost_cents, sell_cents: item.unit_cents, gst: item.gst }
      : {
          code: String(req.body.code || '').trim().toUpperCase().slice(0, 30),
          description: String(req.body.description || '').trim().slice(0, 300),
          cost_cents: Math.max(parseInt(req.body.cost_cents, 10) || 0, 0),
          sell_cents: Math.max(parseInt(req.body.sell_cents, 10) || 0, 0),
          gst: req.body.gst !== '0',
        };
    if (!line.description) return res.redirect('/parts');
    line.qty = qty(req.body.qty);
    const order = await req.db.tx(async (db) => {
      const draft = await db.get(
        `SELECT id, number FROM purchase_orders WHERE status = 'draft' AND supplier_id = $1 AND job_id IS NOT DISTINCT FROM $2 ORDER BY id DESC LIMIT 1`,
        [supplier.id, job ? job.id : null]
      );
      if (!draft) return createOrder(db, req, supplier.id, job ? job.id : null, [line]);
      const lines = await getOrderLines(db, draft.id);
      lines.push(line);
      await saveOrderLines(db, draft.id, lines);
      return draft;
    });
    res.redirect(`/purchase-orders/${order.id}`);
  });

  // Low stock: one draft per supplier, enough to bring stock back to twice the reorder level.
  app.post('/purchase-orders/reorder', async (req, res) => {
    const low = await req.db.all(
      `SELECT * FROM price_items WHERE active AND supplier_id IS NOT NULL AND reorder_level > 0 AND stock_qty <= reorder_level ORDER BY supplier_id, lower(description)`
    );
    if (!low.length) return res.redirect(`/parts?notice=${encodeURIComponent('Nothing is below its reorder level with a supplier set.')}`);
    const made = await req.db.tx(async (db) => {
      const out = [];
      for (const supplierId of [...new Set(low.map((i) => i.supplier_id))]) {
        const lines = low
          .filter((i) => i.supplier_id === supplierId)
          .map((i) => ({
            price_item_id: i.id, code: i.code, description: i.description, gst: i.gst,
            qty: Math.max(1, Math.ceil(i.reorder_level * 2 - i.stock_qty)), cost_cents: i.cost_cents, sell_cents: i.unit_cents,
          }));
        const o = await createOrder(db, req, supplierId, null, lines);
        await db.run(`UPDATE purchase_orders SET reference = 'STOCK' WHERE id = $1`, [o.id]);
        out.push(o);
      }
      return out;
    });
    res.redirect(made.length === 1 ? `/purchase-orders/${made[0].id}` : '/purchase-orders');
  });

  app.get('/purchase-orders/:id', async (req, res, next) => {
    const order = await getOrder(req.db, req.params.id);
    if (!order) return next();
    const lines = await getOrderLines(req.db, order.id);
    const supplier = await getSupplier(req.db, order.supplier_id);
    res.render('parts/order', {
      order,
      lines,
      totals: orderTotals(lines),
      supplier,
      xeroBill: order.status === 'received' && (await xero.isConnected(req.db)) ? (await xero.billStatus(req.db, order.id)) || { status: 'not sent' } : null,
      connector: connectorFor(supplier),
      suppliers: await activeSuppliers(req.db),
      PO_STATUSES,
      poNumber,
      notice: String(req.query.notice || '').slice(0, 300),
    });
  });

  app.get('/purchase-orders/:id/print', async (req, res, next) => {
    const order = await getOrder(req.db, req.params.id);
    if (!order) return next();
    const lines = await getOrderLines(req.db, order.id);
    res.render('parts/print', { order, lines, totals: orderTotals(lines), poNumber, PO_STATUSES });
  });

  // Only a draft can be edited.
  app.post('/purchase-orders/:id', async (req, res, next) => {
    const order = await getOrder(req.db, req.params.id);
    if (!order) return next();
    if (order.status !== 'draft') return res.redirect(`/purchase-orders/${order.id}`);
    const supplier = (await getSupplier(req.db, req.body.supplier_id)) || { id: order.supplier_id };
    const lines = await checkItems(req.db, orderLinesFrom(req.body));
    await req.db.tx(async (db) => {
      await db.run('UPDATE purchase_orders SET supplier_id = $1, reference = $2, notes = $3 WHERE id = $4', [
        supplier.id,
        String(req.body.reference || '').trim().slice(0, 100),
        String(req.body.notes || '').trim().slice(0, 2000),
        order.id,
      ]);
      await saveOrderLines(db, order.id, lines);
    });
    res.redirect(`/purchase-orders/${order.id}?notice=Saved.`);
  });

  // Sends the order through the supplier's connector (or marks it ordered by hand).
  app.post('/purchase-orders/:id/send', async (req, res, next) => {
    const order = await getOrder(req.db, req.params.id);
    if (!order) return next();
    if (order.status !== 'draft') return res.redirect(`/purchase-orders/${order.id}`);
    const lines = await getOrderLines(req.db, order.id);
    if (!lines.length) return res.redirect(`/purchase-orders/${order.id}?notice=${encodeURIComponent('Add a part to the order first.')}`);
    const supplier = await getSupplier(req.db, order.supplier_id);
    const job = await getJob(req.db, order.job_id);
    let result;
    try {
      result = await connectorFor(supplier).placeOrder(
        { db: req.db, supplier, config: readConfig(supplier) },
        { order, lines, job, vehicle: job && job.vehicle_id ? await getVehicle(req.db, job.vehicle_id) : null }
      );
    } catch (err) {
      return res.redirect(`/purchase-orders/${order.id}?notice=${encodeURIComponent(`${supplier.name} didn't take the order: ${err.message}`)}`);
    }
    await req.db.tx(async (db) => {
      await db.run(`UPDATE purchase_orders SET status = 'ordered', ordered_at = now(), supplier_ref = $1 WHERE id = $2`, [
        String(result.reference || '').slice(0, 100),
        order.id,
      ]);
      if (job) {
        await logEvent(db, job.id, req.user.id, 'parts', `Parts ordered from ${supplier.name} on PO-${order.number}${result.sent ? ' (sent online)' : ''}`);
        if (['open', 'in_progress'].includes(job.status)) {
          await db.run(`UPDATE jobs SET status = 'waiting_parts' WHERE id = $1`, [job.id]);
          await logEvent(db, job.id, req.user.id, 'status', 'Status changed to Waiting on parts');
        }
      }
    });
    res.redirect(`/purchase-orders/${order.id}?notice=${encodeURIComponent(result.message || 'Ordered.')}`);
  });

  // Parts arriving: stock goes up, or the parts go onto the job they were ordered for.
  app.post('/purchase-orders/:id/receive', async (req, res, next) => {
    const order = await getOrder(req.db, req.params.id);
    if (!order) return next();
    if (!['ordered', 'part_received'].includes(order.status)) return res.redirect(`/purchase-orders/${order.id}`);
    const got = req.body.received && typeof req.body.received === 'object' ? req.body.received : {};
    const toJob = Boolean(order.job_id) && req.body.add_to_job === '1';
    const status = await req.db.tx(async (db) => {
      const lines = await db.all('SELECT * FROM purchase_order_lines WHERE order_id = $1 ORDER BY sort, id FOR UPDATE', [order.id]);
      const jobLines = [];
      let count = 0;
      for (const l of lines) {
        const n = Math.min(Math.max(parseFloat(got[`l${l.id}`]) || 0, 0), l.qty - l.received_qty);
        if (n <= 0) continue;
        count++;
        // Every received part ends up in the price list with its latest cost.
        let itemId = l.price_item_id;
        if (!itemId) {
          const found = l.code
            ? await db.get('SELECT id FROM price_items WHERE code = $1 ORDER BY (supplier_id = $2) DESC NULLS LAST LIMIT 1', [l.code, order.supplier_id])
            : await db.get('SELECT id FROM price_items WHERE lower(description) = lower($1) ORDER BY (supplier_id = $2) DESC NULLS LAST LIMIT 1', [l.description, order.supplier_id]);
          itemId = found
            ? found.id
            : (await db.get(
                `INSERT INTO price_items (kind, code, description, unit_cents, cost_cents, gst, supplier_id) VALUES ('part', $1, $2, $3, $4, $5, $6) RETURNING id`,
                [l.code, l.description, l.sell_cents, l.cost_cents, l.gst, order.supplier_id]
              )).id;
        }
        const intoStock = !l.from_job && !toJob;
        await db.run(
          `UPDATE price_items SET stock_qty = stock_qty + $1, cost_cents = CASE WHEN $2 > 0 THEN $2 ELSE cost_cents END,
             supplier_id = COALESCE(supplier_id, $3) WHERE id = $4`,
          [intoStock ? n : 0, l.cost_cents, order.supplier_id, itemId]
        );
        await db.run('UPDATE purchase_order_lines SET received_qty = received_qty + $1, price_item_id = $2 WHERE id = $3', [n, itemId, l.id]);
        if (toJob && !l.from_job) {
          jobLines.push({ kind: 'part', description: l.code ? `${l.description} (${l.code})` : l.description, qty: n, unit_cents: l.sell_cents || l.cost_cents, gst: l.gst });
        }
      }
      if (!count) return null;
      const left = await db.get('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE order_id = $1 AND received_qty < qty', [order.id]);
      const next = left.n ? 'part_received' : 'received';
      await db.run(
        `UPDATE purchase_orders SET status = $1, received_at = CASE WHEN $1 = 'received' THEN now() ELSE received_at END,
           supplier_invoice = CASE WHEN $2 <> '' THEN $2 ELSE supplier_invoice END WHERE id = $3`,
        [next, String(req.body.supplier_invoice || '').trim().slice(0, 100), order.id]
      );
      if (order.job_id) {
        const job = await db.get('SELECT id, status FROM jobs WHERE id = $1 FOR UPDATE', [order.job_id]);
        if (jobLines.length && job.status !== 'invoiced') {
          await saveLines(db, 'job', job.id, [...(await getLines(db, 'job', job.id)), ...jobLines]);
        }
        await logEvent(db, job.id, req.user.id, 'parts', `Parts received on PO-${order.number}${next === 'received' ? '' : ' (some still to come)'}`);
        // Last order in for a job waiting on parts: back to work.
        const waiting = await db.get(`SELECT COUNT(*) AS n FROM purchase_orders WHERE job_id = $1 AND status IN ('ordered', 'part_received')`, [job.id]);
        if (job.status === 'waiting_parts' && !waiting.n) {
          await db.run(`UPDATE jobs SET status = 'in_progress' WHERE id = $1`, [job.id]);
          await logEvent(db, job.id, req.user.id, 'status', 'Status changed to In progress');
        }
      }
      return next;
    });
    if (status === 'received') await xero.queueBill(req.db, order.id);
    const msg = status ? (status === 'received' ? 'All parts received.' : 'Received. Some parts are still to come.') : 'Nothing was ticked as received.';
    res.redirect(`/purchase-orders/${order.id}?notice=${encodeURIComponent(msg)}`);
  });

  app.post('/purchase-orders/:id/cancel', async (req, res, next) => {
    const order = await getOrder(req.db, req.params.id);
    if (!order) return next();
    if (!['draft', 'ordered'].includes(order.status)) return res.redirect(`/purchase-orders/${order.id}`);
    await req.db.tx(async (db) => {
      await db.run(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      if (order.job_id) await logEvent(db, order.job_id, req.user.id, 'parts', `Parts order PO-${order.number} cancelled`);
    });
    res.redirect(`/purchase-orders/${order.id}`);
  });

  app.post('/purchase-orders/:id/delete', async (req, res, next) => {
    const order = await getOrder(req.db, req.params.id);
    if (!order) return next();
    if (!['draft', 'cancelled'].includes(order.status)) return res.redirect(`/purchase-orders/${order.id}`);
    await req.db.run('DELETE FROM purchase_orders WHERE id = $1', [order.id]);
    res.redirect(order.job_id ? `/jobs/${order.job_id}#parts` : '/purchase-orders');
  });
};

module.exports.PO_STATUSES = PO_STATUSES;
module.exports.orderTotals = orderTotals;
