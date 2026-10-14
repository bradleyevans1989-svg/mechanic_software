const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL DEFAULT 'My Workshop',
  abn TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  bank_details TEXT NOT NULL DEFAULT '',
  invoice_terms TEXT NOT NULL DEFAULT 'Thank you for your business.',
  labour_rate_cents INTEGER NOT NULL DEFAULT 12000,
  payment_days INTEGER NOT NULL DEFAULT 7,
  next_invoice_no INTEGER NOT NULL DEFAULT 1001,
  next_quote_no INTEGER NOT NULL DEFAULT 1001,
  next_job_no INTEGER NOT NULL DEFAULT 1001
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rego TEXT NOT NULL DEFAULT '',
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL DEFAULT '',
  odometer INTEGER,
  rego_due TEXT,
  next_service_date TEXT,
  next_service_km INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  description TEXT NOT NULL DEFAULT '',
  tech_notes TEXT NOT NULL DEFAULT '',
  odometer INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  duration_hours REAL NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked',
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

-- Quotes and invoices share one table; type says which.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('quote', 'invoice')),
  number INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL,
  odometer INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (type, number)
);

-- Prices are stored in cents, excluding GST.
CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'part',
  description TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL DEFAULT 0,
  gst INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  CHECK ((job_id IS NULL) != (document_id IS NULL))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles(customer_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_rego ON vehicles(rego);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_docs_type ON documents(type, issue_date);
CREATE INDEX IF NOT EXISTS idx_lines_job ON line_items(job_id);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON line_items(document_id);
CREATE INDEX IF NOT EXISTS idx_payments_doc ON payments(document_id);
`;

function open(file) {
  file = file || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'workshop.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
  migrate(db);
  return db;
}

// Schema changes after the first release, applied once each in order (tracked by user_version).
const MIGRATIONS = [
  // 1: staff accounts, and which mechanic is on each job.
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'staff',
     active INTEGER NOT NULL DEFAULT 1,
     session_version INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL
   );
   ALTER TABLE jobs ADD COLUMN mechanic_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
   ALTER TABLE settings ADD COLUMN session_secret TEXT NOT NULL DEFAULT '';`,

  // 2: accounting sync (Xero now, MYOB later).
  `CREATE TABLE integrations (
     provider TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT '',
     tenant_name TEXT NOT NULL DEFAULT '',
     access_token TEXT NOT NULL DEFAULT '',
     refresh_token TEXT NOT NULL DEFAULT '',
     expires_at INTEGER NOT NULL DEFAULT 0,
     config TEXT NOT NULL DEFAULT '{}',
     connected_at TEXT
   );
   CREATE TABLE sync_links (
     provider TEXT NOT NULL,
     entity TEXT NOT NULL,
     local_id INTEGER NOT NULL,
     parent_id INTEGER,
     remote_id TEXT NOT NULL DEFAULT '',
     hash TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending',
     error TEXT NOT NULL DEFAULT '',
     synced_at TEXT,
     PRIMARY KEY (provider, entity, local_id)
   );`,
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  MIGRATIONS.slice(current).forEach((sql, i) => {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${current + i + 1}`);
    })();
  });
}

// Takes the next number from a settings counter (invoice, quote or job).
function nextNumber(db, counter) {
  const col = { invoice: 'next_invoice_no', quote: 'next_quote_no', job: 'next_job_no' }[counter];
  const n = db.prepare(`SELECT ${col} AS n FROM settings WHERE id = 1`).get().n;
  db.prepare(`UPDATE settings SET ${col} = ${col} + 1 WHERE id = 1`).run();
  return n;
}

function getLines(db, parent, id) {
  const col = parent === 'job' ? 'job_id' : 'document_id';
  return db.prepare(`SELECT * FROM line_items WHERE ${col} = ? ORDER BY sort, id`).all(id);
}

function saveLines(db, parent, id, lines) {
  const col = parent === 'job' ? 'job_id' : 'document_id';
  db.prepare(`DELETE FROM line_items WHERE ${col} = ?`).run(id);
  const insert = db.prepare(
    `INSERT INTO line_items (${col}, kind, description, qty, unit_cents, gst, sort) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  lines.forEach((l, i) => insert.run(id, l.kind, l.description, l.qty, l.unit_cents, l.gst ? 1 : 0, i));
}

module.exports = { open, nextNumber, getLines, saveLines };
