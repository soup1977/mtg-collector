// Backups: a consistent database snapshot plus human-readable exports, written into folders that a
// cloud app (OneDrive, iCloud Drive) syncs. The live database never lives in a synced folder.
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, setSettings } from './settings.js';
import { ARCHIDEKT_HEADER, csvRow } from './csv.js';

const FOLDER = 'MTG Collector Backups';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Personal OneDrive: the OneDrive app mounts it under ~/Library/CloudStorage/OneDrive-Personal. */
function oneDrivePersonal() {
  const base = join(homedir(), 'Library', 'CloudStorage');
  try {
    const hit = readdirSync(base).find((d) => /^OneDrive-Personal/i.test(d));
    return hit ? join(base, hit) : null;
  } catch { return null; }
}

/** In Docker, MTG_BACKUP_DIR fixes the backup folder; the other destinations don't exist there. */
export const backupManaged = () => Boolean(process.env.MTG_BACKUP_DIR);

export function destinations(settings) {
  if (backupManaged()) {
    const base = process.env.MTG_BACKUP_DIR;
    return [{ id: 'server', label: 'Server folder', base, hint: existsSync(base) ? null : `${base} does not exist`,
      enabled: true, available: existsSync(base), path: base }];
  }
  const icloud = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const od = oneDrivePersonal();
  const list = [
    { id: 'onedrive', label: 'OneDrive (personal)', base: od,
      hint: od ? null : 'Not found. Sign in to your personal Microsoft account in the OneDrive app, then reload.' },
    { id: 'icloud', label: 'iCloud Drive', base: existsSync(icloud) ? icloud : null,
      hint: existsSync(icloud) ? null : 'iCloud Drive is not turned on in System Settings.' },
    { id: 'custom', label: 'Custom folder', base: settings.backupCustomPath || null,
      hint: settings.backupCustomPath ? null : 'Set a folder path below.' },
  ];
  return list.map((d) => ({
    ...d,
    enabled: settings.backupDestinations.includes(d.id),
    available: Boolean(d.base && existsSync(d.base)),
    path: d.base ? join(d.base, FOLDER) : null,
  }));
}

