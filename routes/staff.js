const { requireOwner, hashPassword, verifyPassword, passwordProblem } = require('../lib/auth');

const ROLES = { owner: 'Owner', staff: 'Staff' };

module.exports = function (app, { db }) {
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const activeOwners = () => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1`).get().n;
  const emailTaken = (email, exceptId) =>
    Boolean(db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, exceptId || 0));

  function formFrom(body) {
    return {
      name: String(body.name || '').trim(),
      email: String(body.email || '').trim().toLowerCase(),
      role: ROLES[body.role] ? body.role : 'staff',
      active: body.active === '1' ? 1 : 0,
    };
  }

  app.get('/staff', requireOwner, (req, res) => {
    const staff = db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').all();
    res.render('staff/index', { staff, ROLES });
  });

  app.get('/staff/new', requireOwner, (req, res) => {
    res.render('staff/form', { member: { role: 'staff', active: 1 }, ROLES, error: null });
  });

  app.post('/staff', requireOwner, (req, res) => {
    const member = formFrom(req.body);
    member.active = 1;
    let error = null;
    if (!member.name || !member.email) error = 'Enter a name and email.';
    else if (emailTaken(member.email)) error = 'Someone already uses that email.';
    else error = passwordProblem(req.body.password);
    if (error) return res.status(400).render('staff/form', { member, ROLES, error });
    db.prepare(
      `INSERT INTO users (name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`
    ).run(member.name, member.email, hashPassword(req.body.password), member.role, new Date().toISOString());
    res.redirect('/staff');
  });

  app.get('/staff/:id/edit', requireOwner, (req, res, next) => {
    const member = getUser(req.params.id);
    if (!member) return next();
    res.render('staff/form', { member, ROLES, error: null });
  });

  app.post('/staff/:id', requireOwner, (req, res, next) => {
    const existing = getUser(req.params.id);
    if (!existing) return next();
    const member = { ...formFrom(req.body), id: existing.id };
    const newPassword = String(req.body.password || '');
    let error = null;
    const losesOwner = existing.role === 'owner' && existing.active && (member.role !== 'owner' || !member.active);
    if (!member.name || !member.email) error = 'Enter a name and email.';
    else if (emailTaken(member.email, existing.id)) error = 'Someone already uses that email.';
    else if (losesOwner && activeOwners() <= 1) error = 'There must be at least one active owner.';
    else if (newPassword) error = passwordProblem(newPassword);
    if (error) return res.status(400).render('staff/form', { member, ROLES, error });

    // Deactivating, demoting or resetting a password signs that person out.
    const signOut = newPassword || !member.active || member.role !== existing.role;
    db.prepare(
      `UPDATE users SET name = ?, email = ?, role = ?, active = ?,
         password_hash = COALESCE(?, password_hash), session_version = session_version + ?
       WHERE id = ?`
    ).run(
      member.name,
      member.email,
      member.role,
      member.active,
      newPassword ? hashPassword(newPassword) : null,
      signOut ? 1 : 0,
      existing.id
    );
    if (existing.id === req.user.id && signOut && member.active) app.locals.signIn(req, res, getUser(existing.id));
    res.redirect('/staff');
  });

  app.get('/account', (req, res) => res.render('account', { error: null, saved: req.query.saved === '1' }));

  app.post('/account', (req, res) => {
    const name = String(req.body.name || '').trim() || req.user.name;
    const newPassword = String(req.body.new_password || '');
    if (newPassword) {
      const error = !verifyPassword(req.body.current_password, req.user.password_hash)
        ? 'Your current password is wrong.'
        : passwordProblem(newPassword);
      if (error) return res.status(400).render('account', { error, saved: false });
      db.prepare('UPDATE users SET name = ?, password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(
        name,
        hashPassword(newPassword),
        req.user.id
      );
      app.locals.signIn(req, res, getUser(req.user.id));
    } else {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    }
    res.redirect('/account?saved=1');
  });
};
