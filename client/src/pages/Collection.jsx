import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { UsageBadges, ManaCost, useHoverPreview } from '../components/bits.jsx';
import { Price, money, useSettings } from '../prices.jsx';

const PAGE = 120;
const TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Battle', 'Legendary'];

export default function Collection({ stats }) {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [limit, setLimit] = useState(PAGE);
  const [qInput, setQInput] = useState(params.get('q') || '');
  const navigate = useNavigate();
  const [hover, preview] = useHoverPreview();

  const view = params.get('view') || 'grid';
  const color = params.get('color') || '';
  const set = (k, v) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };

  // debounce text search into the URL
  useEffect(() => {
    const t = setTimeout(() => { if ((params.get('q') || '') !== qInput) set('q', qInput); }, 200);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useMemo(() => {
    const p = new URLSearchParams(params);
    p.delete('view');
    if (!p.get('scope')) p.set('scope', 'owned');
    return p.toString();
  }, [params]);

  const settings = useSettings();
  useEffect(() => {
    setLimit(PAGE);
    api.get(`/api/collection?${query}`).then(setData);
  }, [query, settings?.bulkThreshold, settings?.excludeBulk, settings?.pricesRefreshedAt]);

  const toggleColor = (c) => set('color', color.includes(c) ? color.replace(c, '') : color + c);

  if (stats && stats.rows === 0) {
    return <div className="empty"><h2>Your collection is empty</h2><p><Link to="/import">Import your Archidekt collection CSV</Link> to get started.</p></div>;
  }

  const cards = data?.cards || [];

  return (
    <>
      <h1>Collection</h1>
      <div className="toolbar">
        <input type="search" placeholder="Search by name…" value={qInput} onChange={(e) => setQInput(e.target.value)} />
        <div className="pips" title="Color identity includes">
          {'WUBRGC'.split('').map((c) => (
            <button key={c} className={`pip ${c} ${color.includes(c) ? 'on' : ''}`} onClick={() => toggleColor(c)}>{c}</button>
          ))}
        </div>
        <select value={params.get('type') || ''} onChange={(e) => set('type', e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={params.get('set') || ''} onChange={(e) => set('set', e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All sets</option>
          {stats?.sets.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.copies})</option>)}
        </select>
        <select value={params.get('sort') || 'name'} onChange={(e) => set('sort', e.target.value)}>
          <option value="name">Sort: Name</option>
          <option value="cmc">Sort: Mana value</option>
          <option value="owned">Sort: Most owned</option>
          <option value="decks">Sort: Most decks</option>
          <option value="shortfall">Sort: Shortfall</option>
          <option value="price">Sort: Price</option>
          <option value="value">Sort: Value owned</option>
        </select>
        <select value={params.get('scope') || 'owned'} onChange={(e) => set('scope', e.target.value === 'owned' ? '' : e.target.value)}>
          <option value="owned">Cards I own</option>
          <option value="decks">Cards in decks</option>
          <option value="all">Owned + in decks</option>
          <option value="considering">Considering for a deck</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={params.get('short') === '1'} onChange={(e) => set('short', e.target.checked ? '1' : '')} />
          Short only
        </label>
        <div className="seg" style={{ marginLeft: 'auto' }}>
          <button className={view === 'grid' ? 'on' : ''} onClick={() => set('view', '')}>Grid</button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => set('view', 'table')}>Table</button>
        </div>
      </div>

      <p className="muted small">
        {data ? <>
          {data.count.toLocaleString()} cards · {money(cards.reduce((s, c) => s + (c.value || 0), 0))}
          {settings?.excludeBulk && <> (bulk under {money(settings.bulkThreshold)} not counted)</>}
        </> : 'Loading…'}
      </p>

      {view === 'grid' ? (
        <div className="grid">
          {cards.slice(0, limit).map((c) => (
            <Link key={c.oracle_id} to={`/card/${c.oracle_id}`} className="tile">
              <div className="img-wrap">
                {c.image_normal ? <img loading="lazy" src={c.image_normal} alt={c.name} /> : <div className="noimg">{c.name}</div>}
                <span className="qty" title="Copies owned">×{c.owned}</span>
                <div className="overlay">
                  <UsageBadges owned={c.owned} needed={c.needed} deckCount={c.deck_count} shortfall={c.shortfall} />
                  {c.considering && <span className="badge warn" title={`Considered for ${c.considering}`}>considered: {c.considering}</span>}
                </div>
              </div>
              <div className="meta"><span className="name">{c.name}</span><Price value={c.price} className="price" /></div>
            </Link>
          ))}
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>Name</th><th className="hide-sm">Cost</th><th className="hide-sm">Type</th><th className="num">Owned</th><th className="num">Price</th><th className="num hide-sm">Value</th><th className="num">In decks</th><th></th></tr>
          </thead>
          <tbody>
            {cards.slice(0, limit).map((c) => (
              <tr key={c.oracle_id} className="clickable" onClick={() => navigate(`/card/${c.oracle_id}`)} {...hover(c.image_normal)}>
                <td><b>{c.name}</b></td>
                <td className="hide-sm"><ManaCost cost={c.mana_cost} /></td>
                <td className="hide-sm muted">{c.type_line}</td>
                <td className="num">{c.owned}</td>
                <td className="num"><Price value={c.price} /></td>
                <td className="num hide-sm">{c.value ? money(c.value) : <span className="muted">—</span>}</td>
                <td className="num">{c.needed ? `${c.needed} in ${c.deck_count}` : "—"}{c.considering && <div className="small" style={{ color: "var(--warn)" }}>considered: {c.considering}</div>}</td>
                <td>{c.shortfall > 0 && <span className="badge short">short {c.shortfall}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview}

      {cards.length > limit && (
        <p style={{ textAlign: 'center', marginTop: 20 }}>
          <button onClick={() => setLimit((l) => l + PAGE * 2)}>Show more ({(cards.length - limit).toLocaleString()} remaining)</button>
        </p>
      )}
    </>
  );
}
