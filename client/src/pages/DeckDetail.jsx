import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { CardSearch, ManaCost, useHoverPreview } from '../components/bits.jsx';
import { Price, countable, money, unitPrice, useSettings } from '../prices.jsx';
import SwapDialog from '../components/SwapDialog.jsx';

const FORMATS = {
  commander: 'Commander', standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern',
  legacy: 'Legacy', pauper: 'Pauper', casual: 'Casual (no checks)',
};

/**
 * Deck search: card name ("plague"), set and number ("som 75", or "som 7" while typing),
 * or a set code alone ("som") for every card from that set.
 */
export function matchesSearch(c, raw) {
  const q = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/#/g, '');
  if (!q) return true;
  if (c.name.toLowerCase().includes(q)) return true;
  const code = `${c.set_code} ${c.collector_number}`.toLowerCase();
  return code === q || code.startsWith(q.includes(' ') ? q : `${q} `);
}

function Status({ c, archived }) {
  const basic = /Basic Land/.test(c.type_line || '');
  if (basic) return <span className="badge plain">basic</span>;
  if (archived) {
    // Dissolved deck: nothing is claimed; just say whether you still have it and where else it's used.
    if (c.owned === 0) return <span className="badge plain">not owned</span>;
    return c.deck_count > 0
      ? <span className="badge decks" title="Copies are now used by other decks">own {c.owned} · in {c.deck_count} deck{c.deck_count === 1 ? '' : 's'}</span>
      : <span className="badge ok">own {c.owned} · free</span>;
  }
  if (c.verify_status === 'missing') return <span className="badge short" title="You marked this missing / proxy">✕ missing</span>;
  if (c.verify_status === 'confirmed') {
    if (c.printing_claimed > c.printing_owned) {
      return <span className="badge warn" title={`Decks claim ${c.printing_claimed} of this printing, you own ${c.printing_owned}`}>
        ✓ confirmed · {c.printing_owned === 0 ? 'not in collection' : 'over-claimed'}</span>;
    }
    return <span className="badge ok" title={`Verified ${c.verified_at?.slice(0, 10) || ''}`}>✓ confirmed{c.finish && c.finish !== 'Normal' ? ` · ${c.finish}` : ''}</span>;
  }
  if (c.owned === 0) return <span className="badge short">not owned</span>;
  if (c.shortfall > 0) {
    return <span className="badge warn" title={`You own ${c.owned}; your decks use ${c.needed} across ${c.deck_count} decks`}>
      short {c.shortfall} · shared</span>;
  }
  return <span className="badge ok" title={`Own ${c.owned}, decks need ${c.needed}`}>owned{!c.own_listed_printing ? ' · other printing' : ''}</span>;
}

