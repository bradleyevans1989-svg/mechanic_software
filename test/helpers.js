// Shared test setup: a throwaway Postgres database per test file, and a small HTTP client.
const { Client } = require('pg');
const { createStore } = require('../lib/db');
const { createApp } = require('../app');

const BASE_URL = process.env.TEST_DATABASE_URL || 'postgres://workshop:workshop@127.0.0.1:5433/workshop';

async function adminQuery(sql) {
  const c = new Client({ connectionString: BASE_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function startApp(options) {
  const name = `ws_test_${process.pid}_${Date.now()}`;
  await adminQuery(`CREATE DATABASE ${name}`);
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  const store = createStore(url.toString());
  await store.migrate();
  const app = createApp(store, options);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;

  const client = (cookie = '') => ({
    cookie,
    async get(path) {
      const res = await fetch(base + path, { headers: { cookie: this.cookie }, redirect: 'manual' });
      return { status: res.status, text: await res.text(), location: res.headers.get('location'), res };
    },
    post(path, fields = {}) {
      return fetch(base + path, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: this.cookie },
        body: new URLSearchParams(fields).toString(),
      });
    },
  });

  // Signs up a new workshop and returns a client logged in as its owner.
  async function signup(workshop, email, password = 'spanner-123') {
    const c = client();
    const res = await c.post('/signup', { workshop, name: `${workshop} Owner`, email, password });
    if (res.status !== 302) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    const user = await store.system.get('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    c.workshopId = user.workshop_id;
    c.db = store.tenant(user.workshop_id);
    return c;
  }

  async function stop() {
    server.close();
    await store.close();
    await adminQuery(`DROP DATABASE ${name} WITH (FORCE)`);
  }

  return { app, store, base, client, signup, stop };
}

const idFrom = (res) => Number(res.headers.get('location').split('?')[0].split('/').pop());

module.exports = { startApp, idFrom };
