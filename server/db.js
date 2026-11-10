import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function openDb(file = process.env.MTG_DB || resolve(root, 'data/mtg.sqlite')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS cards (
      scryfall_id      TEXT PRIMARY KEY,
      oracle_id        TEXT,
      name             TEXT NOT NULL,
      set_code         TEXT,
      set_name         TEXT,
      collector_number TEXT,
      rarity           TEXT,
      mana_cost        TEXT,
      cmc              REAL,
      type_line        TEXT,
      oracle_text      TEXT,
      colors           TEXT,
      color_identity   TEXT,
      image_normal     TEXT,
      image_small      TEXT,
      prices           TEXT,
      raw              TEXT,
      fetched_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cards_oracle ON cards(oracle_id);
    CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);

    CREATE TABLE IF NOT EXISTS collection_items (
      id             INTEGER PRIMARY KEY,
      scryfall_id    TEXT NOT NULL REFERENCES cards(scryfall_id),
      finish         TEXT,
      condition      TEXT,
      language       TEXT,
      quantity       INTEGER NOT NULL,
      date_added     TEXT,
      purchase_price REAL,
      tags           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ci_card ON collection_items(scryfall_id);

    CREATE TABLE IF NOT EXISTS decks (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      format     TEXT,
      notes      TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deck_cards (
      id           INTEGER PRIMARY KEY,
      deck_id      INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      scryfall_id  TEXT NOT NULL REFERENCES cards(scryfall_id),
      oracle_id    TEXT NOT NULL,
      quantity     INTEGER NOT NULL DEFAULT 1,
      category     TEXT,
      is_commander INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dc_deck ON deck_cards(deck_id);
    CREATE INDEX IF NOT EXISTS idx_dc_oracle ON deck_cards(oracle_id);

    -- Every change the app makes to the collection (for review, undo and export back to Archidekt).
    CREATE TABLE IF NOT EXISTS collection_log (
      id                 INTEGER PRIMARY KEY,
      at                 TEXT DEFAULT (datetime('now')),
      action             TEXT NOT NULL,          -- 'add' | 'undo'
      scryfall_id        TEXT NOT NULL REFERENCES cards(scryfall_id),
      finish             TEXT,
      quantity           INTEGER NOT NULL,
      reason             TEXT,
      collection_item_id INTEGER,
      undone             INTEGER NOT NULL DEFAULT 0,
      exported_at        TEXT
    );
  `);

  // Column migrations for databases created before these features existed.
  const addColumn = (table, col, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addColumn('collection_items', 'source', "TEXT NOT NULL DEFAULT 'import'"); // 'import' | 'app'
  addColumn('deck_cards', 'verify_status', 'TEXT');                          // NULL | 'confirmed' | 'missing'
  addColumn('deck_cards', 'finish', 'TEXT');                                 // finish of the physical copy, once confirmed
  addColumn('deck_cards', 'verified_at', 'TEXT');
  addColumn('deck_cards', 'scan_count', 'INTEGER NOT NULL DEFAULT 0');      // copies scanned so far (for qty > 1)
  addColumn('decks', 'archived_at', 'TEXT');                                 // set when dissolved; cards no longer count as used
  addColumn('deck_cards', 'board', "TEXT NOT NULL DEFAULT 'main'");          // 'main' | 'considering' (maybe list, not counted)
  addColumn('deck_cards', 'replaces_oracle_id', 'TEXT');                     // considering only: the main-deck card it would replace

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

    -- Deck history: swaps, additions, removals, moves to/from Considering.
    CREATE TABLE IF NOT EXISTS deck_changes (
      id       INTEGER PRIMARY KEY,
      deck_id  INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      at       TEXT DEFAULT (datetime('now')),
      action   TEXT NOT NULL,      -- 'swap' | 'add' | 'remove' | 'to_considering' | 'to_main'
      card_in  TEXT,               -- card name coming in (or moved)
      card_out TEXT,               -- card name going out
      detail   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_changes_deck ON deck_changes(deck_id);

    -- Main-board cards in decks that aren't dissolved: the only ones that count as "used".
    DROP VIEW IF EXISTS active_deck_cards;
    CREATE VIEW active_deck_cards AS
      SELECT dc.* FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
      WHERE d.archived_at IS NULL AND dc.board = 'main';

    -- Unit price of each collection item for its finish (TCGplayer market price via Scryfall, USD).
    DROP VIEW IF EXISTS item_prices;
    CREATE VIEW item_prices AS
      SELECT ci.id, ci.scryfall_id, c.oracle_id, ci.quantity, ci.finish,
        CAST(CASE ci.finish
          WHEN 'Foil'   THEN COALESCE(json_extract(c.prices, '$.usd_foil'), json_extract(c.prices, '$.usd'))
          WHEN 'Etched' THEN COALESCE(json_extract(c.prices, '$.usd_etched'), json_extract(c.prices, '$.usd_foil'), json_extract(c.prices, '$.usd'))
          ELSE COALESCE(json_extract(c.prices, '$.usd'), json_extract(c.prices, '$.usd_foil'), json_extract(c.prices, '$.usd_etched'))
        END AS REAL) AS unit_price
      FROM collection_items ci JOIN cards c ON c.scryfall_id = ci.scryfall_id;

    -- Copies owned of one exact printing, and how many of them confirmed deck cards claim.
    DROP VIEW IF EXISTS printing_usage;
    CREATE VIEW printing_usage AS
      WITH o AS (SELECT scryfall_id, SUM(quantity) AS owned FROM collection_items GROUP BY scryfall_id),
           cl AS (SELECT scryfall_id, SUM(quantity) AS claimed FROM active_deck_cards
                  WHERE verify_status = 'confirmed' GROUP BY scryfall_id)
      SELECT ids.scryfall_id, COALESCE(o.owned, 0) AS owned, COALESCE(cl.claimed, 0) AS claimed
      FROM (SELECT scryfall_id FROM o UNION SELECT scryfall_id FROM cl) ids
      LEFT JOIN o ON o.scryfall_id = ids.scryfall_id
      LEFT JOIN cl ON cl.scryfall_id = ids.scryfall_id;

    DROP VIEW IF EXISTS owned_by_oracle;
    CREATE VIEW owned_by_oracle AS
      SELECT c.oracle_id, SUM(ci.quantity) AS owned
      FROM collection_items ci JOIN cards c ON c.scryfall_id = ci.scryfall_id
      GROUP BY c.oracle_id;

    DROP VIEW IF EXISTS needed_by_oracle;
    CREATE VIEW needed_by_oracle AS
      SELECT oracle_id, SUM(quantity) AS needed, COUNT(DISTINCT deck_id) AS deck_count
      FROM active_deck_cards GROUP BY oracle_id;

    -- One row per oracle card that is owned or in any deck (dissolved decks included, so their
    -- pages still show every card; only active decks count toward needed / shortfall).
    DROP VIEW IF EXISTS card_usage;
    CREATE VIEW card_usage AS
      WITH ids AS (
        SELECT oracle_id FROM owned_by_oracle
        UNION SELECT oracle_id FROM deck_cards
      ), rep AS (
        -- a representative printing per oracle id (prefer one you own)
        SELECT c.oracle_id, c.scryfall_id,
               ROW_NUMBER() OVER (PARTITION BY c.oracle_id
                 ORDER BY (SELECT COUNT(*) FROM collection_items ci WHERE ci.scryfall_id = c.scryfall_id) DESC,
                          c.scryfall_id) AS rn
        FROM cards c WHERE c.oracle_id IN (SELECT oracle_id FROM ids)
      )
      SELECT ids.oracle_id,
             c.scryfall_id AS rep_scryfall_id,
             c.name, c.type_line, c.mana_cost, c.cmc, c.colors, c.color_identity, c.rarity,
             c.image_small, c.image_normal, c.set_code,
             COALESCE(o.owned, 0)       AS owned,
             COALESCE(n.needed, 0)      AS needed,
             COALESCE(n.deck_count, 0)  AS deck_count,
             CASE WHEN c.type_line LIKE '%Basic Land%' THEN 0
                  ELSE MAX(COALESCE(n.needed, 0) - COALESCE(o.owned, 0), 0) END AS shortfall
      FROM ids
      JOIN rep r ON r.oracle_id = ids.oracle_id AND r.rn = 1
      JOIN cards c ON c.scryfall_id = r.scryfall_id
      LEFT JOIN owned_by_oracle o ON o.oracle_id = ids.oracle_id
      LEFT JOIN needed_by_oracle n ON n.oracle_id = ids.oracle_id;
  `);
  return db;
}

/** Run fn inside a transaction. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
