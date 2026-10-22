// Adds demo workshops with made-up customers so you can try the app, one per type of workshop.
// Usage: npm run seed   then log in as demo@example.com / demo-password (a car workshop),
// or demo-marine@example.com, demo-truck@example.com and so on for the other types.
const { createStore, nextNumber, saveLines } = require('../lib/db');
const { hashPassword } = require('../lib/auth');
const { now, today, addDays } = require('../lib/util');
const { TYPE_KEYS, typeFor, addStarterItems, addStarterProcedures } = require('../lib/verticals');

const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password';

const emailFor = (type) => (type === 'mechanical' ? EMAIL : `demo-${type}@example.com`);

// Adds one type's demo workshop if it isn't there yet.
async function seedType(store, type) {
  const email = emailFor(type);
  if (await store.system.get('SELECT id FROM users WHERE email = $1', [email])) return false;
  const demo = typeFor(type).demo;
  const ws = await store.system.get(`INSERT INTO workshops (name) VALUES ($1) RETURNING id`, [demo.business]);
  const owner = await store.system.get(
    `INSERT INTO users (workshop_id, name, email, password_hash, role) VALUES ($1, 'Demo Owner', $2, $3, 'owner') RETURNING id`,
    [ws.id, email, hashPassword(PASSWORD)]
  );
  const staffEmail = type === 'mechanical' ? 'mick@example.com' : `mick-${type}@example.com`;
  await store.system.run(`INSERT INTO users (workshop_id, name, email, password_hash, role) VALUES ($1, 'Mick', $2, $3, 'staff')`, [
    ws.id,
    staffEmail,
    hashPassword(PASSWORD),
  ]);

  const t = today();
  await store.tenant(ws.id).tx(async (db) => {
    await db.run(
      `INSERT INTO settings (business_name, workshop_type, abn, phone, address, bank_details)
       VALUES ($1, $2, '12 345 678 901', '07 5555 0100', E'1 Example St\\nSpringfield QLD 4000', $3)`,
      [demo.business, type, `BSB 000-000  Acc 12345678  ${demo.business}`]
    );
    await addStarterItems(db, type);
    await addStarterProcedures(db, type, owner.id);
    const { interval } = typeFor(type);
    // Due dates spread so the Today screen and Reminders have something on them.
    const dates = [
      [addDays(t, 10), addDays(t, 90)],
      [addDays(t, 120), addDays(t, 14)],
      [addDays(t, -5), null],
    ];
    const vehicles = [];
    const customers = {};
    for (const [i, [name, phone, email, rego, make, model, year, meter, vin]] of demo.people.entries()) {
      // A fleet customer can appear more than once; their vehicles share one customer.
      if (!customers[name]) {
        const c = await db.get('INSERT INTO customers (name, phone, email, kind, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
          name,
          phone,
          email,
          /Pty Ltd|Co$/.test(name) ? 'company' : 'individual',
          now(),
        ]);
        customers[name] = c.id;
      }
      const [svc, regoDue] = dates[i % dates.length];
      const v = await db.get(
        `INSERT INTO vehicles (customer_id, rego, make, model, year, vin, odometer, next_service_date, rego_due,
           service_interval_months, service_interval_km, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [customers[name], rego, make, model, year, vin || '', meter, svc, rego ? regoDue : null, interval.months, interval.meter, now()]
      );
      await db.run('INSERT INTO vehicle_owners (vehicle_id, customer_id, from_at) VALUES ($1, $2, $3)', [v.id, customers[name], now()]);
      vehicles.push({ cid: customers[name], vid: v.id, odo: meter });
    }
    const book = (v, date, time, hours, desc) =>
      db.run(
        `INSERT INTO bookings (customer_id, vehicle_id, date, time, duration_hours, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [v.cid, v.vid, date, time, hours, desc, now()]
      );
    await book(vehicles[0], t, '08:00', 2, demo.bookings[0]);
    await book(vehicles[1], t, '10:30', 1, demo.bookings[1]);
    await book(vehicles[2], addDays(t, 1), '09:00', 3, demo.bookings[2]);

    // One finished, invoiced job from last week.
    const v = vehicles[2];
    const job = await db.get(
      `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, tech_notes, odometer, created_at, completed_at, is_service)
       VALUES ($1, $2, $3, 'invoiced', $4, $5, $6, $7, $8, true) RETURNING id`,
      [await nextNumber(db, 'job'), v.cid, v.vid, demo.job.description, demo.job.notes, v.odo, addDays(t, -7) + ' 08:00:00', addDays(t, -7) + ' 15:00:00']
    );
    const lines = demo.job.lines.map(([kind, description, qty, unit_cents]) => ({ kind, description, qty, unit_cents, gst: true }));
    await saveLines(db, 'job', job.id, lines);
    const doc = await db.get(
      `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
       VALUES ('invoice', $1, $2, $3, $4, $5, $6, 'issued', $7, $8, $9) RETURNING id`,
      [await nextNumber(db, 'invoice'), v.cid, v.vid, job.id, addDays(t, -7), t, v.odo, demo.job.description, now()]
    );
    await saveLines(db, 'document', doc.id, lines);
  });
  console.log(`Added ${demo.business}. Log in as ${email} / ${PASSWORD}`);
  return true;
}

// Adds any demo workshop that isn't there yet. Safe to run on every boot (SEED_DEMO=1).
async function seedDemo(store) {
  let added = false;
  for (const type of TYPE_KEYS) added = (await seedType(store, type)) || added;
  if (!added) console.log(`Demo workshops already exist. Log in as ${EMAIL} / ${PASSWORD}`);
  return added;
}

module.exports = { seedDemo, emailFor, EMAIL, PASSWORD };

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
