#!/usr/bin/env node
// MCP server: lets Claude (desktop app or Claude Code) read your collection and decks, and suggest
// cards by adding them to a deck's Considering list. It never edits main decks or the collection.
// Runs over stdio; uses the same database as the web app (SQLite handles both safely).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb } from './db.js';
import { validateDeck, deckCardsForValidation, FORMATS } from './validate.js';
import { addCard } from './deckEdit.js';
import { fetchNamed, upsertCards } from './scryfall.js';
import { getSettings } from './settings.js';

const db = openDb();

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const ci = (s) => JSON.parse(s || '[]');
const price = (prices) => {
  const p = typeof prices === 'string' ? JSON.parse(prices || '{}') : prices || {};
  const v = p.usd ?? p.usd_foil ?? p.usd_etched;
  return v == null ? null : Number(v);
};

/** Find a deck by id or (partial, case-insensitive) name. */
function findDeck(ref) {
  const all = db.prepare('SELECT * FROM decks').all();
  if (/^\d+$/.test(String(ref))) {
    const d = all.find((x) => x.id === Number(ref));
    if (d) return d;
  }
  const q = String(ref).toLowerCase();
  const exact = all.filter((d) => d.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((d) => d.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  const err = partial.length > 1
    ? `"${ref}" matches several decks: ${partial.map((d) => d.name).join('; ')}. Be more specific.`
    : `No deck matches "${ref}". Decks: ${all.map((d) => d.name).join('; ')}`;
  throw new Error(err);
}

function deckColorIdentity(deckId) {
  const rows = db.prepare(`SELECT c.color_identity FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
    WHERE dc.deck_id = ? AND dc.is_commander = 1 AND dc.board = 'main'`).all(deckId);
  return [...new Set(rows.flatMap((r) => ci(r.color_identity)))].sort((a, b) => 'WUBRG'.indexOf(a) - 'WUBRG'.indexOf(b));
}

const server = new McpServer({ name: 'mtg-collector', version: '1.0.0' }, {
  instructions: [
    "Tools for the user's Magic: The Gathering collection and decks (mostly Commander).",
    "'owned' = copies in the collection; 'free' = owned copies not used by any active deck (main deck).",
    "A deck's Considering list is a maybe-list: it doesn't count toward the deck or use collection copies.",
    'You can only add cards to Considering lists; the user decides what goes into the main deck.',
    "When suggesting a swap, pass 'replaces' with the main-deck card it would replace so the user sees the pair.",
    'Prices are TCGplayer market USD.',
  ].join(' '),
});

server.registerTool('collection_summary', {
  title: 'Collection summary',
  description: 'Totals for the collection: cards, unique cards, value, and how many cards are free (not used by any deck), broken down by color identity.',
  inputSchema: {},
}, async () => {
  const s = getSettings(db);
  const totals = db.prepare(`SELECT COALESCE(SUM(quantity),0) copies, COUNT(DISTINCT oracle_id) uniq,
      COALESCE(SUM(quantity * COALESCE(unit_price,0)),0) value FROM item_prices`).get();
  const rows = db.prepare('SELECT color_identity, owned, needed FROM card_usage WHERE owned > 0').all();
  const byIdentity = {};
  let free = 0;
  for (const r of rows) {
    const k = ci(r.color_identity).join('') || 'C';
    const f = Math.max(r.owned - r.needed, 0);
    free += f;
    byIdentity[k] = (byIdentity[k] || 0) + f;
  }
  return json({
    copies: totals.copies, unique_cards: totals.uniq, market_value_usd_including_bulk: Math.round(totals.value * 100) / 100,
    free_copies: free, free_copies_by_color_identity: byIdentity,
    active_decks: db.prepare('SELECT COUNT(*) n FROM decks WHERE archived_at IS NULL').get().n,
    prices_updated: s.pricesRefreshedAt,
  });
});

server.registerTool('list_decks', {
  title: 'List decks',
  description: 'All decks with format, commander, color identity, card count, problems (wrong size, off-color, duplicates, banned), value and how many cards are on the Considering list. Dissolved decks are marked.',
  inputSchema: { include_dissolved: z.boolean().optional().describe('Include dissolved (archived) decks. Default false.') },
}, async ({ include_dissolved = false }) => {
  const decks = db.prepare(`SELECT d.*,
      (SELECT group_concat(c.name, ' + ') FROM deck_cards x JOIN cards c ON c.scryfall_id = x.scryfall_id
        WHERE x.deck_id = d.id AND x.is_commander = 1 AND x.board = 'main') AS commander,
      (SELECT COALESCE(SUM(quantity),0) FROM deck_cards WHERE deck_id = d.id AND board = 'main') AS cards,
      (SELECT COALESCE(SUM(quantity),0) FROM deck_cards WHERE deck_id = d.id AND board = 'considering') AS considering
    FROM decks d ORDER BY d.name`).all().filter((d) => include_dissolved || !d.archived_at);
  return json(decks.map((d) => {
    const cards = deckCardsForValidation(db, [d.id]);
    const value = db.prepare(`SELECT c.prices, dc.quantity FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE dc.deck_id = ? AND dc.board = 'main'`).all(d.id).reduce((s, r) => s + r.quantity * (price(r.prices) || 0), 0);
    return {
      id: d.id, name: d.name, format: d.format || 'commander', commander: d.commander,
      color_identity: deckColorIdentity(d.id).join('') || 'C', cards: d.cards, considering: d.considering,
      value_usd: Math.round(value * 100) / 100,
      problems: d.archived_at ? [] : validateDeck(d.format || 'commander', cards).map((i) => `${i.label}: ${i.message} ${i.cards.map((c) => c.name).join(', ')}`.trim()),
      ...(d.archived_at ? { dissolved: d.archived_at } : {}),
    };
  }));
});

server.registerTool('get_deck', {
  title: 'Get deck',
  description: 'Full deck list grouped by category, with each card\'s mana cost, mana value, type, whether you own it and which other decks use it, price, plus the Considering list, problems, mana curve and type counts. Set include_text to get each card\'s rules text (longer).',
  inputSchema: {
    deck: z.string().describe('Deck name (partial match OK) or id'),
    include_text: z.boolean().optional().describe('Include oracle rules text for every card. Default false.'),
  },
}, async ({ deck, include_text = false }) => {
  let d;
  try { d = findDeck(deck); } catch (e) { return fail(e.message); }
  const rows = db.prepare(`SELECT dc.id, dc.quantity, dc.category, dc.is_commander, dc.board, dc.verify_status, dc.oracle_id,
      (SELECT rc.name FROM cards rc WHERE rc.oracle_id = dc.replaces_oracle_id LIMIT 1) AS replaces,
      c.name, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.prices, c.color_identity, u.owned, u.needed,
      (SELECT group_concat(d2.name, '; ') FROM deck_cards x JOIN decks d2 ON d2.id = x.deck_id
        WHERE x.oracle_id = dc.oracle_id AND x.deck_id != dc.deck_id AND x.board = 'main' AND d2.archived_at IS NULL) AS other_decks
    FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id JOIN card_usage u ON u.oracle_id = dc.oracle_id
    WHERE dc.deck_id = ? ORDER BY dc.is_commander DESC, dc.category, c.cmc, c.name`).all(d.id);
  const view = (r) => ({
    qty: r.quantity, name: r.name, mana_cost: r.mana_cost || '', mv: r.cmc, type: r.type_line,
    owned: r.owned, ...(r.other_decks ? { also_in: r.other_decks } : {}), price_usd: price(r.prices),
    ...(include_text ? { text: r.oracle_text } : {}),
  });
  const main = rows.filter((r) => r.board === 'main');
  const categories = {};
  for (const r of main) {
    const k = r.is_commander ? 'Commander' : r.category || 'Uncategorized';
    (categories[k] ||= []).push(view(r));
  }
  const curve = {};
  const types = {};
  for (const r of main) {
    if (/Land/.test(r.type_line)) { types.Land = (types.Land || 0) + r.quantity; continue; }
    const mv = Math.min(Math.round(r.cmc), 7);
    curve[mv === 7 ? '7+' : mv] = (curve[mv === 7 ? '7+' : mv] || 0) + r.quantity;
    for (const t of ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle']) {
      if (r.type_line.includes(t)) types[t] = (types[t] || 0) + r.quantity;
    }
  }
  return json({
    id: d.id, name: d.name, format: d.format || 'commander', dissolved: d.archived_at || undefined,
    color_identity: deckColorIdentity(d.id).join('') || 'C',
    cards: main.reduce((s, r) => s + r.quantity, 0),
    problems: validateDeck(d.format || 'commander', deckCardsForValidation(db, [d.id])).map((i) => `${i.label}: ${i.message} ${i.cards.map((c) => c.name).join(', ')}`.trim()),
    mana_curve_nonland: curve, type_counts: types,
    categories,
    considering: rows.filter((r) => r.board === 'considering').map((r) => ({ ...view(r), ...(r.replaces ? { would_replace: r.replaces } : {}) })),
  });
});

server.registerTool('search_collection', {
  title: 'Search collection',
  description: [
    'Search cards in the collection. Combine filters freely.',
    'Use fits_identity with a deck\'s color identity (e.g. "G", "BRG") to find cards legal for that commander,',
    'and availability "free" to find copies not already used by another deck.',
  ].join(' '),
  inputSchema: {
    name: z.string().optional().describe('Name contains'),
    text: z.string().optional().describe('Rules text contains (case-insensitive), e.g. "draw a card", "landfall"'),
    type: z.string().optional().describe('Type line contains, e.g. "Creature", "Elf", "Equipment"'),
    fits_identity: z.string().optional().describe('Color identity must fit within these colors (WUBRG letters; "C" for colorless only)'),
    max_mana_value: z.number().optional(),
    min_price: z.number().optional(),
    max_price: z.number().optional(),
    availability: z.enum(['any', 'free', 'unused']).optional()
      .describe('"free": you have copies not used by any active deck. "unused": not in any active deck at all. Default "any".'),
    include_text: z.boolean().optional().describe('Include rules text. Default true.'),
    sort: z.enum(['name', 'price', 'mana_value']).optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Default 40'),
  },
}, async (a) => {
  const where = ['u.owned > 0'];
  const p = {};
  if (a.name) { where.push('u.name LIKE :name'); p.name = `%${a.name}%`; }
  if (a.text) { where.push('c.oracle_text LIKE :text'); p.text = `%${a.text}%`; }
  if (a.type) { where.push('u.type_line LIKE :type'); p.type = `%${a.type}%`; }
  if (a.max_mana_value != null) { where.push('u.cmc <= :mv'); p.mv = a.max_mana_value; }
  if (a.availability === 'free') where.push('u.owned > u.needed');
  if (a.availability === 'unused') where.push('u.needed = 0');
  const order = { price: 'price DESC', mana_value: 'u.cmc, u.name' }[a.sort] || 'u.name';
  let rows = db.prepare(`SELECT u.name, u.mana_cost, u.cmc, u.type_line, u.color_identity, u.owned, u.needed, c.oracle_text,
      COALESCE(CAST(json_extract(c.prices, '$.usd') AS REAL), CAST(json_extract(c.prices, '$.usd_foil') AS REAL)) AS price,
      (SELECT group_concat(d.name, '; ') FROM deck_cards x JOIN decks d ON d.id = x.deck_id
        WHERE x.oracle_id = u.oracle_id AND x.board = 'main' AND d.archived_at IS NULL) AS used_in,
      (SELECT group_concat(d.name, '; ') FROM deck_cards x JOIN decks d ON d.id = x.deck_id
        WHERE x.oracle_id = u.oracle_id AND x.board = 'considering' AND d.archived_at IS NULL) AS considered_for
    FROM card_usage u JOIN cards c ON c.scryfall_id = u.rep_scryfall_id
    WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(p);
  if (a.fits_identity) {
    const allowed = new Set(a.fits_identity.toUpperCase().replace(/C/g, '').split(''));
    rows = rows.filter((r) => ci(r.color_identity).every((x) => allowed.has(x)));
  }
  if (a.min_price != null) rows = rows.filter((r) => (r.price ?? 0) >= a.min_price);
  if (a.max_price != null) rows = rows.filter((r) => r.price != null && r.price <= a.max_price);
  const total = rows.length;
  const limit = a.limit ?? 40;
  return json({
    total_matches: total, showing: Math.min(total, limit),
    cards: rows.slice(0, limit).map((r) => ({
      name: r.name, mana_cost: r.mana_cost || '', mv: r.cmc, type: r.type_line,
      color_identity: ci(r.color_identity).join('') || 'C', owned: r.owned, free: Math.max(r.owned - r.needed, 0),
      ...(r.used_in ? { used_in: r.used_in } : {}), ...(r.considered_for ? { considered_for: r.considered_for } : {}),
      price_usd: r.price, ...(a.include_text === false ? {} : { text: r.oracle_text }),
    })),
  });
});

server.registerTool('get_card', {
  title: 'Get card',
  description: 'One card in detail: rules text, price, Commander legality, every printing you own, and every deck that uses or is considering it.',
  inputSchema: { name: z.string().describe('Exact card name') },
}, async ({ name }) => {
  const card = db.prepare(`SELECT * FROM cards WHERE name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE
    ORDER BY (SELECT COUNT(*) FROM collection_items ci WHERE ci.scryfall_id = cards.scryfall_id) DESC LIMIT 1`).get(name, `${name} // %`);
  if (!card) return fail(`"${name}" isn't in the collection or any deck. Check the spelling.`);
  const raw = JSON.parse(card.raw || '{}');
  const usage = db.prepare('SELECT owned, needed FROM card_usage WHERE oracle_id = ?').get(card.oracle_id) || { owned: 0, needed: 0 };
  return json({
    name: card.name, mana_cost: card.mana_cost, mv: card.cmc, type: card.type_line, text: card.oracle_text,
    color_identity: ci(card.color_identity).join('') || 'C', price_usd: price(card.prices),
    commander_legality: raw.legalities?.commander,
    owned: usage.owned, free: Math.max(usage.owned - usage.needed, 0),
    owned_printings: db.prepare(`SELECT c.set_name, c.set_code, c.collector_number, ci.finish, SUM(ci.quantity) AS qty
      FROM collection_items ci JOIN cards c ON c.scryfall_id = ci.scryfall_id WHERE c.oracle_id = ?
      GROUP BY c.scryfall_id, ci.finish`).all(card.oracle_id),
    decks: db.prepare(`SELECT d.name, dc.quantity AS qty, dc.board, dc.category, d.archived_at IS NOT NULL AS dissolved
      FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE dc.oracle_id = ? ORDER BY d.name`).all(card.oracle_id)
      .map((r) => ({ deck: r.name, qty: r.qty, list: r.board === 'considering' ? 'considering' : 'main', category: r.category, ...(r.dissolved ? { dissolved: true } : {}) })),
  });
});

server.registerTool('add_to_considering', {
  title: 'Add cards to a deck\'s Considering list',
  description: [
    "Suggest cards for a deck by putting them on its Considering list (a maybe-list). This doesn't change the main deck",
    'or the collection; the user reviews suggestions in the app and swaps them in themselves.',
    'Cards already in the deck or already considered are skipped. Cards the user does not own are allowed (they show as not owned).',
  ].join(' '),
  inputSchema: {
    deck: z.string().describe('Deck name (partial match OK) or id'),
    cards: z.array(z.object({
      name: z.string().describe('Exact card name'),
      reason: z.string().optional().describe('Short reason, shown in the deck history'),
      replaces: z.string().optional().describe('Name of the card currently in the main deck that this would replace'),
    })).min(1).max(30),
  },
}, async ({ deck, cards }) => {
  let d;
  try { d = findDeck(deck); } catch (e) { return fail(e.message); }
  if (d.archived_at) return fail(`${d.name} is dissolved. Restore it in the app first.`);
  const results = [];
  for (const { name, reason, replaces } of cards) {
    try {
      // Prefer a printing you own; otherwise look the card up on Scryfall.
      let card = db.prepare(`SELECT c.scryfall_id, c.oracle_id, c.name FROM cards c
        WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE
        ORDER BY (SELECT COUNT(*) FROM collection_items ci WHERE ci.scryfall_id = c.scryfall_id) DESC LIMIT 1`).get(name, `${name} // %`);
      if (!card) {
        const sc = await fetchNamed(name);
        if (!sc) { results.push({ name, status: 'not found on Scryfall' }); continue; }
        upsertCards(db, [sc]);
        card = { scryfall_id: sc.id, oracle_id: sc.oracle_id ?? sc.card_faces?.[0]?.oracle_id, name: sc.name };
      }
      const existing = db.prepare('SELECT board FROM deck_cards WHERE deck_id = ? AND oracle_id = ? LIMIT 1').get(d.id, card.oracle_id);
      if (existing) { results.push({ name: card.name, status: existing.board === 'main' ? 'already in the deck' : 'already being considered' }); continue; }
      // The card it would replace must be in the main deck.
      let replacesRow = null;
      if (replaces) {
        replacesRow = db.prepare(`SELECT dc.oracle_id, c.name FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id
          WHERE dc.deck_id = ? AND dc.board = 'main' AND (c.name = ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE) LIMIT 1`)
          .get(d.id, replaces, `${replaces} // %`);
        if (!replacesRow) { results.push({ name: card.name, status: `not added: "${replaces}" is not in the main deck` }); continue; }
      }
      addCard(db, d.id, { scryfall_id: card.scryfall_id, board: 'considering', replaces_oracle_id: replacesRow?.oracle_id ?? null });
      if (reason || replacesRow) {
        const detail = `suggested by Claude${replacesRow ? ` in place of ${replacesRow.name}` : ''}${reason ? `: ${reason}` : ''}`;
        db.prepare(`UPDATE deck_changes SET detail = ? WHERE id = (SELECT MAX(id) FROM deck_changes WHERE deck_id = ?)`).run(detail, d.id);
      }
      const owned = db.prepare('SELECT owned FROM card_usage WHERE oracle_id = ?').get(card.oracle_id)?.owned ?? 0;
      results.push({ name: card.name, status: 'added to Considering', owned, ...(replacesRow ? { replaces: replacesRow.name } : {}) });
    } catch (e) {
      results.push({ name, status: `error: ${e.message}` });
    }
  }
  return json({ deck: d.name, results });
});

await server.connect(new StdioServerTransport());
console.error(`mtg-collector MCP server ready (formats: ${Object.keys(FORMATS).join(', ')})`);
