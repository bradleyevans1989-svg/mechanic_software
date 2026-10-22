const payments = require('../lib/payments');
const { requireOwner } = require('../lib/auth');
const { getDoc } = require('../lib/docs');
const { today, docNumber } = require('../lib/util');
const { appUrl } = require('./share');

const KEY_RE = /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/;

module.exports = {
  // The customer's side, from the invoice's share link.
  public(app, { store, xero }) {
    async function load(req) {
      const token = String(req.params.token || '');
      if (!/^[a-f0-9]{32}$/.test(token)) return null;
      const link = await store.system.get('SELECT * FROM share_links WHERE token = $1', [token]);
      if (!link) return null;
      const db = store.tenant(link.workshop_id);
      const settings = await db.get('SELECT * FROM settings');
      const doc = settings && (await getDoc(db, link.document_id, today(settings.timezone)));
      if (!doc || doc.type !== 'invoice') return null;
      return { token, db, settings, doc, shareUrl: `${appUrl(req)}/share/${token}` };
    }

    const gone = (res) => res.status(404).render('message', { title: 'Link not found', message: 'This link is no longer valid. Please contact the workshop.' });

    // Back from the checkout: record the payment if it went through, then show the invoice.
    // Without a session, this only tells the invoice page whether to offer "Pay now".
    app.get('/share/:token', async (req, res, next) => {
      const found = await load(req);
      if (!found) return next();
      if (!req.query.session) {
        res.locals.payOnline = Boolean(payments.providerFor(found.settings)) && found.doc.status !== 'void' && found.doc.balance > 0;
        res.locals.paidOnline = req.query.paid === '1' ? 'yes' : req.query.paid === '0' ? 'no' : '';
        return next();
      }
      try {
        const r = await payments.settle(found.db, found.settings, req.query.session);
        if (r && r.status === 'paid') await xero.queueInvoice(found.db, found.doc.id);
        return res.redirect(`/share/${found.token}?paid=${r && r.status === 'paid' ? '1' : '0'}`);
      } catch (err) {
        console.error(`Online payment return: ${err.message}`);
        return res.redirect(`/share/${found.token}?paid=0`);
      }
    });

    app.post('/share/:token/pay', async (req, res) => {
      const found = await load(req);
      if (!found) return gone(res);
      try {
        const customer = await found.db.get('SELECT email FROM customers WHERE id = $1', [found.doc.customer_id]);
        const url = await payments.startCheckout(found.db, { ...found, customerEmail: customer && customer.email });
        res.redirect(303, url);
      } catch (err) {
        res.status(400).render('message', { title: 'Payment not started', message: `${err.message} Please contact the workshop.` });
      }
    });

    // Test mode's pretend checkout.
    app.get('/share/:token/pay/test', async (req, res) => {
      const found = await load(req);
      if (!found || !payments.testAllowed()) return gone(res);
      const row = await found.db.get(`SELECT * FROM online_payments WHERE session_id = $1 AND document_id = $2 AND provider = 'test'`, [
        String(req.query.session || ''),
        found.doc.id,
      ]);
      if (!row) return gone(res);
      res.locals.settings = found.settings;
      res.render('online-payments/test-checkout', { token: found.token, row, doc: found.doc, docNumber });
    });

    app.post('/share/:token/pay/test', async (req, res) => {
      const found = await load(req);
      if (!found || !payments.testAllowed()) return gone(res);
      const row = await found.db.get(`SELECT * FROM online_payments WHERE session_id = $1 AND document_id = $2 AND provider = 'test'`, [
        String(req.body.session || ''),
        found.doc.id,
      ]);
      if (!row) return gone(res);
      const r = await payments.settle(found.db, found.settings, row.session_id, { testPaid: req.body.outcome === 'paid' });
      if (r.status === 'paid') await xero.queueInvoice(found.db, found.doc.id);
      res.redirect(`/share/${found.token}?paid=${r.status === 'paid' ? '1' : '0'}`);
    });
  },

  // The workshop's side.
  pages(app, { xero }) {
    app.get('/settings/payments', requireOwner, async (req, res) => {
      const s = res.locals.settings;
      res.render('online-payments/settings', {
        provider: payments.providerFor(s),
        testAllowed: payments.testAllowed(),
        keyHint: s.pay_stripe_key ? `${s.pay_stripe_key.slice(0, 8)}…${s.pay_stripe_key.slice(-4)}` : '',
        recent: await req.db.all(
          `SELECT o.*, d.number, d.type FROM online_payments o JOIN documents d ON d.id = o.document_id
           WHERE o.status = 'paid' ORDER BY o.paid_at DESC LIMIT 10`
        ),
        saved: req.query.saved === '1',
        error: String(req.query.error || '').slice(0, 200),
      });
    });

    app.post('/settings/payments', requireOwner, async (req, res) => {
      const want = ['stripe', 'test'].includes(req.body.pay_provider) ? req.body.pay_provider : '';
      const key = String(req.body.pay_stripe_key || '').trim();
      const current = res.locals.settings.pay_stripe_key;
      if (want === 'test' && !payments.testAllowed()) return res.redirect('/settings/payments?error=' + encodeURIComponent('Test mode is only for test sites.'));
      if (key && !KEY_RE.test(key)) return res.redirect('/settings/payments?error=' + encodeURIComponent('That doesn\'t look like a Stripe secret key (it starts with sk_live_ or rk_live_).'));
      if (want === 'stripe' && !key && !current) return res.redirect('/settings/payments?error=' + encodeURIComponent('Paste your Stripe secret key to turn on Stripe.'));
      await req.db.run('UPDATE settings SET pay_provider = $1, pay_stripe_key = $2', [want, key || (req.body.forget_key === '1' ? '' : current)]);
      res.redirect('/settings/payments?saved=1');
    });

    // Opening an invoice picks up online payments whose customer never came back to the link.
    app.get('/documents/:id', async (req, res, next) => {
      if (payments.providerFor(res.locals.settings) === 'stripe') {
        try {
          if (await payments.settlePending(req.db, res.locals.settings, Number(req.params.id))) await xero.queueInvoice(req.db, Number(req.params.id));
        } catch (err) {
          console.error(`Checking online payments: ${err.message}`);
        }
      }
      res.locals.payOnline = Boolean(payments.providerFor(res.locals.settings));
      next();
    });
  },
};
