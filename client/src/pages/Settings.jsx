import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, updateSettings, useSettings, reloadSettings } from '../prices.jsx';

const ago = (iso) => {
  if (!iso) return 'never';
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

function Backups({ s, save, onChange }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [custom, setCustom] = useState(s.backupCustomPath || '');
  const [showAll, setShowAll] = useState(false);

  const load = () => api.get('/api/backups').then(setData).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, [s.backupDestinations.join(), s.backupCustomPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id, on) => save({ backupDestinations: on ? [...s.backupDestinations, id] : s.backupDestinations.filter((d) => d !== id) });

  const backupNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/api/backups');
      await reloadSettings();
      const bad = r.results.filter((x) => !x.ok);
      setMsg({ ok: !bad.length, text: r.results.map((x) => `${x.label}: ${x.ok ? 'saved' : `failed (${x.error})`}`).join(' · ') });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const restore = async (b) => {
    if (!confirm(`Restore the backup from ${b.name.replace('_', ' ')} (${b.label})?\n\nThis replaces your collection, decks and settings with that backup. A safety copy of the current state is saved first.`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/api/backups/restore', { destination: b.destination, name: b.name });
      await reloadSettings();
      onChange?.();
      setMsg({ ok: true, text: `Restored ${r.restored}. Safety copy of the previous state: ${r.safetyCopy}` });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const enabledOk = data?.destinations.some((d) => d.enabled && d.available);
  const backups = data?.backups || [];

  return (
    <>
      <h2>Backups</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Each backup is a full snapshot (collection, decks, verification, history, settings) plus readable files:
        your collection as an Archidekt CSV and every deck as a text list. They're saved in an
        {data?.managed ? 'folder on the server.' : '"MTG Collector Backups" folder that your cloud app syncs.'}
      </p>
      {data?.managed && data.destinations.map((d) => (
        <div key={d.id} className="dest">
          <b>{d.label}</b>{' '}
          {d.available ? <span className="muted small mono">{d.path}</span> : <span className="small" style={{ color: 'var(--warn)' }}>{d.hint}</span>}
        </div>
      ))}
      {!data?.managed && data?.destinations.map((d) => (
        <div key={d.id} className="dest">
          <label className="check">
            <input type="checkbox" checked={d.enabled} onChange={(e) => toggle(d.id, e.target.checked)} />
            <b>{d.label}</b>
          </label>
          {d.available
            ? <span className="muted small mono">{d.path}</span>
            : <span className="small" style={{ color: 'var(--warn)' }}>{d.hint}</span>}
        </div>
      ))}
      {data && !data.managed && <div className="row" style={{ marginTop: 4 }}>
        <input
          style={{ flex: 1 }} placeholder="Custom folder, e.g. /Users/you/Dropbox" value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => custom !== (s.backupCustomPath || '') && save({ backupCustomPath: custom })}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        />
      </div>}
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={s.autoBackup} onChange={(e) => save({ autoBackup: e.target.checked })} />
          Back up automatically once a day, keeping the last
          <input type="number" min="1" max="365" defaultValue={s.backupKeep} style={{ width: 64 }}
            onBlur={(e) => Number(e.target.value) !== s.backupKeep && save({ backupKeep: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <div><b>Last backup:</b> {ago(s.lastBackupAt)}</div>
        <button className="primary" onClick={backupNow} disabled={busy || !enabledOk}>{busy ? 'Working…' : 'Back up now'}</button>
      </div>
      {!enabledOk && data && <p className="notice small">Turn on at least one available destination to back up.</p>}
      {msg && <p className={msg.ok ? 'flash ok' : 'flash bad'}>{msg.text}</p>}

      {backups.length > 0 && (
        <>
          <h3>Restore</h3>
          <table>
            <tbody>
              {(showAll ? backups : backups.slice(0, 5)).map((b) => (
                <tr key={b.destination + b.name}>
                  <td>{b.name.replace('_', ' ').replace(/(\d{2})(\d{2})(\d{2})$/, '$1:$2:$3')}</td>
                  <td className="muted small">{b.label}</td>
                  <td className="num muted small">{(b.size / 1048576).toFixed(1)} MB</td>
                  <td className="num"><button className="icon small" disabled={busy} onClick={() => restore(b)}>Restore</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {backups.length > 5 && !showAll && <button className="icon small" style={{ marginTop: 6 }} onClick={() => setShowAll(true)}>Show all {backups.length}</button>}
        </>
      )}
    </>
  );
}

export default function Settings({ onChange }) {
  const s = useSettings();
  const [threshold, setThreshold] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { if (s) setThreshold(String(s.bulkThreshold)); }, [s?.bulkThreshold]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s) return <p className="muted">Loading…</p>;

  const save = async (patch) => {
    setMsg(null);
    try { await updateSettings(patch); onChange?.(); } catch (e) { setMsg({ ok: false, text: e.message }); }
  };

  const refresh = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/api/cards/refresh');
      await reloadSettings();
      onChange?.();
      setMsg({ ok: true, text: `Updated prices for ${r.refreshed.toLocaleString()} cards.` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <>
      <h1>Settings</h1>

      <div className="panel settings">
        <h2 style={{ marginTop: 0 }}>Prices</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Prices are TCGplayer market prices (USD), supplied by Scryfall, matched to each copy's finish (normal, foil, etched).
        </p>
        <div className="row">
          <div>
            <b>Last updated:</b> {ago(s.pricesRefreshedAt)}
            <div className="muted small">Scryfall updates prices daily. The app refreshes automatically on start if they're over a day old.</div>
          </div>
          <button onClick={refresh} disabled={busy}>{busy ? 'Refreshing… (~20 s)' : 'Refresh prices now'}</button>
        </div>
        {msg && <p className={msg.ok ? 'flash ok' : 'flash bad'}>{msg.text}</p>}

        <h2>Bulk</h2>
        <label className="check">
          <input type="checkbox" checked={s.excludeBulk} onChange={(e) => save({ excludeBulk: e.target.checked })} />
          Treat cheap cards as bulk: show "bulk" instead of a price and leave them out of value totals
        </label>
        <div className="row" style={{ opacity: s.excludeBulk ? 1 : 0.5 }}>
          <label>
            Bulk is anything under{' '}
            <span className="money-input">$<input
              type="number" min="0" step="0.05" value={threshold} disabled={!s.excludeBulk}
              onChange={(e) => setThreshold(e.target.value)}
              onBlur={() => threshold !== String(s.bulkThreshold) && save({ bulkThreshold: threshold })}
              onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
            /></span>
          </label>
          <div className="seg">
            {[0.25, 0.5, 1, 2].map((v) => (
              <button key={v} className={s.bulkThreshold === v ? 'on' : ''} disabled={!s.excludeBulk}
                onClick={() => save({ bulkThreshold: v })}>{money(v)}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel settings" style={{ marginTop: 16 }}>
        <Backups s={s} save={save} onChange={onChange} />
      </div>
    </>
  );
}
