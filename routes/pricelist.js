const { parseDollars, parseIntOrNull, LINE_KINDS } = require('../lib/util');
const { CAR_ITEMS, addStarterItems } = require('../lib/verticals');

// A starter list so a new workshop can pick common items straight away (the car workshop's).
const STARTER_ITEMS = CAR_ITEMS;

function itemFrom(body) {
  const g = (k) => String(body[k] ?? '').trim();
  return {
    kind: LINE_KINDS.includes(g('kind')) ? g('kind') : 'part',
    code: g('code').toUpperCase().slice(0, 30),
    description: g('description').slice(0, 300),
    unit_cents: Math.max(parseDollars(body.price), 0),
    cost_cents: Math.max(parseDollars(body.cost), 0),
    gst: body.gst !== '0',
    active: body.active !== '0',
  };
}

module.exports = function (app) {
  app.get('/price-list', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const items = await req.db.all(
      `SELECT * FROM price_items WHERE ($1 = '' OR description ILIKE $2 OR code ILIKE $2)
       ORDER BY active DESC, kind, lower(description) LIMIT 1000`,
      [q, like]
    );
    res.render('pricelist/index', { items, q, saved: req.query.saved === '1', error: null, draft: { kind: 'part', gst: true } });
  });

  // Used by the line editor's picker.
  app.get('/price-list.json', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const items = await req.db.all(
      `SELECT id, kind, code, description, unit_cents, gst FROM price_items
       WHERE active AND ($1 = '' OR description ILIKE $2 OR code ILIKE $2)
       ORDER BY (code ILIKE $2) DESC, lower(description) LIMIT 25`,
      [q, like]
    );
    const settings = await req.db.get('SELECT labour_rate_cents FROM settings');
    // Labour items with no price use the workshop's hourly rate.
    for (const i of items) if (i.kind === 'labour' && !i.unit_cents) i.unit_cents = settings.labour_rate_cents;
    res.json(items);
  });

  app.post('/price-list', async (req, res) => {
    const item = itemFrom(req.body);
    if (!item.description) {
      const items = await req.db.all('SELECT * FROM price_items ORDER BY active DESC, kind, lower(description) LIMIT 1000');
      return res.status(400).render('pricelist/index', { items, q: '', saved: false, error: 'Give the item a description.', draft: item });
    }
    await req.db.run(
      `INSERT INTO price_items (kind, code, description, unit_cents, cost_cents, gst) VALUES ($1, $2, $3, $4, $5, $6)`,
      [item.kind, item.code, item.description, item.unit_cents, item.cost_cents, item.gst]
    );
    res.redirect('/price-list?saved=1');
  });

  app.post('/price-list/starter', async (req, res) => {
    await req.db.tx((db) => addStarterItems(db, res.locals.settings.workshop_type));
    res.redirect('/price-list?saved=1');
  });

  app.get('/price-list/:id/edit', async (req, res, next) => {
    const item = await req.db.get('SELECT * FROM price_items WHERE id = $1', [req.params.id]);
    if (!item) return next();
    res.render('pricelist/form', { item, error: null });
  });

  app.post('/price-list/:id', async (req, res, next) => {
    const existing = await req.db.get('SELECT id FROM price_items WHERE id = $1', [req.params.id]);
    if (!existing) return next();
    const item = itemFrom(req.body);
    if (!item.description) return res.status(400).render('pricelist/form', { item: { ...item, id: existing.id }, error: 'Give the item a description.' });
    await req.db.run(
      `UPDATE price_items SET kind = $1, code = $2, description = $3, unit_cents = $4, cost_cents = $5, gst = $6, active = $7 WHERE id = $8`,
      [item.kind, item.code, item.description, item.unit_cents, item.cost_cents, item.gst, item.active, existing.id]
    );
    res.redirect('/price-list?saved=1');
  });

  app.post('/price-list/:id/delete', async (req, res) => {
    await req.db.run('DELETE FROM price_items WHERE id = $1', [parseIntOrNull(req.params.id)]);
    res.redirect('/price-list');
  });
};

module.exports.STARTER_ITEMS = STARTER_ITEMS;
