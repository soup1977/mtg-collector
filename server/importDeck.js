import { parse } from 'csv-parse/sync';
import { fetchCollection, upsertCards, ensureCardsById } from './scryfall.js';
import { tx } from './db.js';

const CONSIDERING_CATEGORY = /^(maybeboard|maybe|sideboard|considering)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isDeckCsv = (text) => /^﻿?Quantity,Name,/i.test(text.trimStart());

/**
 * Parse an Archidekt deck CSV export. Archidekt's header is malformed (a missing comma
 * merges "Edition date" and "Category", and mana cost trails the quoted card text),
 * so columns are read by position from the data rows and the Scryfall ID is located
 * by pattern rather than by header name.
 * Data row layout: qty, name, edition, set, date, category, secondary categories, label, ...
 */
export function parseDeckCsv(text) {
  const rows = parse(text, {
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true, from_line: 2, bom: true,
  });
  const entries = [];
  const errors = [];
  for (const r of rows) {
    const raw = r.slice(0, 2).join(' ');
    const scryfallId = r.find((f) => UUID.test(f.trim()))?.trim();
    const quantity = parseInt(r[0], 10);
    if (!scryfallId || !quantity) {
      errors.push({ line: raw, reason: 'Missing quantity or Scryfall ID' });
      continue;
    }
    const categories = [r[5], ...(r[6] || '').split(',')]
      .map((c) => (c || '').replace(/\{[^}]*\}/g, '').trim())
      .filter(Boolean);
    entries.push({
      raw: `${quantity}x ${r[1]} (${r[3]})`,
      quantity,
      name: r[1],
      set: (r[3] || '').toLowerCase() || null,
      scryfallId,
      category: categories[0] || null,
      isCommander: categories.some((c) => c.toLowerCase() === 'commander'),
    });
  }
  return { entries, errors };
}

/** Resolve CSV entries by exact Scryfall ID. */
async function resolveById(db, entries) {
  const missing = new Set(await ensureCardsById(db, entries.map((e) => e.scryfallId)));
  const lookup = db.prepare('SELECT scryfall_id, oracle_id, name, set_code FROM cards WHERE scryfall_id = ?');
  const resolved = [];
  const unresolved = [];
  for (const e of entries) {
    const c = !missing.has(e.scryfallId) && lookup.get(e.scryfallId);
    if (!c) unresolved.push({ line: e.raw, reason: 'Scryfall ID not found' });
    else resolved.push({ ...e, scryfall_id: c.scryfall_id, oracle_id: c.oracle_id, resolvedName: c.name, resolvedSet: c.set_code });
  }
  return { resolved, unresolved };
}

// "1x Name (set) 123 *F* [Category,Other{top}]" - collector number, finish marker and category optional.
const LINE_RE = /^(\d+)x?\s+(.+?)\s+\(([^)]+)\)(?:\s+([^\s\[*]+))?(?:\s+\*[A-Z]+\*)*\s*(?:\[(.*)\])?\s*$/;
// Fallback for plain "1 Name" / "1x Name" lines without a set.
const BARE_RE = /^(\d+)x?\s+(.+?)\s*$/;

export function parseDeckLine(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('//') || line.startsWith('#')) return null;
  let m = line.match(LINE_RE);
  let qty, name, set = null, collector = null, catText = '';
  if (m) {
    [, qty, name, set, collector = null, catText = ''] = m;
  } else if ((m = line.match(BARE_RE))) {
    [, qty, name] = m;
  } else {
    return { error: 'Could not parse line', raw: line };
  }
  const categories = (catText || '')
    .split(',')
    .map((c) => c.replace(/\{[^}]*\}/g, '').trim())
    .filter(Boolean);
  const isCommander = categories.some((c) => c.toLowerCase() === 'commander');
  return {
    raw: line,
    quantity: parseInt(qty, 10),
    name: name.trim(),
    set: set ? set.toLowerCase() : null,
    collector,
    category: categories[0] || null,
    isCommander,
  };
}

export function parseDeckText(text) {
  const entries = [];
  const errors = [];
  for (const raw of text.split(/\r?\n/)) {
    const p = parseDeckLine(raw);
    if (!p) continue;
    if (p.error) errors.push({ line: p.raw, reason: p.error });
    else entries.push(p);
  }
  return { entries, errors };
}

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
// Scryfall's card name for a DFC is "Front // Back"; decks often list just the front.
function nameMatches(card, name) {
  const n = norm(name);
  return norm(card.name) === n || norm(card.name.split(' // ')[0]) === n
    || (card.card_faces || []).some((f) => norm(f.name) === n);
}

/**
 * Resolve parsed deck entries to Scryfall cards.
 * Tries (set+collector) -> (name+set) -> (name) and caches everything it finds.
 * Returns entries with scryfall_id/oracle_id set, plus an unresolved list.
 */