export default function DeckDetail({ onChange }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [deck, setDeck] = useState(null);
  const [err, setErr] = useState(null);
  const [addCat, setAddCat] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [fix, setFix] = useState(null);
  const [search, setSearch] = useState('');
  const [restored, setRestored] = useState(null);
  const settings = useSettings();
  const [hover, preview] = useHoverPreview();
  const [incoming, setIncoming] = useState(null); // card being added, waiting on the swap dialog
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => Promise.all([
    api.get(`/api/decks/${id}`).then(setDeck),
    api.get(`/api/decks/${id}/history`).then(setHistory),
  ]).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  const mutate = async (fn) => {
    setErr(null);
    try { await fn(); await load(); onChange?.(); } catch (e) { setErr(e.message); }
  };

  // The main deck is what counts; Considering is a maybe list shown separately.
  const mainCards = useMemo(() => (deck?.cards || []).filter((c) => c.board !== 'considering'), [deck]);
  const consideringCards = useMemo(() => (deck?.cards || []).filter((c) => c.board === 'considering' && matchesSearch(c, search)), [deck, search]);
  const shown = useMemo(() => mainCards.filter((c) => matchesSearch(c, search)), [mainCards, search]);

  const groups = useMemo(() => {
    const m = new Map();
    for (const c of shown) {
      const k = c.is_commander ? 'Commander' : c.category || 'Uncategorized';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(c);
    }
    return [...m.entries()];
  }, [shown]);

  const categories = useMemo(() => [...new Set((deck?.cards || []).map((c) => c.category).filter(Boolean))].sort(), [deck]);

  if (err && !deck) return <p className="error">{err}</p>;
  if (!deck) return <p className="muted">Loading…</p>;

  const total = mainCards.reduce((s, c) => s + c.quantity, 0);
  const verifiable = mainCards.filter((c) => !/Basic Land/.test(c.type_line || ''));
  const verified = verifiable.filter((c) => c.verify_status).length;
  const autofix = () => mutate(async () => setFix(await api.post(`/api/decks/${id}/autofix`)));
  const missing = mainCards.filter((c) => c.shortfall > 0 && !/Basic Land/.test(c.type_line || ''));
  const priceOf = (c) => unitPrice(c.prices, c.finish || 'Normal');
  const costToComplete = missing.reduce((s, c) => s + Math.min(c.shortfall, c.quantity) * countable(priceOf(c), settings), 0);
  const deckValue = mainCards.reduce((s, c) => s + c.quantity * countable(priceOf(c), settings), 0);

  // Adding a card asks whether it's a swap, a Considering card, or a plain add.
  const addCard = async (name) => {
    setErr(null);
    try {
      const card = await api.get(`/api/cards/lookup?name=${encodeURIComponent(name)}`);
      const info = await api.get(`/api/cards/${card.oracle_id}`);
      setIncoming({ name: card.name, scryfall_id: card.scryfall_id, type_line: info.type_line, image: info.image });
    } catch (e) { setErr(e.message); }
  };
  const finishAdd = async ({ mode, out_card_id, outTo, replaces_oracle_id }) => {
    setAdding(true);
    await mutate(() => (mode === 'swap'
      ? api.post(`/api/decks/${id}/swap`, { scryfall_id: incoming.scryfall_id, out_card_id, outTo })
      : api.post(`/api/decks/${id}/cards`, {
        scryfall_id: incoming.scryfall_id, quantity: 1, replaces_oracle_id: mode === 'considering' ? replaces_oracle_id || null : null,
        category: mode === 'add' ? addCat || null : null, board: mode === 'considering' ? 'considering' : 'main',
      })));
    setAdding(false);
    setIncoming(null);
  };
  // Per-card flags from validation problems (off-color, duplicate, banned, not legal).
  const FLAG_TEXT = { color: 'off-color', duplicates: 'dup', banned: 'banned', not_legal: 'not legal' };
  const flags = new Map();
  for (const i of deck.issues || []) {
    if (!FLAG_TEXT[i.code]) continue;
    for (const c of i.cards) {
      for (const rowId of c.ids || [c.id]) {
        flags.set(rowId, [...(flags.get(rowId) || []), { code: i.code, text: FLAG_TEXT[i.code], title: i.message }]);
      }
    }
  }
  const moveTo = (c, board) => mutate(() => api.patch(`/api/decks/${id}/cards/${c.id}`, { board }));
  const setReplaces = (c, oracleId) => mutate(() => api.patch(`/api/decks/${id}/cards/${c.id}`, { replaces_oracle_id: oracleId }));
  const swapIn = (c) => mutate(() => api.post(`/api/decks/${id}/cards/${c.id}/swap-in`, { outTo: 'considering' }));
  // Main-deck cards that could be replaced (one entry per card), and which Considering cards target each.
  const replaceOptions = [...new Map(mainCards.filter((m) => !m.is_commander).map((m) => [m.oracle_id, m])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const challengers = new Map();
  for (const c of deck.cards.filter((x) => x.board === 'considering' && x.replaces_oracle_id)) {
    challengers.set(c.replaces_oracle_id, [...(challengers.get(c.replaces_oracle_id) || []), c.name]);
  }
  const setQty = (c, q) => mutate(() => api.patch(`/api/decks/${id}/cards/${c.id}`, { quantity: q }));
  const setCat = (c, category) => mutate(() => api.patch(`/api/decks/${id}/cards/${c.id}`, { category }));
  const remove = (c) => mutate(() => api.del(`/api/decks/${id}/cards/${c.id}`));
  const rename = (name) => mutate(async () => { await api.patch(`/api/decks/${id}`, { name }); setEditingName(false); });
  const delDeck = async () => {
    if (!confirm(`Permanently delete deck "${deck.name}"? The cards stay in your collection, but the list is gone for good.`)) return;
    await api.del(`/api/decks/${id}`);
    onChange?.();
    navigate('/decks');
  };
  const archived = Boolean(deck.archived_at);
  const dissolve = () => {
    if (!confirm(`Dissolve "${deck.name}"? Its cards stay in your collection and stop counting as used. The list is kept under Archived, and you can restore it later.`)) return;
    mutate(async () => { await api.post(`/api/decks/${id}/archive`); setRestored(null); });
  };
  const restore = () => mutate(async () => setRestored(await api.post(`/api/decks/${id}/restore`)));

  return (
    <>
      <p className="small"><Link to="/decks">← Decks</Link></p>
      {editingName ? (
        <form onSubmit={(e) => { e.preventDefault(); rename(e.target.elements.n.value); }} className="toolbar" style={{ margin: 0 }}>
          <input name="n" defaultValue={deck.name} autoFocus />
          <button className="primary">Save</button>
          <button type="button" onClick={() => setEditingName(false)}>Cancel</button>
        </form>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
          <h1 style={{ margin: 0 }}>{deck.name} <button className="icon small" onClick={() => setEditingName(true)} title="Rename">✎</button></h1>
          <select value={deck.format || 'commander'} title="Format: decides which deck rules are checked"
            onChange={(e) => mutate(() => api.patch(`/api/decks/${id}`, { format: e.target.value }))}>
            {Object.entries(FORMATS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
      )}

      {restored && (
        <div className={restored.conflicts.length ? 'notice small' : 'flash ok'} style={{ marginBottom: 12 }}>
          Deck restored.
          {restored.conflicts.length > 0 ? <>
            {' '}{restored.conflicts.length} card(s) are now short because other decks use them too:{' '}
            {restored.conflicts.map((c, i) => <span key={c.oracle_id}>{i > 0 && ', '}<Link to={`/card/${c.oracle_id}`}>{c.name}</Link> (own {c.owned}, {c.deck_count} decks)</span>)}
          </> : ' No conflicts with your other decks.'}
          {' '}<button className="icon small" onClick={() => setRestored(null)}>dismiss</button>
        </div>
      )}

      {archived ? (
        <div className="notice archived-banner">
          <div>
            <b>Dissolved {deck.archived_at.slice(0, 10)}.</b> These cards are free in your collection and don't count as used.
            The list is kept so you can bring the deck back.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" onClick={restore}>Restore deck</button>
            <button className="danger" onClick={delDeck}>Delete permanently</button>
          </div>
        </div>
      ) : <>
      <div className="summary">
        <div className="stat"><div className="v">{total}</div><div className="l">Cards</div></div>
        <div className={`stat ${missing.length ? 'bad' : ''}`}><div className="v">{missing.length}</div><div className="l" title="Cards your collection doesn't have enough copies of">Missing copies</div></div>
        <div className="stat" title={settings?.excludeBulk ? `Bulk under ${money(settings.bulkThreshold)} not counted` : ''}>
          <div className="v">{money(deckValue)}</div><div className="l">Deck value</div>
        </div>
        <div className="stat" title={settings?.excludeBulk ? `Bulk under ${money(settings.bulkThreshold)} not counted` : ''}>
          <div className="v">{money(costToComplete)}</div><div className="l">To complete (est.)</div>
        </div>
        <div className="stat">
          <div className="v">{verified}<span className="muted" style={{ fontSize: 15 }}> / {verifiable.length}</span></div>
          <div className="l">Verified</div>
        </div>
      </div>

      {deck.issues?.length > 0 && (
        <div className="panel problems">
          <h3>⚠ Problems ({deck.issues.length})</h3>
          <ul>
            {deck.issues.map((i) => (
              <li key={i.code}>
                <b>{i.label}.</b> {i.message}{' '}
                <span className="cardlinks">
                  {i.cards.map((c, k) => (
                    <span key={c.oracle_id + k}>{k > 0 && ', '}
                      <Link to={`/card/${c.oracle_id}`}>{c.name}</Link>{c.detail && <span className="muted"> ({c.detail})</span>}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="toolbar">
        <Link to={`/decks/${id}/verify`}><button className="primary">{verified === 0 ? 'Verify deck' : verified < verifiable.length ? 'Continue verifying' : 'Review verification'}</button></Link>
        <button onClick={autofix} title="Switch unverified cards to the printing you own, when you own exactly one with a free copy">Auto-fix printings</button>
      </div>
      {fix && (
        <div className="notice small" style={{ marginBottom: 12 }}>
          {fix.switched.length === 0 ? 'Nothing to auto-fix.' : <>Switched {fix.switched.length} card(s) to printings you own: {fix.switched.map((s) => `${s.name} (${s.from} → ${s.to})`).join(', ')}.</>}
          {fix.ambiguous.length > 0 && <> You own several printings of {fix.ambiguous.map((a) => a.name).join(', ')}; pick those in Verify.</>}
          {' '}<button className="icon small" onClick={() => setFix(null)}>dismiss</button>
        </div>
      )}

      <div className="toolbar">
        <CardSearch onPick={addCard} placeholder="Add a card to this deck…" />
        <input list="deck-cats" placeholder="Category (optional)" value={addCat} onChange={(e) => setAddCat(e.target.value)} />
        <datalist id="deck-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={dissolve} title="Free these cards in your collection but keep the list, so you can restore it">Dissolve deck</button>
          <button className="danger" onClick={delDeck}>Delete deck</button>
        </span>
      </div>
      </>}
      {err && <p className="error">{err}</p>}

      <div className="toolbar" style={{ marginTop: 0 }}>
        <input
          type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this deck: name, or set number (som 75)" style={{ flex: '1 1 280px', maxWidth: 420 }}
        />
        {search.trim() && (
          <span className="muted small">
            {shown.length === 0 ? 'No cards match' : `${shown.reduce((s, c) => s + c.quantity, 0)} of ${total} cards`}
          </span>
        )}
      </div>

      {groups.map(([cat, cards]) => (
        <div key={cat} className="cat-group">
          <h3>{cat} <span className="muted">({cards.reduce((s, c) => s + c.quantity, 0)})</span></h3>
          <table className="deck-table">
            <colgroup>
              <col className="c-qty" /><col /><col className="c-cost hide-sm" /><col className="c-set hide-sm" />
              <col className="c-decks" /><col className="c-own" /><col className="c-price" /><col className="c-status" /><col className="c-cat hide-sm" /><col className="c-del" />
            </colgroup>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} {...hover(c.image_normal)}>
                  <td>
                    <span className="qty-ctl">
                      <button className="icon" onClick={() => setQty(c, c.quantity - 1)} title="Remove one">−</button>
                      <span>{c.quantity}</span>
                      <button className="icon" onClick={() => setQty(c, c.quantity + 1)} title="Add one">+</button>
                    </span>
                  </td>
                  <td>
                    {flags.get(c.id)?.map((f) => <span key={f.code} className="badge short flag" title={f.title}>{f.text}</span>)}
                    <Link to={`/card/${c.oracle_id}`}><b>{c.name}</b></Link>
                    {challengers.get(c.oracle_id) && (
                      <span className="badge warn challenger" title={`Considering replacing this with ${challengers.get(c.oracle_id).join(' or ')}`}>
                        ↔ {challengers.get(c.oracle_id).join(' / ')}?
                      </span>
                    )}
                  </td>
                  <td className="hide-sm"><ManaCost cost={c.mana_cost} /></td>
                  <td className="hide-sm small muted">{c.set_code.toUpperCase()} #{c.collector_number}</td>
                  <td className="small">
                    {c.deck_count > (archived ? 0 : 1)
                      ? <Link to={`/card/${c.oracle_id}`} className="badge decks" title="See which decks">in {c.deck_count} decks</Link>
                      : null}
                  </td>
                  <td className="num"><span className="muted small">own {c.owned}</span></td>
                  <td className="num small"><Price value={priceOf(c)} /></td>
                  <td><Status c={c} archived={archived} /></td>
                  <td className="hide-sm">
                    <input
                      list="deck-cats" defaultValue={c.category || ''} placeholder="category"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                      onBlur={(e) => { if (e.target.value !== (c.category || '')) setCat(c, e.target.value); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                    />
                  </td>
                  <td className="row-actions">
                    {!archived && <button className="icon small" onClick={() => moveTo(c, 'considering')} title="Move to Considering (stops counting as part of the deck)">⇣</button>}
                    <button className="icon danger" onClick={() => remove(c)} title="Remove from deck">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {mainCards.length === 0 && <div className="empty">This deck is empty. Add cards above.</div>}

      {consideringCards.length > 0 && (
        <div className="cat-group">
          <h3>Considering <span className="muted">({consideringCards.reduce((s, c) => s + c.quantity, 0)}) · not part of the deck</span></h3>
          <table className="deck-table considering-table">
            <colgroup>
              <col className="c-qty" /><col /><col className="c-cost hide-sm" /><col className="c-set hide-sm" />
              <col className="c-own" /><col className="c-price" /><col className="c-status" /><col className="c-del-wide" />
            </colgroup>
            <tbody>
              {consideringCards.map((c) => (
                <tr key={c.id} {...hover(c.image_normal)}>
                  <td className="muted">{c.quantity}×</td>
                  <td className="considering-name">
                    <Link to={`/card/${c.oracle_id}`}><b>{c.name}</b></Link>
                    <div className="small replaces">
                      <span className="muted">would replace</span>{' '}
                      <select
                        value={c.replaces_oracle_id || ''} disabled={archived}
                        onChange={(e) => setReplaces(c, e.target.value || null)}
                        className={c.replaces_oracle_id && !c.replaces_in_deck ? 'stale' : ''}
                      >
                        <option value="">nothing yet</option>
                        {c.replaces_oracle_id && !c.replaces_in_deck && (
                          <option value={c.replaces_oracle_id}>{c.replaces_name} (no longer in deck)</option>
                        )}
                        {replaceOptions.map((m) => <option key={m.oracle_id} value={m.oracle_id}>{m.name}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="hide-sm"><ManaCost cost={c.mana_cost} /></td>
                  <td className="hide-sm small muted">{c.set_code.toUpperCase()} #{c.collector_number}</td>
                  <td className="num"><span className="muted small">own {c.owned}</span></td>
                  <td className="num small"><Price value={priceOf(c)} /></td>
                  <td>
                    {c.owned === 0 ? <span className="badge plain">not owned</span>
                      : c.deck_count > 0 ? <span className="badge decks">own {c.owned} · in {c.deck_count} deck{c.deck_count === 1 ? '' : 's'}</span>
                      : <span className="badge ok">own {c.owned} · free</span>}
                  </td>
                  <td className="row-actions">
                    {!archived && c.replaces_in_deck ? (
                      <button className="icon small primary" onClick={() => swapIn(c)}
                        title={`Swap ${c.name} in for ${c.replaces_name} (${c.replaces_name} moves to Considering)`}>⇄ Swap in</button>
                    ) : null}
                    {!archived && <button className="icon small" onClick={() => moveTo(c, 'main')} title="Add to the deck without replacing anything">⇡</button>}
                    <button className="icon danger" onClick={() => remove(c)} title="Remove from Considering">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 && (
        <div className="cat-group">
          <h3 style={{ cursor: 'pointer' }} onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? '▾' : '▸'} History <span className="muted">({history.length})</span>
          </h3>
          {showHistory && (
            <ul className="history panel">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="when">{h.at.slice(0, 10)}</span>
                  <span>
                    {h.action === 'swap' && <>Swapped in <b>{h.card_in}</b> for <b>{h.card_out}</b></>}
                    {h.action === 'add' && <>Added <b>{h.card_in}</b></>}
                    {h.action === 'remove' && <>Removed <b>{h.card_out}</b></>}
                    {h.action === 'to_considering' && <><b>{h.card_in}</b> → Considering</>}
                    {h.action === 'to_main' && <><b>{h.card_in}</b> moved into the deck</>}
                    {h.detail && !['added', 'added to Considering'].includes(h.detail) && <span className="muted"> · {h.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {incoming && (
        <SwapDialog
          incoming={incoming} cards={mainCards} defaultCategory={addCat} busy={adding}
          onSubmit={finishAdd} onCancel={() => setIncoming(null)}
        />
      )}
      {preview}
    </>
  );
}
