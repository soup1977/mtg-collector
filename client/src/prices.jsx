import { useEffect, useState } from 'react';
import { api } from './api.js';

// Shared settings store: loaded once, every component re-renders when it changes.
let settings = null;
let pending = null;
const listeners = new Set();

function load() {
  pending ??= api.get('/api/settings')
    .then((s) => { settings = s; listeners.forEach((l) => l(s)); return s; })
    .catch(() => { pending = null; return settings; }); // e.g. logged out; retried on next use
  return pending;
}

export async function updateSettings(patch) {
  settings = await api.patch('/api/settings', patch);
  listeners.forEach((l) => l(settings));
  return settings;
}

export function reloadSettings() {
  pending = null;
  return load();
}

export function useSettings() {
  const [s, setS] = useState(settings);
  useEffect(() => {
    listeners.add(setS);
    if (!settings) load();
    return () => listeners.delete(setS);
  }, []);
  return s;
}

/** Unit price for a finish from a Scryfall prices object (TCGplayer market, USD). */
export function unitPrice(prices, finish = 'Normal') {
  const n = (v) => (v == null || v === '' ? null : Number(v));
  if (!prices) return null;
  if (finish === 'Foil') return n(prices.usd_foil) ?? n(prices.usd);
  if (finish === 'Etched') return n(prices.usd_etched) ?? n(prices.usd_foil) ?? n(prices.usd);
  return n(prices.usd) ?? n(prices.usd_foil) ?? n(prices.usd_etched);
}

export const isBulk = (price, s) => Boolean(s?.excludeBulk) && (price ?? 0) < (s?.bulkThreshold ?? 0);

/** Value that counts toward totals (bulk counts as 0 when excluded). */
export const countable = (price, s) => (isBulk(price, s) ? 0 : price ?? 0);

export const money = (v) => `$${(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "$12.34", "bulk" (actual price on hover), or "—" when there's no price. */
export function Price({ value, className = '' }) {
  const s = useSettings();
  if (value == null) return <span className={`muted ${className}`} title="No TCGplayer price">—</span>;
  if (isBulk(value, s)) return <span className={`muted ${className}`} title={`${money(value)} (bulk, under ${money(s.bulkThreshold)})`}>bulk</span>;
  return <span className={className}>{money(value)}</span>;
}
