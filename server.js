const { createApp } = require('./app');
const { createStore } = require('./lib/db');

async function main() {
  const store = createStore();
  await store.migrate();
  // A try-it-out workshop for test sites: set SEED_DEMO=1 and it appears on the next boot.
  if (process.env.SEED_DEMO === '1') await require('./scripts/seed').seedDemo(store);
  if (await store.isSuperuser()) {
    console.warn('Connected as a Postgres superuser: row-level security is bypassed. Use an ordinary database user in production.');
  }
  const app = createApp(store);
  app.locals.xero.startSweep();
  require('./lib/sms').startSweep(store);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Bay Boss running on http://localhost:${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
