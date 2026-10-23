const { addDays, addMonths, mondayOf } = require('../lib/util');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// Kinds of thing that can sit on the calendar beside bookings and jobs.
const ENTRY_KINDS = {
  leave: 'Staff leave',
  holiday: 'Public holiday',
  toolbox: 'Toolbox talk',
  note: 'Note',
};

function entryFrom(body, today) {
  const g = (k) => String(body[k] ?? '').trim();
  const start = DATE_RE.test(g('start_date')) ? g('start_date') : today;
  let end = DATE_RE.test(g('end_date')) ? g('end_date') : start;
  if (end < start) end = start;
  return {
    kind: ENTRY_KINDS[g('kind')] ? g('kind') : 'note',
    title: g('title').slice(0, 120),
    user_id: Number(g('user_id')) || null,
    start_date: start,
    end_date: end,
    note: g('note').slice(0, 2000),
  };
}

// Lay events out in lanes so multi-day bars never overlap within a week.
function laneWeek(events, weekStart, weekEnd, maxLanes) {
  const inWeek = events
    .filter((e) => e.start <= weekEnd && e.end >= weekStart)
    .map((e) => ({ ...e, s: e.start < weekStart ? weekStart : e.start, e: e.end > weekEnd ? weekEnd : e.end }))
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : b.e < a.e ? -1 : b.e > a.e ? 1 : a.order - b.order));
  const laneEnds = [];
  const shown = [];
  const more = {};
  for (const ev of inWeek) {
    let lane = laneEnds.findIndex((end) => end < ev.s);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = ev.e;
    const col = dayIndex(weekStart, ev.s) + 1;
    const span = dayIndex(ev.s, ev.e) + 1;
    if (lane < maxLanes) shown.push({ ...ev, lane, col, span, continues: ev.end > weekEnd, continued: ev.start < weekStart });
    else for (let i = 0; i < span; i++) more[col + i] = (more[col + i] || 0) + 1;
  }
  return { events: shown, lanes: Math.min(laneEnds.length, maxLanes), more };
}

