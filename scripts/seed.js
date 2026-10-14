// Fills an empty database with a few made-up customers so you can try the app.
// Usage: npm run seed   (refuses to run if there are already customers)
process.env.TZ = process.env.TZ || 'Australia/Sydney';
const { open, nextNumber, saveLines } = require('../lib/db');
const { now, today, addDays } = require('../lib/util');

const db = open();
if (db.prepare('SELECT COUNT(*) AS n FROM customers').get().n > 0) {
  console.log('Database already has customers; not seeding.');
  process.exit(0);
}

const t = today();
db.transaction(() => {
  db.prepare(
    `UPDATE settings SET business_name = 'Demo Motors', abn = '12 345 678 901', phone = '07 5555 0100',
       address = '1 Example St\nSpringfield QLD 4000', bank_details = 'BSB 000-000  Acc 12345678  Demo Motors'
     WHERE id = 1`
  ).run();

  const addCustomer = db.prepare('INSERT INTO customers (name, phone, email, created_at) VALUES (?, ?, ?, ?)');
  const addVehicle = db.prepare(
    `INSERT INTO vehicles (customer_id, rego, make, model, year, odometer, next_service_date, rego_due, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const people = [
    ['Sam Taylor', '0412 345 678', 'sam@example.com', '123ABC', 'Toyota', 'Hilux', '2018', 142000, addDays(t, 10), addDays(t, 90)],
    ['Alex Nguyen', '0423 456 789', 'alex@example.com', 'XYZ789', 'Mazda', 'CX-5', '2020', 61000, addDays(t, 120), addDays(t, 14)],
    ['Jordan Smith', '0434 567 890', '', 'JS4WD', 'Ford', 'Ranger', '2016', 198500, addDays(t, -5), null],
  ];
  const vehicles = people.map(([name, phone, email, rego, make, model, year, odo, svc, regoDue]) => {
    const cid = addCustomer.run(name, phone, email, now()).lastInsertRowid;
    return { cid, vid: addVehicle.run(cid, rego, make, model, year, odo, svc, regoDue, now()).lastInsertRowid, odo };
  });

  const addBooking = db.prepare(
    `INSERT INTO bookings (customer_id, vehicle_id, date, time, duration_hours, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'booked', ?)`
  );
  addBooking.run(vehicles[0].cid, vehicles[0].vid, t, '08:00', 2, 'Logbook service 140k', now());
  addBooking.run(vehicles[1].cid, vehicles[1].vid, t, '10:30', 1, 'Brake noise front left', now());
  addBooking.run(vehicles[2].cid, vehicles[2].vid, addDays(t, 1), '09:00', 3, 'Timing belt', now());

  // One finished, invoiced job from last week.
  const v = vehicles[2];
  const jobId = db
    .prepare(
      `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, tech_notes, odometer, created_at, completed_at)
       VALUES (?, ?, ?, 'invoiced', 'Major service', 'Rear pads 30% left, recommend replacing next service.', ?, ?, ?)`
    )
    .run(nextNumber(db, 'job'), v.cid, v.vid, v.odo, addDays(t, -7) + ' 08:00:00', addDays(t, -7) + ' 15:00:00').lastInsertRowid;
  const lines = [
    { kind: 'labour', description: 'Labour', qty: 2.5, unit_cents: 12000, gst: 1 },
    { kind: 'part', description: 'Engine oil 15W-40 7L', qty: 1, unit_cents: 6800, gst: 1 },
    { kind: 'part', description: 'Oil filter', qty: 1, unit_cents: 2200, gst: 1 },
    { kind: 'part', description: 'Fuel filter', qty: 1, unit_cents: 5400, gst: 1 },
  ];
  saveLines(db, 'job', jobId, lines);
  const docId = db
    .prepare(
      `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
       VALUES ('invoice', ?, ?, ?, ?, ?, ?, 'issued', ?, 'Major service', ?)`
    )
    .run(nextNumber(db, 'invoice'), v.cid, v.vid, jobId, addDays(t, -7), addDays(t, 0), v.odo, now()).lastInsertRowid;
  saveLines(db, 'document', docId, lines);
})();

console.log('Added demo customers, bookings and an invoice.');
