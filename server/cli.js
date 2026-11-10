// Command-line imports:
//   node server/cli.js collection <file.csv>
//   node server/cli.js deck <file.txt> [deck name] [--replace]
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { openDb } from './db.js';
import { importCollection } from './importCollection.js';
import { importDeck } from './importDeck.js';

const [kind, file, ...rest] = process.argv.slice(2);
if (!kind || !file) {
  console.error('usage: cli.js collection <file.csv> | deck <file.txt> [name] [--replace]');
  process.exit(1);
}
const db = openDb();
const text = readFileSync(file, 'utf8');

if (kind === 'collection') {
  const mode = rest.includes('--replace') ? 'replace' : 'merge';
  console.log(JSON.stringify(await importCollection(db, text, { mode }), null, 2));
} else if (kind === 'deck') {
  const replace = rest.includes('--replace');
  const nameArg = rest.find((a) => a !== '--replace');
  const name = nameArg || basename(file, extname(file)).replace(/^\w/, (c) => c.toUpperCase());
  console.log(JSON.stringify(await importDeck(db, { name, text, replace }), null, 2));
} else {
  console.error(`unknown import kind: ${kind}`);
  process.exit(1);
}
