import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useHoverPreview } from '../components/bits.jsx';

const isBasic = (t) => /Basic Land/.test(t || '');
const FINISH = { nonfoil: 'Normal', foil: 'Foil', etched: 'Etched' };
// "blc 283", "one 12 f", "plst LTR-123": short set code, then a token containing a digit.
const looksLikeCode = (t) => /^[a-z0-9]{2,6}\s+[^\s]*\d[^\s]*(\s+(f|e|n|nf|foil|etched|normal|nonfoil))?$/i.test(t.trim());

function Entry({ e, onUndo }) {
  const r = e.res;
  if (e.error) return <li className="scan bad"><span><b>{e.input}</b> {e.error}</span></li>;
  const name = <Link to={`/card/${r.card.oracle_id}`}><b>{r.card.name}</b></Link>;
  const undo = !e.undone && r.undo && <button className="icon small" onClick={onUndo}>Undo</button>;
  switch (r.result) {
    case 'confirmed':
      return (
        <li className={`scan ok ${e.undone ? 'undone' : ''}`}>
          <span>✓ {name} <span className="muted">{r.card.printing}</span>
            {r.switchedFrom && <span className="badge warn">deck listed {r.switchedFrom}, updated</span>}
            {r.added > 0 && <span className="badge decks">+{r.added} to collection</span>}
            {e.undone && <span className="badge plain">undone</span>}
          </span>{undo}
        </li>
      );
    case 'partial':
      return (
        <li className={`scan ok ${e.undone ? 'undone' : ''}`}>
          <span>✓ {name} <span className="muted">{r.card.printing}</span> <span className="badge plain">{r.scanned} of {r.quantity}</span>
            {e.undone && <span className="badge plain">undone</span>}</span>{undo}
        </li>
      );
    case 'duplicate':
      return <li className="scan warn"><span>⚠ {name} every copy is already scanned ({r.quantity}). Duplicate in the pile, or a typo?</span></li>;
    case 'basic':
      return <li className="scan muted-row"><span>{name} basic land, skipped</span></li>;
    case 'added_to_deck':
      return (
        <li className={`scan warn ${e.undone ? 'undone' : ''}`}>
          <span>
            + {name} <span className="muted">{r.card.printing}</span>
            <span className="badge warn">wasn't on the list, added to deck</span>
            {r.added > 0 && <span className="badge decks">+{r.added} to collection</span>}
            {r.otherDecks.length > 0 && (
              <span className="small">also listed in {r.otherDecks.map((d, i) => <span key={d.id}>{i > 0 && ', '}<Link to={`/decks/${d.id}`}>{d.name}</Link></span>)}</span>
            )}
            {e.undone && <span className="badge plain">undone</span>}
          </span>{undo}
        </li>
      );
    default:
      return null;
  }
}

