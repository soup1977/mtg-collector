// Price refresh: re-pull Scryfall data (which carries TCGplayer market prices) for every card
// you own or have in a deck. Scryfall updates prices about once a day.
import { ensureCardsById } from './scryfall.js';
import { getSettings, setSettings } from './settings.js';

let running = null;

export function refreshPrices(db) {
  if (running) return running; // one refresh at a time
  running = (async () => {
    const ids = db.prepare(`SELECT scryfall_id FROM collection_items
      UNION SELECT scryfall_id FROM deck_cards`).all().map((r) => r.scryfall_id);
    const missing = await ensureCardsById(db, ids, { force: true });
    const at = new Date().toISOString();
    setSettings(db, { pricesRefreshedAt: at });
    return { refreshed: ids.length - missing.length, missing, at };
  })().finally(() => { running = null; });
  return running;
}

export const isRefreshing = () => Boolean(running);

/** Refresh in the background if prices are more than a day old. */
export function refreshIfStale(db, maxAgeMs = 24 * 3600 * 1000) {
  const { pricesRefreshedAt } = getSettings(db);
  const age = pricesRefreshedAt ? Date.now() - Date.parse(pricesRefreshedAt) : Infinity;
  if (age < maxAgeMs) return;
  if (!db.prepare('SELECT 1 FROM collection_items LIMIT 1').get()) return;
  console.log('Prices are stale; refreshing from Scryfall in the background…');
  refreshPrices(db)
    .then((r) => console.log(`Prices refreshed for ${r.refreshed} cards.`))
    .catch((e) => console.error('Price refresh failed:', e.message));
}
