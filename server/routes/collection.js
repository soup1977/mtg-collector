import { Router } from 'express';
import { bulkParams } from '../settings.js';

const SORTS = {
  name: 'name COLLATE NOCASE',
  cmc: 'cmc, name COLLATE NOCASE',
  price: 'price IS NULL, price DESC, name COLLATE NOCASE',
  value: 'value DESC, price DESC, name COLLATE NOCASE',
  owned: 'owned DESC, name COLLATE NOCASE',
  decks: 'deck_count DESC, name COLLATE NOCASE',
  shortfall: 'shortfall DESC, name COLLATE NOCASE',
};

export default function collectionRoutes(db) {
  const r = Router();

  // Collection grouped by oracle card, with owned / deck usage / shortfall.
  r.get('/', (req, res) => {
    const { q, color, type, set, sort = 'name', scope = 'owned', short } = req.query;
    const where = [];
    const params = {};
    if (scope === 'owned') where.push('owned > 0');
    else if (scope === 'decks') where.push('needed > 0');
    else if (scope === 'considering') where.push('considering IS NOT NULL');
    else where.push('(owned > 0 OR needed > 0 OR considering IS NOT NULL)'); // 'all': skip cards only in dissolved decks
    if (q) {
      where.push('name LIKE :q');
      params.q = `%${q}%`;
    }
    if (type) {
      where.push('type_line LIKE :type');
      params.type = `%${type}%`;
    }
    if (set) {
      where.push('oracle_id IN (SELECT c.oracle_id FROM cards c JOIN collection_items ci ON ci.scryfall_id = c.scryfall_id WHERE c.set_code = :set)');
      params.set = set.toLowerCase();
    }
    if (color) {
      // color identity filter: each letter in `color` must be present; "C" = colorless
      for (const ch of color.toUpperCase().split('')) {
        if (ch === 'C') where.push("color_identity = '[]'");
        else if ('WUBRG'.includes(ch)) where.push(`color_identity LIKE '%"${ch}"%'`);
      }
    }
    if (short === '1') where.push('shortfall > 0');
    // price: highest unit price among copies you own (or the deck printing's price if you own none).
    // value: total for your copies; with bulk excluded, copies under the threshold count as 0.
    const sql = `WITH v AS (
        SELECT oracle_id, MAX(unit_price) AS top_price,
               SUM(quantity * CASE WHEN COALESCE(unit_price, 0) < :th THEN 0 ELSE COALESCE(unit_price, 0) END) AS value
        FROM item_prices GROUP BY oracle_id
      ), u AS (
        SELECT cu.oracle_id, cu.name, cu.type_line, cu.mana_cost, cu.cmc, cu.color_identity, cu.rarity, cu.image_small,
          cu.image_normal, cu.owned, cu.needed, cu.deck_count, cu.shortfall,
          COALESCE(v.top_price, CAST(json_extract(c.prices, '$.usd') AS REAL), CAST(json_extract(c.prices, '$.usd_foil') AS REAL)) AS price,
          COALESCE(v.value, 0) AS value,
          (SELECT group_concat(name, ', ') FROM (
             SELECT DISTINCT d.name FROM deck_cards x JOIN decks d ON d.id = x.deck_id
             WHERE x.oracle_id = cu.oracle_id AND x.board = 'considering' AND d.archived_at IS NULL ORDER BY d.name
           )) AS considering
        FROM card_usage cu
        JOIN cards c ON c.scryfall_id = cu.rep_scryfall_id
        LEFT JOIN v ON v.oracle_id = cu.oracle_id
      )
      SELECT * FROM u ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${SORTS[sort] || SORTS.name}`;
    const cards = db.prepare(sql).all({ ...params, ...bulkParams(db) });
    res.json({ count: cards.length, cards });
  });

  r.get('/stats', (_req, res) => {
    res.json({
      ...db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS copies FROM collection_items').get(),
      unique: db.prepare('SELECT COUNT(*) AS n FROM owned_by_oracle').get().n,
      decks: db.prepare('SELECT COUNT(*) AS n FROM decks WHERE archived_at IS NULL').get().n,
      short: db.prepare('SELECT COUNT(*) AS n FROM card_usage WHERE shortfall > 0').get().n,
      ...db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN COALESCE(unit_price, 0) >= :th THEN quantity * COALESCE(unit_price, 0) END), 0) AS value,
          COALESCE(SUM(CASE WHEN COALESCE(unit_price, 0) < :th THEN quantity END), 0) AS bulk_copies,
          COALESCE(SUM(CASE WHEN COALESCE(unit_price, 0) < :th THEN quantity * COALESCE(unit_price, 0) END), 0) AS bulk_value,
          COALESCE(SUM(CASE WHEN unit_price IS NULL THEN quantity END), 0) AS unpriced_copies
        FROM item_prices`).get(bulkParams(db)),
      sets: db.prepare(`SELECT c.set_code AS code, c.set_name AS name, SUM(ci.quantity) AS copies
        FROM collection_items ci JOIN cards c ON c.scryfall_id = ci.scryfall_id
        GROUP BY c.set_code ORDER BY c.set_name`).all(),
    });
  });

  return r;
}
