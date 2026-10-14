const { createApp } = require('./app');
const { createStore } = require('./lib/db');

async function main() {
  const store = createStore();
  await store.migrate();
  if (await store.isSuperuser()) {
    console.warn('Connected as a Postgres superuser: row-level security is bypassed. Use an ordinary database user in production.');
  }
  const app = createApp(store);
  app.locals.xero.startSweep();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Workshop running on http://localhost:${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
