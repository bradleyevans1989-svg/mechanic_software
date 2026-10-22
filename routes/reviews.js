// Google review requests: the setting, and asking from an invoice by email or text.
const { requireOwner } = require('../lib/auth');
const { getDoc } = require('../lib/docs');
const mail = require('../lib/mail');
const reviews = require('../lib/reviews');

module.exports = function (app) {
  app.get('/settings/reviews', requireOwner, async (req, res) => {
    const [counts, recent] = await Promise.all([
      req.db.get(
        `SELECT COUNT(*) FILTER (WHERE review_requested_at > now() - interval '30 days')::int AS month, COUNT(review_requested_at)::int AS total FROM documents`
      ),
      req.db.all(
        `SELECT d.id, d.number, d.type, d.review_requested_at, d.review_via, c.name AS customer_name
         FROM documents d JOIN customers c ON c.id = d.customer_id
         WHERE d.review_requested_at IS NOT NULL ORDER BY d.review_requested_at DESC LIMIT 10`
      ),
    ]);
    const s = res.locals.settings;
    res.render('reviews-settings', {
      counts, recent,
      canEmail: mail.configured(),
      saved: req.query.saved === '1',
      error: req.query.error === 'link',
      preview: s.review_url ? reviews.message(s, { customer_name: 'Sam Driver', make: 'Toyota', model: 'Corolla' }) : '',
      DEFAULT_MESSAGE: reviews.DEFAULT_MESSAGE,
      QUIET_DAYS: reviews.QUIET_DAYS,
    });
  });

  app.post('/settings/reviews', requireOwner, async (req, res) => {
    const url = reviews.reviewLink(req.body.review_url);
    if (url === null) return res.redirect('/settings/reviews?error=link');
    const text = String(req.body.review_message || '').trim().slice(0, 600);
    await req.db.run('UPDATE settings SET review_url = $1, review_auto = $2, review_message = $3', [
      url,
      Boolean(url) && req.body.review_auto === '1',
      text === reviews.DEFAULT_MESSAGE ? '' : text,
    ]);
    res.redirect('/settings/reviews?saved=1');
  });

  // Ask from the invoice: email it from here, or note that it went by text from the user's phone.
  app.post('/documents/:id/review', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc || doc.type !== 'invoice') return next();
    const settings = res.locals.settings;
    const fail = (msg) => res.redirect(`/documents/${doc.id}?error=${encodeURIComponent(msg)}#review`);
    if (!settings.review_url) return fail('Add your Google review link in Settings first.');
    if (req.body.via === 'email') {
      if (!mail.configured()) return fail('Email sending is not set up on this server.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(doc.customer_email || '')) return fail('This customer has no email address.');
      try {
        await reviews.sendEmail(settings, doc, doc.customer_email);
      } catch (err) {
        return fail(err.message);
      }
      await reviews.markAsked(req.db, doc.id, 'email');
    } else {
      await reviews.markAsked(req.db, doc.id, 'sms');
    }
    res.redirect(`/documents/${doc.id}#review`);
  });
};
