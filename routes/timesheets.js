const { addDays, mondayOf, minutesBetween } = require('../lib/util');
const { requireOwner } = require('../lib/auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Hours clocked per staff member per day, from the job time clock.
module.exports = function (app, { store }) {
  app.get('/timesheets', requireOwner, async (req, res) => {
    const start = mondayOf(DATE_RE.test(req.query.week || '') ? req.query.week : res.locals.today);
    const end = addDays(start, 6);
    const [entries, staff] = await Promise.all([
      req.db.all(
        `SELECT t.*, j.number AS job_number, j.id AS job_id, v.rego, c.name AS customer_name,
           to_char(t.started_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day
         FROM time_entries t JOIN jobs j ON j.id = t.job_id
         JOIN customers c ON c.id = j.customer_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
         WHERE to_char(t.started_at AT TIME ZONE $3, 'YYYY-MM-DD') BETWEEN $1 AND $2
         ORDER BY t.started_at`,
        [start, end, req.tz]
      ),
      store.system.all('SELECT id, name, active FROM users WHERE workshop_id = $1 ORDER BY active DESC, lower(name)', [req.user.workshop_id]),
    ]);
    for (const e of entries) e.minutes = minutesBetween(e.started_at, e.ended_at);
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(start, i));
    const rows = staff
      .map((s) => {
        const mine = entries.filter((e) => e.user_id === s.id);
        return {
          ...s,
          byDay: days.map((d) => mine.filter((e) => e.day === d).reduce((sum, e) => sum + e.minutes, 0)),
          total: mine.reduce((sum, e) => sum + e.minutes, 0),
          entries: mine,
        };
      })
      .filter((r) => r.active || r.total > 0);
    const onClock = entries.filter((e) => !e.ended_at);
    res.render('timesheets', { start, days, rows, onClock, prev: addDays(start, -7), next: addDays(start, 7), dayTotals: days.map((d, i) => rows.reduce((s, r) => s + r.byDay[i], 0)) });
  });
};
