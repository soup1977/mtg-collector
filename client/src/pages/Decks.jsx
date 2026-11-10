import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function Decks() {
  const [decks, setDecks] = useState(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { api.get('/api/decks').then(setDecks); }, []);

  const create = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      const { id } = await api.post('/api/decks', { name });
      navigate(`/decks/${id}`);
    } catch (ex) { setErr(ex.message); }
  };

  return (
    <>
      <h1>Decks</h1>
      <form className="toolbar" onSubmit={create}>
        <input placeholder="New deck name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={!name.trim()}>Create empty deck</button>
        <span className="muted small">or <Link to="/import">import from Archidekt</Link></span>
        {err && <span className="error">{err}</span>}
      </form>

      {decks && decks.length === 0 && <div className="empty">No decks yet.</div>}
      <DeckGrid decks={decks?.filter((d) => !d.archived_at)} />
      {decks?.some((d) => d.archived_at) && (
        <>
          <h2>Archived <span className="muted small" style={{ fontWeight: 400 }}>dissolved decks: cards are free in your collection, lists kept for restoring</span></h2>
          <DeckGrid decks={decks.filter((d) => d.archived_at)} archived />
        </>
      )}
    </>
  );
}

function DeckGrid({ decks, archived }) {
  return (
      <div className="deck-grid">
        {decks?.map((d) => archived ? (
          <Link key={d.id} to={`/decks/${d.id}`} className="deck-card archived">
            {d.image ? <img src={d.image} alt="" /> : <div style={{ width: 64 }} />}
            <div>
              <div className="title">{d.name}</div>
              {d.commander && <div className="small muted">{d.commander}</div>}
              <div className="small" style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="badge plain">{d.card_count} cards</span>
                <span className="badge plain">dissolved {d.archived_at.slice(0, 10)}</span>
              </div>
            </div>
          </Link>
        ) : (
          <Link key={d.id} to={`/decks/${d.id}`} className={`deck-card ${d.issues?.length ? 'has-issues' : ''}`}
            title={d.issues?.length ? d.issues.map((i) => `${i.label}: ${i.message}`).join('\n') : ''}>
            {d.image ? <img src={d.image} alt="" /> : <div style={{ width: 64 }} />}
            <div>
              <div className="title">{d.name}</div>
              {d.commander && <div className="small muted">{d.commander}</div>}
              {d.issues?.length > 0 && (
                <div className="small issue-chips">
                  <span className="issue-icon" aria-hidden>⚠</span>
                  {d.issues.map((i) => <span key={i.code} className="badge short">{i.label}</span>)}
                </div>
              )}
              <div className="small" style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {!d.issues?.some((i) => i.code === 'size') && <span className="badge plain">{d.card_count} cards</span>}
                {d.format && d.format !== 'commander' && <span className="badge plain">{d.format}</span>}
                {d.considering_count > 0 && <span className="badge warn">+{d.considering_count} considering</span>}
                {d.missing_count > 0 && <span className="badge short" title="Cards in this deck you don't own at all">{d.missing_count} not owned</span>}
                {d.short_count > d.missing_count && <span className="badge warn" title="Cards you own but not enough copies for all decks">{d.short_count - d.missing_count} shared short</span>}
                {d.short_count === 0 && d.card_count > 0 && <span className="badge ok">fully owned</span>}
              </div>
              {d.verifiable_count > 0 && (
                <div className="vprog small muted" style={{ marginTop: 8 }}>
                  <div className="progress"><div style={{ width: `${(100 * d.verified_count) / d.verifiable_count}%` }} /></div>
                  {d.verified_count}/{d.verifiable_count} verified
                </div>
              )}
            </div>
          </Link>
        ))}
      </div>
  );
}
