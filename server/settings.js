// App settings stored in the database as key/value pairs.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const bad = (message) => Object.assign(new Error(message), { status: 400 });
export const DEFAULTS = {
  excludeBulk: true,     // leave bulk-priced cards out of value totals and show "bulk" instead of a price
  bulkThreshold: 1.0,    // USD: cards priced below this are bulk
  pricesRefreshedAt: null,
  autoBackup: true,                     // back up daily to the enabled destinations
  backupDestinations: ['onedrive'],     // 'onedrive' (personal) | 'icloud' | 'custom'
  backupCustomPath: '',
  backupKeep: 30,                       // backups kept per destination
  lastBackupAt: null,
};

export function getSettings(db) {
  const out = { ...DEFAULTS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (key in DEFAULTS) out[key] = JSON.parse(value);
  }
  return out;
}

export function setSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    let v = value;
    if (key === 'excludeBulk' || key === 'autoBackup') v = Boolean(value);
    if (key === 'backupDestinations') v = (Array.isArray(value) ? value : []).filter((d) => ['onedrive', 'icloud', 'custom'].includes(d));
    if ((key === 'backupCustomPath' || key === 'backupDestinations') && process.env.MTG_BACKUP_DIR) {
      throw bad('The backup folder is set by the server (MTG_BACKUP_DIR)');
    }
    if (key === 'backupCustomPath') {
      v = String(value || '').trim();
      if (v && (!isAbsolute(v) || !existsSync(v) || !statSync(v).isDirectory())) throw bad('Custom backup folder must be an existing folder (full path)');
    }
    if (key === 'backupKeep') {
      v = Math.round(Number(value));
      if (!(v >= 1 && v <= 365)) throw bad('Keep between 1 and 365 backups');
    }
    if (key === 'bulkThreshold') {
      v = Number(value);
      if (!Number.isFinite(v) || v < 0) throw bad('Bulk threshold must be a positive number');
    }
    stmt.run(key, JSON.stringify(v));
  }
  return getSettings(db);
}

/** SQL-ready bulk parameters: threshold is 0 when bulk isn't excluded. */
export function bulkParams(db) {
  const s = getSettings(db);
  return { th: s.excludeBulk ? s.bulkThreshold : 0 };
}
