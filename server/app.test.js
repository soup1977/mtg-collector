import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { parseDeckLine, parseDeckCsv, isDeckCsv } from './importDeck.js';
import { parseCollectionCsv } from './importCollection.js';

test('parses Archidekt text deck lines', () => {
  assert.deepEqual(
    (({ quantity, name, set, category, isCommander }) => ({ quantity, name, set, category, isCommander }))(
      parseDeckLine('1x Saskia the Unyielding (c16) [Commander{top}]')),
    { quantity: 1, name: 'Saskia the Unyielding', set: 'c16', category: 'Commander', isCommander: true },
  );
  const forest = parseDeckLine('4x Forest (sos) [Lands]');
  assert.equal(forest.quantity, 4);
  assert.equal(forest.isCommander, false);
  const withNum = parseDeckLine('1x Sol Ring (cmm) 464 *F* [Ramp,Artifacts]');
  assert.equal(withNum.collector, '464');
  assert.equal(withNum.category, 'Ramp');
  assert.equal(parseDeckLine('1 Lightning Bolt').name, 'Lightning Bolt');
  assert.equal(parseDeckLine('   '), null);
});

test('parses the malformed Archidekt deck CSV by position', () => {
  const text = readFileSync(new URL('./fixtures/saskia.csv', import.meta.url), 'utf8');
  assert.ok(isDeckCsv(text));
  const { entries, errors } = parseDeckCsv(text);
  assert.equal(errors.length, 0);
  assert.equal(entries.length, 95);
  assert.equal(entries.reduce((s, e) => s + e.quantity, 0), 101);
  const cmdr = entries.filter((e) => e.isCommander);
  assert.deepEqual(cmdr.map((e) => e.name), ['Saskia the Unyielding']);
  assert.equal(cmdr[0].scryfallId, '5b483db6-b614-4af1-820a-42a4ee0c8707');
});

test('parses collection CSV with quoted names', () => {
  const rows = parseCollectionCsv(
    'Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,Collector Number\n' +
    '2,"Admiral Brass, Unsinkable",Etched,NM,2025-01-18,EN,,,LCC,lcc,0,8d00400d-4eb2-4430-836d-6a7e8eec3f40,121\n');
  assert.equal(rows[0].name, 'Admiral Brass, Unsinkable');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].finish, 'Etched');
});

test('shortfall sums across printings and decks, ignores basics', () => {
  const db = openDb(':memory:');
  const card = (id, oracle, name, type) => db.prepare(
    `INSERT INTO cards (scryfall_id, oracle_id, name, type_line, color_identity) VALUES (?, ?, ?, ?, '[]')`).run(id, oracle, name, type);
  card('sr1', 'SR', 'Sol Ring', 'Artifact');
  card('sr2', 'SR', 'Sol Ring', 'Artifact');
  card('sc1', 'SC', 'Skullclamp', 'Artifact Equipment');
  card('f1', 'F', 'Forest', 'Basic Land — Forest');
  const own = db.prepare('INSERT INTO collection_items (scryfall_id, quantity) VALUES (?, ?)');
  own.run('sr1', 1); own.run('sr2', 1); own.run('sc1', 1);
  db.exec(`INSERT INTO decks (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C')`);
  const use = db.prepare('INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity) VALUES (?, ?, ?, ?)');
  for (const d of [1, 2, 3]) { use.run(d, 'sr1', 'SR', 1); use.run(d, 'sc1', 'SC', 1); use.run(d, 'f1', 'F', 10); }

  const u = Object.fromEntries(db.prepare('SELECT oracle_id, owned, needed, deck_count, shortfall FROM card_usage').all()
    .map((r) => [r.oracle_id, { ...r }]));
  assert.deepEqual([u.SR.owned, u.SR.needed, u.SR.deck_count, u.SR.shortfall], [2, 3, 3, 1]);
  assert.deepEqual([u.SC.owned, u.SC.needed, u.SC.shortfall], [1, 3, 2]);
  assert.equal(u.F.shortfall, 0);
  assert.equal(u.F.owned, 0);
});

