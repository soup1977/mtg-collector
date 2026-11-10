// Scryfall client: batched lookups, polite rate limiting, and a SQLite cache.
const API = 'https://api.scryfall.com';
const HEADERS = {
  'User-Agent': 'MTGCollector/0.1 (personal local app)',
  Accept: 'application/json',
};
// Scryfall: ~10 req/s generally, but /cards/search, /cards/named and /cards/collection
// are limited to ~2 req/s. Requests are serialized through one queue.
const FAST_MS = 120;
const HEAVY_MS = 550;
const HEAVY = /^\/cards\/(search|named|collection|random)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = 0;
let queue = Promise.resolve();
function throttle(path) {
  const gap = HEAVY.test(path) ? HEAVY_MS : FAST_MS;
  const p = queue.then(async () => {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  });
  queue = p;
  return p;
}

async function request(path, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle(path);
    const res = await fetch(API + path, {
      signal: AbortSignal.timeout(30_000),
      ...opts,
      headers: { ...HEADERS, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    });
    if (res.status === 429) {
      // Honor Retry-After exactly; Scryfall blocks clients that ignore it.
      const secs = parseInt(res.headers.get('retry-after') || '60', 10);
      console.warn(`Scryfall rate limit hit; waiting ${secs}s`);
      await sleep((secs + 1) * 1000);
      last = Date.now();
      continue;
    }
    const json = await res.json().catch(() => {
      throw new Error(`Scryfall ${res.status}: unexpected response (is Scryfall down?)`);
    });
    if (!res.ok && res.status !== 404) throw new Error(`Scryfall ${res.status}: ${json.details || res.statusText}`);
    return { status: res.status, json };
  }
  throw new Error('Scryfall rate limit: too many retries');
}

/**
 * Look up identifiers via /cards/collection in batches of 75.
 * Returns { found: [card], notFound: [identifier] }.
 */
export async function fetchCollection(identifiers) {
  const found = [];
  const notFound = [];
  for (let i = 0; i < identifiers.length; i += 75) {
    const batch = identifiers.slice(i, i + 75);
    const { json } = await request('/cards/collection', {
      method: 'POST',
      body: JSON.stringify({ identifiers: batch }),
    });
    found.push(...(json.data || []));
    notFound.push(...(json.not_found || []));
  }
  return { found, notFound };
}

export async function fetchNamed(name, set) {
  const q = new URLSearchParams({ exact: name });
  if (set) q.set('set', set);
  const { status, json } = await request(`/cards/named?${q}`);
  return status === 200 ? json : null;
}

export async function fetchById(id) {
  const { status, json } = await request(`/cards/${encodeURIComponent(id)}`);
  return status === 200 ? json : null;
}

/** Exact printing by set code + collector number (e.g. "dsc", "94"). */
export async function fetchBySetNumber(set, number) {
  const { status, json } = await request(`/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number)}`);
  return status === 200 ? json : null;
}

export async function autocomplete(q) {
  const { json } = await request(`/cards/autocomplete?q=${encodeURIComponent(q)}`);
  return json.data || [];
}

export async function fetchPrints(oracleId) {
  const q = encodeURIComponent(`oracleid:${oracleId}`);
  const out = [];
  let path = `/cards/search?q=${q}&unique=prints&order=released`;
  while (path) {
    const { status, json } = await request(path);
    if (status !== 200) break;
    out.push(...json.data);
    path = json.has_more ? json.next_page.replace(API, '') : null;
  }
  return out;
}

/** Map a Scryfall card object to a cards-table row. */
export function toRow(c) {
  const face = c.card_faces?.[0] ?? {};
  const imgs = c.image_uris ?? face.image_uris ?? {};
  const join = (k) => c[k] ?? (c.card_faces ? c.card_faces.map((f) => f[k]).filter(Boolean).join(' // ') : null);
  return {
    scryfall_id: c.id,
    oracle_id: c.oracle_id ?? face.oracle_id ?? c.id,
    name: c.name,
    set_code: c.set,
    set_name: c.set_name,
    collector_number: c.collector_number,
    rarity: c.rarity,
    mana_cost: join('mana_cost'),
    cmc: c.cmc ?? 0,
    type_line: join('type_line'),
    oracle_text: c.card_faces ? c.card_faces.map((f) => f.oracle_text).join('\n//\n') : c.oracle_text ?? '',
    colors: JSON.stringify(c.colors ?? face.colors ?? []),
    color_identity: JSON.stringify(c.color_identity ?? []),
    image_normal: imgs.normal ?? null,
    image_small: imgs.small ?? null,
    prices: JSON.stringify(c.prices ?? {}),
    raw: JSON.stringify(c),
    fetched_at: new Date().toISOString(),
  };
}

export function upsertCards(db, cards) {
  const stmt = db.prepare(`
    INSERT INTO cards (scryfall_id, oracle_id, name, set_code, set_name, collector_number, rarity,
      mana_cost, cmc, type_line, oracle_text, colors, color_identity, image_normal, image_small,
      prices, raw, fetched_at)
    VALUES (:scryfall_id, :oracle_id, :name, :set_code, :set_name, :collector_number, :rarity,
      :mana_cost, :cmc, :type_line, :oracle_text, :colors, :color_identity, :image_normal, :image_small,
      :prices, :raw, :fetched_at)
    ON CONFLICT(scryfall_id) DO UPDATE SET
      oracle_id=excluded.oracle_id, name=excluded.name, set_code=excluded.set_code,
      set_name=excluded.set_name, collector_number=excluded.collector_number, rarity=excluded.rarity,
      mana_cost=excluded.mana_cost, cmc=excluded.cmc, type_line=excluded.type_line,
      oracle_text=excluded.oracle_text, colors=excluded.colors, color_identity=excluded.color_identity,
      image_normal=excluded.image_normal, image_small=excluded.image_small, prices=excluded.prices,
      raw=excluded.raw, fetched_at=excluded.fetched_at`);
  for (const c of cards) stmt.run(toRow(c));
}

/** Ensure all scryfall ids are cached; fetch the missing ones. Returns ids Scryfall didn't know. */
export async function ensureCardsById(db, ids, { force = false } = {}) {
  const unique = [...new Set(ids)];
  const have = new Set(
    force ? [] : db.prepare('SELECT scryfall_id FROM cards').all().map((r) => r.scryfall_id),
  );
  const missing = unique.filter((id) => !have.has(id));
  if (!missing.length) return [];
  const { found, notFound } = await fetchCollection(missing.map((id) => ({ id })));
  db.exec('BEGIN');
  try {
    upsertCards(db, found);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return notFound.map((n) => n.id);
}
