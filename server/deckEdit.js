// Editing deck lists: add, remove, swap, and moving cards between the main deck and Considering.
// Every change is written to deck_changes so a deck has a readable history.
import { tx } from './db.js';
import { httpError as err, int, text } from './http.js';

const BOARDS = ['main', 'considering'];
function requireDeck(db, deckId) {
  if (!db.prepare('SELECT 1 FROM decks WHERE id = ?').get(deckId)) throw err(404, 'Deck not found');
}
const nameOf = (db, scryfallId) => db.prepare('SELECT name FROM cards WHERE scryfall_id = ?').get(scryfallId)?.name;

export function logChange(db, deckId, action, { cardIn = null, cardOut = null, detail = null } = {}) {
  db.prepare('INSERT INTO deck_changes (deck_id, action, card_in, card_out, detail) VALUES (?, ?, ?, ?, ?)')
    .run(deckId, action, cardIn, cardOut, detail);
}

function touch(db, deckId) {
  db.prepare("UPDATE decks SET updated_at = datetime('now') WHERE id = ?").run(deckId);
}

/** Insert a card, merging with an existing row of the same printing, category and board. Returns the row id. */
function insertCard(db, deckId, { scryfall_id, quantity = 1, category = null, board = 'main', is_commander = false }) {
  const card = db.prepare('SELECT scryfall_id, oracle_id FROM cards WHERE scryfall_id = ?').get(scryfall_id);
  if (!card) throw err(400, 'Unknown card; look it up first');
  const existing = db.prepare('SELECT id FROM deck_cards WHERE deck_id = ? AND scryfall_id = ? AND category IS ? AND board = ?')
    .get(deckId, scryfall_id, category, board);
  if (existing) {
    db.prepare('UPDATE deck_cards SET quantity = quantity + ? WHERE id = ?').run(quantity, existing.id);
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, category, is_commander, board)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(deckId, card.scryfall_id, card.oracle_id, quantity, category, is_commander ? 1 : 0, board).lastInsertRowid);
}

/** Take one copy of a deck card out: delete it, or move that copy to Considering. */
function takeOut(db, row, to) {
  if (row.quantity > 1) db.prepare('UPDATE deck_cards SET quantity = quantity - 1 WHERE id = ?').run(row.id);
  if (to === 'considering') {
    if (row.quantity > 1) insertCard(db, row.deck_id, { scryfall_id: row.scryfall_id, board: 'considering' });
    else db.prepare("UPDATE deck_cards SET board = 'considering', category = NULL, is_commander = 0 WHERE id = ?").run(row.id);
  } else if (row.quantity <= 1) {
    db.prepare('DELETE FROM deck_cards WHERE id = ?').run(row.id);
  }
}

/** Name of a main-deck card by oracle id, or an error if it isn't in the main deck. */
function mainCardName(db, deckId, oracleId) {
  const r = db.prepare(`SELECT c.name FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
    WHERE dc.deck_id = ? AND dc.oracle_id = ? AND dc.board = 'main' LIMIT 1`).get(deckId, oracleId);
  if (!r) throw err(400, 'The card it would replace is not in the main deck');
  return r.name;
}

/** Plain add, to the main deck or to Considering (optionally noting which main-deck card it would replace). */
export function addCard(db, deckId, { scryfall_id, quantity = 1, category = null, board = 'main', is_commander = false, replaces_oracle_id = null }) {
  quantity = int(quantity, 'Quantity', 1, 99);
  category = text(category, 'Category', 60);
  if (!BOARDS.includes(board)) throw err(400, 'Board must be main or considering');
  return tx(db, () => {
    requireDeck(db, deckId);
    const replacing = board === 'considering' && replaces_oracle_id ? mainCardName(db, deckId, replaces_oracle_id) : null;
    const id = insertCard(db, deckId, { scryfall_id, quantity, category: board === 'main' ? category : null, board, is_commander });
    if (replacing) db.prepare('UPDATE deck_cards SET replaces_oracle_id = ? WHERE id = ?').run(replaces_oracle_id, id);
    logChange(db, deckId, board === 'main' ? 'add' : 'to_considering', {
      cardIn: nameOf(db, scryfall_id),
      cardOut: replacing,
      detail: board === 'main' ? 'added' : replacing ? `considering in place of ${replacing}` : 'added to Considering',
    });
    touch(db, deckId);
    return { id };
  });
}

/** Set (or clear, with null) the main-deck card a Considering card would replace. */
export function setReplaces(db, deckId, cardId, oracleId) {
  return tx(db, () => {
    const row = db.prepare("SELECT * FROM deck_cards WHERE id = ? AND deck_id = ? AND board = 'considering'").get(cardId, deckId);
    if (!row) throw err(404, 'Not a Considering card in this deck');
    if (oracleId) mainCardName(db, deckId, oracleId);
    db.prepare('UPDATE deck_cards SET replaces_oracle_id = ? WHERE id = ?').run(oracleId || null, row.id);
    touch(db, deckId);
    return { ok: true };
  });
}

/**
 * Swap a Considering card into the deck in place of the card it was marked to replace
 * (or `out_card_id` if given). The replaced card goes to Considering or out of the deck.
 */
