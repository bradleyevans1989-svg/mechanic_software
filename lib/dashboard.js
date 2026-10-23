// Figures behind the Today page's charts and tiles. Money is in cents, dates are workshop dates (YYYY-MM-DD).
const { addDays, addMonths, mondayOf } = require('./util');
const charts = require('./charts');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (iso) => MONTHS[Number(iso.slice(5, 7)) - 1];
const dayMonth = (iso) => `${Number(iso.slice(8, 10))} ${monthName(iso)}`;

// Invoice total inc GST for documents d, rounded per line like lib/docs.js.
const INVOICE_TOTAL = `COALESCE((SELECT SUM(ROUND((l.qty * l.unit_cents)::numeric) + CASE WHEN l.gst THEN ROUND(ROUND((l.qty * l.unit_cents)::numeric) / 10) ELSE 0 END)
  FROM line_items l WHERE l.document_id = d.id), 0)`;

// The ranges on the chart's tabs. Each bucket is [from, to) with labels for the axis and the hover tip.
function ranges(today) {
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(today, -i);
    daily.push({ from: d, to: addDays(d, 1), short: dayMonth(d), long: dayMonth(d) });
  }
  const weekly = [];
  const thisWeek = mondayOf(today);
  for (let i = 11; i >= 0; i--) {
    const d = addDays(thisWeek, -7 * i);
    weekly.push({ from: d, to: addDays(d, 7), short: dayMonth(d), long: `Week of ${dayMonth(d)}` });
  }
  const monthly = [];
  const thisMonth = today.slice(0, 8) + '01';
  for (let i = 11; i >= 0; i--) {
    const d = addMonths(thisMonth, -i);
    monthly.push({ from: d, to: addMonths(d, 1), short: monthName(d), long: `${monthName(d)} ${d.slice(0, 4)}` });
  }
  const yearly = [];
  const year = Number(today.slice(0, 4));
  for (let y = year - 4; y <= year; y++) yearly.push({ from: `${y}-01-01`, to: `${y + 1}-01-01`, short: String(y), long: String(y) });
  return { daily, weekly, monthly, yearly };
}

// Adds up rows of { day, cents } into each bucket.
function sumInto(buckets, rows) {
  return buckets.map((b) => rows.reduce((s, r) => (r.day >= b.from && r.day < b.to ? s + r.cents : s), 0));
}

