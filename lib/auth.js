const crypto = require('crypto');

// Staff accounts with a signed session cookie (no session store needed).
// The cookie carries the user's session_version, so changing a password or
// deactivating someone signs them out everywhere.
const COOKIE = 'ws_session';
const MAX_AGE_DAYS = 30;
const MIN_PASSWORD = 8;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

function passwordProblem(password) {
  return String(password || '').length < MIN_PASSWORD ? `Password must be at least ${MIN_PASSWORD} characters.` : null;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Failed logins per IP, to slow down password guessing.
const failures = new Map();
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;

function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) return false;
  return f.count >= FAIL_LIMIT;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

function setup(app, db) {
  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    secret = db.prepare('SELECT session_secret FROM settings WHERE id = 1').get().session_secret;
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE settings SET session_secret = ? WHERE id = 1').run(secret);
    }
  }
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('hex');

  // First-run code so a stranger can't claim a fresh install before you do.
  const setupCode = process.env.SETUP_CODE || crypto.randomBytes(4).toString('hex');
  app.locals.setupCode = setupCode;
  const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (!hasUsers() && !process.env.SETUP_CODE) {
    console.log(`First run: open /setup and enter setup code ${setupCode} to create the owner account.`);
  }

  function signIn(req, res, user) {
    const payload = `${user.id}.${user.session_version}.${Date.now() + MAX_AGE_DAYS * 864e5}`;
    res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: MAX_AGE_DAYS * 864e5,
    });
  }

  function currentUser(req) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [id, ver, exp, sig] = parts;
    const expected = Buffer.from(sign(`${id}.${ver}.${exp}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    if (Number(exp) < Date.now()) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id);
    return user && String(user.session_version) === ver ? user : null;
  }

  app.get('/setup', (req, res) => {
    if (hasUsers()) return res.redirect('/login');
    res.render('setup', { error: null, form: {} });
  });

  app.post('/setup', (req, res) => {
    if (hasUsers()) return res.redirect('/login');
    const form = { name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim().toLowerCase() };
    let error = null;
    if (String(req.body.code || '').trim() !== setupCode) error = 'That setup code is wrong. It is shown in the server log.';
    else if (!form.name || !form.email) error = 'Enter your name and email.';
    else error = passwordProblem(req.body.password);
    if (error) return res.status(400).render('setup', { error, form });
    const id = db
      .prepare(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?)`)
      .run(form.name, form.email, hashPassword(req.body.password), new Date().toISOString()).lastInsertRowid;
    signIn(req, res, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    res.redirect('/settings');
  });

  app.get('/login', (req, res) => {
    if (!hasUsers()) return res.redirect('/setup');
    res.render('login', { error: null, email: '' });
  });

  app.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (tooManyFailures(req.ip)) {
      return res.status(429).render('login', { error: 'Too many wrong attempts. Try again in 15 minutes.', email });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !verifyPassword(req.body.password, user.password_hash)) {
      recordFailure(req.ip);
      return res.status(401).render('login', { error: 'Wrong email or password.', email });
    }
    signIn(req, res, user);
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.redirect(hasUsers() ? '/login' : '/setup');
    req.user = user;
    res.locals.user = user;
    next();
  });

  // Refresh the cookie after a password change so the person doing it stays signed in.
  app.locals.signIn = signIn;
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  res.status(403).render('message', { title: 'Owner only', message: 'Only the workshop owner can do this.' });
}

module.exports = { setup, requireOwner, hashPassword, verifyPassword, passwordProblem };
