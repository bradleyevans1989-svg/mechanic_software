const { requireOwner, limiter } = require('../lib/auth');
const { today, addDays, now, fmtDate } = require('../lib/util');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DROP_OFFS = {
  early: 'First thing (before 9am)',
  morning: 'During the morning',
  afternoon: 'After lunch',
  wait: "I'd like to wait while it's done",
};
const DEFAULT_SERVICES = `Logbook service
General service
Brakes
Tyres and wheel alignment
Air conditioning
Roadworthy / safety certificate
Something else (tell us below)`;
const AHEAD_DAYS = 42;

function slugFrom(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'workshop'
  );
}

const services = (settings) => (settings.booking_services || DEFAULT_SERVICES).split('\n').map((s) => s.trim()).filter(Boolean);
const dayOfWeek = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const dateLabel = (iso) => `${DAY_NAMES[dayOfWeek(iso)]} ${fmtDate(iso)}`;
const digits = (s) => String(s || '').replace(/\D/g, '');

// Days a customer can pick: open days after the notice period that aren't full.
async function openDates(db, settings) {
  const from = addDays(today(settings.timezone), Math.max(settings.booking_notice_days, 0));
  const until = addDays(from, AHEAD_DAYS);
  const counts = {};
  if (settings.booking_max_per_day > 0) {
    const rows = await db.all(
      `SELECT date, COUNT(*)::int AS n FROM (
         SELECT date FROM bookings WHERE date BETWEEN $1 AND $2 AND status != 'cancelled'
         UNION ALL SELECT date FROM booking_requests WHERE date BETWEEN $1 AND $2 AND status = 'pending'
       ) x GROUP BY date`,
      [from, until]
    );
    for (const r of rows) counts[r.date] = r.n;
  }
  const out = [];
  for (let d = from; d <= until; d = addDays(d, 1)) {
    if (!String(settings.booking_days).includes(String(dayOfWeek(d)))) continue;
    if (settings.booking_max_per_day > 0 && (counts[d] || 0) >= settings.booking_max_per_day) continue;
    out.push({ value: d, label: dateLabel(d) });
  }
  return out;
}

// The page's address for a workshop, made from its name the first time it's asked for.
async function pageSlug(store, workshopId, businessName) {
  const row = await store.system.get('SELECT slug FROM booking_pages WHERE workshop_id = $1', [workshopId]);
  if (row) return row.slug;
  const base = slugFrom(businessName);
  for (let i = 0; i < 50; i++) {
    const slug = i ? `${base.slice(0, 36)}-${i + 1}` : base;
    const ins = await store.system.get(
      'INSERT INTO booking_pages (slug, workshop_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING slug',
      [slug, workshopId]
    );
    if (ins) return ins.slug;
    const again = await store.system.get('SELECT slug FROM booking_pages WHERE workshop_id = $1', [workshopId]);
    if (again) return again.slug;
  }
  throw new Error('Could not make a booking page address.');
}

