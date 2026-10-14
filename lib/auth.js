const crypto = require('crypto');

// Single shared password (APP_PASSWORD) and a signed cookie, so no session store is needed.
const COOKIE = 'ws_auth';
const MAX_AGE_DAYS = 30;

function key() {
  return crypto
    .createHash('sha256')
    .update((process.env.SESSION_SECRET || '') + ':' + (process.env.APP_PASSWORD || ''))
    .digest();
}

function sign(value) {
  return crypto.createHmac('sha256', key()).update(value).digest('hex');
}

function makeToken() {
  const expires = String(Date.now() + MAX_AGE_DAYS * 864e5);
  return `${expires}.${sign(expires)}`;
}

function validToken(token) {
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(process.env.APP_PASSWORD || '').digest();
  return crypto.timingSafeEqual(a, b);
}

function setup(app) {
  app.get('/login', (req, res) => res.render('login', { error: null }));

  app.post('/login', (req, res) => {
    if (!process.env.APP_PASSWORD || !passwordMatches(req.body.password)) {
      return res.status(401).render('login', { error: 'Wrong password.' });
    }
    res.cookie(COOKIE, makeToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: MAX_AGE_DAYS * 864e5,
    });
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    res.locals.authEnabled = Boolean(process.env.APP_PASSWORD);
    if (!process.env.APP_PASSWORD) return next();
    if (validToken(readCookie(req, COOKIE))) return next();
    res.redirect('/login');
  });
}

module.exports = { setup };
