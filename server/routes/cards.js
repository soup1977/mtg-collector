import { Router } from 'express';
import { autocomplete, fetchNamed, fetchPrints, upsertCards } from '../scryfall.js';
import { refreshPrices } from '../prices.js';

export default function cardRoutes(db) {
  const r = Router();

  // Card name autocomplete (Scryfall) for adding cards to decks.
  r.get('/autocomplete', async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json([]);
      // Local matches first (cards you own), then Scryfall.
      const local = db.prepare(`SELECT DISTINCT name FROM card_usage WHERE name LIKE ? ORDER BY owned DESC, name LIMIT 8`)
        .all(`${q}%`).map((x) => x.name);
      const remote = await autocomplete(q);
      res.json([...new Set([...local, ...remote])].slice(0, 15));
    } catch (e) { next(e); }
  });

  // Every printing of a card (for choosing which printing a deck lists).
  r.get('/:oracleId/prints', async (req, res, next) => {
    try {
      const prints = await fetchPrints(req.params.oracleId);
      upsertCards(db, prints);
      const owned = new Set(db.prepare(`SELECT DISTINCT ci.scryfall_id FROM collection_items ci
        JOIN cards c ON c.scryfall_id = ci.scryfall_id WHERE c.oracle_id = ?`).all(req.params.oracleId).map((x) => x.scryfall_id));
      res.json(prints.map((p) => ({
        scryfall_id: p.id, set_code: p.set, set_name: p.set_name, collector_number: p.collector_number,
        released_at: p.released_at, owned: owned.has(p.id), finishes: p.finishes || ['nonfoil'],
        image_normal: p.image_uris?.normal ?? p.card_faces?.[0]?.image_uris?.normal ?? null,
      })).reverse());
    } catch (e) { next(e); }
  });

  // Resolve a card name to a cached card (used when adding to decks).
  r.get('/lookup', async (req, res, next) => {
    try {
      const name = String(req.query.name || '');
      // Prefer a printing you own.
      let row = db.prepare(`SELECT c.scryfall_id, c.oracle_id, c.name FROM cards c
        JOIN collection_items ci ON ci.scryfall_id = c.scryfall_id
        WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE LIMIT 1`).get(name, `${name} // %`);
      if (!row) {
        const card = await fetchNamed(name);
        if (!card) return res.status(404).json({ error: `No card named "${name}"` });
        upsertCards(db, [card]);
        row = { scryfall_id: card.id, oracle_id: card.oracle_id ?? card.card_faces?.[0]?.oracle_id, name: card.name };
      }
      res.json(row);
    } catch (e) { next(e); }
  });

  // Refetch Scryfall data (TCGplayer prices) for every card you own or have in a deck.
  r.post('/refresh', async (_req, res, next) => {
    try { res.json(await refreshPrices(db)); } catch (e) { next(e); }
  });

  // The core view: a card, the printings you own, and every deck that uses it.
  r.get('/:oracleId', (req, res) => {
    const { oracleId } = req.params;
    const usage = db.prepare('SELECT * FROM card_usage WHERE oracle_id = ?').get(oracleId);
    const any = usage || db.prepare('SELECT * FROM cards WHERE oracle_id = ? LIMIT 1').get(oracleId);
    if (!any) return res.status(404).json({ error: 'Card not found' });
    const repId = usage ? usage.rep_scryfall_id : any.scryfall_id;
    const card = db.prepare('SELECT * FROM cards WHERE scryfall_id = ?').get(repId);
    const raw = JSON.parse(card.raw);

    const printings = db.prepare(`SELECT c.scryfall_id, c.set_code, c.set_name, c.collector_number, c.image_small,
        ci.finish, ci.condition, ci.language, ci.date_added, SUM(ci.quantity) AS quantity, c.prices
      FROM collection_items ci JOIN cards c ON c.scryfall_id = ci.scryfall_id
      WHERE c.oracle_id = ?
      GROUP BY c.scryfall_id, ci.finish, ci.condition, ci.language
      ORDER BY c.set_name, ci.finish`).all(oracleId)
      .map((p) => ({
        ...p,
        prices: JSON.parse(p.prices || '{}'),
        claimed_by: db.prepare(`SELECT d.id, d.name, dc.quantity FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
          WHERE dc.scryfall_id = ? AND dc.verify_status = 'confirmed' AND COALESCE(dc.finish, ?) = ? AND d.archived_at IS NULL
            AND dc.board = 'main'`)
          .all(p.scryfall_id, p.finish, p.finish),
      }));

    const decks = db.prepare(`SELECT d.id, d.name, d.format, dc.id AS deck_card_id, dc.quantity, dc.category, dc.is_commander,
        dc.verify_status, dc.finish,
        c.scryfall_id, c.set_code, c.set_name, c.collector_number,
        EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = dc.scryfall_id) AS own_listed_printing,
        d.archived_at, dc.board
      FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE dc.oracle_id = ? ORDER BY d.archived_at IS NOT NULL, dc.board != 'main', d.name`).all(oracleId);

    res.json({
      oracle_id: oracleId,
      name: card.name,
      mana_cost: card.mana_cost,
      type_line: card.type_line,
      oracle_text: card.oracle_text,
      rarity: card.rarity,
      color_identity: JSON.parse(card.color_identity || '[]'),
      image: card.image_normal,
      back_image: raw.card_faces?.[1]?.image_uris?.normal ?? null,
      prices: JSON.parse(card.prices || '{}'),
      scryfall_uri: raw.scryfall_uri,
      legalities: raw.legalities,
      owned: usage?.owned ?? 0,
      needed: usage?.needed ?? 0,
      shortfall: usage?.shortfall ?? 0,
      is_basic: /Basic Land/.test(card.type_line || ''),
      printings,
      decks,
    });
  });

  return r;
}
