// Deck verification: confirm which physical printing each deck card is,
// claim owned copies, and add cards to the collection when they weren't logged.
import { tx } from './db.js';
import { fetchBySetNumber, fetchPrints, upsertCards } from './scryfall.js';

const isBasic = (typeLine) => /Basic Land/.test(typeLine || '');
const today = () => new Date().toISOString().slice(0, 10);

/** Owned copies of one printing, copies claimed by *other* confirmed deck cards, and who claims them. */
export function printingAvailability(db, scryfallId, excludeDeckCardId = -1) {
  const owned = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM collection_items WHERE scryfall_id = ?').get(scryfallId).n;
  const claims = db.prepare(`SELECT d.id AS deck_id, d.name AS deck, dc.quantity
      FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
      WHERE dc.scryfall_id = ? AND dc.verify_status = 'confirmed' AND dc.id != ? AND d.archived_at IS NULL
        AND dc.board = 'main'`).all(scryfallId, excludeDeckCardId);
  const claimed = claims.reduce((s, c) => s + c.quantity, 0);
  return { owned, claimed, free: owned - claimed, claims };
}

function ownedFinishes(db, scryfallId) {
  return db.prepare(`SELECT finish, SUM(quantity) AS quantity FROM collection_items
    WHERE scryfall_id = ? GROUP BY finish ORDER BY quantity DESC`).all(scryfallId);
}

/** Options for verifying one deck card: every printing you own of that card, with availability. */
export function verifyOptions(db, deckCardId) {
  const row = db.prepare(`SELECT dc.*, c.name, c.type_line, c.set_code, c.set_name, c.collector_number, c.image_normal, d.name AS deck_name
    FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id JOIN decks d ON d.id = dc.deck_id
    WHERE dc.id = ?`).get(deckCardId);
  if (!row) return null;
  const printings = db.prepare(`SELECT DISTINCT c.scryfall_id, c.set_code, c.set_name, c.collector_number, c.image_normal, c.raw
      FROM cards c JOIN collection_items ci ON ci.scryfall_id = c.scryfall_id
      WHERE c.oracle_id = ? ORDER BY c.set_name`).all(row.oracle_id)
    .map((p) => {
      const raw = JSON.parse(p.raw);
      delete p.raw;
      return {
        ...p,
        finishes: raw.finishes || ['nonfoil'],
        owned_finishes: ownedFinishes(db, p.scryfall_id),
        ...printingAvailability(db, p.scryfall_id, row.id),
      };
    });
  // Make sure the deck's listed printing is always an option, even if not owned.
  if (!printings.some((p) => p.scryfall_id === row.scryfall_id)) {
    const raw = JSON.parse(db.prepare('SELECT raw FROM cards WHERE scryfall_id = ?').get(row.scryfall_id).raw);
    printings.push({
      scryfall_id: row.scryfall_id, set_code: row.set_code, set_name: row.set_name,
      collector_number: row.collector_number, image_normal: row.image_normal,
      finishes: raw.finishes || ['nonfoil'], owned_finishes: [],
      ...printingAvailability(db, row.scryfall_id, row.id),
    });
  }
  return { card: row, printings };
}

/** Record a collection addition and log it. */
export function addToCollection(db, { scryfall_id, finish = 'Normal', quantity, reason }) {
  const info = db.prepare(`INSERT INTO collection_items (scryfall_id, finish, condition, language, quantity, date_added, source)
    VALUES (?, ?, 'NM', 'EN', ?, ?, 'app')`).run(scryfall_id, finish, quantity, today());
  const itemId = Number(info.lastInsertRowid);
  const log = db.prepare(`INSERT INTO collection_log (action, scryfall_id, finish, quantity, reason, collection_item_id)
    VALUES ('add', ?, ?, ?, ?, ?)`).run(scryfall_id, finish, quantity, reason, itemId);
  return { itemId, logId: Number(log.lastInsertRowid) };
}

/** Undo a logged collection addition. */
export function undoAddition(db, logId) {
  const entry = db.prepare('SELECT * FROM collection_log WHERE id = ? AND undone = 0').get(logId);
  if (!entry) return false;
  if (entry.collection_item_id) db.prepare('DELETE FROM collection_items WHERE id = ?').run(entry.collection_item_id);
  db.prepare('UPDATE collection_log SET undone = 1 WHERE id = ?').run(entry.id);
  return true;
}

/**
 * Apply a verify action to a deck card.
 *  - confirm: set the printing (and finish); if you don't own enough free copies of
 *    that printing and addMissing is true, add the difference to the collection.
 *  - missing: you don't have this card (or it's a proxy).
 *  - reset: back to unverified.
 */
