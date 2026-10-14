const { addDays, mondayOf, minutesBetween } = require('../lib/util');
const { requireOwner } = require('../lib/auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const SHIFT_KINDS = { shift: 'Working', off: 'Day off', leave: 'On leave', rdo: 'RDO' };

// Minutes worked on a clock entry, breaks taken out (open entries run to now).
function workedMinutes(entry, breaks) {
  const total = minutesBetween(entry.started_at, entry.ended_at);
  const rest = breaks.filter((b) => b.entry_id === entry.id).reduce((s, b) => s + minutesBetween(b.started_at, b.ended_at || entry.ended_at), 0);
  return { total, rest, worked: Math.max(0, total - rest) };
}

async function clockState(db, userId) {
  const entry = await db.get('SELECT * FROM clock_entries WHERE user_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [userId]);
  if (!entry) return { entry: null, onBreak: null };
  const onBreak = await db.get('SELECT * FROM clock_breaks WHERE entry_id = $1 AND ended_at IS NULL', [entry.id]);
  return { entry, onBreak };
}

// The next rostered shift for someone, today's if it hasn't finished yet.
async function nextShift(db, userId, today, timeNow) {
  return db.get(
    `SELECT * FROM shifts WHERE user_id = $1 AND kind = 'shift' AND (date > $2 OR (date = $2 AND (end_time = '' OR end_time > $3)))
     ORDER BY date, start_time LIMIT 1`,
    [userId, today, timeNow]
  );
}

module.exports = function (app, { store }) {
  const staffOf = (req) => store.system.all('SELECT id, name, active FROM users WHERE workshop_id = $1 ORDER BY active DESC, lower(name)', [req.user.workshop_id]);

  app.get('/clocking', async (req, res) => {
    const db = req.db;
    const today = res.locals.today;
    const start = mondayOf(DATE_RE.test(req.query.week || '') ? req.query.week : today);
    const end = addDays(start, 6);
    const [state, entries, breaks, staff, shift, everyone] = await Promise.all([
      clockState(db, req.user.id),
      db.all(
        `SELECT *, to_char(started_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day FROM clock_entries
         WHERE user_id = $4 AND to_char(started_at AT TIME ZONE $3, 'YYYY-MM-DD') BETWEEN $1 AND $2 ORDER BY started_at DESC`,
        [start, end, req.tz, req.user.id]
      ),
      db.all(
        `SELECT b.* FROM clock_breaks b JOIN clock_entries e ON e.id = b.entry_id
         WHERE e.user_id = $4 AND to_char(e.started_at AT TIME ZONE $3, 'YYYY-MM-DD') BETWEEN $1 AND $2 ORDER BY b.started_at`,
        [start, end, req.tz, req.user.id]
      ),
      staffOf(req),
      nextShift(db, req.user.id, today, res.locals.timeNow),
      db.all(
        `SELECT e.user_id, e.started_at, (SELECT started_at FROM clock_breaks b WHERE b.entry_id = e.id AND b.ended_at IS NULL) AS break_started
         FROM clock_entries e WHERE e.ended_at IS NULL`
      ),
    ]);
    for (const e of entries) Object.assign(e, workedMinutes(e, breaks), { breaks: breaks.filter((b) => b.entry_id === e.id) });
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      days.push({ date, minutes: entries.filter((e) => e.day === date).reduce((s, e) => s + e.worked, 0) });
    }
    const team = staff.filter((s) => s.active).map((s) => ({ ...s, now: everyone.find((e) => e.user_id === s.id) || null }));
    res.render('clocking', {
      ...state, entries, days, start, prev: addDays(start, -7), next: addDays(start, 7), shift, team,
      weekMinutes: days.reduce((s, d) => s + d.minutes, 0),
    });
  });

  app.post('/clocking/start', async (req, res) => {
    const { entry } = await clockState(req.db, req.user.id);
    if (!entry) await req.db.run('INSERT INTO clock_entries (user_id) VALUES ($1)', [req.user.id]);
    res.redirect(req.body.back || '/clocking');
  });

  app.post('/clocking/break', async (req, res) => {
    const { entry, onBreak } = await clockState(req.db, req.user.id);
    if (entry && !onBreak) await req.db.run('INSERT INTO clock_breaks (entry_id) VALUES ($1)', [entry.id]);
    res.redirect(req.body.back || '/clocking');
  });

  app.post('/clocking/resume', async (req, res) => {
    const { onBreak } = await clockState(req.db, req.user.id);
    if (onBreak) await req.db.run('UPDATE clock_breaks SET ended_at = now() WHERE id = $1', [onBreak.id]);
    res.redirect(req.body.back || '/clocking');
  });

  app.post('/clocking/finish', async (req, res) => {
    const { entry, onBreak } = await clockState(req.db, req.user.id);
    if (entry) {
      await req.db.tx(async (db) => {
        if (onBreak) await db.run('UPDATE clock_breaks SET ended_at = now() WHERE id = $1', [onBreak.id]);
        await db.run('UPDATE clock_entries SET ended_at = now(), note = $2 WHERE id = $1', [entry.id, String(req.body.note || '').slice(0, 500)]);
        // Finishing the day also clocks off any job still running.
        await db.run('UPDATE time_entries SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [req.user.id]);
      });
    }
    res.redirect(req.body.back || '/clocking');
  });

  // Owners can fix a forgotten finish.
  app.post('/clocking/:id/fix', requireOwner, async (req, res) => {
    const ended = String(req.body.ended_at || '');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ended)) {
      await req.db.run(
        `UPDATE clock_entries SET ended_at = ($2 || ':00')::timestamp AT TIME ZONE $3 WHERE id = $1 AND ended_at IS NULL`,
        [req.params.id, ended, req.tz]
      );
      await req.db.run('UPDATE clock_breaks SET ended_at = COALESCE(ended_at, (SELECT ended_at FROM clock_entries WHERE id = entry_id)) WHERE entry_id = $1', [req.params.id]);
    }
    res.redirect('/timesheets');
  });

  // Roster: who works when.
  app.get('/roster', async (req, res) => {
    const start = mondayOf(DATE_RE.test(req.query.week || '') ? req.query.week : res.locals.today);
    const end = addDays(start, 6);
    const [staff, shifts, leave] = await Promise.all([
      staffOf(req),
      req.db.all('SELECT * FROM shifts WHERE date BETWEEN $1 AND $2', [start, end]),
      req.db.all(`SELECT user_id, start_date, end_date FROM calendar_entries WHERE kind = 'leave' AND start_date <= $2 AND end_date >= $1`, [start, end]),
    ]);
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(start, i));
    const rows = staff.filter((s) => s.active).map((s) => ({
      ...s,
      cells: days.map((d) => ({
        date: d,
        shift: shifts.find((x) => x.user_id === s.id && x.date === d) || null,
        leave: leave.some((l) => l.user_id === s.id && l.start_date <= d && l.end_date >= d),
      })),
    }));
    res.render('roster', { start, days, rows, prev: addDays(start, -7), next: addDays(start, 7), SHIFT_KINDS, canEdit: req.user.role === 'owner' });
  });

  app.get('/roster/edit', requireOwner, async (req, res, next) => {
    const date = req.query.date;
    const userId = Number(req.query.user_id);
    if (!DATE_RE.test(date || '') || !userId) return next();
    const person = await store.system.get('SELECT id, name FROM users WHERE id = $1 AND workshop_id = $2', [userId, req.user.workshop_id]);
    if (!person) return next();
    const shift = (await req.db.get('SELECT * FROM shifts WHERE user_id = $1 AND date = $2', [userId, date])) || { user_id: userId, date, kind: 'shift', start_time: '07:30', end_time: '16:00', note: '' };
    res.render('roster-edit', { shift, person, SHIFT_KINDS });
  });

  app.post('/roster', requireOwner, async (req, res) => {
    const g = (k) => String(req.body[k] ?? '').trim();
    const date = DATE_RE.test(g('date')) ? g('date') : res.locals.today;
    const userId = Number(g('user_id'));
    const kind = SHIFT_KINDS[g('kind')] ? g('kind') : 'shift';
    const startT = TIME_RE.test(g('start_time')) ? g('start_time') : '';
    const endT = TIME_RE.test(g('end_time')) ? g('end_time') : '';
    const person = userId && (await store.system.get('SELECT id FROM users WHERE id = $1 AND workshop_id = $2', [userId, req.user.workshop_id]));
    if (person) {
      if (g('clear')) await req.db.run('DELETE FROM shifts WHERE user_id = $1 AND date = $2', [userId, date]);
      else
        await req.db.run(
          `INSERT INTO shifts (user_id, date, kind, start_time, end_time, note) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (workshop_id, user_id, date) DO UPDATE SET kind = EXCLUDED.kind, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, note = EXCLUDED.note`,
          [userId, date, kind, kind === 'shift' ? startT : '', kind === 'shift' ? endT : '', g('note').slice(0, 200)]
        );
    }
    res.redirect(`/roster?week=${date}`);
  });

  // Copy last week's roster onto this week, leaving days already set alone.
  app.post('/roster/copy', requireOwner, async (req, res) => {
    const start = mondayOf(DATE_RE.test(req.body.week || '') ? req.body.week : res.locals.today);
    const prevStart = addDays(start, -7);
    const last = await req.db.all('SELECT * FROM shifts WHERE date BETWEEN $1 AND $2', [prevStart, addDays(prevStart, 6)]);
    for (const s of last) {
      await req.db.run(
        `INSERT INTO shifts (user_id, date, kind, start_time, end_time, note) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workshop_id, user_id, date) DO NOTHING`,
        [s.user_id, addDays(s.date, 7), s.kind, s.start_time, s.end_time, s.note]
      );
    }
    res.redirect(`/roster?week=${start}`);
  });
};

module.exports.clockState = clockState;
module.exports.nextShift = nextShift;
module.exports.workedMinutes = workedMinutes;
module.exports.SHIFT_KINDS = SHIFT_KINDS;