export default function ScanPile({ deck, reload, onChange }) {
  const [text, setText] = useState('');
  const [feed, setFeed] = useState([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [hl, setHl] = useState(0);
  const [picker, setPicker] = useState(null); // { name, loading } | { name, printings, inDeck, need }
  const [sel, setSel] = useState(null);
  const busyRef = useRef(false);
  const pickerRef = useRef();
  const [hover, preview, clearPreview] = useHoverPreview(340);
  // The tile under the cursor unmounts when the picker closes, so no mouseleave fires: clear explicitly.
  useEffect(() => { if (!picker) clearPreview(); }, [picker, clearPreview]);
  const inputRef = useRef();
  useEffect(() => { inputRef.current?.focus(); }, []);

  const cards = deck.cards.filter((c) => c.board !== 'considering' && !isBasic(c.type_line));
  const remaining = cards.filter((c) => c.verify_status !== 'confirmed');
  const unscanned = cards.filter((c) => !c.verify_status);
  const done = cards.length - remaining.length;
  const pct = cards.length ? Math.round((100 * done) / cards.length) : 0;

  const isCode = looksLikeCode(text);

  // Name suggestions: this deck's cards first (unscanned before scanned), Scryfall if nothing matches.
  const [remote, setRemote] = useState([]);
  const localSugg = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (isCode || q.length < 2) return [];
    const seen = new Set();
    return cards
      .filter((c) => c.name.toLowerCase().includes(q) && !seen.has(c.oracle_id) && seen.add(c.oracle_id))
      .sort((a, b) => (!!a.verify_status - !!b.verify_status)
        || (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q))
        || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((c) => ({ name: c.name, oracle_id: c.oracle_id, status: c.verify_status, inDeck: true }));
  }, [text, isCode, cards]);
  useEffect(() => {
    setRemote([]);
    const q = text.trim();
    if (isCode || q.length < 3 || localSugg.length) return;
    const t = setTimeout(() => {
      api.get(`/api/cards/autocomplete?q=${encodeURIComponent(q)}`)
        .then((names) => setRemote(names.slice(0, 6).map((name) => ({ name }))))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [text, isCode, localSugg.length]);
  const sugg = localSugg.length ? localSugg : remote;
  useEffect(() => setHl(0), [text]);

  const submit = async (body, input) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    const key = Date.now();
    let ok = false;
    try {
      const res = await api.post(`/api/decks/${deck.id}/scan`, body);
      setFeed((f) => [{ key, input, res }, ...f]);
      setLast(res.card);
      ok = true;
      if (['confirmed', 'partial', 'added_to_deck'].includes(res.result)) { await reload(); onChange?.(); }
    } catch (err) {
      setFeed((f) => [{ key, input, error: err.message }, ...f]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    return ok;
  };

  const scan = async (e) => {
    e.preventDefault();
    const input = text.trim();
    if (!input) return;
    if (!isCode) {
      if (sugg[hl]) choose(sugg[hl]);
      return;
    }
    if (await submit({ quick: input }, input)) setText('');
    inputRef.current?.focus();
  };

  const choose = async (s) => {
    setText('');
    setPicker({ name: s.name, loading: true });
    try {
      const oracleId = s.oracle_id || (await api.get(`/api/cards/lookup?name=${encodeURIComponent(s.name)}`)).oracle_id;
      const opts = await api.get(`/api/decks/${deck.id}/scan/options?oracle_id=${oracleId}`);
      const need = Math.max(opts.quantity, 1);
      const pick = opts.printings.find((p) => p.owned > 0 && p.free >= need)
        || opts.printings.find((p) => p.listed) || opts.printings[0];
      setPicker({ name: s.name, ...opts, need });
      setSel(pick ? { scryfall_id: pick.scryfall_id, finish: pick.owned_finishes[0]?.finish || FINISH[pick.finishes[0]] } : null);
      setTimeout(() => pickerRef.current?.focus(), 0);
    } catch (err) {
      setPicker(null);
      setFeed((f) => [{ key: Date.now(), input: s.name, error: err.message }, ...f]);
      inputRef.current?.focus();
    }
  };

  const confirmPick = async () => {
    if (!sel || !picker) return;
    const p = picker.printings.find((x) => x.scryfall_id === sel.scryfall_id);
    await submit({ scryfall_id: sel.scryfall_id, finish: sel.finish }, `${picker.name} (${p.set_code.toUpperCase()})`);
    setPicker(null);
    inputRef.current?.focus();
  };

  const cancelPick = () => { setPicker(null); inputRef.current?.focus(); };

  const pickerKeys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelPick(); }
    else if (e.key === 'Enter') { e.preventDefault(); confirmPick(); }
    else if (/^[1-9]$/.test(e.key)) {
      const p = picker?.printings?.[Number(e.key) - 1];
      if (p) setSel({ scryfall_id: p.scryfall_id, finish: p.owned_finishes[0]?.finish || FINISH[p.finishes[0]] });
    } else if (e.key === 'f' || e.key === 'F') setSel((s) => s && { ...s, finish: s.finish === 'Foil' ? 'Normal' : 'Foil' });
  };

  const undo = async (entry) => {
    await api.post(`/api/decks/${deck.id}/scan/undo`, entry.res.undo);
    setFeed((f) => f.map((x) => (x.key === entry.key ? { ...x, undone: true } : x)));
    await reload(); onChange?.();
    inputRef.current?.focus();
  };

  const removeOne = async (c) => {
    await api.del(`/api/decks/${deck.id}/cards/${c.id}`);
    await reload(); onChange?.();
  };

  const finish = async (how) => {
    const msg = how === 'remove'
      ? `Remove all ${remaining.length} unconfirmed card(s) from ${deck.name}? (They were swapped out.)`
      : `Mark the ${unscanned.length} card(s) you didn't scan as missing? (They should be in the deck but you don't have them.)`;
    if (!confirm(msg)) return;
    await api.post(`/api/decks/${deck.id}/${how === 'remove' ? 'remove-unscanned' : 'mark-remaining-missing'}`);
    await reload(); onChange?.();
  };

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Pick up the next card from the pile and type the set code and collector number from the bottom of the card.
        Add <code>f</code> for foil or <code>e</code> for etched. Older card without a set code? Type its name and pick the printing by picture.
        The app finds the card in this deck and logs that copy in your collection.
      </p>
      <div className="progress"><div style={{ width: `${pct}%` }} /></div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <b>{done} / {cards.length} scanned</b>
        <span className="muted small">basic lands skipped</span>
      </div>

      <div className="scanwrap">
        <div>
          <form onSubmit={scan} className="quick big ac-wrap">
            <div className="ac" style={{ maxWidth: 'none' }}>
              <input
                ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="blc 283 · one 12 f · or a card name for older cards" autoComplete="off" spellCheck={false}
                disabled={!!picker}
                onKeyDown={(e) => {
                  if (!sugg.length) return;
                  if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, sugg.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
                  else if (e.key === 'Escape') setText('');
                }}
              />
              {!picker && sugg.length > 0 && (
                <ul>
                  {sugg.map((s, i) => (
                    <li key={s.name} className={i === hl ? 'hl' : ''} onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
                      {s.name}
                      {s.inDeck
                        ? s.status === 'confirmed' ? <span className="badge ok" style={{ marginLeft: 8 }}>scanned</span> : null
                        : <span className="badge plain" style={{ marginLeft: 8 }}>not in deck</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="primary" disabled={!text.trim() || busy || !!picker}>
              {busy ? '…' : isCode || !text.trim() ? 'Scan' : 'Find'}
            </button>
          </form>

          {picker && (
            <div className="panel picker" ref={pickerRef} tabIndex={-1} onKeyDown={pickerKeys}>
              <div className="picker-head">
                <h2 style={{ margin: 0 }}>Which printing of {picker.name}?</h2>
                {!picker.loading && !picker.inDeck && <span className="badge short">not in this deck</span>}
                <button className="icon" style={{ marginLeft: 'auto' }} onClick={cancelPick}>Cancel <kbd>Esc</kbd></button>
              </div>
              {picker.loading ? <p className="muted">Loading printings from Scryfall…</p> : (
                <>
                  <p className="small muted" style={{ margin: '4px 0 10px' }}>
                    Match the set symbol and art. Owned printings first, then every printing oldest to newest.
                  </p>
                  <div className="ptiles">
                    {picker.printings.map((p, i) => (
                      <button
                        key={p.scryfall_id} className={`ptile ${sel?.scryfall_id === p.scryfall_id ? 'on' : ''}`}
                        onClick={() => setSel({ scryfall_id: p.scryfall_id, finish: p.owned_finishes[0]?.finish || FINISH[p.finishes[0]] })}
                        onDoubleClick={confirmPick} {...hover(p.image_normal)}
                      >
                        {p.image_normal && <img src={p.image_normal} alt="" loading={i < 12 ? 'eager' : 'lazy'} />}
                        <div className="pmeta">
                          {i < 9 && <kbd>{i + 1}</kbd>}
                          <b>{p.set_code.toUpperCase()}</b>{p.collector_number && <> #{p.collector_number}</>} · {String(p.released_at).slice(0, 4)}
                        </div>
                        <div className="small muted" style={{ lineHeight: 1.2 }}>{p.set_name}</div>
                        <div className="pbadges">
                          {p.listed && <span className="badge plain">deck lists</span>}
                          {p.owned > 0 && <span className={`badge ${p.free >= picker.need ? 'ok' : 'warn'}`}>
                            own {p.owned}{p.claimed ? ` · ${Math.max(p.free, 0)} free` : ''}</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                  {sel && (() => {
                    const p = picker.printings.find((x) => x.scryfall_id === sel.scryfall_id);
                    return (
                      <div className="picker-foot">
                        <div className="finishes" style={{ margin: 0 }}>
                          <span className="muted small">Finish:</span>
                          {p.finishes.map((f) => (
                            <button key={f} className={sel.finish === FINISH[f] ? 'on' : ''} onClick={() => setSel({ ...sel, finish: FINISH[f] })}>{FINISH[f]}</button>
                          ))}
                        </div>
                        <button className="primary" disabled={busy} onClick={confirmPick}>
                          Scan {p.set_code.toUpperCase()} {sel.finish !== 'Normal' ? sel.finish : ''} <kbd>↵</kbd>
                        </button>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}
          {picker && preview}
          <ul className="feed">
            {feed.map((e) => <Entry key={e.key} e={e} onUndo={() => undo(e)} />)}
          </ul>
          {feed.length === 0 && <p className="muted small">Scanned cards will appear here.</p>}
        </div>

        <aside>
          {last?.image && <img className="scanimg" src={last.image} alt={last.name} />}
          <div className="panel" style={{ marginTop: 12 }}>
            <h3 style={{ marginTop: 0 }}>Not scanned yet ({remaining.length})</h3>
            {remaining.length === 0 ? <p className="small">Everything is accounted for. 🎉</p> : (
              <ul className="remaining">
                {remaining.map((c) => (
                  <li key={c.id}>
                    <Link to={`/card/${c.oracle_id}`}>{c.name}</Link>
                    {c.quantity > 1 && <span className="muted small"> {c.scan_count}/{c.quantity}</span>}
                    {c.verify_status === 'missing' && <span className="badge short" style={{ marginLeft: 6 }}>missing</span>}
                    <button className="icon small" style={{ float: 'right' }} title="Swapped out: remove from this deck" onClick={() => removeOne(c)}>×</button>
                  </li>
                ))}
              </ul>
            )}
            {remaining.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p className="small muted" style={{ margin: '0 0 6px' }}>
                  Done with the pile? Use × to drop single cards you swapped out, or handle the rest at once:
                </p>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={{ flex: 1 }} onClick={() => finish('remove')} title="Delete every unconfirmed card from this deck list">
                    All swapped out
                  </button>
                  {unscanned.length > 0 && (
                    <button className="danger" style={{ flex: 1 }} onClick={() => finish('missing')} title="Keep them in the deck, flagged missing">
                      Mark {unscanned.length} missing
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
