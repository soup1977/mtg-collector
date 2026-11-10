// Deck validation: size, commander, duplicates, color identity, legality. Main board only
// (Considering cards aren't part of the deck).

export const FORMATS = {
  commander: { label: 'Commander', size: 100, copies: 1, commander: true, legality: 'commander' },
  standard: { label: 'Standard', min: 60, copies: 4, legality: 'standard' },
  pioneer: { label: 'Pioneer', min: 60, copies: 4, legality: 'pioneer' },
  modern: { label: 'Modern', min: 60, copies: 4, legality: 'modern' },
  legacy: { label: 'Legacy', min: 60, copies: 4, legality: 'legacy' },
  pauper: { label: 'Pauper', min: 60, copies: 4, legality: 'pauper' },
  casual: { label: 'Casual (no checks)' },
};

const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** How many copies of this card a deck may run (basics and "any number" cards are unlimited). */
export function copyLimit(card, formatCopies) {
  if (/\bBasic\b/.test(card.type_line || '')) return Infinity;
  const text = card.oracle_text || '';
  if (/any number of cards named/i.test(text)) return Infinity;
  const m = text.match(/up to (\w+) cards named/i);
  if (m) return WORDS[m[1].toLowerCase()] ?? (Number(m[1]) || formatCopies);
  return formatCopies;
}

const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/**
 * cards: main-board rows { id, oracle_id, name, quantity, is_commander, type_line, oracle_text,
 *   color_identity (JSON string or array), legality (string|null) }
 * Returns [{ code, label, message, cards: [{ id, oracle_id, name }] }].
 */
export function validateDeck(format, cards) {
  const f = FORMATS[format] || FORMATS.commander;
  const issues = [];
  if (!f.size && !f.min && !f.copies) return issues; // casual
  const ref = (c) => ({ id: c.id, oracle_id: c.oracle_id, name: c.name });
  const total = cards.reduce((s, c) => s + c.quantity, 0);

  if (f.size && total !== f.size) {
    const diff = f.size - total;
    issues.push({
      code: 'size', label: `${total}/${f.size} cards`,
      message: diff > 0 ? `${diff} card${diff === 1 ? '' : 's'} short of ${f.size}.` : `${-diff} card${diff === -1 ? '' : 's'} over ${f.size}.`,
      cards: [],
    });
  } else if (f.min && total < f.min) {
    issues.push({ code: 'size', label: `${total}/${f.min} cards`, message: `${f.min - total} short of the ${f.min}-card minimum.`, cards: [] });
  }

  const commanders = cards.filter((c) => c.is_commander);
  if (f.commander) {
    if (!commanders.length) {
      issues.push({ code: 'commander', label: 'no commander', message: 'No commander set. Put the commander in the "Commander" category.', cards: [] });
    } else if (commanders.length > 2) {
      issues.push({ code: 'commander', label: `${commanders.length} commanders`, message: 'More than two commanders.', cards: commanders.map(ref) });
    }
  }

  // Duplicates: total copies per card (across printings/categories) above the format's limit.
  const byOracle = new Map();
  for (const c of cards) {
    const g = byOracle.get(c.oracle_id) || { card: c, qty: 0, rows: [] };
    g.qty += c.quantity;
    g.rows.push(c);
    byOracle.set(c.oracle_id, g);
  }
  const dups = [...byOracle.values()].filter((g) => g.qty > copyLimit(g.card, f.copies));
  if (dups.length) {
    issues.push({
      code: 'duplicates', label: `${dups.length} duplicate${dups.length === 1 ? '' : 's'}`,
      message: f.copies === 1 ? 'Singleton format: more than one copy of' : `More than ${f.copies} copies of`,
      cards: dups.map((g) => ({ ...ref(g.card), detail: `×${g.qty}`, ids: g.rows.map((r) => r.id) })),
    });
  }

  // Color identity: every card within the commanders' combined identity.
  if (f.commander && commanders.length) {
    const ci = (c) => (Array.isArray(c.color_identity) ? c.color_identity : JSON.parse(c.color_identity || '[]'));
    const allowed = new Set(commanders.flatMap(ci));
    const off = cards.filter((c) => !c.is_commander && ci(c).some((x) => !allowed.has(x)));
    if (off.length) {
      const allowedText = allowed.size ? [...allowed].map((x) => COLOR_NAMES[x]).join(', ') : 'colorless only';
      issues.push({
        code: 'color', label: `${off.length} off-color`,
        message: `Outside the commander's color identity (${allowedText}):`,
        cards: off.map((c) => ({ ...ref(c), detail: ci(c).filter((x) => !allowed.has(x)).join('') })),
      });
    }
  }

  // Legality from Scryfall: banned, or not legal in the format at all.
  if (f.legality) {
    const banned = cards.filter((c) => c.legality === 'banned');
    const illegal = cards.filter((c) => c.legality === 'not_legal');
    if (banned.length) {
      issues.push({ code: 'banned', label: `${banned.length} banned`, message: `Banned in ${f.label}:`, cards: banned.map(ref) });
    }
    if (illegal.length) {
      issues.push({ code: 'not_legal', label: `${illegal.length} not legal`, message: `Not legal in ${f.label}:`, cards: illegal.map(ref) });
    }
  }
  return issues;
}

/** Load a deck's main-board cards with what validation needs. */
export function deckCardsForValidation(db, deckIds, format = null) {
  return db.prepare(`SELECT dc.id, dc.deck_id, dc.oracle_id, dc.quantity, dc.is_commander,
      c.name, c.type_line, c.oracle_text, c.color_identity, d.format,
      json_extract(c.raw, '$.legalities.' || COALESCE(?, d.format, 'commander')) AS legality
    FROM deck_cards dc JOIN cards c ON c.scryfall_id = dc.scryfall_id JOIN decks d ON d.id = dc.deck_id
    WHERE dc.board = 'main' AND dc.deck_id IN (${deckIds.map(() => '?').join(',') || 'NULL'})`).all(format, ...deckIds);
}

/** Validation for many decks at once: Map deckId -> issues. */
export function validateDecks(db, decks) {
  const ids = decks.filter((d) => !d.archived_at).map((d) => d.id);
  const rows = deckCardsForValidation(db, ids);
  const byDeck = new Map(ids.map((id) => [id, []]));
  for (const r of rows) byDeck.get(r.deck_id)?.push(r);
  const out = new Map();
  for (const d of decks) out.set(d.id, d.archived_at ? [] : validateDeck(d.format || 'commander', byDeck.get(d.id) || []));
  return out;
}
