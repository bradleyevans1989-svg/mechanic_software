const express = require('express');
const path = require('path');
const util = require('./lib/util');
const auth = require('./lib/auth');

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

function createApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.get('/healthz', (req, res) => res.send('ok'));

  app.use((req, res, next) => {
    res.locals.u = util;
    res.locals.JOB_STATUSES = JOB_STATUSES;
    res.locals.BOOKING_STATUSES = BOOKING_STATUSES;
    res.locals.QUOTE_STATUSES = QUOTE_STATUSES;
    res.locals.settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    res.locals.path = req.path;
    res.locals.q = '';
    next();
  });

  auth.setup(app);

  const ctx = { db, JOB_STATUSES, BOOKING_STATUSES, QUOTE_STATUSES };
  require('./routes/main')(app, ctx);
  require('./routes/customers')(app, ctx);
  require('./routes/bookings')(app, ctx);
  require('./routes/jobs')(app, ctx);
  require('./routes/documents')(app, ctx);

  app.use((req, res) => res.status(404).render('message', { title: 'Not found', message: 'That page does not exist.' }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('message', { title: 'Something went wrong', message: err.message });
  });

  return app;
}

module.exports = { createApp };
