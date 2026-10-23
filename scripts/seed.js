// Adds a demo workshop with made-up customers so you can try the app.
// Usage: npm run seed   then log in as demo@example.com / demo-password
// (or as the technician, tech@example.com / demo-password)
const { createStore, nextNumber, saveLines } = require('../lib/db');
const { hashPassword } = require('../lib/auth');
const { now, today, addDays } = require('../lib/util');

const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password';
const TECH_EMAIL = 'tech@example.com';

// Adds the demo workshop if it isn't there yet. Safe to run on every boot (SEED_DEMO=1).
async function seedDemo(store) {
  if (await store.system.get('SELECT id FROM users WHERE email = $1', [EMAIL])) {
    console.log(`Demo workshop already exists. Log in as ${EMAIL} / ${PASSWORD}`);
    await seedTech(store);
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

    const mick = await db.get(`SELECT id FROM users WHERE email = 'mick@example.com'`);
    await seedHistory(db, vehicles, mick.id, t);
  });
  await seedTech(store);
  console.log(`Added the demo workshop. Log in as ${EMAIL} / ${PASSWORD}`);
  return true;
}

// A technician login with a few jobs of their own, added to the demo workshop if it doesn't have one yet.
async function seedTech(store) {
  const owner = await store.system.get('SELECT workshop_id FROM users WHERE email = $1', [EMAIL]);
  if (!owner || (await store.system.get('SELECT id FROM users WHERE email = $1', [TECH_EMAIL]))) return;
  const tech = await store.system.get(
    `INSERT INTO users (workshop_id, name, email, password_hash, role) VALUES ($1, 'Jess Carter', $2, $3, 'tech') RETURNING id`,
    [owner.workshop_id, TECH_EMAIL, hashPassword(PASSWORD)]
  );
  const t = today();
  await store.tenant(owner.workshop_id).tx(async (db) => {
    const vehicle = (rego) => db.get('SELECT id, customer_id, odometer FROM vehicles WHERE rego = $1', [rego]);
    // The starter procedures, so tasks can point at "how we do it here".
    if (!(await db.get('SELECT id FROM procedures LIMIT 1'))) {
      for (const p of require('../routes/team').STARTER_PROCEDURES) {
        await db.run('INSERT INTO procedures (title, category, body) VALUES ($1, $2, $3)', [p.title, p.category, p.body]);
      }
    }
    const brakes = await db.get(`SELECT id FROM procedures WHERE title = 'Estimating extra work'`);
    const work = [
      ['123ABC', 'in_progress', 'Logbook service 140k. Customer mentions a squeak from the front over bumps.', 'normal', t, '15:00',
        ['Drain and refill engine oil', 'Replace oil and air filters', 'Check front suspension bushes for the squeak', 'Top up fluids and reset service light', 'Road test']],
      ['XYZ789', 'open', 'Brake noise front left. Check pads and rotors, quote if they need doing.', 'urgent', t, '12:00',
        ['Inspect front pads and rotors', 'Photograph anything worn', 'Ring the office with a price before going ahead']],
      ['JS4WD', 'open', 'Timing belt and water pump.', 'normal', addDays(t, 1), '16:00',
        ['Replace timing belt kit', 'Replace water pump', 'Bleed cooling system']],
    ];
    for (const [rego, status, desc, priority, due, time, tasks] of work) {
      const v = await vehicle(rego);
      if (!v) continue;
      const job = await db.get(
        `INSERT INTO jobs (number, customer_id, vehicle_id, mechanic_id, status, description, priority, due_date, due_time, odometer, created_at, is_service)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [await nextNumber(db, 'job'), v.customer_id, v.id, tech.id, status, desc, priority, due, time, v.odometer, now(), /service/i.test(desc)]
      );
      for (const [i, text] of tasks.entries()) {
        await db.run(
          `INSERT INTO job_tasks (job_id, text, sort, procedure_id, done_at, done_by) VALUES ($1, $2, $3, $4, $5, $6)`,
          [job.id, text, i, /^Ring the office/.test(text) && brakes ? brakes.id : null, status === 'in_progress' && i < 2 ? new Date() : null, status === 'in_progress' && i < 2 ? tech.id : null]
        );
      }
      await db.run(`INSERT INTO job_events (job_id, user_id, kind, text) VALUES ($1, $2, 'mechanic', 'Assigned to Jess Carter')`, [job.id, tech.id]);
    }
  });
  console.log(`Added a technician login: ${TECH_EMAIL} / ${PASSWORD}`);
}

// A year of finished work and a few cars on the floor, so the Today page's charts have something to show.
async function seedHistory(db, vehicles, mickId, t) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const WORK = [
    ['Logbook service', 1.5, [['Engine oil 5W-30 6L', 6200], ['Oil filter', 2200], ['Air filter', 3400]]],
    ['Front brake pads and rotors', 2, [['Brake pads front', 9800], ['Rotors front (pair)', 18400]]],
    ['Major service', 3, [['Engine oil 15W-40 7L', 6800], ['Oil filter', 2200], ['Fuel filter', 5400], ['Spark plugs (4)', 7600]]],
    ['Battery replacement', 0.5, [['Battery 600CCA', 21900]]],
    ['Diagnose warning light', 1, []],
    ['Timing belt kit', 4.5, [['Timing belt kit', 38500], ['Water pump', 14200]]],
    ['Wheel alignment and tyres', 1, [['Tyre 265/65R17', 24500], ['Tyre 265/65R17', 24500]]],
  ];
  const at = (day, hour) => `${day} ${String(hour).padStart(2, '0')}:00:00`;

  // Finished, invoiced jobs over the past year; busier lately.
  for (let back = 360; back >= 1; back -= 1) {
    const day = addDays(t, -back);
    const dow = new Date(day + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6 || rand() > 0.35 + (360 - back) / 1200) continue;
    const v = pick(vehicles);
    const [desc, hours, parts] = pick(WORK);
    const job = await db.get(
      `INSERT INTO jobs (number, customer_id, vehicle_id, mechanic_id, status, description, created_at, completed_at)
       VALUES ($1, $2, $3, $4, 'invoiced', $5, $6, $7) RETURNING id`,
      [await nextNumber(db, 'job'), v.cid, v.vid, mickId, desc, at(day, 8), at(day, 15)]
    );
    const lines = [{ kind: 'labour', description: 'Labour', qty: hours, unit_cents: 12000, gst: true }, ...parts.map(([d, c]) => ({ kind: 'part', description: d, qty: 1, unit_cents: c, gst: true }))];
    if (rand() < 0.3) lines.push({ kind: 'other', description: 'Workshop consumables', qty: 1, unit_cents: 1500, gst: true });
    await saveLines(db, 'job', job.id, lines);
    // Time on the clock lands either side of the estimate.
    const worked = hours * (0.75 + rand() * 0.45);
    await db.run(`INSERT INTO time_entries (job_id, user_id, started_at, ended_at, billed) VALUES ($1, $2, $3::timestamptz, $3::timestamptz + make_interval(mins => $4), true)`, [
      job.id, mickId, at(day, 9), Math.round(worked * 60),
    ]);
    const doc = await db.get(
      `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, notes, created_at)
       VALUES ('invoice', $1, $2, $3, $4, $5, $6, 'issued', $7, $8) RETURNING id`,
      [await nextNumber(db, 'invoice'), v.cid, v.vid, job.id, day, addDays(day, 7), desc, at(day, 15)]
    );
    await saveLines(db, 'document', doc.id, lines);
    // Most pay on pickup or within the week; a few recent ones are still owing.
    if (back > 25 || rand() < 0.6) {
      const paidOn = addDays(day, rand() < 0.7 ? 0 : 1 + Math.floor(rand() * 5));
      const total = lines.reduce((s, l) => s + Math.round(l.qty * l.unit_cents * 1.1), 0);
      await db.run(`INSERT INTO payments (document_id, date, amount_cents, method, created_at) VALUES ($1, $2, $3, $4, $5)`, [
        doc.id, paidOn > t ? t : paidOn, total, pick(['card', 'eft', 'cash']), at(day, 16),
      ]);
    }
  }

  // Cars on the floor today.
  const floor = [
    [vehicles[0], 'in_progress', 'Clutch replacement', 'urgent', 5],
    [vehicles[1], 'waiting_parts', 'Replace front struts', 'normal', 3],
    [vehicles[2], 'ready', 'Pre-purchase inspection', 'normal', 1],
  ];
  for (const [v, status, desc, priority, hours] of floor) {
    const job = await db.get(
      `INSERT INTO jobs (number, customer_id, vehicle_id, mechanic_id, status, description, priority, due_date, due_time, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '16:00', $9) RETURNING id`,
      [await nextNumber(db, 'job'), v.cid, v.vid, mickId, status, desc, priority, status === 'ready' ? t : addDays(t, 1), at(addDays(t, -1), 8)]
    );
    await saveLines(db, 'job', job.id, [{ kind: 'labour', description: 'Labour', qty: hours, unit_cents: 12000, gst: true }]);
    await db.run(`INSERT INTO job_events (job_id, user_id, kind, text, at) VALUES ($1, $2, 'created', 'Job opened', now() - interval '26 hours')`, [job.id, mickId]);
    await db.run(`INSERT INTO job_events (job_id, user_id, kind, text, at) VALUES ($1, $2, 'mechanic', 'Assigned to Mick', now() - interval '25 hours')`, [job.id, mickId]);
    if (status !== 'open') {
      await db.run(`INSERT INTO job_events (job_id, user_id, kind, text, at) VALUES ($1, $2, 'status', $3, now() - make_interval(mins => $4))`, [
        job.id, mickId, `Status changed to ${{ in_progress: 'In progress', waiting_parts: 'Waiting on parts', ready: 'Ready for pickup' }[status]}`, { in_progress: 42, waiting_parts: 180, ready: 95 }[status],
      ]);
    }
  }
  const strut = await db.get(`SELECT id FROM jobs WHERE status = 'waiting_parts' LIMIT 1`);
  await db.run(`INSERT INTO job_events (job_id, user_id, kind, text, at) VALUES ($1, $2, 'note', 'Struts on order from Repco, due tomorrow morning', now() - interval '150 minutes')`, [strut.id, mickId]);
  await db.run(`INSERT INTO team_posts (user_id, text) VALUES ($1, 'Order more 5W-30, down to the last drum'), ($1, 'Hoist 2 safety check due Friday')`, [mickId]);
}

module.exports = { seedDemo, seedTech, EMAIL, PASSWORD, TECH_EMAIL };

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
