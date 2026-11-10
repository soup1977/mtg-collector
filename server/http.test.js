// HTTP-level tests: login, cross-site protection, host check, input validation, error hiding.
import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createApp } from './app.js';

async function serve(opts = {}) {
  const db = openDb(':memory:');
  const app = createApp(db, { secret: 'test-secret', serveClient: false, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { body, headers = {}, cookie } = {}) => fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const app_ = (method, path, o = {}) => call(method, path, { ...o, headers: { 'X-MTG-Client': '1', ...o.headers } });
  // fetch() won't send a custom Host header, so the host check is tested with node:http.
  const withHost = (host, path) => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.address().port, path, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
  });
  return { db, call, app: app_, withHost, close: () => server.close() };
}

test('password: API locked until login; wrong password rejected; logout ends session', async () => {
  const s = await serve({ password: 'hunter2' });
  try {
    assert.equal((await s.call('GET', '/api/health')).status, 200);
    assert.deepEqual(await (await s.call('GET', '/api/session')).json(), { authRequired: true, authenticated: false });
    assert.equal((await s.call('GET', '/api/decks')).status, 401);

    assert.equal((await s.app('POST', '/api/login', { body: { password: 'nope' } })).status, 401);
    const ok = await s.app('POST', '/api/login', { body: { password: 'hunter2' } });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];

    assert.equal((await s.call('GET', '/api/decks', { cookie })).status, 200);
    assert.equal((await s.call('GET', '/api/decks', { cookie: 'mtg_session=9999999999999.forged' })).status, 401);
    assert.equal((await s.call('GET', '/api/decks', { cookie: `${cookie}x` })).status, 401);

    // A session signed under another password is not valid.
    const other = await serve({ password: 'different' });
    try { assert.equal((await other.call('GET', '/api/decks', { cookie })).status, 401); } finally { other.close(); }

    const out = await s.app('POST', '/api/logout', { cookie });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  } finally { s.close(); }
});

test('password: login attempts are rate limited', async () => {
  const s = await serve({ password: 'hunter2' });
  try {
    for (let i = 0; i < 10; i++) await s.app('POST', '/api/login', { body: { password: 'x' } });
    const r = await s.app('POST', '/api/login', { body: { password: 'hunter2' } });
    assert.equal(r.status, 429);
  } finally { s.close(); }
});

test('cross-site: changes need the client header and same-origin fetch metadata', async () => {
  const s = await serve();
  try {
    // A form post from another site: no custom header.
    assert.equal((await s.call('POST', '/api/decks', { body: { name: 'X' } })).status, 403);
    assert.equal((await s.call('POST', '/api/backups')).status, 403);
    // Header present but the browser says it came from another site.
    assert.equal((await s.app('POST', '/api/decks', { body: { name: 'X' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    // The app itself.
    assert.equal((await s.app('POST', '/api/decks', { body: { name: 'X' }, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 201);
    // Reads don't need the header.
    assert.equal((await s.call('GET', '/api/decks')).status, 200);
  } finally { s.close(); }
});

test('no password: only localhost (or ALLOWED_HOSTS) may be used, which blocks DNS rebinding', async () => {
  const s = await serve({ allowedHosts: ['mtg.tailnet.ts.net'] });
  try {
    assert.equal(await s.withHost('evil.example.com', '/api/decks'), 403);
    assert.equal(await s.withHost('mtg.tailnet.ts.net:3077', '/api/decks'), 200);
    assert.equal(await s.withHost('localhost:3001', '/api/decks'), 200);
  } finally { s.close(); }
});

test('security headers are set', async () => {
  const s = await serve();
  try {
    const r = await s.call('GET', '/api/health');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-powered-by'), null);
  } finally { s.close(); }
});

test('input validation: quantities, deck existence, settings', async () => {
  const s = await serve();
  try {
    s.db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, type_line, color_identity) VALUES ('sr', 'SR', 'Sol Ring', 'Artifact', '[]')`).run();
    const { id } = await (await s.app('POST', '/api/decks', { body: { name: 'D' } })).json();

    for (const quantity of [-5, 0, 1.5, 'abc', 1e9]) {
      const r = await s.app('POST', `/api/decks/${id}/cards`, { body: { scryfall_id: 'sr', quantity } });
      assert.equal(r.status, 400, `quantity ${quantity}`);
    }
    assert.equal((await s.app('POST', '/api/decks/999/cards', { body: { scryfall_id: 'sr' } })).status, 404);
    const add = await s.app('POST', `/api/decks/${id}/cards`, { body: { scryfall_id: 'sr', quantity: 1 } });
    assert.equal(add.status, 201);
    const cardId = (await add.json()).id;
    assert.equal((await s.app('PATCH', `/api/decks/${id}/cards/${cardId}`, { body: { quantity: -3 } })).status, 400);
    assert.equal((await s.app('PATCH', `/api/decks/${id}/cards/${cardId}`, { body: { quantity: 2 } })).status, 200);

    assert.equal((await s.app('POST', '/api/decks', { body: { name: 'x'.repeat(101) } })).status, 400);
    assert.equal((await s.app('POST', '/api/decks', { body: { name: 'F', format: 'nonsense' } })).status, 400);
    assert.equal((await s.app('DELETE', '/api/decks/999')).status, 404);

    assert.equal((await s.app('PATCH', '/api/settings', { body: { backupCustomPath: 'relative/path' } })).status, 400);
    assert.equal((await s.app('PATCH', '/api/settings', { body: { backupCustomPath: '/definitely/not/here' } })).status, 400);
    // Internal timestamps can't be set from outside.
    const after = await (await s.app('PATCH', '/api/settings', { body: { lastBackupAt: '2099-01-01' } })).json();
    assert.equal(after.lastBackupAt, null);
  } finally { s.close(); }
});

test('managed backup folder (MTG_BACKUP_DIR) cannot be changed from the UI', async () => {
  process.env.MTG_BACKUP_DIR = '/tmp';
  const s = await serve();
  try {
    const b = await (await s.call('GET', '/api/backups')).json();
    assert.equal(b.managed, true);
    assert.deepEqual(b.destinations.map((d) => d.id), ['server']);
    assert.equal((await s.app('PATCH', '/api/settings', { body: { backupCustomPath: '/etc' } })).status, 400);
    assert.equal((await s.app('PATCH', '/api/settings', { body: { backupDestinations: ['custom'] } })).status, 400);
  } finally { s.close(); delete process.env.MTG_BACKUP_DIR; }
});

test('unexpected errors are logged, not sent to the browser', async () => {
  const s = await serve();
  const orig = console.error;
  console.error = () => {};
  try {
    s.db.exec('DROP VIEW card_usage');
    const r = await s.call('GET', '/api/collection');
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.doesNotMatch(body.error, /card_usage|no such/i);
  } finally { console.error = orig; s.close(); }
});
