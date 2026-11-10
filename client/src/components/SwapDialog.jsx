import { useEffect, useMemo, useRef, useState } from 'react';

const TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land'];
const mainType = (t = '') => TYPES.find((x) => t.includes(x)) || '';

/**
 * Asked when adding a card to a deck: is it replacing something, going on the Considering list,
 * or just being added?
 *   incoming: { name, scryfall_id, type_line, image }
 *   cards: the deck's main-board cards
 *   onSubmit({ mode: 'swap'|'considering'|'add', out_card_id?, outTo? })
 */
export default function SwapDialog({ incoming, cards, defaultCategory, onSubmit, onCancel, busy }) {
  const [mode, setMode] = useState('swap');
  const [outId, setOutId] = useState(null);
  const [outTo, setOutTo] = useState('remove');
  const [q, setQ] = useState('');
  const [replacesId, setReplacesId] = useState('');
  const searchRef = useRef();
  useEffect(() => { searchRef.current?.focus(); }, []);

  // Swap candidates: same card type first (a creature usually replaces a creature), then by name.
  const candidates = useMemo(() => {
    const t = mainType(incoming.type_line);
    const s = q.trim().toLowerCase();
    return cards
      .filter((c) => !c.is_commander && (!s || c.name.toLowerCase().includes(s) || (c.category || '').toLowerCase().includes(s)))
      .sort((a, b) => ((mainType(b.type_line) === t) - (mainType(a.type_line) === t)) || a.name.localeCompare(b.name));
  }, [cards, incoming, q]);

  useEffect(() => {
    if (mode === 'swap' && candidates.length && !candidates.some((c) => c.id === outId)) setOutId(candidates[0].id);
  }, [candidates, mode, outId]);

  const out = cards.find((c) => c.id === outId);
  const canSubmit = !busy && (mode !== 'swap' || out);
  const submit = () => canSubmit && onSubmit(
    mode === 'swap' ? { mode, out_card_id: outId, outTo }
      : mode === 'considering' ? { mode, replaces_oracle_id: replacesId || null } : { mode },
  );

  // Keys are handled at the window so they keep working when focus leaves the dialog
  // (switching modes removes the focused search box).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      else if (mode === 'swap' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const i = candidates.findIndex((c) => c.id === outId);
        const n = candidates[Math.max(0, Math.min(candidates.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) setOutId(n.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal panel" role="dialog" aria-label={`Add ${incoming.name}`}>
        <div className="swap-head">
          {incoming.image && <img src={incoming.image} alt="" />}
          <div>
            <div className="muted small">Adding</div>
            <h2 style={{ margin: '2px 0 4px' }}>{incoming.name}</h2>
            <div className="muted small">{incoming.type_line}</div>
          </div>
        </div>

        <div className="seg" style={{ margin: '14px 0 12px' }}>
          <button className={mode === 'swap' ? 'on' : ''} onClick={() => setMode('swap')}>Swap a card out</button>
          <button className={mode === 'considering' ? 'on' : ''} onClick={() => setMode('considering')}>Add to Considering</button>
          <button className={mode === 'add' ? 'on' : ''} onClick={() => setMode('add')}>Just add</button>
        </div>

        {mode === 'swap' && (
          <>
            <input ref={searchRef} type="search" placeholder="Which card is coming out? (type to filter)" value={q}
              onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
            <ul className="swap-list">
              {candidates.map((c) => (
                <li key={c.id} className={c.id === outId ? 'on' : ''} onClick={() => setOutId(c.id)} onDoubleClick={submit}>
                  <span className="vname">{c.name}</span>
                  <span className="muted small">{c.category || mainType(c.type_line)}</span>
                </li>
              ))}
              {candidates.length === 0 && <li className="muted">No cards match.</li>}
            </ul>
            <div className="swap-out">
              <span className="muted small">{out ? out.name : 'The card'} goes:</span>
              <label className="check"><input type="radio" checked={outTo === 'remove'} onChange={() => setOutTo('remove')} /> Out of the deck</label>
              <label className="check"><input type="radio" checked={outTo === 'considering'} onChange={() => setOutTo('considering')} /> To Considering</label>
            </div>
          </>
        )}
        {mode === 'considering' && (
          <p className="small muted">
            Goes on this deck's Considering list. It won't count as part of the deck or use a copy from your collection;
            your collection shows it as considered for this deck.
          </p>
        )}
        {mode === 'considering' && (
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            Would replace:
            <select value={replacesId} onChange={(e) => setReplacesId(e.target.value)} style={{ flex: 1 }}>
              <option value="">nothing yet (decide later)</option>
              {[...new Map(candidates.map((c) => [c.oracle_id, c])).values()].map((c) => (
                <option key={c.oracle_id} value={c.oracle_id}>{c.name}{c.category ? ` · ${c.category}` : ''}</option>
              ))}
            </select>
          </label>
        )}
        {mode === 'add' && (
          <p className="small muted">Added to the main deck{defaultCategory ? <> under <b>{defaultCategory}</b></> : ''}, without taking anything out.</p>
        )}

        <div className="modal-foot">
          <button onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
          <button className="primary" disabled={!canSubmit} onClick={submit}>
            {mode === 'swap' ? (out ? `Swap for ${out.name}` : 'Swap') : mode === 'considering' ? 'Add to Considering' : 'Add to deck'} <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
