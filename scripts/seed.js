// Adds a demo workshop with made-up customers so you can try the app.
// Usage: npm run seed   then log in as demo@example.com / demo-password
const { createStore, nextNumber, saveLines } = require('../lib/db');
const { hashPassword } = require('../lib/auth');
const { now, today, addDays } = require('../lib/util');

const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password';

// Adds the demo workshop if it isn't there yet. Safe to run on every boot (SEED_DEMO=1).
async function seedDemo(store) {
  if (await store.system.get('SELECT id FROM users WHERE email = $1', [EMAIL])) {
    console.log(`Demo workshop already exists. Log in as ${EMAIL} / ${PASSWORD}`);
    return false;
  }
  const ws = await store.system.get(`INSERT INTO workshops (name) VALUES ('Demo Motors') RETURNING id`);
  await store.system.run(`INSERT INTO users (workshop_id, name, email, password_hash, role) VALUES ($1, 'Demo Owner', $2, $3, 'owner')`, [
    ws.id,
    EMAIL,
    hashPassword(PASSWORD),
  ]);
  await store.system.run(`INSERT INTO users (workshop_id, name, email, password_hash, role) VALUES ($1, 'Mick', 'mick@example.com', $2, 'staff')`, [
    ws.id,
    hashPassword(PASSWORD),
  ]);

  const t = today();
  await store.tenant(ws.id).tx(async (db) => {
    await db.run(
      `INSERT INTO settings (business_name, abn, phone, address, bank_details)
       VALUES ('Demo Motors', '12 345 678 901', '07 5555 0100', E'1 Example St\\nSpringfield QLD 4000', 'BSB 000-000  Acc 12345678  Demo Motors')`
    );
    const people = [
      ['Sam Taylor', '0412 345 678', 'sam@example.com', '123ABC', 'Toyota', 'Hilux', '2018', 142000, addDays(t, 10), addDays(t, 90)],
      ['Alex Nguyen', '0423 456 789', 'alex@example.com', 'XYZ789', 'Mazda', 'CX-5', '2020', 61000, addDays(t, 120), addDays(t, 14)],
      ['Jordan Smith', '0434 567 890', '', 'JS4WD', 'Ford', 'Ranger', '2016', 198500, addDays(t, -5), null],
    ];
    const vehicles = [];
    for (const [name, phone, email, rego, make, model, year, odo, svc, regoDue] of people) {
      const c = await db.get('INSERT INTO customers (name, phone, email, created_at) VALUES ($1, $2, $3, $4) RETURNING id', [name, phone, email, now()]);
      const v = await db.get(
        `INSERT INTO vehicles (customer_id, rego, make, model, year, odometer, next_service_date, rego_due, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [c.id, rego, make, model, year, odo, svc, regoDue, now()]
      );
      vehicles.push({ cid: c.id, vid: v.id, odo });
    }
    const book = (v, date, time, hours, desc) =>
      db.run(
        `INSERT INTO bookings (customer_id, vehicle_id, date, time, duration_hours, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [v.cid, v.vid, date, time, hours, desc, now()]
      );
    await book(vehicles[0], t, '08:00', 2, 'Logbook service 140k');
    await book(vehicles[1], t, '10:30', 1, 'Brake noise front left');
    await book(vehicles[2], addDays(t, 1), '09:00', 3, 'Timing belt');

    // One finished, invoiced job from last week.
    const v = vehicles[2];
    const job = await db.get(
      `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, tech_notes, odometer, created_at, completed_at)
       VALUES ($1, $2, $3, 'invoiced', 'Major service', 'Rear pads 30% left, recommend replacing next service.', $4, $5, $6) RETURNING id`,
      [await nextNumber(db, 'job'), v.cid, v.vid, v.odo, addDays(t, -7) + ' 08:00:00', addDays(t, -7) + ' 15:00:00']
    );
    const lines = [
      { kind: 'labour', description: 'Labour', qty: 2.5, unit_cents: 12000, gst: true },
      { kind: 'part', description: 'Engine oil 15W-40 7L', qty: 1, unit_cents: 6800, gst: true },
      { kind: 'part', description: 'Oil filter', qty: 1, unit_cents: 2200, gst: true },
      { kind: 'part', description: 'Fuel filter', qty: 1, unit_cents: 5400, gst: true },
    ];
    await saveLines(db, 'job', job.id, lines);
    const doc = await db.get(
      `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
       VALUES ('invoice', $1, $2, $3, $4, $5, $6, 'issued', $7, 'Major service', $8) RETURNING id`,
      [await nextNumber(db, 'invoice'), v.cid, v.vid, job.id, addDays(t, -7), t, v.odo, now()]
    );
    await saveLines(db, 'document', doc.id, lines);
  });
  console.log(`Added the demo workshop. Log in as ${EMAIL} / ${PASSWORD}`);
  return true;
}

module.exports = { seedDemo, EMAIL, PASSWORD };

if (require.main === module) {
  (async () => {
    const store = createStore();
    await store.migrate();
    await seedDemo(store);
    await store.close();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
