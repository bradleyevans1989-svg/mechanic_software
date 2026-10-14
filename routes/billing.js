const express = require('express');
const { requireOwner } = require('../lib/auth');
const { verifySignature } = require('../lib/stripe');

function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Routes that work even when a workshop's trial has ended, so the owner can pay.
const ALWAYS_ALLOWED = ['/billing', '/billing/checkout', '/billing/portal', '/account', '/logout'];

module.exports = {
  // Registered before login, since Stripe calls it with a signature instead.
  webhook(app, { billing }) {
    app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret || !verifySignature(req.body, req.get('stripe-signature'), secret)) return res.status(400).send('bad signature');
      let event;
      try {
        event = JSON.parse(req.body.toString('utf8'));
      } catch {
        return res.status(400).send('bad json');
      }
      try {
        await billing.handleEvent(event);
        res.send('ok');
      } catch (err) {
        console.error('Stripe webhook failed:', err);
        res.status(500).send('failed'); // Stripe will retry
      }
    });
  },

  // After login: block workshops that aren't paid up, except for the billing pages.
  gate(app, { billing }) {
    app.use(async (req, res, next) => {
      const ws = await billing.getWorkshop(req.user.workshop_id);
      req.workshop = ws;
      res.locals.workshop = ws;
      res.locals.standing = billing.standing(ws);
      res.locals.billingEnabled = billing.configured();
      if (res.locals.standing.ok || !billing.configured() || ALWAYS_ALLOWED.includes(req.path)) return next();
      if (req.user.role === 'owner') return res.redirect('/billing');
      res.status(402).render('message', {
        title: 'Subscription needed',
        message: `${ws.name}'s free trial has ended. Ask the workshop owner to set up the subscription.`,
      });
    });
  },

  pages(app, { billing }) {
    app.get('/billing', requireOwner, (req, res) => {
      res.render('billing', {
        checkout: String(req.query.checkout || ''),
        error: String(req.query.error || '').slice(0, 300),
        price: process.env.PLAN_PRICE_LABEL || '',
      });
    });

    app.post('/billing/checkout', requireOwner, async (req, res) => {
      if (!billing.configured()) return res.redirect('/billing');
      try {
        res.redirect(await billing.checkoutUrl(req.workshop, req.user, appUrl(req)));
      } catch (err) {
        res.redirect(`/billing?error=${encodeURIComponent(err.message)}`);
      }
    });

    app.post('/billing/portal', requireOwner, async (req, res) => {
      if (!billing.configured() || !req.workshop.stripe_customer_id) return res.redirect('/billing');
      try {
        res.redirect(await billing.portalUrl(req.workshop, appUrl(req)));
      } catch (err) {
        res.redirect(`/billing?error=${encodeURIComponent(err.message)}`);
      }
    });
  },
};