export function swapIn(db, deckId, cardId, { outTo = 'considering', out_card_id } = {}) {
  if (!['remove', 'considering'].includes(outTo)) throw err(400, 'outTo must be remove or considering');
  return tx(db, () => {
    const inRow = db.prepare("SELECT * FROM deck_cards WHERE id = ? AND deck_id = ? AND board = 'considering'").get(cardId, deckId);
    if (!inRow) throw err(404, 'Not a Considering card in this deck');
    const out = out_card_id
      ? db.prepare("SELECT * FROM deck_cards WHERE id = ? AND deck_id = ? AND board = 'main'").get(out_card_id, deckId)
      : db.prepare("SELECT * FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board = 'main' ORDER BY is_commander, id LIMIT 1")
        .get(deckId, inRow.replaces_oracle_id);
    if (!out) throw err(400, 'Choose which card it replaces first');
    const inName = nameOf(db, inRow.scryfall_id);
    const outName = nameOf(db, out.scryfall_id);

    // One copy comes in, taking the outgoing card's category.
    if (inRow.quantity > 1) {
      db.prepare('UPDATE deck_cards SET quantity = quantity - 1 WHERE id = ?').run(inRow.id);
      insertCard(db, deckId, { scryfall_id: inRow.scryfall_id, category: out.category });
    } else {
      db.prepare("UPDATE deck_cards SET board = 'main', category = ?, replaces_oracle_id = NULL WHERE id = ?").run(out.category, inRow.id);
    }
    takeOut(db, out, outTo);
    // Other cards that were competing for that slot now compete with the card that took it.
    const stillThere = db.prepare("SELECT 1 FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board = 'main'").get(deckId, out.oracle_id);
    if (!stillThere) {
      db.prepare("UPDATE deck_cards SET replaces_oracle_id = ? WHERE deck_id = ? AND board = 'considering' AND replaces_oracle_id = ?")
        .run(inRow.oracle_id, deckId, out.oracle_id);
    }
    logChange(db, deckId, 'swap', { cardIn: inName, cardOut: outName, detail: outTo === 'considering' ? `${outName} moved to Considering` : null });
    touch(db, deckId);
    return { ok: true };
  });
}

/**
 * Swap: a new card comes into the main deck in place of one going out.
 * The new card takes the outgoing card's category unless one is given.
 * outTo: 'remove' (out of the deck, freed in the collection) | 'considering'.
 */
export function swapCard(db, deckId, { scryfall_id, out_card_id, outTo = 'remove', category }) {
  if (category !== undefined) category = text(category, 'Category', 60);
  if (!['remove', 'considering'].includes(outTo)) throw err(400, 'outTo must be remove or considering');
  return tx(db, () => {
    const out = db.prepare("SELECT * FROM deck_cards WHERE id = ? AND deck_id = ? AND board = 'main'").get(out_card_id, deckId);
    if (!out) throw err(404, 'The card being swapped out is not in this deck');
    const outName = nameOf(db, out.scryfall_id);
    const inName = nameOf(db, scryfall_id);
    if (!inName) throw err(400, 'Unknown card; look it up first');
    const id = insertCard(db, deckId, { scryfall_id, category: category ?? out.category, is_commander: out.is_commander && out.quantity === 1 });
    takeOut(db, out, outTo);
    logChange(db, deckId, 'swap', { cardIn: inName, cardOut: outName, detail: outTo === 'considering' ? `${outName} moved to Considering` : null });
    touch(db, deckId);
    return { id };
  });
}

/** Move a card between the main deck and Considering. */
export function moveBoard(db, deckId, cardId, board) {
  if (!BOARDS.includes(board)) throw err(400, 'Board must be main or considering');
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM deck_cards WHERE id = ? AND deck_id = ?').get(cardId, deckId);
    if (!row) throw err(404, 'Not found');
    if (row.board === board) return { ok: true };
    const name = nameOf(db, row.scryfall_id);
    if (board === 'considering') {
      // The whole row moves; it no longer counts, so drop verification too.
      db.prepare(`UPDATE deck_cards SET board = 'considering', category = NULL, is_commander = 0,
        verify_status = NULL, finish = NULL, scan_count = 0, replaces_oracle_id = NULL WHERE id = ?`).run(row.id);
    } else {
      db.prepare("UPDATE deck_cards SET board = 'main', replaces_oracle_id = NULL WHERE id = ?").run(row.id);
    }
    logChange(db, deckId, board === 'considering' ? 'to_considering' : 'to_main', { cardIn: name });
    touch(db, deckId);
    return { ok: true };
  });
}

export function removeCard(db, deckId, cardId) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM deck_cards WHERE id = ? AND deck_id = ?').get(cardId, deckId);
    if (!row) return { ok: true };
    db.prepare('DELETE FROM deck_cards WHERE id = ?').run(row.id);
    logChange(db, deckId, 'remove', { cardOut: nameOf(db, row.scryfall_id), detail: row.board === 'considering' ? 'from Considering' : null });
    touch(db, deckId);
    return { ok: true };
  });
}

export function deckHistory(db, deckId, limit = 100) {
  return db.prepare('SELECT * FROM deck_changes WHERE deck_id = ? ORDER BY id DESC LIMIT ?').all(deckId, limit);
}
