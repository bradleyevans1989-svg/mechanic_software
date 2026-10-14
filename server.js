// Dates and "today" follow the workshop's timezone, not the server's.
process.env.TZ = process.env.TZ || 'Australia/Sydney';

const { createApp } = require('./app');
const { open } = require('./lib/db');

const db = open();
const port = process.env.PORT || 3000;

if (!process.env.APP_PASSWORD) {
  console.warn('APP_PASSWORD is not set: anyone who can reach this app can use it.');
}

createApp(db).listen(port, () => console.log(`Workshop running on http://localhost:${port}`));
