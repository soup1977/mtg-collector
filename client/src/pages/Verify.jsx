import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import ScanPile from './ScanPile.jsx';

const FINISH = { nonfoil: 'Normal', foil: 'Foil', etched: 'Etched' };
const isBasic = (t) => /Basic Land/.test(t || '');

function StatusDot({ s }) {
  if (s === 'confirmed') return <span className="vdot ok" title="Confirmed">✓</span>;
  if (s === 'missing') return <span className="vdot bad" title="Missing / proxy">✕</span>;
  return <span className="vdot" title="Not verified" />;
}

export default function Verify({ onChange }) {
  const { id } = useParams();
  const [deck, setDeck] = useState(null);
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('verifyMode') || 'scan'; } catch { return 'scan'; }
  });
  const switchMode = (m) => {
    setMode(m);
    try { localStorage.setItem('verifyMode', m); } catch { /* ignore */ }
  };
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [currentId, setCurrentId] = useState(null);
  const [opts, setOpts] = useState(null);
  const [allPrints, setAllPrints] = useState(null);
  const [loadingPrints, setLoadingPrints] = useState(false);
  const [sel, setSel] = useState(null); // { scryfall_id, finish }
  const [quick, setQuick] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const quickRef = useRef();

  const loadDeck = useCallback(() => api.get(`/api/decks/${id}`).then((d) => { setDeck(d); return d; }), [id]);
  useEffect(() => { loadDeck(); }, [loadDeck]);

  const cards = useMemo(() => (deck?.cards || []).filter((c) => c.board !== 'considering' && !isBasic(c.type_line)), [deck]);
  const queue = useMemo(() => (onlyOpen ? cards.filter((c) => !c.verify_status) : cards), [cards, onlyOpen]);
  const done = cards.filter((c) => c.verify_status).length;

  // Pick the first card in the queue when nothing is selected (or the selection left the queue).
  useEffect(() => {
    if (!deck) return;
    if (!currentId || !cards.some((c) => c.id === currentId)) setCurrentId(queue[0]?.id ?? null);
  }, [deck, queue, cards, currentId]);

  const current = cards.find((c) => c.id === currentId);

  // Load options for the current card and choose a sensible default printing.
  useEffect(() => {
    if (!currentId) { setOpts(null); return; }
    setOpts(null); setAllPrints(null); setQuick(''); setMsg((m) => (m?.sticky ? { ...m, sticky: false } : null));
    api.get(`/api/decks/${id}/cards/${currentId}/verify`).then((o) => {
      setOpts(o);
      const c = o.card;
      const listed = o.printings.find((p) => p.scryfall_id === c.scryfall_id);
      const pick = (c.verify_status === 'confirmed' && listed)
        || (listed && listed.free >= c.quantity && listed)
        || o.printings.find((p) => p.free >= c.quantity)
        || listed || o.printings[0];
      setSel(pick ? {
        scryfall_id: pick.scryfall_id,
        finish: c.finish || pick.owned_finishes?.[0]?.finish || FINISH[pick.finishes[0]] || 'Normal',
      } : null);
      setTimeout(() => quickRef.current?.focus(), 0);
    });
  }, [id, currentId]);

  const goNext = useCallback((fromId = currentId) => {
    const idx = queue.findIndex((c) => c.id === fromId);
    const next = queue.slice(idx + 1).find((c) => !c.verify_status || !onlyOpen) || queue.find((c) => c.id !== fromId && !c.verify_status);
    setCurrentId(next?.id ?? null);
  }, [queue, currentId, onlyOpen]);

  const goPrev = () => {
    const idx = cards.findIndex((c) => c.id === currentId);
    if (idx > 0) setCurrentId(cards[idx - 1].id);
  };

  const busyRef = useRef(false);
  const act = async (body) => {
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await api.post(`/api/decks/${id}/cards/${current.id}/verify`, body);
      const name = current.name;
      setMsg({
        ok: true, sticky: true,
        text: r.status === 'confirmed'
          ? `✓ ${name}: ${r.printing} ${r.finish}${r.added ? `, added ${r.added} to collection` : ''}`
          : r.status === 'missing' ? `✕ ${name} marked missing` : `${name} reset`,
      });
      const fromId = current.id;
      await loadDeck();
      onChange?.();
      if (body.action !== 'reset') goNext(fromId);
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally { busyRef.current = false; setBusy(false); }
  };

  const loadAll = async () => {
    setLoadingPrints(true);
    try { setAllPrints(await api.get(`/api/cards/${current.oracle_id}/prints`)); }
    finally { setLoadingPrints(false); }
  };

  // Keyboard: 1-9 choose owned printing, Enter confirm, M missing, S/→ skip, ← back.
  useEffect(() => {
    const onKey = (e) => {
      if (mode !== 'cards') return;
      const inInput = e.target.tagName === 'INPUT';
      if (inInput && e.key !== 'Enter') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter') {
        if (inInput && quick.trim()) return; // the quick-entry form handles its own submit
        if (sel) { e.preventDefault(); act({ action: 'confirm', scryfall_id: sel.scryfall_id, finish: sel.finish }); }
      } else if (e.key === 'm' || e.key === 'M') act({ action: 'missing' });
      else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (/^[1-9]$/.test(e.key) && opts) {
        const p = opts.printings[Number(e.key) - 1];
        if (p) setSel({ scryfall_id: p.scryfall_id, finish: p.owned_finishes?.[0]?.finish || FINISH[p.finishes[0]] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!deck) return <p className="muted">Loading…</p>;

  const pct = cards.length ? Math.round((done / cards.length) * 100) : 0;
  const allOpts = opts ? [...opts.printings, ...(allPrints || []).filter((p) => !opts.printings.some((o) => o.scryfall_id === p.scryfall_id))] : [];
  const selP = allOpts.find((p) => p.scryfall_id === sel?.scryfall_id);
  const free = selP?.free ?? 0;
  const willAdd = current && selP ? Math.max(0, current.quantity - Math.max(free, 0)) : 0;

  return (
    <>
      <p className="small"><Link to={`/decks/${id}`}>← {deck.name}</Link></p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>Verify {deck.name}</h1>
        <div className="seg">
          <button className={mode === 'scan' ? 'on' : ''} onClick={() => switchMode('scan')}>Scan pile</button>
          <button className={mode === 'cards' ? 'on' : ''} onClick={() => switchMode('cards')}>Card by card</button>
        </div>
      </div>
      {mode === 'scan' ? <ScanPile deck={deck} reload={loadDeck} onChange={onChange} /> : <>
      <p className="muted" style={{ marginTop: 0 }}>
        Go through the physical deck. Pick the printing you actually have, or type its set code and number.
        Confirming a printing you don't have logged adds it to your collection.
      </p>

      <div className="progress"><div style={{ width: `${pct}%` }} /></div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <b>{done} / {cards.length} verified</b>
        <span className="muted small">basic lands skipped</span>
        <label className="check" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Unverified only
        </label>
      </div>
      {msg && <p className={msg.ok ? 'flash ok' : 'flash bad'}>{msg.text}</p>}

      <div className="verify">
        <aside className="vlist">
          {cards.map((c) => (
            <button key={c.id} className={`vitem ${c.id === currentId ? 'on' : ''}`} onClick={() => setCurrentId(c.id)}>
              <StatusDot s={c.verify_status} />
              <span className="vname">{c.name}</span>
              {c.quantity > 1 && <span className="muted small">×{c.quantity}</span>}
            </button>
          ))}
        </aside>

        {!current ? (
          <div className="panel empty">
            <h2>All done 🎉</h2>
            <p>Every non-basic card in {deck.name} is verified.</p>
            <p><Link to={`/decks/${id}`}>Back to deck</Link> · <Link to="/changes">Review collection changes</Link></p>
          </div>
        ) : (
          <div className="vmain">
            <div className="vart">
              {selP?.image_normal || current.image_normal
                ? <img src={selP?.image_normal || current.image_normal} alt={current.name} />
                : null}
            </div>
            <div>
              <h2 style={{ marginTop: 0 }}>
                {current.quantity > 1 && <span className="muted">{current.quantity}× </span>}
                <Link to={`/card/${current.oracle_id}`}>{current.name}</Link>
              </h2>
              <p className="small muted" style={{ marginTop: -6 }}>
                Deck lists {current.set_code.toUpperCase()} #{current.collector_number}
                {current.category && <> · {current.category}</>}
                {current.verify_status && <> · <b>{current.verify_status}</b>{current.finish && ` (${current.finish})`}</>}
              </p>

              <form onSubmit={(e) => { e.preventDefault(); if (quick.trim()) act({ quick }); }} className="quick">
                <input
                  ref={quickRef} value={quick} onChange={(e) => setQuick(e.target.value)}
                  placeholder="Quick: set number [f|e], e.g. dsc 94 f"
                  autoComplete="off" spellCheck={false}
                />
                <button disabled={!quick.trim() || busy}>Confirm</button>
              </form>

              {!opts ? <p className="muted">Loading printings…</p> : (
                <>
                  <h3>Printings you own</h3>
                  {opts.printings.filter((p) => p.owned > 0).length === 0 && (
                    <p className="muted small">You don't have any printing of this card logged.</p>
                  )}
                  <div className="ptiles">
                    {opts.printings.map((p, i) => (
                      <PrintTile
                        key={p.scryfall_id} p={p} n={i + 1} sel={sel} setSel={setSel}
                        listed={p.scryfall_id === current.scryfall_id} need={current.quantity}
                      />
                    ))}
                  </div>
                  {!allPrints && (
                    <button onClick={loadAll} disabled={loadingPrints} style={{ marginTop: 8 }}>
                      {loadingPrints ? 'Loading…' : 'Show all printings'}
                    </button>
                  )}
                  {allPrints && (
                    <>
                      <h3>Other printings</h3>
                      <div className="ptiles">
                        {allOpts.filter((p) => !opts.printings.some((o) => o.scryfall_id === p.scryfall_id)).map((p) => (
                          <PrintTile key={p.scryfall_id} p={p} sel={sel} setSel={setSel} need={current.quantity} />
                        ))}
                      </div>
                    </>
                  )}

                  {selP && (
                    <div className="finishes">
                      <span className="muted small">Finish:</span>
                      {(selP.finishes || ['nonfoil']).map((f) => (
                        <button
                          key={f} className={sel.finish === FINISH[f] ? 'on' : ''}
                          onClick={() => setSel({ ...sel, finish: FINISH[f] })}
                        >{FINISH[f]}</button>
                      ))}
                    </div>
                  )}

                  <div className="vactions">
                    <button
                      className="primary" disabled={!sel || busy}
                      onClick={() => act({ action: 'confirm', scryfall_id: sel.scryfall_id, finish: sel.finish })}
                    >
                      {willAdd > 0 ? `Confirm + add ${willAdd} to collection` : 'Confirm, I have this'} <kbd>↵</kbd>
                    </button>
                    <button className="danger" disabled={busy} onClick={() => act({ action: 'missing' })}>Missing / proxy <kbd>M</kbd></button>
                    <button onClick={() => goNext()}>Skip <kbd>S</kbd></button>
                    {current.verify_status && <button onClick={() => act({ action: 'reset' })}>Reset</button>}
                  </div>
                  {selP && willAdd > 0 && selP.claims?.length > 0 && (
                    <p className="notice small">
                      Your {selP.owned} cop{selP.owned === 1 ? 'y' : 'ies'} of this printing {selP.owned === 1 ? 'is' : 'are'} already
                      claimed by {selP.claims.map((c) => c.deck).join(', ')}. Confirming adds another copy, so make sure that's right.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      </>}
    </>
  );
}

function PrintTile({ p, n, sel, setSel, listed, need }) {
  const on = sel?.scryfall_id === p.scryfall_id;
  const pick = () => setSel({ scryfall_id: p.scryfall_id, finish: p.owned_finishes?.[0]?.finish || FINISH[(p.finishes || ['nonfoil'])[0]] });
  return (
    <button className={`ptile ${on ? 'on' : ''}`} onClick={pick} title={p.set_name}>
      {p.image_normal && <img src={p.image_normal} alt="" loading="lazy" />}
      <div className="pmeta">
        {n && <kbd>{n}</kbd>}
        <b>{p.set_code.toUpperCase()}</b> #{p.collector_number}
      </div>
      <div className="pbadges">
        {listed && <span className="badge plain">deck lists</span>}
        {p.owned > 0 && (
          <span className={`badge ${p.free >= need ? 'ok' : 'warn'}`}
            title={p.claims?.length ? `Claimed by ${p.claims.map((c) => `${c.deck} (${c.quantity})`).join(', ')}` : ''}>
            own {p.owned}{p.claimed ? ` · ${Math.max(p.free, 0)} free` : ''}
          </span>
        )}
        {p.owned_finishes?.filter((f) => f.finish !== 'Normal').map((f) => (
          <span key={f.finish} className="badge plain">{f.finish} ×{f.quantity}</span>
        ))}
      </div>
    </button>
  );
}