function dayIndex(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

async function loadEvents(req, from, to) {
  const db = req.db;
  const today = req.res.locals.today;
  const [bookings, jobs, entries] = await Promise.all([
    db.all(
      `SELECT b.id, b.date, b.time, b.status, b.job_id, b.description, c.name AS customer_name, v.rego, v.make, v.model
       FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN vehicles v ON v.id = b.vehicle_id
       WHERE b.date BETWEEN $1 AND $2 AND b.status != 'cancelled' ORDER BY b.date, b.time = '', b.time`,
      [from, to]
    ),
    db.all(
      `SELECT j.id, j.number, j.status, j.description, j.due_date, j.priority, j.mechanic_id, substr(j.created_at, 1, 10) AS start_day,
         substr(j.completed_at, 1, 10) AS done_day, c.name AS customer_name, v.rego, v.make, v.model, m.name AS mechanic_name
       FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
       LEFT JOIN users m ON m.id = j.mechanic_id
       WHERE j.status != 'cancelled' AND substr(j.created_at, 1, 10) <= $2
         AND GREATEST(substr(j.created_at, 1, 10), COALESCE(j.due_date, ''), COALESCE(substr(j.completed_at, 1, 10), ''),
                      CASE WHEN j.status = 'invoiced' THEN '' ELSE $3 END) >= $1
       ORDER BY j.created_at`,
      [from, to, today]
    ),
    db.all(
      `SELECT e.*, u.name AS user_name FROM calendar_entries e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.start_date <= $2 AND e.end_date >= $1 ORDER BY e.start_date, e.id`,
      [from, to]
    ),
  ]);
  const events = [];
  let order = 0;
  // Whole-day things first so holidays and leave sit at the top of a day.
  for (const e of entries) {
    const who = e.user_name ? e.user_name.split(' ')[0] : '';
    const label = e.kind === 'leave' ? `${who || 'Staff'} off${e.title ? ': ' + e.title : ''}` : e.title || ENTRY_KINDS[e.kind];
    events.push({ id: 'e' + e.id, kind: e.kind, start: e.start_date, end: e.end_date, label, href: `/calendar/${e.id}/edit`, order: order++ });
  }
  for (const j of jobs) {
    const open = j.status !== 'invoiced';
    const candidates = [j.start_day, j.due_date, j.done_day, open ? today : null].filter(Boolean);
    const end = candidates.reduce((a, b) => (a > b ? a : b));
    const title = [j.rego, j.make, j.model].filter(Boolean).join(' ') || j.customer_name;
    events.push({
      id: 'j' + j.id, kind: open ? 'job' : 'job done', start: j.start_day, end,
      label: `J${j.number} ${title}`, href: `/jobs/${j.id}`, order: order++, time: '',
    });
  }
  for (const b of bookings) {
    if (b.job_id) continue; // once the car is in, the job bar covers it
    const title = [b.rego, b.make, b.model].filter(Boolean).join(' ') || b.customer_name;
    events.push({ id: 'b' + b.id, kind: 'booking', start: b.date, end: b.date, label: `${b.time ? b.time + ' ' : ''}${title}`, href: `/bookings/${b.id}/edit`, order: order++ });
  }
  return { events, bookings, jobs, entries };
}

module.exports = function (app, { store }) {
  const staffOf = (req) => store.system.all('SELECT id, name FROM users WHERE workshop_id = $1 AND active ORDER BY lower(name)', [req.user.workshop_id]);

  app.get('/calendar', async (req, res) => {
    const today = res.locals.today;
    const month = MONTH_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
    const first = month + '-01';
    const gridStart = mondayOf(first);
    const nextFirst = addMonths(first, 1);
    const weeksNeeded = Math.ceil((dayIndex(gridStart, nextFirst)) / 7);
    const gridEnd = addDays(gridStart, weeksNeeded * 7 - 1);
    const { events } = await loadEvents(req, gridStart, gridEnd);
    const weeks = [];
    for (let w = 0; w < weeksNeeded; w++) {
      const ws = addDays(gridStart, w * 7);
      const we = addDays(ws, 6);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(ws, i);
        days.push({ date, inMonth: date.slice(0, 7) === month, isToday: date === today, num: Number(date.slice(8)) });
      }
      weeks.push({ start: ws, days, ...laneWeek(events, ws, we, 4) });
    }
    const [y, m] = month.split('-').map(Number);
    const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    res.render('calendar/index', { month, monthName, weeks, prev: addMonths(first, -1).slice(0, 7), next: nextFirst.slice(0, 7), ENTRY_KINDS });
  });

  app.get('/calendar/day/:date', async (req, res, next) => {
    const date = req.params.date;
    if (!DATE_RE.test(date)) return next();
    const { bookings, jobs, entries } = await loadEvents(req, date, date);
    const label = new Date(date + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    res.render('calendar/day', { date, label, bookings, jobs, entries, ENTRY_KINDS, prev: addDays(date, -1), next: addDays(date, 1) });
  });

  async function renderForm(req, res, entry, error) {
    res.render('calendar/form', { entry, staff: await staffOf(req), error, ENTRY_KINDS });
  }

  app.get('/calendar/new', (req, res) => {
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : res.locals.today;
    const kind = ENTRY_KINDS[req.query.kind] ? req.query.kind : 'leave';
    renderForm(req, res, { kind, title: '', user_id: req.user.id, start_date: date, end_date: date, note: '' }, null);
  });

  app.post('/calendar', async (req, res) => {
    const e = entryFrom(req.body, res.locals.today);
    if (e.kind !== 'leave') e.user_id = null;
    if (e.kind !== 'leave' && !e.title) return renderForm(req, res.status(400), e, 'Give it a title.');
    await req.db.run(
      `INSERT INTO calendar_entries (kind, title, user_id, start_date, end_date, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.kind, e.title, e.user_id, e.start_date, e.end_date, e.note, req.user.id]
    );
    res.redirect(`/calendar?month=${e.start_date.slice(0, 7)}`);
  });

  app.get('/calendar/:id/edit', async (req, res, next) => {
    const entry = await req.db.get('SELECT * FROM calendar_entries WHERE id = $1', [req.params.id]);
    if (!entry) return next();
    renderForm(req, res, entry, null);
  });

  app.post('/calendar/:id', async (req, res, next) => {
    const entry = await req.db.get('SELECT id FROM calendar_entries WHERE id = $1', [req.params.id]);
    if (!entry) return next();
    const e = entryFrom(req.body, res.locals.today);
    if (e.kind !== 'leave') e.user_id = null;
    if (e.kind !== 'leave' && !e.title) return renderForm(req, res.status(400), { ...e, id: entry.id }, 'Give it a title.');
    await req.db.run(
      `UPDATE calendar_entries SET kind = $1, title = $2, user_id = $3, start_date = $4, end_date = $5, note = $6 WHERE id = $7`,
      [e.kind, e.title, e.user_id, e.start_date, e.end_date, e.note, entry.id]
    );
    res.redirect(`/calendar?month=${e.start_date.slice(0, 7)}`);
  });

  app.post('/calendar/:id/delete', async (req, res) => {
    const entry = await req.db.get('SELECT start_date FROM calendar_entries WHERE id = $1', [req.params.id]);
    await req.db.run('DELETE FROM calendar_entries WHERE id = $1', [req.params.id]);
    res.redirect(`/calendar?month=${(entry ? entry.start_date : res.locals.today).slice(0, 7)}`);
  });
};

module.exports.ENTRY_KINDS = ENTRY_KINDS;
module.exports.laneWeek = laneWeek;
