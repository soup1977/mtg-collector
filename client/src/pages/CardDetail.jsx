import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { ManaCost } from '../components/bits.jsx';

import { Price, unitPrice } from '../prices.jsx';

export default function CardDetail() {
  const { oracleId } = useParams();
  const [card, setCard] = useState(null);
  const [err, setErr] = useState(null);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    setCard(null); setFlipped(false);
    api.get(`/api/cards/${oracleId}`).then(setCard).catch((e) => setErr(e.message));
  }, [oracleId]);

  if (err) return <p className="error">{err}</p>;
  if (!card) return <p className="muted">Loading…</p>;

  const shortfall = card.is_basic ? 0 : card.shortfall;

  return (
    <div className="detail">
      <div className="art">
        {card.image && <img src={flipped && card.back_image ? card.back_image : card.image} alt={card.name} />}
        {card.back_image && <button className="flip" onClick={() => setFlipped((f) => !f)}>Flip card</button>}
        <p className="small muted" style={{ marginTop: 10 }}>
          TCGplayer: <Price value={unitPrice({ usd: card.prices.usd })} />
          {card.prices.usd_foil && <> · Foil <Price value={Number(card.prices.usd_foil)} /></>}
          {card.prices.usd_etched && <> · Etched <Price value={Number(card.prices.usd_etched)} /></>}
          {card.scryfall_uri && <> · <a href={card.scryfall_uri} target="_blank" rel="noreferrer">Scryfall ↗</a></>}
        </p>
      </div>

      <div>
        <h1>{card.name} <ManaCost cost={card.mana_cost} /></h1>
        <div className="typeline">{card.type_line} · {card.rarity}</div>
        <div className="oracle">{card.oracle_text}</div>

        <div className="summary">
          <div className="stat"><div className="v">{card.owned}</div><div className="l">Owned</div></div>
          <div className="stat"><div className="v">{card.decks.filter((d) => !d.archived_at && d.board !== 'considering').length}</div><div className="l">Decks</div></div>
          <div className="stat"><div className="v">{card.needed}</div><div className="l">Copies in decks</div></div>
          <div className={`stat ${shortfall > 0 ? 'bad' : ''}`}>
            <div className="v">{shortfall}</div>
            <div className="l">{card.is_basic ? 'Short (basics ignored)' : 'Short'}</div>
          </div>
        </div>

        <h2>In decks</h2>
        {card.decks.length === 0 ? (
          <p className="muted">Not used in any deck.</p>
        ) : (
          <div className="deck-list">
            {card.decks.map((d) => (
              <Link key={d.deck_card_id} to={`/decks/${d.id}`} className={`deck-row ${d.archived_at ? 'archived' : ''}`}>
                <span className="dname">{d.name}</span>
                {d.archived_at && <span className="badge plain" title="Dissolved deck: doesn't count as using this card">dissolved</span>}
                {d.board === "considering" && <span className="badge warn" title="On this deck's Considering list: not part of the deck">considering</span>}
                {d.is_commander ? <span className="badge warn">Commander</span> : null}
                {d.verify_status === 'confirmed' && <span className="badge ok">✓ confirmed{d.finish && d.finish !== 'Normal' ? ` · ${d.finish}` : ''}</span>}
                {d.verify_status === 'missing' && <span className="badge short">✕ missing</span>}
                {d.category && <span className="badge plain">{d.category}</span>}
                <span className="small muted" title="Printing listed in the deck">
                  {d.set_code.toUpperCase()} #{d.collector_number}
                </span>
                {!d.verify_status && !d.own_listed_printing && card.owned > 0 && (
                  <span className="badge warn" title="You own this card, but not the printing the deck lists">other printing</span>
                )}
                <span className="badge decks">×{d.quantity}</span>
              </Link>
            ))}
          </div>
        )}

        <h2>Owned printings</h2>
        {card.printings.length === 0 ? (
          <p className="muted">You don't own a copy of this card.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Set</th><th>#</th><th>Finish</th><th className="hide-sm">Condition</th><th className="hide-sm">Lang</th><th className="hide-sm">Added</th><th className="num">Price</th><th className="num">Qty</th><th>In deck</th></tr>
            </thead>
            <tbody>
              {card.printings.map((p, i) => (
                <tr key={i}>
                  <td>{p.set_name} <span className="muted small">({p.set_code.toUpperCase()})</span></td>
                  <td>{p.collector_number}</td>
                  <td>{p.finish}</td>
                  <td className="hide-sm">{p.condition}</td>
                  <td className="hide-sm">{p.language}</td>
                  <td className="hide-sm">{p.date_added}</td>
                  <td className="num"><Price value={unitPrice(p.prices, p.finish)} /></td>
                  <td className="num">{p.quantity}</td>
                  <td className="small">
                    {p.claimed_by.length === 0 ? <span className="muted">free</span>
                      : p.claimed_by.map((c) => <Link key={c.id} to={`/decks/${c.id}`} className="badge decks" style={{ marginRight: 4 }}>{c.name}{c.quantity > 1 ? ` ×${c.quantity}` : ''}</Link>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
