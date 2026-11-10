// Login, cross-site request protection, and security headers.
//
// - APP_PASSWORD set: every /api route except health/session/login needs a session cookie.
//   Sessions are signed with a secret derived from the password, so changing the password
//   logs everyone out.
// - No APP_PASSWORD: only requests addressed to localhost (or ALLOWED_HOSTS) are served,
//   which blocks DNS-rebinding attacks against an unauthenticated local app.
// - Every state-changing /api request must carry the X-MTG-Client header (cross-site pages
//   cannot add custom headers without a CORS preflight, which this server never approves),
//   and must not be marked cross-site by the browser.
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const COOKIE = 'mtg_session';
const SESSION_DAYS = 30;
const PUBLIC_API = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const CLIENT_HEADER = 'x-mtg-client';

/** Secret for signing sessions: SESSION_SECRET, else a random one kept next to the database. */
export function loadSecret(file) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!file) return randomBytes(32).toString('hex');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const s = randomBytes(32).toString('hex');
  writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const hostname = (host = '') => host.replace(/:\d+$/, '').toLowerCase();

export function createAuth({ password = '', secret, allowedHosts = [] } = {}) {
  const required = Boolean(password);
  const key = createHmac('sha256', secret).update(password).digest();
  const sign = (exp) => createHmac('sha256', key).update(String(exp)).digest('base64url');

  const makeToken = () => {
    const exp = Date.now() + SESSION_DAYS * 86400_000;
    return `${exp}.${sign(exp)}`;
  };
  const validToken = (token) => {
    const [exp, sig] = String(token || '').split('.');
    if (!exp || !sig || !(Number(exp) > Date.now())) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const isAuthed = (req) => !required || validToken(parseCookies(req.headers.cookie)[COOKIE]);

  const setCookie = (req, res, value, maxAgeSec) => {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (req.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  };

  // Failed logins per client: 10 per 15 minutes.
  const failures = new Map();
  const WINDOW = 15 * 60_000;
  const LIMIT = 10;
  const tooMany = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > WINDOW) { failures.delete(ip); return false; }
    return f.count >= LIMIT;
  };
  const fail = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > WINDOW) failures.set(ip, { first: Date.now(), count: 1 });
    else f.count++;
  };

  const allowed = new Set([...LOOPBACK, ...allowedHosts.map((h) => h.toLowerCase())]);

  /** Security headers for every response. */
  function headers(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data: https://*.scryfall.io https://*.scryfall.com",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '));
    next();
  }

  /** Host check (no password), cross-site check, and login check for /api. */
  function guard(req, res, next) {
    if (!required && !allowed.has(hostname(req.headers.host))) {
      return res.status(403).json({ error: 'Host not allowed. Set APP_PASSWORD (or ALLOWED_HOSTS) to serve this address.' });
    }
    if (!req.path.startsWith('/api/') && req.path !== '/api') return next();
    if (!SAFE_METHODS.has(req.method)) {
      const site = req.headers['sec-fetch-site'];
      if ((site && site !== 'same-origin' && site !== 'none') || req.headers[CLIENT_HEADER] !== '1') {
        return res.status(403).json({ error: 'Cross-site request blocked' });
      }
    }
    if (PUBLIC_API.has(req.path) || isAuthed(req)) return next();
    res.status(401).json({ error: 'Login required', code: 'LOGIN_REQUIRED' });
  }

  function routes(app) {
    app.get('/api/session', (req, res) => res.json({ authRequired: required, authenticated: isAuthed(req) }));

    app.post('/api/login', (req, res) => {
      if (!required) return res.json({ ok: true });
      const ip = req.ip || 'unknown';
      if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const given = String(req.body?.password ?? '');
      if (!timingSafeEqual(sha256(given), sha256(password))) {
        fail(ip);
        return res.status(401).json({ error: 'Wrong password' });
      }
      failures.delete(ip);
      setCookie(req, res, makeToken(), SESSION_DAYS * 86400);
      res.json({ ok: true });
    });

    app.post('/api/logout', (req, res) => {
      setCookie(req, res, '', 0);
      res.json({ ok: true });
    });
  }

  return { required, headers, guard, routes, isAuthed };
}