module.exports = {
  slugFrom,

  // The customer side: no login, the address names the workshop.
  public(app, { store }) {
    const submitLimit = limiter(8);

    async function load(req) {
      const slug = String(req.params.slug || '').toLowerCase();
      if (!SLUG_RE.test(slug)) return null;
      const page = await store.system.get(
        `SELECT p.workshop_id FROM booking_pages p JOIN workshops w ON w.id = p.workshop_id WHERE p.slug = $1 AND w.status != 'closed'`,
        [slug]
      );
      if (!page) return null;
      const db = store.tenant(page.workshop_id);
      const settings = await db.get('SELECT * FROM settings');
      if (!settings || !settings.online_booking) return null;
      return { db, settings, slug, hasLogo: Boolean(await db.get('SELECT 1 AS x FROM logos')) };
    }

    const gone = (res) =>
      res.status(404).render('message', { title: 'Booking page not found', message: 'This workshop is not taking online bookings at the moment. Please give them a call.' });

    async function renderForm(res, found, form, error) {
      res.locals.settings = found.settings;
      res.render('online-booking/form', {
        ...found,
        form,
        error,
        dates: await openDates(found.db, found.settings),
        services: services(found.settings),
        DROP_OFFS,
      });
    }

    app.get('/book/:slug', async (req, res) => {
      const found = await load(req);
      if (!found) return gone(res);
      renderForm(res, found, {}, null);
    });

    app.get('/book/:slug/logo', async (req, res) => {
      const found = await load(req);
      if (!found) return res.status(404).end();
      await require('./templates').serveSharedLogo(found.db, res);
    });

    app.post('/book/:slug', async (req, res) => {
      const found = await load(req);
      if (!found) return gone(res);
      const g = (k, max = 200) => String(req.body[k] ?? '').trim().slice(0, max);
      const form = {
        name: g('name', 120),
        phone: g('phone', 40),
        email: g('email', 200),
        rego: g('rego', 12).toUpperCase().replace(/\s+/g, ''),
        car: g('car', 120),
        service: g('service', 120),
        date: g('date', 10),
        drop_off: DROP_OFFS[req.body.drop_off] ? req.body.drop_off : '',
        notes: g('notes', 2000),
      };
      // A hidden field people can't see; bots fill it in.
      if (g('website')) return res.redirect(`/book/${found.slug}/thanks`);
      if (submitLimit.blocked(req.ip)) return renderForm(res.status(429), found, form, 'Too many requests. Please call the workshop instead.');
      const dates = await openDates(found.db, found.settings);
      let error = null;
      if (!form.name) error = 'Please enter your name.';
      else if (digits(form.phone).length < 8) error = 'Please enter a phone number we can call you on.';
      else if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) error = 'That email address does not look right.';
      else if (!form.rego && !form.car) error = 'Please tell us the rego or the make and model.';
      else if (!dates.some((d) => d.value === form.date)) error = 'Please pick one of the days shown.';
      if (error) return renderForm(res.status(400), found, form, error);
      submitLimit.hit(req.ip);
      await found.db.run(
        `INSERT INTO booking_requests (name, phone, email, rego, car, service, date, drop_off, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [form.name, form.phone, form.email, form.rego, form.car, form.service, form.date, form.drop_off, form.notes]
      );
      res.redirect(`/book/${found.slug}/thanks?date=${form.date}`);
    });

    app.get('/book/:slug/thanks', async (req, res) => {
      const found = await load(req);
      if (!found) return gone(res);
      res.locals.settings = found.settings;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
      res.render('online-booking/thanks', { ...found, date: date ? dateLabel(date) : null });
    });
  },

  // The workshop side: requests to accept or decline, and the page settings.
  pages(app, { store }) {
    app.get('/bookings/requests', async (req, res) => {
      const [pending, handled] = await Promise.all([
        req.db.all(`SELECT * FROM booking_requests WHERE status = 'pending' ORDER BY date, created_at`),
        req.db.all(
          `SELECT r.*, u.name AS handled_by_name FROM booking_requests r LEFT JOIN users u ON u.id = r.handled_by
           WHERE r.status != 'pending' ORDER BY r.handled_at DESC LIMIT 20`
        ),
      ]);
      // Who each request probably is: a car with that rego, or a customer with that phone number.
      for (const r of pending) {
        r.vehicle = r.rego
          ? await req.db.get(
              `SELECT v.*, c.name AS customer_name FROM vehicles v JOIN customers c ON c.id = v.customer_id
               WHERE upper(replace(v.rego, ' ', '')) = $1 AND c.archived_at IS NULL LIMIT 1`,
              [r.rego]
            )
          : null;
        r.customer = r.vehicle
          ? null
          : await req.db.get(
              `SELECT * FROM customers WHERE archived_at IS NULL AND length($1) >= 8 AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = right($1, 9) LIMIT 1`,
              [digits(r.phone)]
            );
        r.dayLabel = dateLabel(r.date);
      }
      const slug = await pageSlug(store, req.user.workshop_id, res.locals.settings.business_name);
      res.render('online-booking/requests', { pending, handled, DROP_OFFS, slug, done: String(req.query.done || '') });
    });

    app.post('/bookings/requests/:id/accept', async (req, res, next) => {
      const bookingDate = await req.db.tx(async (db) => {
        const r = await db.get(`SELECT * FROM booking_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`, [req.params.id]);
        if (!r) return null;
        const at = now(req.tz);
        let vehicle = r.rego
          ? await db.get(
              `SELECT v.* FROM vehicles v JOIN customers c ON c.id = v.customer_id
               WHERE upper(replace(v.rego, ' ', '')) = $1 AND c.archived_at IS NULL LIMIT 1`,
              [r.rego]
            )
          : null;
        let customerId = vehicle ? vehicle.customer_id : null;
        if (!customerId && digits(r.phone).length >= 8) {
          const c = await db.get(
            `SELECT id FROM customers WHERE archived_at IS NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = right($1, 9) LIMIT 1`,
            [digits(r.phone)]
          );
          if (c) customerId = c.id;
        }
        if (!customerId) {
          const c = await db.get('INSERT INTO customers (name, phone, email, created_at) VALUES ($1, $2, $3, $4) RETURNING id', [r.name, r.phone, r.email, at]);
          customerId = c.id;
        }
        if (!vehicle && (r.rego || r.car)) {
          const [make, ...model] = r.car.split(/\s+/);
          vehicle = await db.get(
            `INSERT INTO vehicles (customer_id, rego, make, model, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [customerId, r.rego, make || '', model.join(' '), at]
          );
          await db.run('INSERT INTO vehicle_owners (vehicle_id, customer_id, from_at) VALUES ($1, $2, $3)', [vehicle.id, customerId, at]);
        }
        const time = /^\d{2}:\d{2}$/.test(req.body.time || '') ? req.body.time : '';
        const description = [r.service, DROP_OFFS[r.drop_off], r.notes].filter(Boolean).join(' · ').slice(0, 2000);
        const booking = await db.get(
          `INSERT INTO bookings (customer_id, vehicle_id, date, time, duration_hours, description, status, created_at)
           VALUES ($1, $2, $3, $4, 1, $5, 'booked', $6) RETURNING id`,
          [customerId, vehicle ? vehicle.id : null, r.date, time, `Online booking: ${description}`, at]
        );
        await db.run(`UPDATE booking_requests SET status = 'accepted', booking_id = $1, handled_by = $2, handled_at = now() WHERE id = $3`, [
          booking.id,
          req.user.id,
          r.id,
        ]);
        return r.date;
      });
      if (!bookingDate) return next();
      res.redirect(`/bookings/requests?done=accepted&week=${bookingDate}`);
    });

    app.post('/bookings/requests/:id/decline', async (req, res, next) => {
      const r = await req.db.get(
        `UPDATE booking_requests SET status = 'declined', handled_by = $1, handled_at = now() WHERE id = $2 AND status = 'pending' RETURNING id`,
        [req.user.id, req.params.id]
      );
      if (!r) return next();
      res.redirect('/bookings/requests?done=declined');
    });

    app.get('/settings/booking', requireOwner, async (req, res) => {
      const slug = await pageSlug(store, req.user.workshop_id, res.locals.settings.business_name);
      const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      res.render('online-booking/settings', {
        slug,
        pageUrl: `${base}/book/${slug}`,
        DAY_NAMES,
        DEFAULT_SERVICES,
        saved: req.query.saved === '1',
        error: String(req.query.error || '').slice(0, 200),
      });
    });

    app.post('/settings/booking', requireOwner, async (req, res) => {
      const days = [].concat(req.body.days || []).flatMap((d) => String(d).split(',')).filter((d) => /^[0-6]$/.test(d));
      const int = (k, min, max) => Math.min(Math.max(parseInt(req.body[k], 10) || 0, min), max);
      await req.db.run(
        `UPDATE settings SET online_booking = $1, booking_intro = $2, booking_services = $3, booking_days = $4,
           booking_notice_days = $5, booking_max_per_day = $6`,
        [
          req.body.online_booking === '1',
          String(req.body.booking_intro || '').trim().slice(0, 1000),
          String(req.body.booking_services || '').trim().slice(0, 2000),
          [...new Set(days)].sort().join(''),
          int('booking_notice_days', 0, 30),
          int('booking_max_per_day', 0, 200),
        ]
      );
      const wanted = String(req.body.slug || '').trim().toLowerCase();
      const current = await pageSlug(store, req.user.workshop_id, res.locals.settings.business_name);
      if (wanted && wanted !== current) {
        if (!SLUG_RE.test(wanted)) return res.redirect(`/settings/booking?error=${encodeURIComponent('Use 3 to 40 lower-case letters, numbers and dashes for the address.')}`);
        const taken = await store.system.get('SELECT 1 AS x FROM booking_pages WHERE slug = $1', [wanted]);
        if (taken) return res.redirect(`/settings/booking?error=${encodeURIComponent('That address is taken. Try another.')}`);
        await store.system.run('UPDATE booking_pages SET slug = $1 WHERE workshop_id = $2', [wanted, req.user.workshop_id]);
      }
      res.redirect('/settings/booking?saved=1');
    });
  },
};