export function verifyCard(db, deckCardId, { action, scryfall_id, finish, addMissing = true }) {
  const row = db.prepare('SELECT dc.*, d.name AS deck_name FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE dc.id = ?').get(deckCardId);
  if (!row) throw Object.assign(new Error('Deck card not found'), { status: 404 });

  if (action === 'reset' || action === 'missing') {
    db.prepare(`UPDATE deck_cards SET verify_status = ?, verified_at = ?, scan_count = 0 WHERE id = ?`)
      .run(action === 'missing' ? 'missing' : null, action === 'missing' ? new Date().toISOString() : null, row.id);
    return { status: action === 'missing' ? 'missing' : null, added: 0 };
  }
  if (action !== 'confirm') throw Object.assign(new Error(`Unknown action ${action}`), { status: 400 });

  const target = scryfall_id || row.scryfall_id;
  const card = db.prepare('SELECT scryfall_id, oracle_id, name, set_code, collector_number FROM cards WHERE scryfall_id = ?').get(target);
  if (!card) throw Object.assign(new Error('Unknown printing'), { status: 400 });
  if (card.oracle_id !== row.oracle_id) {
    const listed = db.prepare('SELECT name FROM cards WHERE scryfall_id = ?').get(row.scryfall_id).name;
    throw Object.assign(new Error(`${card.set_code.toUpperCase()} #${card.collector_number} is ${card.name}, not ${listed}`), { status: 400 });
  }

  return tx(db, () => {
    const avail = printingAvailability(db, target, row.id);
    const owned = ownedFinishes(db, target);
    const useFinish = finish || owned[0]?.finish || 'Normal';
    let added = 0;
    let logId = null;
    if (addMissing && avail.free < row.quantity) {
      added = row.quantity - Math.max(avail.free, 0);
      ({ logId } = addToCollection(db, {
        scryfall_id: target, finish: useFinish, quantity: added,
        reason: `Verified in deck "${row.deck_name}"`,
      }));
    }
    db.prepare(`UPDATE deck_cards SET scryfall_id = ?, finish = ?, verify_status = 'confirmed', verified_at = ?, scan_count = quantity WHERE id = ?`)
      .run(target, useFinish, new Date().toISOString(), row.id);
    return {
      status: 'confirmed', added, logId, finish: useFinish,
      printing: `${card.set_code.toUpperCase()} #${card.collector_number}`,
      previous: { scryfall_id: row.scryfall_id, finish: row.finish, verify_status: row.verify_status, scan_count: row.scan_count },
    };
  });
}

/**
 * Parse quick entry like "dsc 94", "DSC 94 f", "plst LTR-123 foil", "c16 41 e".
 * Returns { set, number, finish } or null.
 */
export function parseQuickEntry(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  const [set, number, f] = parts;
  if (!/^[a-z0-9]{2,6}$/i.test(set)) return null;
  let finish = 'Normal';
  if (f) {
    if (/^(f|foil)$/i.test(f)) finish = 'Foil';
    else if (/^(e|etched)$/i.test(f)) finish = 'Etched';
    else if (/^(n|nf|nonfoil|normal)$/i.test(f)) finish = 'Normal';
    else return null;
  }
  return { set: set.toLowerCase(), number, finish };
}

/** Resolve a quick entry to a cached printing (fetching from Scryfall if needed). */
export async function resolveQuickEntry(db, text) {
  const q = parseQuickEntry(text);
  if (!q) throw Object.assign(new Error('Use: set number [f|e], e.g. "dsc 94" or "one 12 f"'), { status: 400 });
  let card = db.prepare('SELECT scryfall_id FROM cards WHERE set_code = ? AND collector_number = ?').get(q.set, q.number);
  if (!card) {
    const sc = await fetchBySetNumber(q.set, q.number);
    if (!sc) throw Object.assign(new Error(`No card ${q.set.toUpperCase()} #${q.number} on Scryfall`), { status: 404 });
    upsertCards(db, [sc]);
    card = { scryfall_id: sc.id };
  }
  return { scryfall_id: card.scryfall_id, finish: q.finish };
}

/**
 * Auto-fix: for unverified cards whose listed printing you don't own, switch to the
 * printing you do own when there is exactly one owned printing with a free copy.
 * Does not confirm anything; you still verify against the physical deck.
 */
