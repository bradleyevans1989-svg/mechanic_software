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

// Run on a missing user too, so response time doesn't reveal which emails exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

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

// Attempts per IP in a 15 minute window, to slow down password guessing and sign-up spam.
function limiter(limit) {
  const hits = new Map();
  const WINDOW = 15 * 60 * 1000;
  return {
    blocked(ip) {
      const h = hits.get(ip);
      return Boolean(h && Date.now() - h.first < WINDOW && h.count >= limit);
    },
    hit(ip) {
      const h = hits.get(ip);
      if (!h || Date.now() - h.first > WINDOW) hits.set(ip, { first: Date.now(), count: 1 });
      else h.count++;
      if (hits.size > 10000) hits.clear();
    },
  };
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set in production.');
  return 'dev-only-secret';
}

function setup(app, store) {
  const secret = sessionSecret();
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('hex');
  const loginLimit = limiter(10);
  const signupLimit = limiter(5);

  function signIn(req, res, user) {
    const payload = `${user.id}.${user.session_version}.${Date.now() + MAX_AGE_DAYS * 864e5}`;
    res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: MAX_AGE_DAYS * 864e5,
    });
  }
  app.locals.signIn = signIn;

  async function currentUser(req) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [id, ver, exp, sig] = parts;
    const expected = Buffer.from(sign(`${id}.${ver}.${exp}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    if (Number(exp) < Date.now() || !/^\d+$/.test(id)) return null;
    const user = await store.system.get(
      `SELECT u.*, w.name AS workshop_name, w.status AS workshop_status FROM users u
       JOIN workshops w ON w.id = u.workshop_id WHERE u.id = $1 AND u.active`,
      [Number(id)]
    );
    return user && String(user.session_version) === ver && user.workshop_status !== 'closed' ? user : null;
  }

  // Self-serve sign-up: a new workshop and its owner login.
  app.get('/signup', (req, res) => {
    res.render('signup', { error: null, form: {}, codeRequired: Boolean(process.env.SIGNUP_CODE) });
  });

  app.post('/signup', async (req, res) => {
    const form = {
      workshop: String(req.body.workshop || '').trim().slice(0, 120),
      name: String(req.body.name || '').trim().slice(0, 120),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 200),
    };
    const fail = (error, status = 400) =>
      res.status(status).render('signup', { error, form, codeRequired: Boolean(process.env.SIGNUP_CODE) });
    if (signupLimit.blocked(req.ip)) return fail('Too many sign-ups from here. Try again later.', 429);
    if (process.env.SIGNUP_CODE && String(req.body.code || '').trim() !== process.env.SIGNUP_CODE) {
      signupLimit.hit(req.ip);
      return fail('That sign-up code is wrong.');
    }
    if (!form.workshop || !form.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) {
      return fail('Enter your workshop name, your name and a valid email.');
    }
    const problem = passwordProblem(req.body.password);
    if (problem) return fail(problem);
    if (await store.system.get('SELECT id FROM users WHERE email = $1', [form.email])) {
      return fail('That email already has a login. Log in instead.');
    }
    signupLimit.hit(req.ip);

    const workshop = await store.system.get('INSERT INTO workshops (name) VALUES ($1) RETURNING id', [form.workshop]);
    await store.tenant(workshop.id).run('INSERT INTO settings (business_name) VALUES ($1)', [form.workshop]);
    let user;
    try {
      user = await store.system.get(
        `INSERT INTO users (workshop_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING *`,
        [workshop.id, form.name, form.email, hashPassword(req.body.password)]
      );
    } catch (err) {
      await store.system.run('DELETE FROM workshops WHERE id = $1', [workshop.id]);
      if (err.code === '23505') return fail('That email already has a login. Log in instead.');
      throw err;
    }
    signIn(req, res, user);
    res.redirect('/settings?welcome=1');
  });

  app.get('/login', (req, res) => res.render('login', { error: null, email: '' }));

  app.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (loginLimit.blocked(req.ip)) {
      return res.status(429).render('login', { error: 'Too many wrong attempts. Try again in 15 minutes.', email });
    }
    const user = await store.system.get('SELECT * FROM users WHERE email = $1 AND active', [email]);
    const ok = verifyPassword(req.body.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      loginLimit.hit(req.ip);
      return res.status(401).render('login', { error: 'Wrong email or password.', email });
    }
    signIn(req, res, user);
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/login');
  });

  // Everything after this needs a login, and runs as that person's workshop.
  app.use(async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');
    req.user = user;
    req.db = store.tenant(user.workshop_id);
    const settings = await req.db.get('SELECT * FROM settings');
    req.tz = settings.timezone;
    res.locals.user = user;
    res.locals.settings = settings;
    const clock = require('./util').clock(req.tz);
    res.locals.today = clock.date;
    res.locals.timeNow = clock.time.slice(0, 5);
    next();
  });
}

// Who can log in, and what the badge in the top bar says.
const ROLES = { owner: 'Owner', staff: 'Staff', tech: 'Technician' };

// Technicians get the floor only: their jobs, clocking, roster and the team pages.
// Everything with prices, customers' details or the business's settings stays out of reach.
const TECH_GET = [
  /^\/my-jobs(\/\d+)?$/,
  /^\/jobs\/\d+(\/photos\/\d+)?$/,
  /^\/(clocking|roster|team|procedures|training|account)$/,
  /^\/(procedures|training)\/\d+$/,
  /^\/logo$/,
];
const TECH_POST = [
  /^\/jobs\/\d+\/(clock-on|clock-off|notes|progress|take|checklist|tasks|photos)$/,
  /^\/jobs\/\d+\/(tasks|photos)\/\d+\/(toggle|delete)$/,
  /^\/clocking\/(start|break|resume|finish)$/,
  /^\/team(\/\d+\/(done|reopen|delete))?$/,
  /^\/training\/\d+\/complete$/,
  /^\/account$/,
];

function techGate(req, res, next) {
  if (!req.user || req.user.role !== 'tech') return next();
  if (req.method === 'GET' && req.path === '/') return res.redirect('/my-jobs');
  const allowed = req.method === 'GET' || req.method === 'HEAD' ? TECH_GET : req.method === 'POST' ? TECH_POST : [];
  if (allowed.some((re) => re.test(req.path))) return next();
  res.status(403).render('message', {
    title: 'Not on a technician login',
    message: 'Ask the workshop owner if you need this. Your jobs are under My jobs.',
  });
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  res.status(403).render('message', { title: 'Owner only', message: 'Only the workshop owner can do this.' });
}

module.exports = { setup, requireOwner, techGate, ROLES, hashPassword, verifyPassword, passwordProblem };
