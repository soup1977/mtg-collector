import { parse } from 'csv-parse/sync';
import { ensureCardsById } from './scryfall.js';
import { tx } from './db.js';

/** Parse an Archidekt collection CSV into row objects. */
export function parseCollectionCsv(text) {
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  return records.map((r, i) => ({
    line: i + 2,
    name: r['Name'],
    quantity: parseInt(r['Quantity'], 10) || 0,
    finish: r['Finish'] || 'Normal',
    condition: r['Condition'] || null,
    language: r['Language'] || null,
    date_added: r['Date Added'] || null,
    purchase_price: r['Purchase Price'] ? parseFloat(r['Purchase Price']) : null,
    tags: r['Tags'] || null,
    scryfall_id: (r['Scryfall ID'] || '').trim(),
  }));
}

/**
 * Import an Archidekt collection CSV.
 *
 * mode 'merge' (default): this app is the master record. For each printing+finish, if the CSV has
 *   more copies than the app, the difference is added. Nothing is ever removed, so cards added
 *   while verifying decks survive a re-import.
 * mode 'replace': discard the whole collection (including app additions) and load the CSV.
 */
export async function importCollection(db, text, { mode = 'merge' } = {}) {
  const rows = parseCollectionCsv(text);
  const skipped = rows.filter((r) => !r.scryfall_id || r.quantity <= 0);
  const valid = rows.filter((r) => r.scryfall_id && r.quantity > 0);

  const missingIds = await ensureCardsById(db, valid.map((r) => r.scryfall_id));
  const missing = new Set(missingIds);
  const insertable = valid.filter((r) => !missing.has(r.scryfall_id));

  let added = 0;
  let addedRows = 0;
  let unchanged = 0;
  tx(db, () => {
    if (mode === 'replace') {
      db.exec('DELETE FROM collection_items');
      db.exec('UPDATE collection_log SET undone = 1 WHERE undone = 0');
    }
    const stmt = db.prepare(`INSERT INTO collection_items
      (scryfall_id, finish, condition, language, quantity, date_added, purchase_price, tags, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import')`);
    const have = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM collection_items WHERE scryfall_id = ? AND finish = ?');

    // Group CSV rows by printing+finish so duplicates rows are compared as totals.
    const groups = new Map();
    for (const r of insertable) {
      const k = `${r.scryfall_id}|${r.finish}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const group of groups.values()) {
      const csvQty = group.reduce((s, r) => s + r.quantity, 0);
      let delta = csvQty - have.get(group[0].scryfall_id, group[0].finish).n;
      if (delta <= 0) { unchanged += csvQty; continue; }
      added += delta;
      // Insert the newest rows first until the difference is covered.
      for (const r of [...group].sort((a, b) => String(b.date_added).localeCompare(String(a.date_added)))) {
        if (delta <= 0) break;
        const q = Math.min(r.quantity, delta);
        stmt.run(r.scryfall_id, r.finish, r.condition, r.language, q, r.date_added, r.purchase_price, r.tags);
        addedRows++;
        delta -= q;
      }
    }
  });

  // Cards in the app's collection that the CSV doesn't have (likely added while verifying decks).
  const csvKeys = new Set(insertable.map((r) => `${r.scryfall_id}|${r.finish}`));
  const appOnly = db.prepare(`SELECT ci.scryfall_id, ci.finish, SUM(ci.quantity) AS quantity, c.name, c.set_code, c.collector_number
      FROM collection_items ci JOIN cards c ON c.scryfall_id = ci.scryfall_id
      GROUP BY ci.scryfall_id, ci.finish`).all()
    .filter((r) => !csvKeys.has(`${r.scryfall_id}|${r.finish}`));

  return {
    mode,
    rows: insertable.length,
    csvQuantity: insertable.reduce((s, r) => s + r.quantity, 0),
    added,
    addedRows,
    unchanged,
    totalQuantity: db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM collection_items').get().n,
    uniqueCards: db.prepare('SELECT COUNT(*) AS n FROM owned_by_oracle').get().n,
    notInCsv: appOnly.length,
    missing: valid.filter((r) => missing.has(r.scryfall_id)).map((r) => ({ line: r.line, name: r.name, scryfall_id: r.scryfall_id })),
    skipped: skipped.map((r) => ({ line: r.line, name: r.name })),
  };
}
