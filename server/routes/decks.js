import { Router } from 'express';
import { FORMATS, validateDeck, validateDecks, deckCardsForValidation } from '../validate.js';
import { addCard, swapCard, swapIn, setReplaces, moveBoard, removeCard, deckHistory } from '../deckEdit.js';
import { handle, httpError, int, text } from '../http.js';
import { verifyOptions, verifyCard, autofixDeck, resolveQuickEntry, scanCard, scanOptions, undoScan, markRemainingMissing, removeUnscanned } from '../verify.js';

export default function deckRoutes(db) {
  const r = Router();
  const touch = (id) => db.prepare("UPDATE decks SET updated_at = datetime('now') WHERE id = ?").run(id);
  const wrap = handle;
  const deckOr404 = (id) => {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(id);
    if (!deck) throw httpError(404, 'Deck not found');
    return deck;
  };

  r.get('/:id/cards/:cardId/verify', (req, res) => {
    const opts = verifyOptions(db, Number(req.params.cardId));
    if (!opts || opts.card.deck_id !== Number(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(opts);
  });

  // body: { action: 'confirm'|'missing'|'reset', scryfall_id?, finish?, quick?: "dsc 94 f", addMissing? }
  r.post('/:id/cards/:cardId/verify', wrap(async (req, res) => {
    const body = { ...req.body };
    if (body.quick) Object.assign(body, await resolveQuickEntry(db, body.quick), { action: 'confirm' });
    const result = verifyCard(db, Number(req.params.cardId), body);
    touch(req.params.id);
    res.json(result);
  }));

  r.get('/:id/scan/options', wrap(async (req, res) => {
    res.json(await scanOptions(db, Number(req.params.id), String(req.query.oracle_id || '')));
  }));

  // body: { quick: "set number [f|e]" } or { scryfall_id, finish }
  r.post('/:id/scan', wrap(async (req, res) => {
    deckOr404(req.params.id);
    const { quick, scryfall_id, finish } = req.body;
    const result = await scanCard(db, Number(req.params.id), quick ? { quick } : { scryfall_id, finish });
    touch(req.params.id);
    res.json(result);
  }));

  r.post('/:id/scan/undo', wrap(async (req, res) => {
    res.json(undoScan(db, Number(req.params.id), req.body));
  }));

  r.post('/:id/mark-remaining-missing', (req, res) => {
    res.json(markRemainingMissing(db, Number(req.params.id)));
  });

  r.post('/:id/remove-unscanned', (req, res) => {
    const result = removeUnscanned(db, Number(req.params.id));
    touch(req.params.id);
    res.json(result);
  });

  // Dissolve: keep the deck list, but its cards stop counting as used (they're free in the collection).
  r.post('/:id/archive', (req, res) => {
    const info = db.prepare("UPDATE decks SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL").run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Deck not found or already dissolved' });
    res.json({ ok: true });
  });

  // Restore a dissolved deck, and report cards that are now short because other decks use them.
  r.post('/:id/restore', (req, res) => {
    const info = db.prepare('UPDATE decks SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Deck not found or not dissolved' });
    const conflicts = db.prepare(`SELECT DISTINCT u.oracle_id, u.name, u.owned, u.needed, u.deck_count, u.shortfall
      FROM deck_cards dc JOIN card_usage u ON u.oracle_id = dc.oracle_id
      WHERE dc.deck_id = ? AND u.shortfall > 0 AND u.deck_count > 1
      ORDER BY u.name`).all(req.params.id);
    res.json({ ok: true, conflicts });
  });

  r.post('/:id/autofix', (req, res) => {
    const result = autofixDeck(db, Number(req.params.id));
    touch(req.params.id);
    res.json(result);
  });

  r.get('/', (_req, res) => {
    // All counts are main deck only; Considering cards are reported separately.
    const decks = db.prepare(`SELECT d.*,
        COALESCE(SUM(CASE WHEN dc.board = 'main' THEN dc.quantity END), 0) AS card_count,
        COALESCE(SUM(CASE WHEN dc.board = 'considering' THEN dc.quantity END), 0) AS considering_count,
        (SELECT c.name FROM deck_cards x JOIN cards c ON c.scryfall_id = x.scryfall_id
          WHERE x.deck_id = d.id AND x.is_commander = 1 AND x.board = 'main' LIMIT 1) AS commander,
        (SELECT c.image_small FROM deck_cards x JOIN cards c ON c.scryfall_id = x.scryfall_id
          WHERE x.deck_id = d.id AND x.board = 'main' ORDER BY x.is_commander DESC LIMIT 1) AS image,
        (SELECT COUNT(DISTINCT x.oracle_id) FROM deck_cards x JOIN card_usage u ON u.oracle_id = x.oracle_id
          WHERE x.deck_id = d.id AND x.board = 'main' AND u.shortfall > 0) AS short_count,
        (SELECT COUNT(DISTINCT x.oracle_id) FROM deck_cards x JOIN card_usage u ON u.oracle_id = x.oracle_id
          WHERE x.deck_id = d.id AND x.board = 'main' AND u.owned = 0 AND u.type_line NOT LIKE '%Basic Land%') AS missing_count,
        (SELECT COUNT(*) FROM deck_cards x JOIN cards c ON c.scryfall_id = x.scryfall_id
          WHERE x.deck_id = d.id AND x.board = 'main' AND c.type_line NOT LIKE '%Basic Land%') AS verifiable_count,
        (SELECT COUNT(*) FROM deck_cards x JOIN cards c ON c.scryfall_id = x.scryfall_id
          WHERE x.deck_id = d.id AND x.board = 'main' AND c.type_line NOT LIKE '%Basic Land%' AND x.verify_status IS NOT NULL) AS verified_count
      FROM decks d LEFT JOIN deck_cards dc ON dc.deck_id = d.id
      GROUP BY d.id ORDER BY d.archived_at IS NOT NULL, d.name COLLATE NOCASE`).all();
    const issues = validateDecks(db, decks);
    res.json(decks.map((d) => ({ ...d, issues: issues.get(d.id) || [] })));
  });

  r.post('/', wrap(async (req, res) => {
    const name = text(req.body?.name, 'Name', 100);
    if (!name) throw httpError(400, 'Name required');
    const format = req.body.format || 'commander';
    if (!FORMATS[format]) throw httpError(400, `Unknown format ${format}`);
    try {
      const info = db.prepare('INSERT INTO decks (name, format, notes) VALUES (?, ?, ?)')
        .run(name, format, text(req.body.notes, 'Notes', 5000));
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw httpError(409, `A deck named "${name}" already exists`);
      throw e;
    }
  }));

  r.get('/:id', (req, res) => {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(req.params.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    const cards = db.prepare(`SELECT dc.id, dc.quantity, dc.category, dc.is_commander, dc.oracle_id, dc.scryfall_id,
        dc.verify_status, dc.finish, dc.verified_at, dc.board, dc.replaces_oracle_id,
        (SELECT rc.name FROM cards rc WHERE rc.oracle_id = dc.replaces_oracle_id LIMIT 1) AS replaces_name,
        EXISTS (SELECT 1 FROM deck_cards m WHERE m.deck_id = dc.deck_id AND m.board = 'main'
                AND m.oracle_id = dc.replaces_oracle_id) AS replaces_in_deck,
        c.name, c.set_code, c.collector_number, c.mana_cost, c.cmc, c.type_line, c.image_small, c.image_normal, c.prices,
        u.owned, u.needed, u.deck_count, u.shortfall,
        COALESCE(pu.owned, 0) AS printing_owned, COALESCE(pu.claimed, 0) AS printing_claimed,
        EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = dc.scryfall_id) AS own_listed_printing
      FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
      JOIN card_usage u ON u.oracle_id = dc.oracle_id
      LEFT JOIN printing_usage pu ON pu.scryfall_id = dc.scryfall_id
      WHERE dc.deck_id = ?
      ORDER BY dc.is_commander DESC, dc.category COLLATE NOCASE, c.cmc, c.name COLLATE NOCASE`).all(deck.id)
      .map((c) => ({ ...c, prices: JSON.parse(c.prices || '{}') }));
    const issues = deck.archived_at ? [] : validateDeck(deck.format || 'commander', deckCardsForValidation(db, [deck.id]));
    res.json({ ...deck, cards, issues });
  });

  r.patch('/:id', wrap(async (req) => {
    const { format } = req.body;
    if (format !== undefined && !FORMATS[format]) throw httpError(400, `Unknown format ${format}`);
    const name = text(req.body.name, 'Name', 100);
    const notes = req.body.notes === undefined ? null : text(req.body.notes, 'Notes', 5000) ?? '';
    deckOr404(req.params.id);
    try {
      db.prepare(`UPDATE decks SET name = COALESCE(?, name), format = COALESCE(?, format),
        notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`)
        .run(name, format ?? null, notes, req.params.id);
      return { ok: true };
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw httpError(409, 'Deck name already in use');
      throw e;
    }
  }));

  r.delete('/:id', wrap(async (req) => {
    const info = db.prepare('DELETE FROM decks WHERE id = ?').run(req.params.id);
    if (!info.changes) throw httpError(404, 'Deck not found');
    return { ok: true };
  }));

  // Add a card: body { scryfall_id, quantity?, category?, board?: 'main'|'considering' }
  r.post('/:id/cards', wrap(async (req, res) => {
    res.status(201).json(addCard(db, Number(req.params.id), req.body));
  }));

  // Swap a Considering card in for the card it was marked to replace. body { outTo?: 'considering'|'remove', out_card_id? }
  r.post('/:id/cards/:cardId/swap-in', wrap(async (req, res) => {
    res.json(swapIn(db, Number(req.params.id), Number(req.params.cardId), req.body || {}));
  }));

  // Swap: body { scryfall_id (coming in), out_card_id, outTo: 'remove'|'considering', category? }
  r.post('/:id/swap', wrap(async (req, res) => {
    res.status(201).json(swapCard(db, Number(req.params.id), req.body));
  }));

  r.get('/:id/history', (req, res) => res.json(deckHistory(db, Number(req.params.id))));

  r.patch('/:id/cards/:cardId', wrap(async (req, res) => {
    const { quantity, category, is_commander, scryfall_id, board } = req.body;
    if (board) return res.json(moveBoard(db, Number(req.params.id), Number(req.params.cardId), board));
    if ('replaces_oracle_id' in req.body) {
      return res.json(setReplaces(db, Number(req.params.id), Number(req.params.cardId), req.body.replaces_oracle_id));
    }
    const row = db.prepare('SELECT * FROM deck_cards WHERE id = ? AND deck_id = ?').get(req.params.cardId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const qty = quantity === undefined ? undefined : int(quantity, 'Quantity', 0, 99);
    const cat = category === undefined ? undefined : text(category, 'Category', 60);
    if (qty === 0) {
      return res.json(removeCard(db, row.deck_id, row.id));
    } else {
      let newId = row.scryfall_id;
      if (scryfall_id) {
        const c = db.prepare('SELECT oracle_id FROM cards WHERE scryfall_id = ?').get(scryfall_id);
        if (!c || c.oracle_id !== row.oracle_id) return res.status(400).json({ error: 'Printing must be the same card' });
        newId = scryfall_id;
      }
      db.prepare('UPDATE deck_cards SET quantity = ?, category = ?, is_commander = ?, scryfall_id = ? WHERE id = ?').run(
        qty ?? row.quantity,
        cat !== undefined ? cat : row.category,
        is_commander !== undefined ? (is_commander ? 1 : 0) : row.is_commander,
        newId, row.id);
    }
    touch(row.deck_id);
    res.json({ ok: true });
  }));

  r.delete('/:id/cards/:cardId', (req, res) => {
    res.json(removeCard(db, Number(req.params.id), Number(req.params.cardId)));
  });

  return r;
}
