const crypto = require('crypto');
const { getLines } = require('../lib/db');
const { getDoc } = require('../lib/docs');
const { getCustomer, getVehicle, logEvent } = require('../lib/records');
const { today, docNumber, money } = require('../lib/util');
const mail = require('../lib/mail');

function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// The link a customer gets; made once per document and reused.
async function shareToken(store, workshopId, documentId) {
  const sys = store.system;
  const row = await sys.get('SELECT token FROM share_links WHERE workshop_id = $1 AND document_id = $2', [workshopId, documentId]);
  if (row) return row.token;
  const token = crypto.randomBytes(16).toString('hex');
  await sys.run('INSERT INTO share_links (token, workshop_id, document_id) VALUES ($1, $2, $3) ON CONFLICT (workshop_id, document_id) DO NOTHING', [
    token,
    workshopId,
    documentId,
  ]);
  return (await sys.get('SELECT token FROM share_links WHERE workshop_id = $1 AND document_id = $2', [workshopId, documentId])).token;
}

const VIAS = { email: 'email', sms: 'text message', mailto: 'email', link: 'link' };

module.exports = {
  shareToken,
  appUrl,

  // Customer-facing pages: no login, the token is the key.
  public(app, { store }) {
    async function load(req) {
      const token = String(req.params.token || '');
      if (!/^[a-f0-9]{32}$/.test(token)) return null;
      const link = await store.system.get('SELECT * FROM share_links WHERE token = $1', [token]);
      if (!link) return null;
      const db = store.tenant(link.workshop_id);
      const settings = await db.get('SELECT * FROM settings');
      if (!settings) return null;
      const doc = await getDoc(db, link.document_id, today(settings.timezone));
      if (!doc) return null;
      return { db, settings, doc };
    }

    const gone = (res) => res.status(404).render('message', { title: 'Link not found', message: 'This link is no longer valid. Please contact the workshop.' });

    app.get('/share/:token', async (req, res) => {
      const found = await load(req);
      if (!found) return gone(res);
      const { db, settings, doc } = found;
      res.locals.settings = settings;
      res.render('documents/print', {
        doc,
        lines: await getLines(db, 'document', doc.id),
        payments: doc.type === 'invoice' ? await db.all('SELECT * FROM payments WHERE document_id = $1 ORDER BY date, id', [doc.id]) : [],
        customer: await getCustomer(db, doc.customer_id),
        vehicle: doc.vehicle_id ? await getVehicle(db, doc.vehicle_id) : null,
        shared: true,
        token: req.params.token,
        accepted: req.query.accepted === '1',
      });
    });

    // The customer accepts a quote from their link.
    app.post('/share/:token/accept', async (req, res) => {
      const found = await load(req);
      if (!found || found.doc.type !== 'quote') return gone(res);
      const { db, doc } = found;
      if (doc.status === 'draft' || doc.status === 'sent') {
        await db.tx(async (tx) => {
          await tx.run(`UPDATE documents SET status = 'accepted', customer_accepted_at = now() WHERE id = $1`, [doc.id]);
          if (doc.job_id) await logEvent(tx, doc.job_id, null, 'quote', `Quote ${docNumber(doc)} accepted online by the customer`);
        });
      }
      res.redirect(`/share/${req.params.token}?accepted=1`);
    });
  },

  // Logged-in side: sending a document and recording that it went.
  pages(app, { store }) {
    app.post('/documents/:id/send', async (req, res, next) => {
      const doc = await getDoc(req.db, req.params.id, res.locals.today);
      if (!doc) return next();
      const via = VIAS[req.body.via] ? req.body.via : 'link';
      const to = String(req.body.to || doc.customer_email || '').trim().slice(0, 200);
      const label = doc.type === 'quote' ? 'Quote' : 'Tax invoice';
      const link = `${appUrl(req)}/share/${await shareToken(store, req.user.workshop_id, doc.id)}`;
      if (via === 'email') {
        if (!mail.configured()) return res.redirect(`/documents/${doc.id}?error=${encodeURIComponent('Email sending is not set up on this server.')}`);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.redirect(`/documents/${doc.id}?error=${encodeURIComponent('Enter a valid email address.')}`);
        const settings = res.locals.settings;
        const subject = `${label} ${docNumber(doc)} from ${settings.business_name}`;
        const intro =
          doc.type === 'quote'
            ? `Here is your quote for ${money(doc.total)}${doc.due_date ? `, valid until ${doc.due_date.split('-').reverse().join('/')}` : ''}. You can view it and accept it online here:`
            : `Here is your tax invoice for ${money(doc.total)}${doc.balance > 0 ? `, with ${money(doc.balance)} to pay${doc.due_date ? ` by ${doc.due_date.split('-').reverse().join('/')}` : ''}` : ''}. You can view it here:`;
        const text = `Hi ${doc.customer_name},\n\n${intro}\n${link}\n\n${settings.bank_details && doc.type === 'invoice' ? `Pay by bank transfer:\n${settings.bank_details}\n\n` : ''}Thanks,\n${settings.business_name}${settings.phone ? `\n${settings.phone}` : ''}`;
        const html = `<p>Hi ${mail.escapeHtml(doc.customer_name)},</p><p>${mail.escapeHtml(intro)}</p><p><a href="${link}">${mail.escapeHtml(`${label} ${docNumber(doc)}`)}</a></p>${
          settings.bank_details && doc.type === 'invoice' ? `<p>Pay by bank transfer:<br>${mail.escapeHtml(settings.bank_details).replace(/\n/g, '<br>')}</p>` : ''
        }<p>Thanks,<br>${mail.escapeHtml(settings.business_name)}${settings.phone ? `<br>${mail.escapeHtml(settings.phone)}` : ''}</p>`;
        try {
          await mail.send({ to, subject, text, html, replyTo: settings.email || undefined });
        } catch (err) {
          return res.redirect(`/documents/${doc.id}?error=${encodeURIComponent(err.message)}`);
        }
      }
      await req.db.run(
        `UPDATE documents SET sent_at = now(), sent_to = $1, sent_via = $2, status = CASE WHEN type = 'quote' AND status = 'draft' THEN 'sent' ELSE status END WHERE id = $3`,
        [via === 'sms' ? String(req.body.to || doc.customer_phone || '').slice(0, 50) : to, via, doc.id]
      );
      res.redirect(`/documents/${doc.id}?sent=1`);
    });
  },
};
