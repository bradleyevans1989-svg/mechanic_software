const { requireOwner } = require('../lib/auth');
const { stepBlocks } = require('../lib/records');

const STARTER_PROCEDURES = [
  {
    title: 'Vehicle check-in',
    category: 'Front desk',
    body: `# When the car arrives
Confirm the customer's name, phone and the work they want done
Walk around the car with the customer and note any existing damage on the job card
Record the odometer reading
Ask for the best number to ring for approvals
Put the key tag on and hang the keys on the board
# Before work starts
Open the job card and set the mechanic
Check for a service history and any open reminders on the vehicle`,
  },
  {
    title: 'Estimating extra work',
    category: 'Workshop',
    body: `Stop and photograph the problem before touching it
Write the extra work as separate lines on the job card with a price
Ring the customer, explain what you found and the cost, and get a clear yes or no
Add a note to the job card with who approved it and when
Only then carry on with the extra work`,
  },
  {
    title: 'Vehicle handover',
    category: 'Front desk',
    body: `Make sure the invoice is issued and matches the job card
Check the car is clean inside, seat and mirrors back where they were
Walk the customer through what was done and anything to watch
Take payment or confirm the account terms
Set the next service date on the vehicle
Hand over the keys and thank them`,
  },
];

const STARTER_MODULES = [
  { title: 'Hoist safety', description: 'Setting up, lifting and lowering a vehicle safely.', points: 20, body: `# Before lifting
Check the hoist pads and arms are undamaged
Position the arms on the manufacturer's lift points only
Raise the car a little, then rock it to confirm it is stable
# While working
Never work under a car held only on a jack
Keep the area under the hoist clear of tools and leads
# Lowering
Check nobody is underneath and the area is clear
Lower to the locks before leaving the car raised overnight` },
  { title: 'Using the job card', description: 'How we record work, time and notes so invoices are right.', points: 10, body: `Clock on to the job before you start and off when you stop
Write mechanic's notes as you go, not at the end of the day
Add every part to the lines as you fit it
Mark the inspection checklist honestly, with a note on anything that needs attention
Set the job to Ready for pickup when it is finished and the car is clean` },
  { title: 'Chemicals and spills', description: 'Handling oils, coolant and brake cleaner, and what to do about a spill.', points: 15, body: `Read the safety data sheet before using a product for the first time
Wear gloves and eye protection for brake cleaner and degreaser
Put waste oil in the waste oil drum, never down a drain
# If there is a spill
Contain it with the spill kit absorbent
Clean up and dispose of the absorbent in the hazardous waste bin
Tell the owner so the spill kit gets restocked` },
];

