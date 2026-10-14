const express = require('express');
const { requireOwner } = require('../lib/auth');
const { INVOICE_TEMPLATES, JOBCARD_TEMPLATES, pick, sampleDocument, sampleJob } = require('../lib/templates');
const { CHECK_RESULTS } = require('../lib/records');

const COLOUR_RE = /^#[0-9a-f]{6}$/i;
const MAX_LOGO = 1.5 * 1024 * 1024;

module.exports = function (app, { store }) {
  // Pick a design for invoices and job cards, with live previews.
  app.get('/settings/templates', requireOwner, (req, res) => {
    res.render('templates', { INVOICE_TEMPLATES, JOBCARD_TEMPLATES, saved: req.query.saved || '' });
  });

  app.post('/settings/templates', requireOwner, async (req, res) => {
    const kind = req.body.kind === 'jobcard' ? 'jobcard' : 'invoice';
    const table = kind === 'jobcard' ? JOBCARD_TEMPLATES : INVOICE_TEMPLATES;
    const key = pick(table, String(req.body.template || ''));
    await req.db.run(`UPDATE settings SET ${kind}_template = $1`, [key]);
    res.redirect(`/settings/templates?saved=${kind}#${kind}`);
  });

  // Sample invoice or job card rendered in a given design.
  app.get('/settings/templates/preview', requireOwner, (req, res) => {
    const today = res.locals.today;
    if (req.query.kind === 'jobcard') {
      return res.render('jobs/print', { ...sampleJob(today), CHECK_RESULTS, template: pick(JOBCARD_TEMPLATES, String(req.query.t || '')), preview: true });
    }
    const sample = sampleDocument(today);
    if (req.query.type === 'quote') Object.assign(sample.doc, { type: 'quote', status: 'sent', state: 'sent' });
    res.render('documents/print', { ...sample, template: pick(INVOICE_TEMPLATES, String(req.query.t || '')), preview: true });
  });

  // Logo: uploaded as a data URL the browser has already shrunk; stored in the database so it survives redeploys.
  app.post('/settings/logo', requireOwner, express.urlencoded({ extended: false, limit: '4mb' }), async (req, res) => {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.logo_data || ''));
    if (!m) return res.redirect('/settings?logo=bad#branding');
    const data = Buffer.from(m[2], 'base64');
    if (!data.length || data.length > MAX_LOGO) return res.redirect('/settings?logo=big#branding');
    await req.db.tx(async (db) => {
      await db.run(
        `INSERT INTO logos (data, content_type) VALUES ($1, $2)
         ON CONFLICT (workshop_id) DO UPDATE SET data = EXCLUDED.data, content_type = EXCLUDED.content_type, updated_at = now()`,
        [data, `image/${m[1]}`]
      );
      await db.run('UPDATE settings SET has_logo = true');
    });
    res.redirect('/settings?logo=saved#branding');
  });

  app.post('/settings/logo/remove', requireOwner, async (req, res) => {
    await req.db.tx(async (db) => {
      await db.run('DELETE FROM logos');
      await db.run('UPDATE settings SET has_logo = false');
    });
    res.redirect('/settings?logo=removed#branding');
  });

  app.get('/logo', async (req, res) => {
    const logo = await req.db.get('SELECT data, content_type FROM logos');
    if (!logo) return res.status(404).end();
    res.set('Content-Type', logo.content_type).set('Cache-Control', 'private, max-age=300').send(logo.data);
  });
};

module.exports.serveSharedLogo = async function (db, res) {
  const logo = await db.get('SELECT data, content_type FROM logos');
  if (!logo) return res.status(404).end();
  res.set('Content-Type', logo.content_type).set('Cache-Control', 'public, max-age=300').send(logo.data);
};
