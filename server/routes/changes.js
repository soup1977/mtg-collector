import { Router } from 'express';
import { undoAddition } from '../verify.js';
import { ARCHIDEKT_HEADER, csvRow } from '../csv.js';

/** Collection changes made in the app: review, undo, and export for Archidekt. */
export default function changeRoutes(db) {
  const r = Router();

  const list = (where = '') => db.prepare(`SELECT l.*, c.name, c.set_code, c.set_name, c.collector_number, c.oracle_id, c.image_small
      FROM collection_log l JOIN cards c ON c.scryfall_id = l.scryfall_id
      ${where} ORDER BY l.at DESC, l.id DESC`).all();

  r.get('/', (_req, res) => res.json(list()));

  // Archidekt-compatible collection CSV of additions that haven't been exported yet (or ?all=1).
  r.get('/export.csv', (req, res) => {
    const rows = list(req.query.all === '1' ? 'WHERE l.undone = 0' : 'WHERE l.undone = 0 AND l.exported_at IS NULL');
    const lines = rows.map((x) => csvRow([x.quantity, x.name, x.finish, 'NM', x.at.slice(0, 10), 'EN', '', '', x.set_name, x.set_code, '', x.scryfall_id, x.collector_number]));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="mtg-collector-additions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([ARCHIDEKT_HEADER, ...lines].join('\n') + '\n');
  });

  r.post('/mark-exported', (_req, res) => {
    const info = db.prepare("UPDATE collection_log SET exported_at = datetime('now') WHERE exported_at IS NULL AND undone = 0").run();
    res.json({ marked: Number(info.changes) });
  });

  // Undo an addition: remove the collection row it created.
  r.post('/:id/undo', (req, res) => {
    if (!undoAddition(db, Number(req.params.id))) return res.status(404).json({ error: 'Nothing to undo' });
    res.json({ ok: true });
  });

  return r;
}