module.exports = function (app, { store }) {
  const staffOf = (req) => store.system.all('SELECT id, name, active FROM users WHERE workshop_id = $1 ORDER BY lower(name)', [req.user.workshop_id]);

  // Team to-do chat
  app.get('/team', async (req, res) => {
    const [posts, staff] = await Promise.all([
      req.db.all(
        `SELECT p.*, u.name AS author, d.name AS done_by_name FROM team_posts p
         LEFT JOIN users u ON u.id = p.user_id LEFT JOIN users d ON d.id = p.done_by
         ORDER BY p.created_at DESC LIMIT 200`
      ),
      staffOf(req),
    ]);
    const open = posts.filter((p) => p.kind === 'todo' && !p.done_at).reverse();
    const feed = posts.filter((p) => !(p.kind === 'todo' && !p.done_at)).slice(0, 60).reverse();
    res.render('team/index', { open, feed, staff });
  });

  app.post('/team', async (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 2000);
    const kind = req.body.kind === 'note' ? 'note' : 'todo';
    if (text) await req.db.run('INSERT INTO team_posts (user_id, text, kind) VALUES ($1, $2, $3)', [req.user.id, text, kind]);
    res.redirect('/team');
  });

  app.post('/team/:id/done', async (req, res) => {
    await req.db.run('UPDATE team_posts SET done_at = now(), done_by = $2 WHERE id = $1 AND done_at IS NULL', [req.params.id, req.user.id]);
    res.redirect('/team');
  });

  app.post('/team/:id/reopen', async (req, res) => {
    await req.db.run('UPDATE team_posts SET done_at = NULL, done_by = NULL WHERE id = $1', [req.params.id]);
    res.redirect('/team');
  });

  app.post('/team/:id/delete', async (req, res) => {
    const where = req.user.role === 'owner' ? '' : ' AND user_id = $2';
    await req.db.run(`DELETE FROM team_posts WHERE id = $1${where}`, req.user.role === 'owner' ? [req.params.id] : [req.params.id, req.user.id]);
    res.redirect('/team');
  });

  // Procedures: how we do things, step by step
  app.get('/procedures', async (req, res) => {
    const rows = await req.db.all('SELECT p.id, p.title, p.category, p.updated_at, u.name AS updated_by_name FROM procedures p LEFT JOIN users u ON u.id = p.updated_by ORDER BY lower(p.category), lower(p.title)');
    const groups = [];
    for (const r of rows) {
      let g = groups.find((x) => x.category === r.category);
      if (!g) groups.push((g = { category: r.category, items: [] }));
      g.items.push(r);
    }
    res.render('procedures/index', { groups });
  });

  app.post('/procedures/starter', requireOwner, async (req, res) => {
    for (const p of STARTER_PROCEDURES) {
      const exists = await req.db.get('SELECT id FROM procedures WHERE lower(title) = lower($1)', [p.title]);
      if (!exists) await req.db.run('INSERT INTO procedures (title, category, body, updated_by) VALUES ($1, $2, $3, $4)', [p.title, p.category, p.body, req.user.id]);
    }
    res.redirect('/procedures');
  });

  const procForm = (body) => ({
    title: String(body.title || '').trim().slice(0, 150),
    category: String(body.category || '').trim().slice(0, 60),
    body: String(body.body || '').replace(/\r\n/g, '\n').slice(0, 20000),
  });

  app.get('/procedures/new', requireOwner, (req, res) => res.render('procedures/form', { procedure: { title: '', category: '', body: '' }, error: null }));

  app.post('/procedures', requireOwner, async (req, res) => {
    const p = procForm(req.body);
    if (!p.title) return res.status(400).render('procedures/form', { procedure: p, error: 'Give it a title.' });
    const row = await req.db.get('INSERT INTO procedures (title, category, body, updated_by) VALUES ($1, $2, $3, $4) RETURNING id', [p.title, p.category, p.body, req.user.id]);
    res.redirect(`/procedures/${row.id}`);
  });

  app.get('/procedures/:id', async (req, res, next) => {
    const procedure = await req.db.get('SELECT p.*, u.name AS updated_by_name FROM procedures p LEFT JOIN users u ON u.id = p.updated_by WHERE p.id = $1', [req.params.id]);
    if (!procedure) return next();
    res.render('procedures/show', { procedure, blocks: stepBlocks(procedure.body), print: req.query.print === '1' });
  });

  app.get('/procedures/:id/edit', requireOwner, async (req, res, next) => {
    const procedure = await req.db.get('SELECT * FROM procedures WHERE id = $1', [req.params.id]);
    if (!procedure) return next();
    res.render('procedures/form', { procedure, error: null });
  });

  app.post('/procedures/:id', requireOwner, async (req, res, next) => {
    const existing = await req.db.get('SELECT id FROM procedures WHERE id = $1', [req.params.id]);
    if (!existing) return next();
    const p = procForm(req.body);
    if (!p.title) return res.status(400).render('procedures/form', { procedure: { ...p, id: existing.id }, error: 'Give it a title.' });
    await req.db.run('UPDATE procedures SET title = $1, category = $2, body = $3, updated_by = $4, updated_at = now() WHERE id = $5', [p.title, p.category, p.body, req.user.id, existing.id]);
    res.redirect(`/procedures/${existing.id}`);
  });

  app.post('/procedures/:id/delete', requireOwner, async (req, res) => {
    await req.db.run('DELETE FROM procedures WHERE id = $1', [req.params.id]);
    res.redirect('/procedures');
  });

  // Training: modules worth points, completed per person
  app.get('/training', async (req, res) => {
    const [modules, completions, staff] = await Promise.all([
      req.db.all('SELECT * FROM training_modules WHERE active OR $1 ORDER BY active DESC, lower(title)', [req.user.role === 'owner']),
      req.db.all('SELECT c.*, m.points FROM training_completions c JOIN training_modules m ON m.id = c.module_id WHERE m.active'),
      staffOf(req),
    ]);
    const mine = new Set(completions.filter((c) => c.user_id === req.user.id).map((c) => c.module_id));
    const totalPoints = modules.filter((m) => m.active).reduce((s, m) => s + m.points, 0);
    const board = staff
      .filter((s) => s.active)
      .map((s) => {
        const done = completions.filter((c) => c.user_id === s.id);
        return { ...s, points: done.reduce((sum, c) => sum + c.points, 0), done: done.length };
      })
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    res.render('training/index', { modules, mine, board, totalPoints, completions });
  });

  app.post('/training/starter', requireOwner, async (req, res) => {
    for (const m of STARTER_MODULES) {
      const exists = await req.db.get('SELECT id FROM training_modules WHERE lower(title) = lower($1)', [m.title]);
      if (!exists) await req.db.run('INSERT INTO training_modules (title, description, body, points) VALUES ($1, $2, $3, $4)', [m.title, m.description, m.body, m.points]);
    }
    res.redirect('/training');
  });

  const moduleForm = (body) => ({
    title: String(body.title || '').trim().slice(0, 150),
    description: String(body.description || '').trim().slice(0, 500),
    body: String(body.body || '').replace(/\r\n/g, '\n').slice(0, 20000),
    points: Math.min(Math.max(parseInt(body.points, 10) || 0, 0), 1000),
    active: body.active !== '0',
  });

  app.get('/training/new', requireOwner, (req, res) => res.render('training/form', { module: { title: '', description: '', body: '', points: 10, active: true }, error: null }));

  app.post('/training', requireOwner, async (req, res) => {
    const m = moduleForm(req.body);
    if (!m.title) return res.status(400).render('training/form', { module: m, error: 'Give it a title.' });
    const row = await req.db.get('INSERT INTO training_modules (title, description, body, points, active) VALUES ($1, $2, $3, $4, $5) RETURNING id', [m.title, m.description, m.body, m.points, m.active]);
    res.redirect(`/training/${row.id}`);
  });

  app.get('/training/:id', async (req, res, next) => {
    const module = await req.db.get('SELECT * FROM training_modules WHERE id = $1', [req.params.id]);
    if (!module) return next();
    const [completions, staff] = await Promise.all([
      req.db.all('SELECT c.*, u.name FROM training_completions c JOIN users u ON u.id = c.user_id WHERE c.module_id = $1 ORDER BY c.completed_at DESC', [module.id]),
      staffOf(req),
    ]);
    const mine = completions.find((c) => c.user_id === req.user.id) || null;
    res.render('training/show', { module, blocks: stepBlocks(module.body), completions, mine, staff: staff.filter((s) => s.active) });
  });

  app.get('/training/:id/edit', requireOwner, async (req, res, next) => {
    const module = await req.db.get('SELECT * FROM training_modules WHERE id = $1', [req.params.id]);
    if (!module) return next();
    res.render('training/form', { module, error: null });
  });

  app.post('/training/:id', requireOwner, async (req, res, next) => {
    const existing = await req.db.get('SELECT id FROM training_modules WHERE id = $1', [req.params.id]);
    if (!existing) return next();
    const m = moduleForm(req.body);
    if (!m.title) return res.status(400).render('training/form', { module: { ...m, id: existing.id }, error: 'Give it a title.' });
    await req.db.run('UPDATE training_modules SET title = $1, description = $2, body = $3, points = $4, active = $5 WHERE id = $6', [m.title, m.description, m.body, m.points, m.active, existing.id]);
    res.redirect(`/training/${existing.id}`);
  });

  // Mark done for yourself, or (owner) for someone on the team.
  app.post('/training/:id/complete', async (req, res, next) => {
    const module = await req.db.get('SELECT id FROM training_modules WHERE id = $1', [req.params.id]);
    if (!module) return next();
    let userId = req.user.id;
    if (req.user.role === 'owner' && Number(req.body.user_id)) {
      const person = await store.system.get('SELECT id FROM users WHERE id = $1 AND workshop_id = $2', [Number(req.body.user_id), req.user.workshop_id]);
      if (person) userId = person.id;
    }
    await req.db.run('INSERT INTO training_completions (module_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [module.id, userId]);
    res.redirect(`/training/${module.id}`);
  });

  app.post('/training/:id/uncomplete', requireOwner, async (req, res) => {
    await req.db.run('DELETE FROM training_completions WHERE module_id = $1 AND user_id = $2', [req.params.id, Number(req.body.user_id) || 0]);
    res.redirect(`/training/${req.params.id}`);
  });

  app.post('/training/:id/delete', requireOwner, async (req, res) => {
    await req.db.run('DELETE FROM training_modules WHERE id = $1', [req.params.id]);
    res.redirect('/training');
  });
};
