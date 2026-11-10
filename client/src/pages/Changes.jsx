import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Changes({ onChange }) {
  const [rows, setRows] = useState(null);
  const load = () => api.get('/api/changes').then(setRows);
  useEffect(() => { load(); }, []);

  const undo = async (r) => {
    if (!confirm(`Remove ${r.quantity}× ${r.name} (${r.set_code.toUpperCase()} #${r.collector_number}) from your collection?`)) return;
    await api.post(`/api/changes/${r.id}/undo`);
    load(); onChange?.();
  };
  const markExported = async () => {
    await api.post('/api/changes/mark-exported');
    load();
  };

  if (!rows) return <p className="muted">Loading…</p>;
  const pending = rows.filter((r) => !r.undone && !r.exported_at);

  return (
    <>
      <h1>Collection changes</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Cards this app added to your collection while you verified decks. This app is the master record;
        export these if you want Archidekt to match.
      </p>
      <div className="toolbar">
        <a href="/api/changes/export.csv" download><button className="primary" disabled={!pending.length}>Download {pending.length} new as Archidekt CSV</button></a>
        <button onClick={markExported} disabled={!pending.length}>Mark as exported</button>
        <a href="/api/changes/export.csv?all=1" download className="small">Download all</a>
      </div>

      {rows.length === 0 ? <div className="empty">No changes yet. Verify a deck to start.</div> : (
        <table>
          <thead>
            <tr><th>When</th><th>Card</th><th>Printing</th><th>Finish</th><th className="num">Qty</th><th className="hide-sm">Why</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.undone ? { opacity: 0.5 } : null}>
                <td className="small muted">{r.at.slice(0, 16)}</td>
                <td><Link to={`/card/${r.oracle_id}`}><b>{r.name}</b></Link></td>
                <td className="small">{r.set_code.toUpperCase()} #{r.collector_number}</td>
                <td>{r.finish}</td>
                <td className="num">+{r.quantity}</td>
                <td className="hide-sm small muted">{r.reason}</td>
                <td>{r.undone ? <span className="badge plain">undone</span>
                  : r.exported_at ? <span className="badge ok">exported</span>
                  : <span className="badge decks">new</span>}</td>
                <td>{!r.undone && <button className="icon small" onClick={() => undo(r)}>Undo</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
