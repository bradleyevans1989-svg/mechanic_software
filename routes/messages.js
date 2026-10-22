const crypto = require('crypto');
const sms = require('../lib/sms');
const { requireOwner } = require('../lib/auth');
const { getCustomer } = require('../lib/records');

// The secret in the inbound address, so only the SMS provider can post replies.
function inboundSecret() {
  return process.env.SMS_INBOUND_SECRET || crypto.createHash('sha256').update(`sms:${process.env.SESSION_SECRET || 'dev'}`).digest('hex').slice(0, 24);
}

function safeBack(url, fallback) {
  return typeof url === 'string' && /^\/[a-z]/.test(url) && !url.startsWith('//') ? url : fallback;
}

// Adds ?key=msg to a local address, before any #anchor.
function withFlash(url, key, msg) {
  const [path, hash] = url.split('#');
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}${hash ? `#${hash}` : ''}`;
}

module.exports = {
  inboundSecret,

  // Replies from customers, posted by the SMS provider. No login.
  public(app, { store }) {
    app.post('/sms/inbound/:secret', require('express').json({ limit: '100kb' }), async (req, res) => {
      const given = Buffer.from(String(req.params.secret));
      const expected = Buffer.from(inboundSecret());
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(404).end();
      await sms.receive(store, req);
      // Twilio wants TwiML back; an empty response means "don't reply".
      res.type('text/xml').send('<Response></Response>');
    });
  },

  pages(app, { store }) {
    // Everyone's text conversations, newest first, with unread replies on top.
    app.get('/messages', async (req, res) => {
      const threads = await req.db.all(
        `SELECT DISTINCT ON (COALESCE(m.customer_id::text, m.phone)) m.*, c.name AS customer_name,
           (SELECT COUNT(*) FROM sms_messages u WHERE u.direction = 'in' AND u.read_at IS NULL
              AND COALESCE(u.customer_id::text, u.phone) = COALESCE(m.customer_id::text, m.phone))::int AS unread
         FROM sms_messages m LEFT JOIN customers c ON c.id = m.customer_id
         ORDER BY COALESCE(m.customer_id::text, m.phone), m.at DESC LIMIT 500`
      );
      threads.sort((a, b) => (b.unread > 0) - (a.unread > 0) || new Date(b.at) - new Date(a.at));
      res.render('messages/index', { threads, configured: sms.configured(), testMode: sms.isTestMode() });
    });

    app.get('/customers/:id/messages', async (req, res, next) => {
      const customer = await getCustomer(req.db, req.params.id);
      if (!customer) return next();
      const messages = await req.db.all(
        `SELECT m.*, u.name AS user_name FROM sms_messages m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.customer_id = $1 ORDER BY m.at, m.id`,
        [customer.id]
      );
      await req.db.run(`UPDATE sms_messages SET read_at = now() WHERE customer_id = $1 AND direction = 'in' AND read_at IS NULL`, [customer.id]);
      res.render('messages/thread', {
        customer,
        messages,
        configured: sms.configured(),
        testMode: sms.isTestMode(),
        draft: String(req.query.text || '').slice(0, 640),
        error: String(req.query.error || '').slice(0, 300),
      });
    });

    // Send a text. Forms elsewhere (an invoice, a job, reminders) post here too, with a page to go back to.
    app.post('/customers/:id/messages', async (req, res, next) => {
      const customer = await getCustomer(req.db, req.params.id);
      if (!customer) return next();
      const back = safeBack(req.body.back, `/customers/${customer.id}/messages`);
      const jobId = Number(req.body.job_id) || null;
      const job = jobId ? await req.db.get('SELECT id FROM jobs WHERE id = $1 AND customer_id = $2', [jobId, customer.id]) : null;
      const kind = ['message', 'reminder', 'document', 'ready'].includes(req.body.kind) ? req.body.kind : 'message';
      try {
        await sms.sendToCustomer(store, req.db, {
          customerId: customer.id,
          phone: req.body.phone || customer.phone,
          body: req.body.body,
          userId: req.user.id,
          jobId: job ? job.id : null,
          kind,
        });
      } catch (err) {
        return res.redirect(withFlash(back, 'error', err.message));
      }
      if (req.body.reminder_vehicle_id) {
        const v = await req.db.get('SELECT id FROM vehicles WHERE id = $1 AND customer_id = $2', [Number(req.body.reminder_vehicle_id) || 0, customer.id]);
        if (v) {
          await req.db.run(`INSERT INTO reminder_log (vehicle_id, user_id, kind, method, note) VALUES ($1, $2, $3, 'sms', 'Texted from the app')`, [
            v.id,
            req.user.id,
            req.body.reminder_kind === 'rego' ? 'rego' : 'service',
          ]);
        }
      }
      if (req.body.document_id) {
        await req.db.run(
          `UPDATE documents SET sent_at = now(), sent_to = $1, sent_via = 'sms', status = CASE WHEN type = 'quote' AND status = 'draft' THEN 'sent' ELSE status END
           WHERE id = $2 AND customer_id = $3`,
          [String(req.body.phone || customer.phone).slice(0, 50), Number(req.body.document_id) || 0, customer.id]
        );
      }
      res.redirect(withFlash(back, req.body.document_id ? 'sent' : 'texted', '1'));
    });

    // Test mode only: stand in for the customer replying, so the inbox can be tried.
    app.post('/customers/:id/messages/test-reply', async (req, res, next) => {
      const customer = await getCustomer(req.db, req.params.id);
      if (!customer || !sms.isTestMode()) return next();
      const phone = sms.normalise(customer.phone);
      const body = String(req.body.body || '').trim().slice(0, 2000);
      if (phone && body) {
        await req.db.run(`INSERT INTO sms_messages (customer_id, direction, phone, body, kind, status, test) VALUES ($1, 'in', $2, $3, 'reply', 'received', true)`, [
          customer.id,
          phone,
          body,
        ]);
      }
      res.redirect(`/customers/${customer.id}/messages`);
    });

    app.get('/settings/messages', requireOwner, (req, res) =>
      res.render('messages/settings', {
        configured: sms.configured(),
        testMode: sms.isTestMode(),
        provider: sms.providerLabel(),
        inboundUrl: `${(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/sms/inbound/${inboundSecret()}`,
        sms,
        saved: req.query.saved === '1',
      })
    );

    app.post('/settings/messages', requireOwner, async (req, res) => {
      const g = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
      await req.db.run(
        'UPDATE settings SET sms_sender = $1, sms_booking_reminders = $2, sms_booking_template = $3, sms_ready_template = $4',
        [sms.senderId(g('sms_sender', 40)), req.body.sms_booking_reminders === '1', g('sms_booking_template', 640), g('sms_ready_template', 640)]
      );
      res.redirect('/settings/messages?saved=1');
    });

    // "Your car is ready" for a job, using the workshop's wording.
    app.locals.readyText = (settings, job) =>
      sms.fill(settings.sms_ready_template || sms.DEFAULT_READY_TEMPLATE, {
        first: String(job.customer_name || '').split(' ')[0],
        car: sms.carName(job),
        business: settings.business_name,
      });
  },
};