import { parseQuickEntry, verifyCard, autofixDeck, printingAvailability } from './verify.js';

test('parses quick entry', () => {
  assert.deepEqual(parseQuickEntry('dsc 94'), { set: 'dsc', number: '94', finish: 'Normal' });
  assert.deepEqual(parseQuickEntry('ONE 12 f'), { set: 'one', number: '12', finish: 'Foil' });
  assert.deepEqual(parseQuickEntry(' c16  41 etched '), { set: 'c16', number: '41', finish: 'Etched' });
  assert.equal(parseQuickEntry('dsc'), null);
  assert.equal(parseQuickEntry('dsc 94 shiny'), null);
});

test('verify claims copies per printing and adds missing copies to the collection', () => {
  const db = openDb(':memory:');
  const card = db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, set_code, collector_number, type_line, color_identity, raw)
    VALUES (?, ?, ?, ?, ?, 'Artifact', '[]', '{}')`);
  card.run('sr-a', 'SR', 'Sol Ring', 'aaa', '1');
  card.run('sr-b', 'SR', 'Sol Ring', 'bbb', '2');
  card.run('sk-a', 'SK', 'Skullclamp', 'aaa', '3');
  db.prepare("INSERT INTO collection_items (scryfall_id, finish, quantity) VALUES ('sr-a', 'Normal', 1)").run();
  db.exec(`INSERT INTO decks (id, name) VALUES (1, 'A'), (2, 'B')`);
  const use = db.prepare('INSERT INTO deck_cards (id, deck_id, scryfall_id, oracle_id, quantity) VALUES (?, ?, ?, ?, 1)');
  use.run(10, 1, 'sr-b', 'SR'); // deck A lists a printing we don't own
  use.run(20, 2, 'sr-b', 'SR');
  use.run(30, 1, 'sk-a', 'SK');

  // Auto-fix switches deck A's Sol Ring to the one owned printing.
  const fix = autofixDeck(db, 1);
  assert.equal(fix.switched.length, 1);
  assert.equal(db.prepare('SELECT scryfall_id FROM deck_cards WHERE id = 10').get().scryfall_id, 'sr-a');

  // Confirming the owned copy adds nothing.
  assert.equal(verifyCard(db, 10, { action: 'confirm' }).added, 0);
  // Deck B confirms the same printing: the only copy is claimed, so one is added.
  const r = verifyCard(db, 20, { action: 'confirm', scryfall_id: 'sr-a', finish: 'Foil' });
  assert.equal(r.added, 1);
  assert.equal(db.prepare("SELECT SUM(quantity) n FROM collection_items WHERE scryfall_id = 'sr-a'").get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_log').get().n, 1);
  // Wrong card is rejected.
  assert.throws(() => verifyCard(db, 30, { action: 'confirm', scryfall_id: 'sr-a' }), /is Sol Ring, not Skullclamp/);
});

import { scanCard, undoScan, markRemainingMissing } from './verify.js';

test('scan matches a printing to the deck entry, flags strays and duplicates, and undoes', async () => {
  const db = openDb(':memory:');
  const card = db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, set_code, collector_number, type_line, color_identity, raw)
    VALUES (?, ?, ?, ?, ?, ?, '[]', '{}')`);
  card.run('sr-a', 'SR', 'Sol Ring', 'aaa', '1', 'Artifact');
  card.run('sr-b', 'SR', 'Sol Ring', 'bbb', '2', 'Artifact');
  card.run('rr', 'RR', 'Relentless Rats', 'aaa', '5', 'Creature');
  card.run('ot', 'OT', 'Other Card', 'aaa', '9', 'Instant');
  card.run('fo', 'FO', 'Forest', 'aaa', '7', 'Basic Land — Forest');
  db.exec(`INSERT INTO decks (id, name) VALUES (1, 'A'), (2, 'B')`);
  const use = db.prepare('INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity) VALUES (?, ?, ?, ?)');
  use.run(1, 'sr-b', 'SR', 1);
  use.run(1, 'rr', 'RR', 2);
  use.run(2, 'ot', 'OT', 1);

  // Scanning a different printing than the deck lists confirms it and switches the printing.
  const s = await scanCard(db, 1, 'aaa 1 f');
  assert.equal(s.result, 'confirmed');
  assert.equal(s.switchedFrom, 'BBB #2');
  assert.equal(s.added, 1); // not in collection yet
  assert.equal((await scanCard(db, 1, 'aaa 1')).result, 'duplicate');
  // A card not on the list is added to the deck (the physical deck wins), noting where else it's listed.
  const stray = await scanCard(db, 1, 'aaa 9');
  assert.equal(stray.result, 'added_to_deck');
  assert.deepEqual(stray.otherDecks.map((d) => d.name), ['B']);
  undoScan(db, 1, stray.undo);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deck_cards WHERE deck_id = 1 AND oracle_id = 'OT'").get().n, 0);
  assert.equal((await scanCard(db, 1, 'aaa 7')).result, 'basic');
  // Quantity 2: first scan is partial, second confirms.
  assert.equal((await scanCard(db, 1, 'aaa 5')).result, 'partial');
  assert.equal((await scanCard(db, 1, 'aaa 5')).result, 'confirmed');

  // Undo the Sol Ring scan: printing restored, collection copy removed.
  undoScan(db, 1, s.undo);
  const row = db.prepare("SELECT scryfall_id, verify_status FROM deck_cards WHERE oracle_id = 'SR'").get();
  assert.deepEqual({ ...row }, { scryfall_id: 'sr-b', verify_status: null });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_items').get().n, 1); // only the rats copies remain
  assert.equal(markRemainingMissing(db, 1).marked, 1);
});

