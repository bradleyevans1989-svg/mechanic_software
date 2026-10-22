const { requireOwner, hashPassword, verifyPassword, passwordProblem, ROLES } = require('../lib/auth');

// Users sit outside the per-workshop tables, so every query here names the workshop.
module.exports = function (app, { store }) {
  const sys = store.system;
  const getMember = (req, id) => sys.get('SELECT * FROM users WHERE id = $1 AND workshop_id = $2', [id, req.user.workshop_id]);
  const activeOwners = async (req) =>
    (await sys.get(`SELECT COUNT(*) AS n FROM users WHERE workshop_id = $1 AND role = 'owner' AND active`, [req.user.workshop_id])).n;
  const emailTaken = async (email, exceptId) => Boolean(await sys.get('SELECT id FROM users WHERE email = $1 AND id != $2', [email, exceptId || 0]));

  function formFrom(body) {
    return {
      name: String(body.name || '').trim().slice(0, 120),
      email: String(body.email || '').trim().toLowerCase().slice(0, 200),
      role: ROLES[body.role] ? body.role : 'staff',
      active: body.active === '1',
    };
  }

  app.get('/staff', requireOwner, async (req, res) => {
    const staff = await sys.all('SELECT * FROM users WHERE workshop_id = $1 ORDER BY active DESC, lower(name)', [req.user.workshop_id]);
    res.render('staff/index', { staff, ROLES });
  });

  app.get('/staff/new', requireOwner, (req, res) => {
    res.render('staff/form', { member: { role: 'staff', active: true }, ROLES, error: null });
  });

  app.post('/staff', requireOwner, async (req, res) => {
    const member = { ...formFrom(req.body), active: true };
    let error = null;
    if (!member.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(member.email)) error = 'Enter a name and a valid email.';
    else if (await emailTaken(member.email)) error = 'That email already has a login.';
    else error = passwordProblem(req.body.password);
    if (error) return res.status(400).render('staff/form', { member, ROLES, error });
    await sys.run(`INSERT INTO users (workshop_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)`, [
      req.user.workshop_id,
      member.name,
      member.email,
      hashPassword(req.body.password),
      member.role,
    ]);
    res.redirect('/staff');
  });

  app.get('/staff/:id/edit', requireOwner, async (req, res, next) => {
    const member = await getMember(req, req.params.id);
    if (!member) return next();
    res.render('staff/form', { member, ROLES, error: null });
  });

  app.post('/staff/:id', requireOwner, async (req, res, next) => {
    const existing = await getMember(req, req.params.id);
    if (!existing) return next();
    const member = { ...formFrom(req.body), id: existing.id };
    const newPassword = String(req.body.password || '');
    let error = null;
    const losesOwner = existing.role === 'owner' && existing.active && (member.role !== 'owner' || !member.active);
    if (!member.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(member.email)) error = 'Enter a name and a valid email.';
    else if (await emailTaken(member.email, existing.id)) error = 'That email already has a login.';
    else if (losesOwner && (await activeOwners(req)) <= 1) error = 'There must be at least one active owner.';
    else if (newPassword) error = passwordProblem(newPassword);
    if (error) return res.status(400).render('staff/form', { member, ROLES, error });

    // Deactivating, changing role or resetting a password signs that person out.
    const signOut = Boolean(newPassword) || !member.active || member.role !== existing.role;
    await sys.run(
      `UPDATE users SET name = $1, email = $2, role = $3, active = $4,
         password_hash = COALESCE($5, password_hash), session_version = session_version + $6
       WHERE id = $7 AND workshop_id = $8`,
      [member.name, member.email, member.role, member.active, newPassword ? hashPassword(newPassword) : null, signOut ? 1 : 0, existing.id, req.user.workshop_id]
    );
    if (existing.id === req.user.id && signOut && member.active) app.locals.signIn(req, res, await getMember(req, existing.id));
    res.redirect('/staff');
  });

  app.get('/account', (req, res) => res.render('account', { error: null, saved: req.query.saved === '1' }));

  app.post('/account', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120) || req.user.name;
    const newPassword = String(req.body.new_password || '');
    if (newPassword) {
      const error = !verifyPassword(req.body.current_password, req.user.password_hash)
        ? 'Your current password is wrong.'
        : passwordProblem(newPassword);
      if (error) return res.status(400).render('account', { error, saved: false });
      await sys.run('UPDATE users SET name = $1, password_hash = $2, session_version = session_version + 1 WHERE id = $3', [
        name,
        hashPassword(newPassword),
        req.user.id,
      ]);
      app.locals.signIn(req, res, await sys.get('SELECT * FROM users WHERE id = $1', [req.user.id]));
    } else {
      await sys.run('UPDATE users SET name = $1 WHERE id = $2', [name, req.user.id]);
    }
    res.redirect('/account?saved=1');
  });
};
