import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

function Unresolved({ items }) {
  if (!items?.length) return null;
  return (
    <div className="notice">
      <b>{items.length} line(s) couldn't be matched:</b>
      <ul>{items.map((u, i) => <li key={i}><code>{u.line ?? u.name}</code> — {u.reason ?? u.scryfall_id}</li>)}</ul>
    </div>
  );
}

function CollectionImport({ onImported }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  const [replace, setReplace] = useState(false);

  const go = async () => {
    if (replace && !confirm('Replace your ENTIRE collection with this CSV? Cards added in this app (while verifying decks) will be removed. Decks are kept.')) return;
    setBusy(true); setErr(null); setReport(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', replace ? 'replace' : 'merge');
    try { setReport(await api.post('/api/import/collection', fd)); onImported?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Collection</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Archidekt → Collection → Export → CSV. Re-importing <b>merges</b>: new cards are added, nothing is removed,
        so cards you added here while verifying decks are kept.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files[0])} />
      <label className="check small">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
        Replace entire collection instead (discards app changes)
      </label>
      <div><button className="primary" disabled={!file || busy} onClick={go}>{busy ? 'Importing… (fetching from Scryfall)' : 'Import collection'}</button></div>
      {err && <p className="error">{err}</p>}
      {report && (
        <div className="report">
          <p>
            {report.mode === 'replace' ? 'Replaced collection.' : <>Added <b>{report.added.toLocaleString()}</b> new card(s); {report.unchanged.toLocaleString()} already present.</>}
            {' '}Collection now has <b>{report.totalQuantity.toLocaleString()}</b> cards ({report.uniqueCards.toLocaleString()} unique). <Link to="/">View collection →</Link>
          </p>
          {report.mode === 'merge' && report.notInCsv > 0 && (
            <p className="muted small">{report.notInCsv} printing(s) in this app aren't in the CSV, probably added while verifying. <Link to="/changes">See changes</Link>.</p>
          )}
          <Unresolved items={report.missing.map((m) => ({ line: `line ${m.line}: ${m.name}`, reason: `unknown Scryfall ID ${m.scryfall_id}` }))} />
        </div>
      )}
    </div>
  );
}

function DeckImport({ onImported }) {
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);

  const go = async (replace = false) => {
    setBusy(true); setErr(null); setReport(null);
    const fd = new FormData();
    if (file) fd.append('file', file); else fd.append('text', text);
    fd.append('name', name);
    if (replace) fd.append('replace', 'true');
    try {
      setReport(await api.post('/api/import/deck', fd));
      onImported?.();
    } catch (e) {
      if (e.code === 'DECK_EXISTS' && confirm(`${e.message}. Replace its cards with this list?`)) {
        setBusy(false);
        return go(true);
      }
      setErr(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Deck</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Archidekt deck → Export → <b>CSV</b> (best: exact printings via Scryfall ID) or Text. Or paste a list below.
      </p>
      <input
        type="file" accept=".csv,.txt,text/plain,text/csv"
        onChange={(e) => {
          const f = e.target.files[0];
          setFile(f || null);
          if (f && !name) setName(f.name.replace(/\.(csv|txt)$/i, '').replace(/^\w/, (c) => c.toUpperCase()));
        }}
      />
      {!file && <textarea rows={8} placeholder={'1x Sol Ring (cmm)\n1x Arcane Signet (soc) [Artifacts]\n...'} value={text} onChange={(e) => setText(e.target.value)} />}
      <input placeholder="Deck name" value={name} onChange={(e) => setName(e.target.value)} />
      <div><button className="primary" disabled={busy || !name.trim() || (!file && !text.trim())} onClick={() => go(false)}>{busy ? 'Importing…' : 'Import deck'}</button></div>
      {err && <p className="error">{err}</p>}
      {report && (
        <div className="report">
          <p>
            {report.replaced ? 'Updated' : 'Created'} <Link to={`/decks/${report.deckId}`}><b>{report.name}</b></Link>: {report.cards} cards
            {report.commander.length > 0 && <> · Commander: {report.commander.join(', ')}</>}
            {report.keptVerified > 0 && <> · kept verification on {report.keptVerified} card(s)</>}
          </p>
          <Unresolved items={report.unresolved} />
        </div>
      )}
    </div>
  );
}

export default function Import({ onImported }) {
  return (
    <>
      <h1>Import</h1>
      <p className="muted">Card data and images come from Scryfall and are cached locally.</p>
      <div className="import-grid">
        <CollectionImport onImported={onImported} />
        <DeckImport onImported={onImported} />
      </div>
    </>
  );
}
