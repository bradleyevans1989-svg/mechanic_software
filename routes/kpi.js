const { requireOwner } = require('../lib/auth');
const kpi = require('../lib/kpi');
const { addDays } = require('../lib/util');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function (app) {
  app.get('/reports/kpi', requireOwner, async (req, res) => {
    const today = res.locals.today;
    const presets = kpi.periods(today);
    let key = presets[req.query.period] ? req.query.period : 'month';
    let { from, to, label } = presets[key];
    // A chosen range: "to" is the last day included.
    if (DATE_RE.test(req.query.from || '') && DATE_RE.test(req.query.to || '') && req.query.from <= req.query.to) {
      key = 'custom';
      from = req.query.from;
      to = addDays(req.query.to, 1);
      label = 'Chosen dates';
    }
    const prev = kpi.previous(from, to);
    const [now, before, debtors] = await Promise.all([
      kpi.compute(req.db, req.tz, from, to, today),
      kpi.compute(req.db, req.tz, prev.from, prev.to, today),
      kpi.debtorDays(req.db, today),
    ]);
    res.render('kpi', { presets, key, label, from, to, last: addDays(to, -1), prev, now, before, debtors });
  });
};
