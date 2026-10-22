const { minutesBetween, docNumber } = require('../lib/util');

// Technician colours, in a fixed order by staff id so a person keeps their colour.
// Orange and red are left out: orange is the brand accent, red means "over".
const TECH_COLOURS = ['#3987e5', '#199e70', '#9085e9', '#d55181', '#c98500', '#008300'];
const OTHERS_COLOUR = '#8a8a86';

// On track until 80% of the estimate, nearing until 100%, then over.
const NEARING_AT = 0.8;

function paceOf(minutes, estimate) {
  if (!estimate) return 'none';
  const pct = minutes / estimate;
  return pct > 1 ? 'over' : pct >= NEARING_AT ? 'nearing' : 'ok';
}

// Hours logged over the life of the job, as points for a step chart:
// [minutes since the first clock on, minutes logged by then].
function curve(entries, nowMs) {
  if (!entries.length) return { points: [], spanMinutes: 0, from: null };
  const spans = entries.map((t) => [new Date(t.started_at).getTime(), t.ended_at ? new Date(t.ended_at).getTime() : nowMs]);
  const from = Math.min(...spans.map((s) => s[0]));
  const times = [...new Set(spans.flat().concat(nowMs))].filter((x) => x <= nowMs).sort((a, b) => a - b);
  const points = times.map((at) => [
    (at - from) / 60000,
    spans.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, at) - a), 0) / 60000,
  ]);
  return { points, spanMinutes: (nowMs - from) / 60000, from: new Date(from) };
}

// Every job on the floor with its time logged against the estimate.
async function bayBoard(req, store) {
  const db = req.db;
  const jobs = await db.all(
    `SELECT j.id, j.number, j.status, j.priority, j.description, j.due_date, j.due_time,
       c.name AS customer_name, v.rego, v.make, v.model, v.year, m.name AS mechanic_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id
     LEFT JOIN vehicles v ON v.id = j.vehicle_id LEFT JOIN users m ON m.id = j.mechanic_id
     WHERE j.status IN ('in_progress', 'waiting_parts')
       OR (j.status NOT IN ('invoiced', 'cancelled') AND EXISTS (SELECT 1 FROM time_entries t WHERE t.job_id = j.id AND t.ended_at IS NULL))
     ORDER BY j.number`
  );
  const ids = jobs.map((j) => j.id);
  const [entries, quoted, booked, carded, staff] = await Promise.all([
    db.all('SELECT job_id, user_id, started_at, ended_at FROM time_entries WHERE job_id = ANY($1) ORDER BY started_at', [ids]),
    // Labour on the estimate the job came from (latest one not declined).
    db.all(
      `SELECT DISTINCT ON (d.job_id) d.job_id, d.number,
         (SELECT COALESCE(SUM(l.qty), 0) FROM line_items l WHERE l.document_id = d.id AND l.kind = 'labour') AS hours
       FROM documents d WHERE d.type = 'quote' AND d.status != 'declined' AND d.job_id = ANY($1)
       ORDER BY d.job_id, d.id DESC`,
      [ids]
    ),
    db.all(`SELECT job_id, SUM(duration_hours) AS hours FROM bookings WHERE job_id = ANY($1) AND status != 'cancelled' GROUP BY job_id`, [ids]),
    db.all(`SELECT job_id, SUM(qty) AS hours FROM line_items WHERE job_id = ANY($1) AND kind = 'labour' GROUP BY job_id`, [ids]),
    store.system.all('SELECT id, name FROM users WHERE workshop_id = $1 ORDER BY id', [req.user.workshop_id]),
  ]);

  const colourOf = (userId) => {
    const i = staff.findIndex((s) => s.id === userId);
    return i >= 0 && i < TECH_COLOURS.length ? TECH_COLOURS[i] : OTHERS_COLOUR;
  };
  const nameOf = (userId) => (staff.find((s) => s.id === userId) || {}).name || 'Unknown';
  const nowMs = Date.now();

  const board = jobs.map((job) => {
    const mine = entries.filter((t) => t.job_id === job.id);
    const techs = [];
    let seconds = 0;
    for (const t of mine) {
      let tech = techs.find((x) => x.user_id === t.user_id);
      if (!tech) techs.push((tech = { user_id: t.user_id, name: nameOf(t.user_id), colour: colourOf(t.user_id), minutes: 0, running: null }));
      tech.minutes += minutesBetween(t.started_at, t.ended_at);
      seconds += Math.max(0, ((t.ended_at ? new Date(t.ended_at).getTime() : nowMs) - new Date(t.started_at).getTime()) / 1000);
      if (!t.ended_at) tech.running = t.started_at;
    }
    techs.sort((a, b) => b.minutes - a.minutes);

    // Where the estimate comes from, best first: the estimate, the booking, then labour on the job card.
    const q = quoted.find((x) => x.job_id === job.id);
    const b = booked.find((x) => x.job_id === job.id);
    const c = carded.find((x) => x.job_id === job.id);
    let estimate = null;
    if (q && Number(q.hours) > 0) estimate = { minutes: Number(q.hours) * 60, from: `estimate ${docNumber({ type: 'quote', number: q.number })}` };
    else if (b && Number(b.hours) > 0) estimate = { minutes: Number(b.hours) * 60, from: 'booking' };
    else if (c && Number(c.hours) > 0) estimate = { minutes: Number(c.hours) * 60, from: 'job card labour' };

    const minutes = techs.reduce((s, t) => s + t.minutes, 0);
    const running = techs.filter((t) => t.running).length;
    return {
      ...job,
      techs,
      minutes,
      seconds: Math.round(seconds),
      running,
      estimate,
      pace: paceOf(minutes, estimate && estimate.minutes),
      curve: curve(mine, nowMs),
    };
  });

  // Over first, then nearing, then everything on the go, then the rest.
  const rank = { over: 0, nearing: 1, ok: 2, none: 3 };
  board.sort((a, b) => (b.running > 0) - (a.running > 0) || rank[a.pace] - rank[b.pace] || a.number - b.number);
  return board;
}

module.exports = function (app, { store }) {
  app.get('/baywatch', async (req, res) => {
    const board = await bayBoard(req, store);
    const counts = { live: board.filter((j) => j.running).length, ok: 0, nearing: 0, over: 0, none: 0 };
    for (const j of board) counts[j.pace]++;
    const locals = { board, counts, renderedAt: Date.now(), tv: req.query.tv === '1' };
    // The page polls this for a fresh board without reloading.
    if (req.query.part === 'board') return res.render('baywatch/board', locals);
    res.render('baywatch/index', locals);
  });
};

module.exports.bayBoard = bayBoard;
module.exports.paceOf = paceOf;
module.exports.curve = curve;