async function dashboardData(db, today, { unpaid, jobs }) {
  const monthStart = today.slice(0, 8) + '01';
  const all = ranges(today);
  const since = all.yearly[0].from;
  const [invoiced, received, split, finished, events, jobTimes] = await Promise.all([
    db.all(
      `SELECT d.issue_date AS day, SUM(${INVOICE_TOTAL}) AS cents FROM documents d
       WHERE d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= $1 GROUP BY d.issue_date`,
      [since]
    ),
    db.all(
      `SELECT p.date AS day, SUM(p.amount_cents) AS cents FROM payments p JOIN documents d ON d.id = p.document_id
       WHERE d.status != 'void' AND p.date >= $1 GROUP BY p.date`,
      [since]
    ),
    // This month's invoiced work by line kind, ex GST.
    db.all(
      `SELECT l.kind, SUM(ROUND((l.qty * l.unit_cents)::numeric)) AS cents FROM line_items l JOIN documents d ON d.id = l.document_id
       WHERE d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= $1 GROUP BY l.kind`,
      [monthStart]
    ),
    db.all(`SELECT substr(completed_at, 1, 10) AS day FROM jobs WHERE completed_at >= $1 AND status != 'cancelled'`, [addDays(mondayOf(today), -7 * 7)]),
    db.all(
      `SELECT e.kind, e.text, e.at, u.name AS user_name, j.id AS job_id, j.number AS job_number, v.rego
       FROM job_events e JOIN jobs j ON j.id = e.job_id LEFT JOIN users u ON u.id = e.user_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
       ORDER BY e.at DESC, e.id DESC LIMIT 6`
    ),
    // Jobs finished in the last 30 days: time clocked against the estimate, the same way Bay Watch counts it:
    // labour on the estimate, else the booking's hours, else labour on the job card.
    db.all(
      `SELECT j.id, substr(j.completed_at, 1, 10) AS day,
         (SELECT SUM(EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) / 3600) FROM time_entries t WHERE t.job_id = j.id AND t.ended_at IS NOT NULL) AS actual,
         COALESCE(
           (SELECT NULLIF(SUM(l.qty), 0) FROM line_items l WHERE l.kind = 'labour' AND l.document_id =
             (SELECT q.id FROM documents q WHERE q.type = 'quote' AND q.status != 'declined' AND q.job_id = j.id ORDER BY q.id DESC LIMIT 1)),
           (SELECT NULLIF(SUM(b.duration_hours), 0) FROM bookings b WHERE b.job_id = j.id AND b.status != 'cancelled'),
           (SELECT NULLIF(SUM(l.qty), 0) FROM line_items l WHERE l.job_id = j.id AND l.kind = 'labour')
         ) AS estimate
       FROM jobs j WHERE j.completed_at >= $1 AND j.status != 'cancelled' ORDER BY j.completed_at`,
      [addDays(today, -30)]
    ),
  ]);

  const tabs = Object.entries(all).map(([key, buckets]) => ({
    key,
    label: key[0].toUpperCase() + key.slice(1),
    svg: charts.lineChart(buckets, [
      { name: 'Invoiced', cls: 'accent', values: sumInto(buckets, invoiced) },
      { name: 'Received', cls: 'ink', values: sumInto(buckets, received), fill: false },
    ], { id: `chart-${key}` }),
  }));

  const kinds = [['labour', 'Labour', 'accent'], ['part', 'Parts', 'ink'], ['other', 'Other', 'amber']];
  const splitTotal = split.reduce((s, r) => s + r.cents, 0);
  const parts = kinds.map(([kind, name, cls]) => {
    const value = (split.find((r) => r.kind === kind) || {}).cents || 0;
    return { kind, name, cls, value, pct: splitTotal ? Math.round((value / splitTotal) * 100) : 0 };
  });

  // Money in each day so far this month, for the bars on the first tile.
  const monthDays = [];
  for (let d = monthStart; d <= today; d = addDays(d, 1)) monthDays.push({ from: d, to: addDays(d, 1) });
  const receivedMonth = received.filter((r) => r.day >= monthStart && r.day <= today).reduce((s, r) => s + r.cents, 0);

  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const from = addDays(mondayOf(today), -7 * i);
    weeks.push({ from, to: addDays(from, 7) });
  }
  const finishedPerWeek = weeks.map((w) => finished.filter((r) => r.day >= w.from && r.day < w.to).length);

  const timed = jobTimes.filter((j) => j.actual > 0 && j.estimate > 0);
  const actual = timed.reduce((s, j) => s + j.actual, 0);
  const estimate = timed.reduce((s, j) => s + j.estimate, 0);

  const daysLate = (d) => (d.due_date ? Math.round((Date.parse(today) - Date.parse(d.due_date)) / 864e5) : 0);
  const aged = [(n) => n <= 0, (n) => n > 0 && n <= 30, (n) => n > 30 && n <= 60, (n) => n > 60].map((test) =>
    unpaid.filter((d) => test(daysLate(d))).reduce((s, d) => s + d.balance, 0)
  );

  return {
    tabs,
    donut: { svg: charts.donut(parts), parts, total: splitTotal },
    jobsFinishedMonth: finished.filter((r) => r.day >= monthStart).length,
    events,
    tiles: {
      received: { cents: receivedMonth, bars: charts.bars(sumInto(monthDays, received)), from: dayMonth(monthStart), to: dayMonth(today) },
      floor: {
        inProgress: jobs.filter((j) => j.status === 'in_progress').length,
        waiting: jobs.filter((j) => j.status === 'waiting_parts').length,
        ready: jobs.filter((j) => j.status === 'ready').length,
        wave: charts.wave(finishedPerWeek),
        finishedPerWeek,
      },
      pace: {
        pct: estimate ? Math.round((actual / estimate) * 100) : null,
        jobs: timed.length,
        wave: charts.wave(timed.slice(-12).map((j) => j.actual / j.estimate), { line: true }),
      },
      owing: { bars: charts.bars(aged, { width: 70 }), aged },
    },
  };
}

// "5 mins ago", "3 hrs ago", "2 days ago"
function timeAgo(at, nowMs = Date.now()) {
  const mins = Math.max(0, Math.round((nowMs - new Date(at).getTime()) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

module.exports = { dashboardData, ranges, sumInto, timeAgo, INVOICE_TOTAL };