import { getSettings, setSettings, bulkParams } from './settings.js';

test('prices follow finish, and bulk is excluded from totals by setting', () => {
  const db = openDb(':memory:');
  const card = db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, type_line, color_identity, prices)
    VALUES (?, ?, ?, 'Artifact', '[]', ?)`);
  card.run('a', 'A', 'Pricey', JSON.stringify({ usd: '10.00', usd_foil: '25.00' }));
  card.run('b', 'B', 'Cheap', JSON.stringify({ usd: '0.20', usd_foil: null }));
  card.run('c', 'C', 'Etched', JSON.stringify({ usd: null, usd_foil: '3.00', usd_etched: null }));
  const own = db.prepare('INSERT INTO collection_items (scryfall_id, finish, quantity) VALUES (?, ?, ?)');
  own.run('a', 'Normal', 1); own.run('a', 'Foil', 1); own.run('b', 'Foil', 4); own.run('c', 'Etched', 1);

  const prices = Object.fromEntries(db.prepare('SELECT scryfall_id || finish AS k, unit_price FROM item_prices').all().map((r) => [r.k, r.unit_price]));
  assert.deepEqual(prices, { aNormal: 10, aFoil: 25, bFoil: 0.2, cEtched: 3 }); // foil falls back to normal, etched to foil

  const total = () => db.prepare(`SELECT SUM(quantity * CASE WHEN COALESCE(unit_price,0) < :th THEN 0 ELSE unit_price END) AS v
    FROM item_prices`).get(bulkParams(db)).v;
  assert.equal(getSettings(db).bulkThreshold, 1);
  assert.equal(total(), 38);                          // 4 x $0.20 bulk left out
  setSettings(db, { excludeBulk: false });
  assert.equal(Math.round(total() * 100) / 100, 38.8);
  setSettings(db, { excludeBulk: true, bulkThreshold: 5 });
  assert.equal(total(), 35);                          // $3 etched is now bulk too
  assert.throws(() => setSettings(db, { bulkThreshold: -1 }), /positive/);
});

test('dissolving a deck frees its cards; restoring brings the claims back', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, set_code, collector_number, type_line, color_identity, raw)
    VALUES ('sr', 'SR', 'Sol Ring', 'aaa', '1', 'Artifact', '[]', '{}')`).run();
  db.prepare("INSERT INTO collection_items (scryfall_id, finish, quantity) VALUES ('sr', 'Normal', 1)").run();
  db.exec(`INSERT INTO decks (id, name) VALUES (1, 'Raided'), (2, 'Main')`);
  db.exec(`INSERT INTO deck_cards (id, deck_id, scryfall_id, oracle_id, quantity, verify_status) VALUES
    (1, 1, 'sr', 'SR', 1, 'confirmed'), (2, 2, 'sr', 'SR', 1, NULL)`);
  const usage = () => ({ ...db.prepare("SELECT needed, deck_count, shortfall FROM card_usage WHERE oracle_id = 'SR'").get() });

  assert.deepEqual(usage(), { needed: 2, deck_count: 2, shortfall: 1 });
  assert.equal(printingAvailability(db, 'sr').free, 0); // claimed by Raided

  db.exec("UPDATE decks SET archived_at = datetime('now') WHERE id = 1");
  assert.deepEqual(usage(), { needed: 1, deck_count: 1, shortfall: 0 });
  assert.equal(printingAvailability(db, 'sr').free, 1); // copy is free again
  // The dissolved deck's cards still exist for its page.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deck_cards WHERE deck_id = 1').get().n, 1);

  db.exec('UPDATE decks SET archived_at = NULL WHERE id = 1');
  assert.deepEqual(usage(), { needed: 2, deck_count: 2, shortfall: 1 });
});