export function autofixDeck(db, deckId) {
  const rows = db.prepare(`SELECT dc.id, dc.scryfall_id, dc.oracle_id, dc.quantity, c.name, c.type_line, c.set_code, c.collector_number
    FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
    WHERE dc.deck_id = ? AND dc.verify_status IS NULL AND dc.board = 'main'`).all(deckId);
  const switched = [];
  const ambiguous = [];
  tx(db, () => {
    for (const r of rows) {
      if (isBasic(r.type_line)) continue;
      if (printingAvailability(db, r.scryfall_id, r.id).owned > 0) continue;
      const owned = db.prepare(`SELECT DISTINCT c.scryfall_id, c.set_code, c.collector_number FROM cards c
          JOIN collection_items ci ON ci.scryfall_id = c.scryfall_id WHERE c.oracle_id = ?`).all(r.oracle_id)
        .map((p) => ({ ...p, ...printingAvailability(db, p.scryfall_id, r.id) }))
        .filter((p) => p.free >= r.quantity);
      if (owned.length === 1) {
        const p = owned[0];
        db.prepare('UPDATE deck_cards SET scryfall_id = ? WHERE id = ?').run(p.scryfall_id, r.id);
        switched.push({ name: r.name, from: `${r.set_code.toUpperCase()} #${r.collector_number}`, to: `${p.set_code.toUpperCase()} #${p.collector_number}` });
      } else if (owned.length > 1) {
        ambiguous.push({ name: r.name, options: owned.length });
      }
    }
  });
  return { switched, ambiguous };
}

/**
 * Scan mode: you type the printing of whatever card is on top of the (shuffled) pile and the app
 * figures out which deck entry it is.
 * Results: confirmed | partial (qty > 1, more copies to scan) | duplicate | not_in_deck | basic.
 */
export async function scanCard(db, deckId, input) {
  // input: "set number [f|e]" text, or { scryfall_id, finish } picked visually (older cards without a set code).
  const { scryfall_id, finish = 'Normal' } = typeof input === 'string' || input?.quick
    ? await resolveQuickEntry(db, typeof input === 'string' ? input : input.quick)
    : input;
  if (!db.prepare('SELECT 1 FROM cards WHERE scryfall_id = ?').get(scryfall_id)) {
    throw Object.assign(new Error('Unknown printing'), { status: 400 });
  }
  const card = db.prepare('SELECT scryfall_id, oracle_id, name, set_code, collector_number, type_line, image_normal FROM cards WHERE scryfall_id = ?').get(scryfall_id);
  const label = `${card.set_code.toUpperCase()} #${card.collector_number}${finish !== 'Normal' ? ` ${finish}` : ''}`;
  const base = { card: { name: card.name, oracle_id: card.oracle_id, image: card.image_normal, printing: label } };

  if (isBasic(card.type_line)) return { ...base, result: 'basic' };

  const rows = db.prepare(`SELECT dc.*, c.set_code, c.collector_number FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
    WHERE dc.deck_id = ? AND dc.oracle_id = ? ORDER BY (dc.board = 'main') DESC, (dc.verify_status IS NULL) DESC, dc.id`).all(deckId, card.oracle_id);

  if (!rows.length) {
    // The physical deck wins: a card you're holding is in the deck, even if the list doesn't have it
    // (you probably swapped it in). Add it, confirmed.
    const otherDecks = db.prepare(`SELECT DISTINCT d.id, d.name FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
      WHERE dc.oracle_id = ? AND d.id != ? AND d.archived_at IS NULL AND dc.board = 'main' ORDER BY d.name`).all(card.oracle_id, deckId);
    const newId = Number(db.prepare(`INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, category)
      VALUES (?, ?, ?, 1, 'Added while scanning')`).run(deckId, scryfall_id, card.oracle_id).lastInsertRowid);
    const r = verifyCard(db, newId, { action: 'confirm', scryfall_id, finish });
    return {
      ...base, result: 'added_to_deck', deckCardId: newId, added: r.added, otherDecks,
      undo: { deckCardId: newId, logId: r.logId, removeRow: true },
    };
  }

  // First entry that still needs copies scanned (rows marked missing count as open: you found it after all).
  const row = rows.find((r) => r.verify_status !== 'confirmed' && r.scan_count < r.quantity);
  if (!row) return { ...base, result: 'duplicate', quantity: rows.reduce((s, r) => s + r.quantity, 0) };
  // Physically in the deck, so a card on the Considering list is really in the main deck.
  if (row.board !== 'main') db.prepare("UPDATE deck_cards SET board = 'main' WHERE id = ?").run(row.id);

  const listed = `${row.set_code.toUpperCase()} #${row.collector_number}`;
  const switched = row.scryfall_id !== scryfall_id ? listed : null;

  if (row.scan_count + 1 < row.quantity) {
    db.prepare('UPDATE deck_cards SET scan_count = scan_count + 1 WHERE id = ?').run(row.id);
    return {
      ...base, result: 'partial', deckCardId: row.id, scanned: row.scan_count + 1, quantity: row.quantity,
      undo: { deckCardId: row.id, previous: { scryfall_id: row.scryfall_id, finish: row.finish, verify_status: row.verify_status, scan_count: row.scan_count } },
    };
  }

  const r = verifyCard(db, row.id, { action: 'confirm', scryfall_id, finish });
  return {
    ...base, result: 'confirmed', deckCardId: row.id, added: r.added, switchedFrom: switched,
    undo: { deckCardId: row.id, logId: r.logId, previous: r.previous },
  };
}