const safeName = (s) => s.replace(/[/\\:*?"<>|]+/g, '-').trim().slice(0, 80) || 'deck';

/** Collection in Archidekt's CSV format (re-importable here and into Archidekt). */
function collectionCsv(db) {
  const rows = db.prepare(`SELECT ci.quantity, c.name, ci.finish, ci.condition, ci.date_added, ci.language, ci.purchase_price,
      ci.tags, c.set_name, c.set_code, c.scryfall_id, c.collector_number
    FROM collection_items ci JOIN cards c ON c.scryfall_id = ci.scryfall_id ORDER BY c.name`).all();
  return [ARCHIDEKT_HEADER, ...rows.map((r) => csvRow([r.quantity, r.name, r.finish, r.condition, r.date_added, r.language,
    r.purchase_price, r.tags, r.set_name, r.set_code, '', r.scryfall_id, r.collector_number]))].join('\n') + '\n';
}

/** A deck as Archidekt-style text ("1x Name (set) 123 *F* [Category]"), re-importable here. */
function deckText(db, deck) {
  const cards = db.prepare(`SELECT dc.quantity, dc.category, dc.is_commander, dc.board, dc.finish, c.name, c.set_code, c.collector_number
    FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id WHERE dc.deck_id = ?
    ORDER BY dc.board, dc.is_commander DESC, dc.category, c.name`).all(deck.id);
  const lines = cards.map((c) => {
    const cat = c.board === 'considering' ? 'Maybeboard' : c.is_commander ? 'Commander' : c.category;
    const fin = c.finish === 'Foil' ? ' *F*' : c.finish === 'Etched' ? ' *E*' : '';
    return `${c.quantity}x ${c.name} (${c.set_code}) ${c.collector_number}${fin}${cat ? ` [${cat}]` : ''}`;
  });
  const head = [`// ${deck.name}`, `// format: ${deck.format || 'commander'}${deck.archived_at ? ` · dissolved ${deck.archived_at}` : ''}`];
  return [...head, ...lines].join('\n') + '\n';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write one backup into dir: mtg.sqlite, collection.csv, decks/*.txt, README.txt. */
function writeBackup(db, dir) {
  mkdirSync(join(dir, 'decks'), { recursive: true });
  db.exec(`VACUUM INTO '${join(dir, 'mtg.sqlite').replace(/'/g, "''")}'`);
  writeFileSync(join(dir, 'collection.csv'), collectionCsv(db));
  for (const deck of db.prepare('SELECT * FROM decks').all()) {
    writeFileSync(join(dir, 'decks', `${safeName(deck.name)}${deck.archived_at ? ' (dissolved)' : ''}.txt`), deckText(db, deck));
  }
  writeFileSync(join(dir, 'README.txt'), [
    'MTG Collector backup',
    '',
    'mtg.sqlite      Everything (collection, decks, verification, history, settings). Restore it from Settings in the app.',
    'collection.csv  Your collection in Archidekt CSV format.',
    'decks/*.txt     Each deck as an Archidekt-style list (Considering cards are under [Maybeboard]).',
    '',
  ].join('\n'));
}

/** Keep the newest `keep` backups in a destination folder. */
function prune(path, keep) {
  const dirs = readdirSync(path).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d)).sort().reverse();
  for (const d of dirs.slice(keep)) rmSync(join(path, d), { recursive: true, force: true });
}

let running = false;

/** Back up to every enabled, available destination. */
export function runBackup(db) {
  if (running) throw Object.assign(new Error('A backup is already running'), { status: 409 });
  running = true;
  try {
    const s = getSettings(db);
    const targets = destinations(s).filter((d) => d.enabled && d.available);
    if (!targets.length) throw Object.assign(new Error('No backup destination is turned on and available'), { status: 400 });
    const name = stamp();
    const results = [];
    for (const t of targets) {
      try {
        const dir = join(t.path, name);
        writeBackup(db, dir);
        prune(t.path, s.backupKeep);
        results.push({ id: t.id, label: t.label, ok: true, dir });
      } catch (e) {
        results.push({ id: t.id, label: t.label, ok: false, error: e.message });
      }
    }
    if (results.some((r) => r.ok)) setSettings(db, { lastBackupAt: new Date().toISOString() });
    return { name, results };
  } finally {
    running = false;
  }
}

/** Every backup found across destinations, newest first. */
export function listBackups(db) {
  const out = [];
  for (const d of destinations(getSettings(db))) {
    if (!d.enabled || !d.available || !existsSync(d.path)) continue;
    for (const name of readdirSync(d.path)) {
      const file = join(d.path, name, 'mtg.sqlite');
      if (!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(name) || !existsSync(file)) continue;
      out.push({ destination: d.id, label: d.label, name, file, size: statSync(file).size });
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

const TABLES = ['cards', 'collection_items', 'decks', 'deck_cards', 'collection_log', 'deck_changes', 'settings'];

/**
 * Restore a backup into the live database (same connection, so the running app keeps working).
 * A safety copy of the current state is saved to data/pre-restore/ first.
 */
export function restoreBackup(db, { destination, name }) {
  const b = listBackups(db).find((x) => x.destination === destination && x.name === name);
  if (!b) throw Object.assign(new Error('Backup not found'), { status: 404 });
  return { restored: b.name, from: b.label, ...restoreFromFile(db, b.file) };
}

/** Throws a 400 unless `file` is an intact MTG Collector database. */
export function checkBackupFile(file) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const head = Buffer.alloc(16);
  const fd = openSync(file, 'r');
  try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\0') throw bad('That file is not a database. Choose the mtg.sqlite file from a backup folder.');
  let bk;
  try {
    bk = new DatabaseSync(file, { readOnly: true });
    const ok = bk.prepare('PRAGMA quick_check').get();
    if (Object.values(ok)[0] !== 'ok') throw bad('That database is damaged.');
    const tables = new Set(bk.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (!['cards', 'collection_items', 'decks', 'deck_cards'].every((t) => tables.has(t))) {
      throw bad('That database is not an MTG Collector backup.');
    }
  } catch (e) {
    throw e.status ? e : bad(`Can't read that database: ${e.message}`);
  } finally { bk?.close(); }
}

/** Replace the live data with the contents of a database file, after saving a safety copy. */
export function restoreFromFile(db, file) {
  checkBackupFile(file);
  const live = db.location();
  const safety = process.env.MTG_SAFETY_DIR || join(live ? dirname(live) : join(root, 'data'), 'pre-restore');
  mkdirSync(safety, { recursive: true });
  const safetyFile = join(safety, `before-restore-${stamp()}.sqlite`);
  db.exec(`VACUUM INTO '${safetyFile.replace(/'/g, "''")}'`);

  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS bk`);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      for (const t of TABLES) {
        const has = db.prepare("SELECT 1 FROM bk.sqlite_master WHERE type = 'table' AND name = ?").get(t);
        db.exec(`DELETE FROM main.${t}`);
        if (!has) continue;
        // Copy the columns both schemas share (older backups may lack newer columns).
        const mine = db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name);
        const theirs = new Set(db.prepare(`PRAGMA bk.table_info(${t})`).all().map((c) => c.name));
        const cols = mine.filter((c) => theirs.has(c)).join(', ');
        db.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM bk.${t}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('DETACH DATABASE bk');
  }
  return { safetyCopy: safetyFile };
}

/** Back up automatically when the last backup is older than a day. Checked hourly. */
export function startAutoBackup(db) {
  const check = () => {
    const s = getSettings(db);
    if (!s.autoBackup) return;
    const age = s.lastBackupAt ? Date.now() - Date.parse(s.lastBackupAt) : Infinity;
    if (age < 24 * 3600 * 1000) return;
    if (!destinations(s).some((d) => d.enabled && d.available)) return;
    try {
      const r = runBackup(db);
      console.log(`Backup ${r.name}: ${r.results.map((x) => `${x.label} ${x.ok ? 'ok' : `failed (${x.error})`}`).join(', ')}`);
    } catch (e) { console.error('Automatic backup failed:', e.message); }
  };
  setTimeout(check, 10_000);
  return setInterval(check, 3600 * 1000);
}