import { addCard, swapCard, moveBoard, deckHistory } from './deckEdit.js';

test('swap and Considering: considered cards never count as used', () => {
  const db = openDb(':memory:');
  const card = db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, set_code, collector_number, type_line, color_identity, raw)
    VALUES (?, ?, ?, 'aaa', ?, 'Creature', '[]', '{}')`);
  card.run('rw', 'RW', 'Rot Wolf', '1');
  card.run('ch', 'CH', 'Craterhoof Behemoth', '2');
  card.run('gs', 'GS', 'Glistener Elf', '3');
  db.exec(`INSERT INTO decks (id, name) VALUES (1, 'Omnath')`);
  db.exec(`INSERT INTO deck_cards (id, deck_id, scryfall_id, oracle_id, quantity, category, verify_status)
    VALUES (1, 1, 'rw', 'RW', 1, 'Creatures', 'confirmed')`);
  const usage = (o) => ({ ...db.prepare('SELECT needed, deck_count FROM card_usage WHERE oracle_id = ?').get(o) });
  const board = (o) => db.prepare('SELECT board, category FROM deck_cards WHERE oracle_id = ?').get(o);

  // Swap Rot Wolf out (to Considering) for Craterhoof; Craterhoof inherits the category.
  swapCard(db, 1, { scryfall_id: 'ch', out_card_id: 1, outTo: 'considering' });
  assert.deepEqual({ ...board('CH') }, { board: 'main', category: 'Creatures' });
  assert.equal(board('RW').board, 'considering');
  assert.deepEqual(usage('RW'), { needed: 0, deck_count: 0 });     // considered: not used
  assert.deepEqual(usage('CH'), { needed: 1, deck_count: 1 });
  assert.equal(db.prepare("SELECT verify_status FROM deck_cards WHERE oracle_id = 'RW'").get().verify_status, 'confirmed');

  // Add straight to Considering, then promote it.
  const { id } = addCard(db, 1, { scryfall_id: 'gs', board: 'considering' });
  assert.deepEqual(usage('GS'), { needed: 0, deck_count: 0 });
  moveBoard(db, 1, id, 'main');
  assert.deepEqual(usage('GS'), { needed: 1, deck_count: 1 });

  // Swap with outTo 'remove' deletes the outgoing card.
  swapCard(db, 1, { scryfall_id: 'rw', out_card_id: id, outTo: 'remove' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deck_cards WHERE oracle_id = 'GS'").get().n, 0);

  const h = deckHistory(db, 1).map((x) => `${x.action}:${x.card_in ?? ''}>${x.card_out ?? ''}`);
  assert.deepEqual(h, ['swap:Rot Wolf>Glistener Elf', 'to_main:Glistener Elf>', 'to_considering:Glistener Elf>', 'swap:Craterhoof Behemoth>Rot Wolf']);
});

import { validateDeck, copyLimit } from './validate.js';

test('deck validation: size, commander, duplicates, color identity, legality', () => {
  let n = 0;
  const card = (name, ci, extra = {}) => ({
    id: ++n, oracle_id: name, name, quantity: 1, is_commander: 0, type_line: 'Creature', oracle_text: '',
    color_identity: JSON.stringify(ci), legality: 'legal', ...extra,
  });
  const fillers = (k) => Array.from({ length: k }, (_, i) => card(`Filler ${i}`, ['G']));
  const codes = (issues) => issues.map((i) => i.code).sort();

  // A clean 100-card Commander deck.
  const omnath = card('Omnath', ['G'], { is_commander: 1 });
  assert.deepEqual(validateDeck('commander', [omnath, ...fillers(99)]), []);

  // Short, no commander.
  assert.deepEqual(codes(validateDeck('commander', fillers(94))), ['commander', 'size']);
  assert.equal(validateDeck('commander', fillers(94)).find((i) => i.code === 'size').label, '94/100 cards');

  // Off-color, duplicate, banned, and allowed multiples.
  const deck = [
    omnath, ...fillers(93),
    card('Lightning Bolt', ['R']),
    card('Sol Ring', [], { quantity: 2 }),
    card('Relentless Rats', ['B'], { oracle_text: 'A deck can have any number of cards named Relentless Rats.' }),
    card('Forest', [], { type_line: 'Basic Land — Forest', quantity: 1 }),
    card('Primeval Titan', ['G'], { legality: 'banned' }),
  ];
  const issues = validateDeck('commander', deck);
  assert.deepEqual(codes(issues), ['banned', 'color', 'duplicates']);
  assert.deepEqual(issues.find((i) => i.code === 'color').cards.map((c) => c.name), ['Lightning Bolt', 'Relentless Rats']);
  assert.deepEqual(issues.find((i) => i.code === 'duplicates').cards.map((c) => c.name), ['Sol Ring']);

  // Copy limits.
  assert.equal(copyLimit({ type_line: 'Basic Snow Land — Forest' }, 1), Infinity);
  assert.equal(copyLimit({ oracle_text: 'A deck can have up to seven cards named Seven Dwarves.' }, 1), 7);

  // Standard: 60-card minimum, 4 copies, no commander or color checks.
  const std = [card('Shock', ['R'], { quantity: 4 }), card('Opt', ['U'], { quantity: 5 }), ...fillers(51)];
  assert.deepEqual(codes(validateDeck('standard', std)), ['duplicates']);
  assert.deepEqual(validateDeck('casual', fillers(3)), []);
});

import { runBackup, listBackups, restoreBackup } from './backup.js';
import { mkdtempSync, readdirSync as lsDir, readFileSync as readF } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

test('backup writes snapshot + readable exports, prunes, and restores in place', () => {
  const tmp = mkdtempSync(pjoin(tmpdir(), 'mtg-backup-test-'));
  process.env.MTG_SAFETY_DIR = pjoin(tmp, 'safety');
  const realHome = process.env.HOME;
  process.env.HOME = pjoin(tmp, 'home'); // never see the real OneDrive / iCloud folders
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, set_code, collector_number, set_name, type_line, color_identity, raw)
    VALUES ('sr', 'SR', 'Sol Ring, Test', 'aaa', '1', 'Set A', 'Artifact', '[]', '{}')`).run();
  db.prepare("INSERT INTO collection_items (scryfall_id, finish, quantity) VALUES ('sr', 'Foil', 2)").run();
  db.exec(`INSERT INTO decks (id, name) VALUES (1, 'My/Deck')`);
  db.exec(`INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, category, is_commander) VALUES (1, 'sr', 'SR', 1, 'Ramp', 0)`);
  setSettings(db, { backupDestinations: ['custom'], backupCustomPath: tmp, backupKeep: 2 });

  const r = runBackup(db);
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const dir = pjoin(tmp, 'MTG Collector Backups', r.name);
  assert.match(readF(pjoin(dir, 'collection.csv'), 'utf8'), /2,"Sol Ring, Test",Foil/);
  assert.equal(readF(pjoin(dir, 'decks', 'My-Deck.txt'), 'utf8').split('\n')[2], '1x Sol Ring, Test (aaa) 1 [Ramp]');

  // Wreck the data, then restore.
  db.exec('DELETE FROM deck_cards; DELETE FROM decks; UPDATE collection_items SET quantity = 99');
  const res = restoreBackup(db, { destination: 'custom', name: r.name });
  assert.ok(lsDir(pjoin(tmp, 'safety')).length === 1, 'safety copy written');
  assert.equal(db.prepare('SELECT quantity FROM collection_items').get().quantity, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deck_cards').get().n, 1);
  assert.equal(res.restored, r.name);

  // Retention: keep 2.
  const names = new Set([r.name]);
  for (let i = 0; i < 3; i++) {
    const t = Date.now(); while (Date.now() - t < 1100) { /* distinct second-resolution names */ }
    names.add(runBackup(db).name);
  }
  assert.equal(listBackups(db).length, 2);
  delete process.env.MTG_SAFETY_DIR;
  process.env.HOME = realHome;
});

