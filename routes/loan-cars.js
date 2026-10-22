const { requireOwner } = require('../lib/auth');
const { addDays, parseIntOrNull } = require('../lib/util');
const { getCustomer, logEvent } = require('../lib/records');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FUEL = ['E', '1/4', '1/2', '3/4', 'F'];
const LOAN_STATUSES = { booked: 'Booked', out: 'Out', returned: 'Returned', cancelled: 'Cancelled' };
const DEFAULT_TERMS = `1. The driver must hold a current, full driver's licence and be the person named on this agreement.
2. The vehicle is for the driver's own use while their car is with us, and must be returned by the agreed date with the same fuel level.
3. The driver is responsible for all traffic, toll, speeding and parking fines and charges while they have the vehicle, and agrees to their details being given to the issuing authority.
4. The driver must report any accident or damage straight away. The driver pays the insurance excess for any damage while they have the vehicle.
5. No smoking, pets, towing, or carrying more people than there are seatbelts.
6. Unpaid fuel, cleaning, tolls or fines may be added to the driver's invoice.`;

const carLabel = (c) => [c.rego, [c.make, c.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');

const LOAN_SELECT = `
  SELECT l.*, lc.rego AS car_rego, lc.make AS car_make, lc.model AS car_model, lc.colour AS car_colour,
    c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.address AS customer_address,
    j.number AS job_number, uo.name AS out_by_name, ub.name AS back_by_name
  FROM loans l JOIN loan_cars lc ON lc.id = l.loan_car_id JOIN customers c ON c.id = l.customer_id
  LEFT JOIN jobs j ON j.id = l.job_id LEFT JOIN users uo ON uo.id = l.out_by LEFT JOIN users ub ON ub.id = l.back_by`;

// Another loan of this car in the way of these days: a booking that overlaps them,
// or the car being out (it's not free again until it's checked back in).
function clash(db, carId, start, due, exceptId = 0) {
  return db.get(
    `SELECT l.*, c.name AS customer_name FROM loans l JOIN customers c ON c.id = l.customer_id
     WHERE l.loan_car_id = $1 AND l.id != $2 AND l.start_date <= $4
       AND (l.status = 'out' OR (l.status = 'booked' AND l.due_date >= $3))
     ORDER BY l.status = 'out' DESC LIMIT 1`,
    [carId, exceptId, start, due]
  );
}

function fuelOrBlank(v) {
  return FUEL.includes(v) ? v : '';
}

module.exports = function (app, { store }) {
  // The fleet, what's out now, what's coming up, and a fortnight of availability.
  app.get('/loan-cars', async (req, res) => {
    const today = res.locals.today;
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : today;
    const days = Array.from({ length: 14 }, (_, i) => addDays(from, i));
    const [cars, loans] = await Promise.all([
      req.db.all('SELECT * FROM loan_cars WHERE active ORDER BY lower(rego)'),
      req.db.all(`${LOAN_SELECT} WHERE l.status IN ('booked', 'out') ORDER BY l.start_date, l.id`),
    ]);
    // Who had a car on a given day, for a fine or toll that arrives later.
    const on = DATE_RE.test(req.query.on || '') ? req.query.on : '';
    const who = on
      ? await req.db.all(
          `${LOAN_SELECT} WHERE l.status IN ('out', 'returned') AND l.start_date <= $1
             AND COALESCE((l.back_at AT TIME ZONE $2)::date::text, $3) >= $1 ORDER BY lc.rego`,
          [on, req.tz, today]
        )
      : null;
    for (const car of cars) {
      car.days = days.map((d) => {
        const l = loans.find(
          (x) => x.loan_car_id === car.id && x.start_date <= d && (x.status === 'out' ? (x.due_date >= d || d <= today) : x.due_date >= d)
        );
        return { date: d, loan: l || null };
      });
      car.current = loans.find((x) => x.loan_car_id === car.id && x.status === 'out') || null;
    }
    res.render('loan-cars/index', {
      cars,
      days,
      from,
      loans,
      on,
      who,
      carLabel,
      LOAN_STATUSES,
      overdue: loans.filter((l) => l.status === 'out' && l.due_date < today),
    });
  });

  // Owners and staff alike keep the fleet up to date.
  app.get('/loan-cars/new', (req, res) => res.render('loan-cars/car-form', { car: {}, error: null }));
  app.get('/loan-cars/:id/edit', async (req, res, next) => {
    const car = await req.db.get('SELECT * FROM loan_cars WHERE id = $1', [req.params.id]);
    if (!car) return next();
    res.render('loan-cars/car-form', { car, error: null });
  });

  async function saveCar(req, res, id) {
    const g = (k, max = 200) => String(req.body[k] ?? '').trim().slice(0, max);
    const car = { rego: g('rego', 12).toUpperCase(), make: g('make'), model: g('model'), colour: g('colour', 40), odometer: parseIntOrNull(req.body.odometer), notes: g('notes', 2000) };
    if (!car.rego) return res.status(400).render('loan-cars/car-form', { car: { ...car, id }, error: 'Enter the rego.' });
    if (id) {
      const r = await req.db.get(
        'UPDATE loan_cars SET rego = $1, make = $2, model = $3, colour = $4, odometer = $5, notes = $6, active = $7 WHERE id = $8 RETURNING id',
        [car.rego, car.make, car.model, car.colour, car.odometer, car.notes, req.body.active !== '0', id]
      );
      if (!r) return null;
    } else {
      await req.db.run('INSERT INTO loan_cars (rego, make, model, colour, odometer, notes) VALUES ($1, $2, $3, $4, $5, $6)', [
        car.rego, car.make, car.model, car.colour, car.odometer, car.notes,
      ]);
    }
    return res.redirect('/loan-cars');
  }
  app.post('/loan-cars', (req, res) => saveCar(req, res, null));
  app.post('/loan-cars/:id', async (req, res, next) => (await saveCar(req, res, Number(req.params.id))) || next());

  // Booking a loan car, usually from a job.
  async function renderLoanForm(req, res, loan, error) {
    const [cars, customers, job] = await Promise.all([
      req.db.all('SELECT * FROM loan_cars WHERE active ORDER BY lower(rego)'),
      req.db.all('SELECT id, name, phone FROM customers WHERE archived_at IS NULL ORDER BY lower(name)'),
      loan.job_id ? req.db.get('SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = $1', [loan.job_id]) : null,
    ]);
    res.render('loan-cars/loan-form', { loan, cars, customers, job, error, carLabel });
  }

  app.get('/loans/new', async (req, res) => {
    const job = parseIntOrNull(req.query.job_id) ? await req.db.get('SELECT * FROM jobs WHERE id = $1', [parseIntOrNull(req.query.job_id)]) : null;
    const start = DATE_RE.test(req.query.date || '') ? req.query.date : res.locals.today;
    renderLoanForm(req, res, {
      job_id: job ? job.id : null,
      customer_id: job ? job.customer_id : parseIntOrNull(req.query.customer_id),
      loan_car_id: parseIntOrNull(req.query.car_id),
      start_date: start,
      due_date: job && job.due_date && job.due_date >= start ? job.due_date : start,
    }, null);
  });

  app.post('/loans', async (req, res) => {
    const loan = {
      loan_car_id: parseIntOrNull(req.body.loan_car_id),
      customer_id: parseIntOrNull(req.body.customer_id),
      job_id: parseIntOrNull(req.body.job_id),
      start_date: DATE_RE.test(req.body.start_date || '') ? req.body.start_date : res.locals.today,
      due_date: DATE_RE.test(req.body.due_date || '') ? req.body.due_date : '',
    };
    if (!loan.due_date || loan.due_date < loan.start_date) loan.due_date = loan.start_date;
    const car = loan.loan_car_id ? await req.db.get('SELECT * FROM loan_cars WHERE id = $1 AND active', [loan.loan_car_id]) : null;
    const job = loan.job_id ? await req.db.get('SELECT * FROM jobs WHERE id = $1', [loan.job_id]) : null;
    if (job) loan.customer_id = job.customer_id;
    else loan.job_id = null;
    const customer = loan.customer_id ? await getCustomer(req.db, loan.customer_id) : null;
    if (!car) return renderLoanForm(req, res.status(400), loan, 'Pick a loan car.');
    if (!customer) return renderLoanForm(req, res.status(400), loan, 'Pick the customer.');
    const other = await clash(req.db, car.id, loan.start_date, loan.due_date);
    if (other) {
      return renderLoanForm(req, res.status(409), loan, `${car.rego} is ${other.status === 'out' ? 'out with' : 'booked for'} ${other.customer_name} until ${other.due_date.split('-').reverse().join('/')}. Pick another car or other days.`);
    }
    const row = await req.db.get(
      'INSERT INTO loans (loan_car_id, customer_id, job_id, start_date, due_date) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [car.id, customer.id, loan.job_id, loan.start_date, loan.due_date]
    );
    if (loan.job_id) await logEvent(req.db, loan.job_id, req.user.id, 'loan', `Loan car ${car.rego} booked for ${loan.start_date.split('-').reverse().join('/')}`);
    res.redirect(`/loans/${row.id}`);
  });

  app.get('/loans/:id', async (req, res, next) => {
    const loan = await req.db.get(`${LOAN_SELECT} WHERE l.id = $1`, [req.params.id]);
    if (!loan) return next();
    const car = await req.db.get('SELECT * FROM loan_cars WHERE id = $1', [loan.loan_car_id]);
    res.render('loan-cars/loan', { loan, car, FUEL, LOAN_STATUSES, carLabel, terms: res.locals.settings.loan_terms || DEFAULT_TERMS, error: String(req.query.error || '').slice(0, 200) });
  });

  const fail = (res, id, msg) => res.redirect(`/loans/${id}?error=${encodeURIComponent(msg)}`);

  // Handing over the keys: licence, odometer, fuel and the customer agreeing to the terms.
  app.post('/loans/:id/out', async (req, res, next) => {
    const loan = await req.db.get('SELECT * FROM loans WHERE id = $1', [req.params.id]);
    if (!loan) return next();
    if (loan.status !== 'booked') return res.redirect(`/loans/${loan.id}`);
    const licence = String(req.body.licence_no || '').trim().slice(0, 40);
    if (!licence) return fail(res, loan.id, "Enter the driver's licence number.");
    if (req.body.terms !== '1') return fail(res, loan.id, 'The customer needs to agree to the terms.');
    const expiry = DATE_RE.test(req.body.licence_expiry || '') ? req.body.licence_expiry : null;
    if (expiry && expiry < res.locals.today) return fail(res, loan.id, 'That licence has expired.');
    const other = await clash(req.db, loan.loan_car_id, res.locals.today, loan.due_date, loan.id);
    if (other && other.status === 'out') return fail(res, loan.id, `That car is still out with ${other.customer_name}. Check it in first.`);
    const odo = parseIntOrNull(req.body.odometer);
    await req.db.tx(async (db) => {
      await db.run(
        `UPDATE loans SET status = 'out', licence_no = $1, licence_expiry = $2, terms_agreed_at = now(), out_at = now(),
           out_odometer = $3, out_fuel = $4, out_notes = $5, out_by = $6, start_date = LEAST(start_date, $7) WHERE id = $8`,
        [licence, expiry, odo, fuelOrBlank(req.body.fuel), String(req.body.notes || '').trim().slice(0, 2000), req.user.id, res.locals.today, loan.id]
      );
      if (odo !== null) await db.run('UPDATE loan_cars SET odometer = $1 WHERE id = $2', [odo, loan.loan_car_id]);
      if (loan.job_id) await logEvent(db, loan.job_id, req.user.id, 'loan', 'Loan car handed over');
    });
    res.redirect(`/loans/${loan.id}`);
  });

  app.post('/loans/:id/back', async (req, res, next) => {
    const loan = await req.db.get('SELECT * FROM loans WHERE id = $1', [req.params.id]);
    if (!loan) return next();
    if (loan.status !== 'out') return res.redirect(`/loans/${loan.id}`);
    const odo = parseIntOrNull(req.body.odometer);
    if (odo !== null && loan.out_odometer !== null && odo < loan.out_odometer) return fail(res, loan.id, 'The odometer is lower than when it went out.');
    await req.db.tx(async (db) => {
      await db.run(
        `UPDATE loans SET status = 'returned', back_at = now(), back_odometer = $1, back_fuel = $2, back_notes = $3, back_by = $4 WHERE id = $5`,
        [odo, fuelOrBlank(req.body.fuel), String(req.body.notes || '').trim().slice(0, 2000), req.user.id, loan.id]
      );
      if (odo !== null) await db.run('UPDATE loan_cars SET odometer = $1 WHERE id = $2', [odo, loan.loan_car_id]);
      if (loan.job_id) await logEvent(db, loan.job_id, req.user.id, 'loan', 'Loan car returned');
    });
    res.redirect(`/loans/${loan.id}`);
  });

  app.post('/loans/:id/cancel', async (req, res, next) => {
    const r = await req.db.get(`UPDATE loans SET status = 'cancelled' WHERE id = $1 AND status = 'booked' RETURNING id`, [req.params.id]);
    if (!r) return next();
    res.redirect('/loan-cars');
  });

  // The agreement to print and sign at handover.
  app.get('/loans/:id/print', async (req, res, next) => {
    const loan = await req.db.get(`${LOAN_SELECT} WHERE l.id = $1`, [req.params.id]);
    if (!loan) return next();
    res.render('loan-cars/print', { loan, carLabel, terms: res.locals.settings.loan_terms || DEFAULT_TERMS });
  });

  app.post('/settings/loan-terms', requireOwner, async (req, res) => {
    await req.db.run('UPDATE settings SET loan_terms = $1', [String(req.body.loan_terms || '').trim().slice(0, 10000)]);
    res.redirect('/loan-cars?saved=1');
  });

};

// The job card's loan car line.
module.exports.jobLoans = (db, jobId) => db.all(`${LOAN_SELECT} WHERE l.job_id = $1 AND l.status != 'cancelled' ORDER BY l.id`, [jobId]);
module.exports.DEFAULT_TERMS = DEFAULT_TERMS;
