const express = require('express');
const path = require('path');
const util = require('./lib/util');
const auth = require('./lib/auth');
const { createXero } = require('./lib/xero');
const { createBilling } = require('./lib/stripe');
const billingRoutes = require('./routes/billing');
const shareRoutes = require('./routes/share');

const JOB_STATUSES = {
  open: 'Booked in',
  in_progress: 'In progress',
  waiting_parts: 'Waiting on parts',
  ready: 'Ready for pickup',
  invoiced: 'Invoiced',
  cancelled: 'Cancelled',
};

const BOOKING_STATUSES = {
  booked: 'Booked',
  arrived: 'Arrived',
  no_show: 'No show',
  cancelled: 'Cancelled',
};

const QUOTE_STATUSES = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
};

function createApp(store, { autoSync = true } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.get('/healthz', async (req, res) => {
    await store.system.get('SELECT 1');
    res.send('ok');
  });

  app.use((req, res, next) => {
    res.locals.u = util;
    res.locals.JOB_STATUSES = JOB_STATUSES;
    res.locals.BOOKING_STATUSES = BOOKING_STATUSES;
    res.locals.QUOTE_STATUSES = QUOTE_STATUSES;
    res.locals.settings = { business_name: 'Workshop' };
    res.locals.today = util.today();
    res.locals.path = req.path;
    res.locals.q = '';
    res.locals.user = null;
    next();
  });

  // Numeric ids only; anything else is a 404 rather than a database error.
  for (const name of ['id', 'pid']) {
    app.param(name, (req, res, next, value) => (/^\d{1,9}$/.test(value) ? next() : next('route')));
  }

  const billing = createBilling(store);
  const xero = createXero(store);
  xero.setAutoSync(autoSync);
  app.locals.xero = xero;
  app.locals.billing = billing;
  const ctx = { store, xero, billing, JOB_STATUSES, BOOKING_STATUSES, QUOTE_STATUSES };

  billingRoutes.webhook(app, ctx);
  shareRoutes.public(app, ctx);
  auth.setup(app, store);
  billingRoutes.gate(app, ctx);
  billingRoutes.pages(app, ctx);

  require('./routes/main')(app, ctx);
  require('./routes/staff')(app, ctx);
  require('./routes/customers')(app, ctx);
  require('./routes/bookings')(app, ctx);
  require('./routes/jobs')(app, ctx);
  require('./routes/documents')(app, ctx);
  require('./routes/integrations')(app, ctx);
  require('./routes/pricelist')(app, ctx);
  require('./routes/reminders')(app, ctx);
  require('./routes/timesheets')(app, ctx);
  shareRoutes.pages(app, ctx);

  app.use((req, res) => res.status(404).render('message', { title: 'Not found', message: 'That page does not exist.' }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('message', { title: 'Something went wrong', message: 'Please try again. If it keeps happening, let us know.' });
  });

  return app;
}

module.exports = { createApp };
