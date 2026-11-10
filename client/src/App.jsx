import { useEffect, useState, useCallback } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import Collection from './pages/Collection.jsx';
import CardDetail from './pages/CardDetail.jsx';
import Decks from './pages/Decks.jsx';
import DeckDetail from './pages/DeckDetail.jsx';
import Import from './pages/Import.jsx';
import Verify from './pages/Verify.jsx';
import Changes from './pages/Changes.jsx';
import Settings from './pages/Settings.jsx';
import { money, useSettings, reloadSettings } from './prices.jsx';

/** Checks the session first: shows the login screen when the server requires a password. */
export default function App() {
  const [session, setSession] = useState(null);
  const check = useCallback(() => api.get('/api/session').then(setSession)
    .catch(() => setSession({ authRequired: false, authenticated: true, offline: true })), []);
  useEffect(() => {
    check();
    const out = () => setSession((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener('mtg:logged-out', out);
    return () => window.removeEventListener('mtg:logged-out', out);
  }, [check]);

  if (!session) return null;
  if (!session.authenticated) return <Login onDone={() => { reloadSettings(); check(); }} />;
  return <Shell authRequired={session.authRequired} onLogout={async () => { await api.post('/api/logout').catch(() => {}); check(); }} />;
}

function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/api/login', { password }); onDone(); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>MTG Collector</h1>
      <input type="password" autoFocus autoComplete="current-password" placeholder="Password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="primary" disabled={busy || !password}>{busy ? 'Checking…' : 'Log in'}</button>
      {error && <p className="flash bad">{error}</p>}
    </form>
  );
}

function Shell({ authRequired, onLogout }) {
  const [stats, setStats] = useState(null);
  const loc = useLocation();
  const refreshStats = useCallback(() => api.get('/api/collection/stats').then(setStats).catch(() => {}), []);
  const settings = useSettings();
  useEffect(() => { refreshStats(); }, [loc.pathname, refreshStats, settings?.bulkThreshold, settings?.excludeBulk, settings?.pricesRefreshedAt]);

  return (
    <>
      <header className="topbar">
        <span className="brand">MTG Collector</span>
        <nav>
          <NavLink to="/" end>Collection</NavLink>
          <NavLink to="/decks">Decks</NavLink>
          <NavLink to="/changes">Changes</NavLink>
          <NavLink to="/import">Import</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        {authRequired && <button className="icon small logout" onClick={onLogout}>Log out</button>}
        {stats && (
          <span className="stats">
            <span title={settings?.excludeBulk
              ? `Excludes ${stats.bulk_copies.toLocaleString()} bulk cards (${money(stats.bulk_value)}) under ${money(settings.bulkThreshold)}`
              : 'TCGplayer market value'}>
              <b style={{ color: 'var(--text)' }}>{money(stats.value)}</b>
            </span>{' · '}
            {stats.copies.toLocaleString()} cards · {stats.unique.toLocaleString()} unique · {stats.decks} decks
            {stats.short > 0 && <> · <span style={{ color: 'var(--danger)' }}>{stats.short} short</span></>}
          </span>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Collection stats={stats} />} />
          <Route path="/card/:oracleId" element={<CardDetail />} />
          <Route path="/decks" element={<Decks />} />
          <Route path="/decks/:id" element={<DeckDetail onChange={refreshStats} />} />
          <Route path="/decks/:id/verify" element={<Verify onChange={refreshStats} />} />
          <Route path="/changes" element={<Changes onChange={refreshStats} />} />
          <Route path="/settings" element={<Settings onChange={refreshStats} />} />
          <Route path="/import" element={<Import onImported={refreshStats} />} />
        </Routes>
      </main>
    </>
  );
}