export async function resolveEntries(db, entries) {
  const resolved = new Array(entries.length).fill(null);

  const attempt = async (idxs, makeId) => {
    const pairs = idxs.map((i) => [i, makeId(entries[i])]).filter(([, id]) => id);
    if (!pairs.length) return;
    const { found } = await fetchCollection(pairs.map(([, id]) => id));
    upsertCards(db, found);
    for (const [i] of pairs) {
      const e = entries[i];
      const hit = found.find((c) => nameMatches(c, e.name) && (!makeId.needsSet || c.set === e.set));
      if (hit) resolved[i] = hit;
    }
  };

  const pending = () => entries.map((_, i) => i).filter((i) => !resolved[i]);

  // 1. Already-cached printing that matches name+set (avoids network for re-imports).
  const cached = db.prepare('SELECT raw FROM cards WHERE set_code = ? AND (name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE) LIMIT 1');
  entries.forEach((e, i) => {
    if (!e.set) return;
    const row = cached.get(e.set, e.name, `${e.name} // %`);
    if (row) resolved[i] = JSON.parse(row.raw);
  });

  const bySetNum = (e) => (e.set && e.collector ? { set: e.set, collector_number: e.collector } : null);
  bySetNum.needsSet = true;
  const byNameSet = (e) => (e.set ? { name: e.name, set: e.set } : null);
  byNameSet.needsSet = true;
  const byName = (e) => ({ name: e.name });

  await attempt(pending(), bySetNum);
  await attempt(pending(), byNameSet);
  await attempt(pending(), byName);

  const out = [];
  const unresolved = [];
  entries.forEach((e, i) => {
    const c = resolved[i];
    if (!c) unresolved.push({ line: e.raw, reason: 'Card not found on Scryfall' });
    else out.push({ ...e, scryfall_id: c.id, oracle_id: c.oracle_id ?? c.card_faces?.[0]?.oracle_id ?? c.id, resolvedName: c.name, resolvedSet: c.set });
  });
  return { resolved: out, unresolved };
}

/**
 * Import a deck from Archidekt text. If a deck with the same name exists,
 * `replace` must be true or an error with code 'DECK_EXISTS' is thrown.
 */
export async function importDeck(db, { name, text, format = 'commander', replace = false }) {
  name = name.trim();
  const existing = db.prepare('SELECT id FROM decks WHERE name = ?').get(name);
  if (existing && !replace) {
    const err = new Error(`A deck named "${name}" already exists`);
    err.code = 'DECK_EXISTS';
    throw err;
  }
  const csv = isDeckCsv(text);
  const { entries, errors } = csv ? parseDeckCsv(text) : parseDeckText(text);
  const { resolved, unresolved } = csv ? await resolveById(db, entries) : await resolveEntries(db, entries);

  let keptVerified = 0;
  let considering = 0;
  let keptConsidering = 0;
  let keepConsidering = [];
  const deckId = tx(db, () => {
    let id;
    // Verification you've already done survives a re-import: keyed by card (oracle id).
    const prior = new Map();
    if (existing) {
      id = existing.id;
      for (const p of db.prepare(`SELECT oracle_id, scryfall_id, finish, verify_status, verified_at FROM deck_cards
          WHERE deck_id = ? AND verify_status IS NOT NULL AND board = 'main'`).all(id)) {
        if (!prior.has(p.oracle_id)) prior.set(p.oracle_id, p);
      }
      // Considering cards added in the app aren't in Archidekt's list; keep them through the re-import.
      keepConsidering = db.prepare("SELECT * FROM deck_cards WHERE deck_id = ? AND board = 'considering'").all(id);
      db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(id);
      db.prepare("UPDATE decks SET updated_at = datetime('now') WHERE id = ?").run(id);
    } else {
      id = Number(db.prepare('INSERT INTO decks (name, format) VALUES (?, ?)').run(name, format).lastInsertRowid);
    }
    const stmt = db.prepare(`INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, category, is_commander,
        finish, verify_status, verified_at, board) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of resolved) {
      // Archidekt's Maybeboard / Sideboard categories are this app's Considering list.
      const board = CONSIDERING_CATEGORY.test(r.category || '') ? 'considering' : 'main';
      const p = board === 'main' ? prior.get(r.oracle_id) : null;
      if (p) { keptVerified++; prior.delete(r.oracle_id); }
      stmt.run(id, p ? p.scryfall_id : r.scryfall_id, r.oracle_id, r.quantity, board === 'main' ? r.category : null,
        r.isCommander ? 1 : 0, p?.finish ?? null, p?.verify_status ?? null, p?.verified_at ?? null, board);
      if (board === 'considering') considering++;
    }
    const present = new Set(db.prepare('SELECT oracle_id FROM deck_cards WHERE deck_id = ?').all(id).map((r) => r.oracle_id));
    const inMain = new Set(db.prepare("SELECT oracle_id FROM deck_cards WHERE deck_id = ? AND board = 'main'").all(id).map((r) => r.oracle_id));
    const keep = db.prepare(`INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, board, replaces_oracle_id)
      VALUES (?, ?, ?, ?, 'considering', ?)`);
    for (const k of keepConsidering) {
      if (present.has(k.oracle_id)) continue; // the import already has it (in the deck or its Maybeboard)
      keep.run(id, k.scryfall_id, k.oracle_id, k.quantity, inMain.has(k.replaces_oracle_id) ? k.replaces_oracle_id : null);
      keptConsidering++;
    }
    return id;
  });

  return {
    deckId,
    name,
    replaced: Boolean(existing),
    keptVerified,
    considering,
    keptConsidering,
    format: csv ? 'archidekt-csv' : 'text',
    lines: entries.length,
    cards: resolved.filter((r) => !CONSIDERING_CATEGORY.test(r.category || '')).reduce((s, r) => s + r.quantity, 0),
    commander: resolved.filter((r) => r.isCommander).map((r) => r.resolvedName),
    unresolved: [...errors, ...unresolved],
  };
}
