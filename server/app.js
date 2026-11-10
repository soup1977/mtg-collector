// The Express app, separate from startup so tests can run it against an in-memory database.
import express from 'express';
import multer from 'multer';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCollection } from './importCollection.js';
import { importDeck } from './importDeck.js';
import collectionRoutes from './routes/collection.js';
import cardRoutes from './routes/cards.js';
import deckRoutes from './routes/decks.js';
import changeRoutes from './routes/changes.js';
import { getSettings, setSettings } from './settings.js';
import { isRefreshing } from './prices.js';
import { destinations, listBackups, runBackup, restoreBackup, restoreFromFile, backupManaged } from './backup.js';
import { createAuth } from './auth.js';
import { FORMATS } from './validate.js';
import { handle, httpError, text } from './http.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * options: { password, secret, allowedHosts, trustProxy, serveClient }
 */
export function createApp(db, { password = '', secret = 'dev', allowedHosts = [], trustProxy = false, serveClient = true } = {}) {
  const app = express();
  const auth = createAuth({ password, secret, allowedHosts });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10 } });

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(auth.headers);
  app.use(auth.guard);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', handle(() => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  }));
  auth.routes(app);

  app.use('/api/collection', collectionRoutes(db));
  app.use('/api/cards', cardRoutes(db));
  app.use('/api/decks', deckRoutes(db));
  app.use('/api/changes', changeRoutes(db));

  app.get('/api/settings', handle(() => ({ ...getSettings(db), refreshing: isRefreshing(), backupManaged: backupManaged() })));
  const EDITABLE = ['excludeBulk', 'bulkThreshold', 'autoBackup', 'backupDestinations', 'backupCustomPath', 'backupKeep'];
  app.patch('/api/settings', handle((req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    return setSettings(db, Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k))));
  }));

  app.get('/api/backups', handle(() => ({ managed: backupManaged(), destinations: destinations(getSettings(db)), backups: listBackups(db) })));
  app.post('/api/backups', handle(() => runBackup(db)));
  app.post('/api/backups/restore', handle((req) => restoreBackup(db, req.body || {})));

  // Restore from a backup file uploaded from the browser (e.g. mtg.sqlite from another computer).
  const dbUpload = multer({ dest: tmpdir(), limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 0 } });
  app.post('/api/backups/upload', dbUpload.single('file'), handle((req) => {
    if (!req.file) throw httpError(400, 'Choose a backup file (mtg.sqlite)');
    try {
      return { restored: req.file.originalname, from: 'uploaded file', ...restoreFromFile(db, req.file.path) };
    } finally {
      rmSync(req.file.path, { force: true });
    }
  }));

  const bodyText = (req) => (req.file ? req.file.buffer.toString('utf8') : String(req.body?.text || ''));

  app.post('/api/import/collection', upload.single('file'), handle(async (req) => {
    const csv = bodyText(req);
    if (!csv.trim()) throw httpError(400, 'No CSV provided');
    return importCollection(db, csv, { mode: req.body?.mode === 'replace' ? 'replace' : 'merge' });
  }));

  app.post('/api/import/deck', upload.single('file'), handle(async (req) => {
    const list = bodyText(req);
    if (!list.trim()) throw httpError(400, 'No deck list provided');
    const fallback = req.file ? basename(req.file.originalname, extname(req.file.originalname)) : '';
    const name = text(req.body?.name || fallback, 'Deck name', 100);
    if (!name) throw httpError(400, 'Deck name required');
    const format = req.body?.format || 'commander';
    if (!FORMATS[format]) throw httpError(400, `Unknown format ${format}`);
    const replace = req.body?.replace === 'true' || req.body?.replace === true;
    try {
      return await importDeck(db, { name, text: list, format, replace });
    } catch (e) {
      if (e.code === 'DECK_EXISTS') throw Object.assign(httpError(409, e.message), { code: e.code });
      throw e;
    }
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  const dist = resolve(root, 'client/dist');
  if (serveClient && existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }

  // Unexpected errors: log the details, send a generic message.
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    const status = err.status || err.statusCode || 500;
    if (status < 500) return res.status(status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Check the server log.' });
  });

  return app;
}
