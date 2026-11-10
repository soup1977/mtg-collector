// Startup: open the database, check the security configuration, serve, and shut down cleanly.
//
// Environment:
//   PORT            default 3001
//   HOST            default 127.0.0.1 (this computer only). Use 0.0.0.0 to serve your network.
//   APP_PASSWORD    login password. Required when HOST isn't loopback (unless ALLOW_NO_AUTH=1).
//   ALLOWED_HOSTS   comma-separated hostnames allowed without a password (e.g. a Tailscale name)
//   SESSION_SECRET  optional; otherwise a random secret is kept next to the database
//   TRUST_PROXY     set to 1 behind a reverse proxy that terminates HTTPS
//   MTG_DB          database file (default data/mtg.sqlite)
//   MTG_BACKUP_DIR  fixed backup folder (Docker); hides the OneDrive/iCloud/custom choices
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { loadSecret } from './auth.js';
import { refreshIfStale } from './prices.js';
import { startAutoBackup } from './backup.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const password = process.env.APP_PASSWORD || '';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

if (!loopback && !password && process.env.ALLOW_NO_AUTH !== '1') {
  console.error(`Refusing to serve ${host} without a password. Set APP_PASSWORD (or ALLOW_NO_AUTH=1 if you really mean it).`);
  process.exit(1);
}

const db = openDb();
const app = createApp(db, {
  password,
  secret: loadSecret(join(dirname(db.location() || 'data/x'), '.session-secret')),
  allowedHosts: (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
  trustProxy: process.env.TRUST_PROXY === '1' ? 1 : false,
});

const server = app.listen(port, host, () => {
  console.log(`MTG Collector on http://${loopback ? 'localhost' : host}:${port}${password ? ' (login required)' : ''}`);
  if (process.env.NO_PRICE_REFRESH !== '1') refreshIfStale(db);
  if (process.env.NO_AUTO_BACKUP !== '1') startAutoBackup(db);
});

// Docker sends SIGTERM on stop: finish in-flight requests and close the database.
let stopping = false;
const shutdown = (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: shutting down`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
