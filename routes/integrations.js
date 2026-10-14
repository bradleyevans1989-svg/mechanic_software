const crypto = require('crypto');
const { requireOwner } = require('../lib/auth');
const { today } = require('../lib/util');

function redirectUri(req) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/xero/callback`;
}

module.exports = function (app, { xero }) {
  app.get('/integrations', requireOwner, (req, res) => {
    const { row, config, connected } = xero.state();
    res.render('integrations', {
      xeroConfigured: xero.configured(),
      connected,
      tenantName: row ? row.tenant_name : '',
      config,
      orgs: !connected && config.pending_orgs ? config.pending_orgs : [],
      counts: xero.counts(),
      problems: xero.problems(),
      redirectUri: redirectUri(req),
      notice: req.query.notice || '',
      error: req.query.error || '',
      today: today(),
    });
  });

  app.get('/xero/connect', requireOwner, (req, res) => {
    if (!xero.configured()) return res.redirect('/integrations');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('xero_state', state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000 });
    res.redirect(xero.authorizeUrl(redirectUri(req), state));
  });

  app.get('/xero/callback', requireOwner, async (req, res) => {
    const cookieState = (req.headers.cookie || '').match(/(?:^|;\s*)xero_state=([^;]+)/);
    res.clearCookie('xero_state');
    if (req.query.error) return res.redirect(`/integrations?error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
    if (!cookieState || cookieState[1] !== req.query.state) {
      return res.redirect('/integrations?error=' + encodeURIComponent('Xero sign-in expired. Try connecting again.'));
    }
    try {
      const orgs = await xero.finishConnect(String(req.query.code || ''), redirectUri(req));
      if (orgs.length === 0) throw new Error('No Xero organisation was shared with the app.');
      if (orgs.length > 1) {
        xero.saveConfig({ pending_orgs: orgs.map((o) => ({ id: o.id, tenantId: o.tenantId, tenantName: o.tenantName })) });
        return res.redirect('/integrations');
      }
      res.redirect('/integrations?notice=' + encodeURIComponent(`Connected to ${orgs[0].tenantName}.`));
    } catch (err) {
      res.redirect('/integrations?error=' + encodeURIComponent(err.message));
    }
  });

  app.post('/xero/tenant', requireOwner, (req, res) => {
    const { config } = xero.state();
    const org = (config.pending_orgs || []).find((o) => o.tenantId === req.body.tenant_id);
    if (!org) return res.redirect('/integrations');
    xero.setTenant(org.tenantId, org.tenantName, org.id);
    xero.saveConfig({ pending_orgs: null });
    res.redirect('/integrations?notice=' + encodeURIComponent(`Connected to ${org.tenantName}.`));
  });

  app.post('/xero/settings', requireOwner, (req, res) => {
    const code = (k) => String(req.body[k] || '').trim().slice(0, 10);
    xero.saveConfig({
      labour_account: code('labour_account') || '200',
      parts_account: code('parts_account') || '200',
      other_account: code('other_account') || '200',
      payment_account: code('payment_account'),
    });
    res.redirect('/integrations?notice=' + encodeURIComponent('Xero settings saved.'));
  });

  app.post('/xero/send-past', requireOwner, (req, res) => {
    const since = /^\d{4}-\d{2}-\d{2}$/.test(req.body.since || '') ? req.body.since : today();
    const n = xero.queueAll(since);
    res.redirect('/integrations?notice=' + encodeURIComponent(`${n} invoice${n === 1 ? '' : 's'} queued for Xero.`));
  });

  app.post('/xero/sync', requireOwner, async (req, res) => {
    const r = await xero.runPending({ retryErrors: true });
    const msg = r.stopped
      ? `Sync stopped: ${r.stopped}`
      : `Sent ${r.synced} to Xero${r.failed ? `, ${r.failed} failed` : ''}.`;
    res.redirect('/integrations?notice=' + encodeURIComponent(msg));
  });

  app.post('/xero/disconnect', requireOwner, async (req, res) => {
    await xero.disconnect();
    res.redirect('/integrations?notice=' + encodeURIComponent('Disconnected from Xero.'));
  });

  // "Send to Xero now" on an invoice.
  app.post('/documents/:id/xero', async (req, res) => {
    xero.queueInvoice(Number(req.params.id));
    await xero.runPending({ retryErrors: true });
    res.redirect(`/documents/${req.params.id}`);
  });
};