/**
 * Printing choices for scanning a card by name: owned printings (with free copies for this deck)
 * first, then every printing on Scryfall, oldest first.
 */
export async function scanOptions(db, deckId, oracleId) {
  const prints = await fetchPrints(oracleId);
  upsertCards(db, prints);
  const row = db.prepare(`SELECT id, quantity, scryfall_id FROM deck_cards WHERE deck_id = ? AND oracle_id = ?
    ORDER BY (verify_status = 'confirmed'), id LIMIT 1`).get(deckId, oracleId);
  const excl = row?.id ?? -1;
  const out = prints.map((p) => ({
    scryfall_id: p.id,
    set_code: p.set,
    set_name: p.set_name,
    collector_number: p.collector_number,
    released_at: p.released_at,
    finishes: p.finishes || ['nonfoil'],
    image_normal: p.image_uris?.normal ?? p.card_faces?.[0]?.image_uris?.normal ?? null,
    listed: row?.scryfall_id === p.id,
    owned_finishes: ownedFinishes(db, p.id),
    ...printingAvailability(db, p.id, excl),
  }));
  out.sort((a, b) => (b.owned > 0) - (a.owned > 0) || String(a.released_at).localeCompare(String(b.released_at)));
  return { inDeck: Boolean(row), quantity: row?.quantity ?? 0, printings: out };
}

/** Revert one scan: restore the deck card and remove any collection copy it added. */
export function undoScan(db, deckId, { deckCardId, logId, previous, removeRow }) {
  return tx(db, () => {
    const row = db.prepare('SELECT id FROM deck_cards WHERE id = ? AND deck_id = ?').get(deckCardId, deckId);
    if (!row) throw Object.assign(new Error('Deck card not found'), { status: 404 });
    if (logId) undoAddition(db, logId);
    if (removeRow) {
      db.prepare('DELETE FROM deck_cards WHERE id = ?').run(row.id);
      return { ok: true };
    }
    db.prepare(`UPDATE deck_cards SET scryfall_id = ?, finish = ?, verify_status = ?, scan_count = ?,
      verified_at = CASE WHEN ? IS NULL THEN NULL ELSE verified_at END WHERE id = ?`)
      .run(previous.scryfall_id, previous.finish ?? null, previous.verify_status ?? null, previous.scan_count ?? 0,
        previous.verify_status ?? null, row.id);
    return { ok: true };
  });
}

/** After scanning the whole pile: everything not found is missing. */
export function markRemainingMissing(db, deckId) {
  const info = db.prepare(`UPDATE deck_cards SET verify_status = 'missing', verified_at = ?
    WHERE deck_id = ? AND verify_status IS NULL AND board = 'main'
      AND scryfall_id IN (SELECT scryfall_id FROM cards WHERE type_line NOT LIKE '%Basic Land%')`)
    .run(new Date().toISOString(), deckId);
  return { marked: Number(info.changes) };
}

/**
 * After scanning the whole pile: cards not confirmed (unscanned, or already marked missing)
 * were swapped out, so drop them from the deck.
 */
export function removeUnscanned(db, deckId) {
  const rows = db.prepare(`SELECT dc.id, c.name FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
    WHERE dc.deck_id = ? AND dc.board = 'main' AND (dc.verify_status IS NULL OR dc.verify_status = 'missing')
      AND c.type_line NOT LIKE '%Basic Land%'`).all(deckId);
  const del = db.prepare('DELETE FROM deck_cards WHERE id = ?');
  tx(db, () => rows.forEach((r) => del.run(r.id)));
  return { removed: rows.length, names: rows.map((r) => r.name) };
}

export { isBasic };
