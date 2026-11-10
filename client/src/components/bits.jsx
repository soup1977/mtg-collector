import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export function UsageBadges({ owned, needed, deckCount, shortfall, isBasic }) {
  return (
    <>
      {deckCount > 0 && <span className="badge decks" title={`Used in ${deckCount} deck(s), ${needed} copies total`}>
        {deckCount} deck{deckCount === 1 ? '' : 's'}</span>}
      {shortfall > 0 && !isBasic && <span className="badge short" title={`Own ${owned}, decks need ${needed}`}>
        short {shortfall}</span>}
    </>
  );
}

/** Text-mode mana cost: {2}{G}{W} -> 2 G W chips. */
export function ManaCost({ cost }) {
  if (!cost) return null;
  const parts = cost.split(' // ').map((half) => (half.match(/\{[^}]+\}/g) || []).map((s) => s.slice(1, -1)));
  return (
    <span className="pips" style={{ verticalAlign: 'middle' }}>
      {parts.map((syms, hi) => (
        <span key={hi} className="pips">
          {hi > 0 && <span className="muted">//</span>}
          {syms.map((s, i) => {
            const cls = 'WUBRGC'.includes(s) ? s : 'C';
            return <span key={i} className={`pip on ${cls}`} style={{ width: 18, height: 18, fontSize: 10, border: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{s.replace('/', '')}</span>;
          })}
        </span>
      ))}
    </span>
  );
}

/** Card-name autocomplete backed by /api/cards/autocomplete. */
export function CardSearch({ onPick, placeholder = 'Add a card…' }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState([]);
  const [hl, setHl] = useState(0);
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setOpts([]); return; }
    timer.current = setTimeout(() => {
      api.get(`/api/cards/autocomplete?q=${encodeURIComponent(q)}`).then((o) => { setOpts(o); setHl(0); }).catch(() => setOpts([]));
    }, 200);
    return () => clearTimeout(timer.current);
  }, [q]);

  const pick = (name) => { setQ(''); setOpts([]); onPick(name); };

  return (
    <div className="ac">
      <input
        type="search" value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, opts.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && opts[hl]) { e.preventDefault(); pick(opts[hl]); }
          else if (e.key === 'Escape') setOpts([]);
        }}
      />
      {opts.length > 0 && (
        <ul>
          {opts.map((o, i) => (
            <li key={o} className={i === hl ? 'hl' : ''} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>{o}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Floating card image that follows the cursor while hovering a row. */
export function useHoverPreview(width = 244) {
  const [state, setState] = useState(null);
  const height = Math.round(width * 1.395);
  const clear = useCallback(() => setState(null), []);
  const bind = (img) => ({
    onMouseEnter: (e) => img && setState({ img, x: e.clientX, y: e.clientY }),
    onMouseMove: (e) => img && setState({ img, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setState(null),
  });
  const el = state && (
    <img
      className="hover-preview" src={state.img} alt=""
      style={{
        width,
        // Right of the cursor, or left of it when there's no room.
        left: state.x + 24 + width < window.innerWidth ? state.x + 24 : Math.max(8, state.x - width - 24),
        top: Math.max(8, Math.min(state.y - height / 2, window.innerHeight - height - 8)),
      }}
    />
  );
  return [bind, el, clear];
}