import { swapIn, setReplaces } from './deckEdit.js';
import { importDeck } from './importDeck.js';

test('Considering cards remember what they would replace, swap in, and survive re-import', async () => {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO cards (scryfall_id, oracle_id, name, set_code, collector_number, type_line, color_identity, raw)
    VALUES (?, ?, ?, 'aaa', ?, 'Creature', '[]', ?)`);
  const card = (id, oracle, name, num) => ins.run(id, oracle, name, num, JSON.stringify({ id, oracle_id: oracle, name, set: 'aaa' }));
  card('rw', 'RW', 'Rot Wolf', '1');
  card('ch', 'CH', 'Craterhoof Behemoth', '2');
  card('av', 'AV', 'Avenger of Zendikar', '3');
  db.exec(`INSERT INTO decks (id, name) VALUES (1, 'Omnath')`);
  db.exec(`INSERT INTO deck_cards (id, deck_id, scryfall_id, oracle_id, quantity, category) VALUES (1, 1, 'rw', 'RW', 1, 'Beaters')`);

  const hoof = addCard(db, 1, { scryfall_id: 'ch', board: 'considering', replaces_oracle_id: 'RW' }).id;
  const avenger = addCard(db, 1, { scryfall_id: 'av', board: 'considering' }).id;
  setReplaces(db, 1, avenger, 'RW'); // two contenders for Rot Wolf's slot
  assert.throws(() => setReplaces(db, 1, avenger, 'NOPE'), /not in the main deck/);

  swapIn(db, 1, hoof, { outTo: 'considering' });
  const rows = Object.fromEntries(db.prepare('SELECT oracle_id, board, category, replaces_oracle_id r FROM deck_cards').all()
    .map((x) => [x.oracle_id, `${x.board}|${x.category ?? ''}|${x.r ?? ''}`]));
  assert.deepEqual(rows, {
    CH: 'main|Beaters|',            // took Rot Wolf's category
    RW: 'considering||',            // Rot Wolf moved to Considering
    AV: 'considering||CH',          // the other contender now competes with Craterhoof
  });
  assert.equal(deckHistory(db, 1)[0].card_out, 'Rot Wolf');

  // Re-importing the deck (Archidekt doesn't know about app-only Considering cards) keeps them.
  // Plain-text format so no Scryfall lookup is needed: the card is cached by name + set.
  const r = await importDeck(db, { name: 'Omnath', text: '1x Craterhoof Behemoth (aaa) [Beaters]', replace: true });
  assert.equal(r.keptConsidering, 2);
  const after = Object.fromEntries(db.prepare('SELECT oracle_id, board, replaces_oracle_id r FROM deck_cards').all()
    .map((x) => [x.oracle_id, `${x.board}|${x.r ?? ''}`]));
  assert.deepEqual(after, { CH: 'main|', RW: 'considering|', AV: 'considering|CH' });
});
