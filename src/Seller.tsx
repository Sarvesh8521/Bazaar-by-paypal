import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Lantern, ProductArt } from './art';
import { SELLER_STYLES, getSellerData, money, openStall, saveSellerToken, searchProducts, sellerTokens, type Health, type Persona, type ProductCard, type SellerData } from './api';

/* ------------------------------- open a stall ------------------------------- */

export function SellForm({ health }: { health: Health | null }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ProductCard[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [title, setTitle] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [description, setDescription] = useState('');
  const [list, setList] = useState(100);
  const [floor, setFloor] = useState(70);
  const floorTouched = useRef(false);
  const [category, setCategory] = useState('');
  const [persona, setPersona] = useState<Persona>('stubborn');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ id: string; token: string; title: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const searchOn = health !== null && health.channel3 !== 'not_configured';

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    setSearching(true);
    setSearchError('');
    try {
      setResults(await searchProducts(q));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
      setResults(null);
    }
    setSearching(false);
  }

  function pick(p: ProductCard) {
    setTitle(p.title);
    setImageUrl(p.imageUrl ?? '');
    setList(Math.round(p.price));
    if (!floorTouched.current) setFloor(Math.round(p.price * 0.7));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await openStall({ title, category: category || undefined, listPrice: list, floorPrice: floor, persona, description: description || undefined, imageUrl: imageUrl || undefined });
      saveSellerToken(r.listing.id, r.sellerToken);
      setDone({ id: r.listing.id, token: r.sellerToken, title: r.listing.title });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the stall');
    }
    setBusy(false);
  }

  if (done)
    return (
      <section className="page narrow">
        <h1>Your stall is open</h1>
        <p>
          <strong>{done.title}</strong> is on the street now. Buyers' agents can start haggling with your agent right away.
        </p>
        <div className="panel">
          <h2>Your seller key</h2>
          <p className="small">It opens your private desk, which shows your floor price and every deal. Bazaar shows it only once and this browser has saved it. Keep a copy somewhere safe.</p>
          <code className="token">{done.token}</code>
          <button
            className="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(done.token);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? 'Copied' : 'Copy key'}
          </button>
        </div>
        <div className="row">
          <a className="primary" href={`#/desk/${done.id}`}>
            Open your desk
          </a>
          <a className="ghost" href="#/">
            See the street
          </a>
        </div>
      </section>
    );

  return (
    <section className="page narrow wide">
      <a className="back" href="#/">
        Back to the street
      </a>
      <h1>Open your own stall</h1>
      <p className="muted">Set a price and a secret floor. Your agent sells for you and never goes below the floor, even if the AI tries to.</p>

      {searchOn && (
        <form className="panel" onSubmit={search}>
          <h2>Start from a real product</h2>
          <p className="small muted">Search Channel3's catalogue to fill in the name, photo and a starting price.</p>
          <div className="row">
            <input aria-label="Search products" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. film camera" minLength={2} />
            <button className="ghost" disabled={searching || q.trim().length < 2}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          {searchError && <p className="small bad-text">{searchError}</p>}
          {results && results.length === 0 && <p className="small muted">No products with a USD price found. Try other words, or fill in the form yourself.</p>}
          {results && results.length > 0 && (
            <ul className="products">
              {results.map((p) => (
                <li key={p.id || p.title}>
                  <button type="button" onClick={() => pick(p)}>
                    <span className="pimg">{p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <ProductArt title={p.title} />}</span>
                    <span className="ptitle">{p.title}</span>
                    <span className="pprice">
                      from {money(p.price)} at {p.store}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}

      <form className="form" onSubmit={submit}>
        <label>
          What are you selling?
          <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={80} placeholder="Vintage brass lamp" />
        </label>
        <label>
          Which row does it stand in? (optional)
          <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={30} placeholder="headphones" aria-describedby="cat-help" list="rows" />
        </label>
        <datalist id="rows">
          <option value="headphones" />
          <option value="keyboards" />
          <option value="cameras" />
        </datalist>
        <p id="cat-help" className="help">
          Stalls in the same row compete. A buyer can send their agent down the whole row, and yours then haggles against the others.
        </p>
        <label>
          A line about it (optional)
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Works great, small dent on the base" />
        </label>
        <label>
          Photo link (optional, https only)
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} type="url" pattern="https://.*" placeholder="https://" />
        </label>
        <div className="two">
          <label>
            List price (USD)
            <input
              type="number"
              min={1}
              max={100000}
              step="any"
              value={list}
              onChange={(e) => {
                const v = Number(e.target.value);
                setList(v);
                if (!floorTouched.current) setFloor(Math.round(v * 0.7));
              }}
              required
            />
          </label>
          <label>
            Secret floor (USD)
            <input
              type="number"
              min={1}
              max={list}
              step="any"
              value={floor}
              onChange={(e) => {
                floorTouched.current = true;
                setFloor(Number(e.target.value));
              }}
              required
              aria-describedby="floor-help"
            />
          </label>
        </div>
        <p id="floor-help" className="help">
          Buyers never see the floor. Your agent will not accept less, and Bazaar checks that in code.
        </p>

        <fieldset className="styles">
          <legend>Your agent's style</legend>
          {(Object.keys(SELLER_STYLES) as Persona[]).map((p) => (
            <label key={p} className={`style-opt${persona === p ? ' on' : ''}`}>
              <input type="radio" name="seller-style" checked={persona === p} onChange={() => setPersona(p)} />
              <Lantern tone="seller" persona={p} mood={persona === p ? 'pleased' : 'calm'} size={46} />
              <span className="style-name">{p === 'friendly' ? 'Charmer' : p === 'stubborn' ? 'Hardliner' : 'Showman'}</span>
              <span className="style-blurb">{SELLER_STYLES[p]}</span>
            </label>
          ))}
        </fieldset>

        {error && (
          <p className="banner bad" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || floor > list || floor <= 0}>
          {busy ? 'Hanging the sign…' : 'Open the stall'}
        </button>
        {floor > list && <p className="small bad-text">The floor can't be higher than the list price.</p>}
      </form>
    </section>
  );
}

/* ------------------------------ the seller's desk ------------------------------ */

export function Desk({ id }: { id: string }) {
  const [token, setToken] = useState(() => sellerTokens()[id] ?? '');
  const [typed, setTyped] = useState('');
  const [data, setData] = useState<SellerData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let alive = true;
    const load = () =>
      getSellerData(id, token)
        .then((d) => {
          if (alive) {
            setData(d);
            setError('');
          }
        })
        .catch((e: Error) => alive && setError(e.message));
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, token]);

  if (!token || (error && !data))
    return (
      <section className="page narrow">
        <a className="back" href="#/">
          Back to the street
        </a>
        <h1>Seller desk</h1>
        {error && (
          <p className="banner bad" role="alert">
            {error}
          </p>
        )}
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            saveSellerToken(id, typed.trim());
            setToken(typed.trim());
          }}
        >
          <label>
            Paste your seller key
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" required />
          </label>
          <button className="primary">Open the desk</button>
        </form>
      </section>
    );

  if (!data) return <section className="page narrow muted">Opening the desk…</section>;
  return <DeskView data={data} />;
}

export function DeskView({ data }: { data: SellerData }) {
  const { listing: l, deals, stats } = data;
  return (
    <section className="page">
      <a className="back" href="#/">
        Back to the street
      </a>
      <div className="desk-head">
        <div>
          <h1>{l.title}</h1>
          <p className="muted">
            Listed at {money(l.listPrice, l.currency)}. Your agent: {SELLER_STYLES[l.sellerPersona].toLowerCase()}.
          </p>
        </div>
        <div className="floor">
          <span>Your secret floor</span>
          <strong>{money(l.floorPrice, l.currency)}</strong>
          <small>Only you can see this</small>
        </div>
      </div>

      <dl className="stats">
        <div>
          <dt>Haggles</dt>
          <dd>{stats.negotiations}</dd>
        </div>
        <div>
          <dt>Deals agreed</dt>
          <dd>{stats.agreementPct !== null ? `${stats.agreementPct}%` : 'None yet'}</dd>
        </div>
        <div>
          <dt>Verified sales</dt>
          <dd>{stats.sold}</dd>
        </div>
        <div>
          <dt>Verified revenue</dt>
          <dd>{money(stats.revenue, l.currency)}</dd>
        </div>
        <div>
          <dt>Rehearsal deal value</dt>
          <dd>
            {money(stats.simulatedValue, l.currency)}
            <small>{stats.simulatedDeals} deal{stats.simulatedDeals === 1 ? '' : 's'}, no money moved</small>
          </dd>
        </div>
        <div>
          <dt>Payments pending</dt>
          <dd>
            {stats.pendingPayments}
            {stats.pendingPayments > 0 && <small>{money(stats.pendingValue, l.currency)} not yet counted</small>}
          </dd>
        </div>
        {stats.refundedValue > 0 && (
          <div>
            <dt>Refunded</dt>
            <dd>{money(stats.refundedValue, l.currency)}</dd>
          </div>
        )}
        <div>
          <dt>Average price</dt>
          <dd>{stats.avgPrice !== null ? money(stats.avgPrice, l.currency) : 'None yet'}</dd>
        </div>
        <div>
          <dt>Average above your floor</dt>
          <dd>{stats.avgMarginOverFloor !== null ? money(stats.avgMarginOverFloor, l.currency) : 'None yet'}</dd>
        </div>
        <div>
          <dt>Won against rivals</dt>
          <dd>{stats.wonVsCompetitors}</dd>
        </div>
        <div>
          <dt>Lost to a cheaper stall</dt>
          <dd>{stats.lost}</dd>
        </div>
      </dl>

      {deals.length === 0 ? (
        <p className="muted">No haggles yet. Buyers' agents will show up here the moment someone sends one to your stall.</p>
      ) : (
        <div className="table-wrap">
          <table className="deals">
            <caption>Every haggle at your stall, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Result</th>
                <th scope="col">Price</th>
                <th scope="col">Above floor</th>
                <th scope="col">Rounds</th>
                <th scope="col">Buyer's style</th>
              </tr>
            </thead>
            <tbody>
              {[...deals].reverse().map((d) => (
                <motion.tr key={d.id + d.at} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <td>{new Date(d.at).toLocaleTimeString()}</td>
                  <td className={d.outcome === 'deal' && d.settlement !== 'pending' && d.settlement !== 'refunded' && d.settlement !== 'rehearsal' ? 'sold' : 'nodeal'}>{d.outcome === 'deal' ? (d.settlement === 'pending' ? 'Deal agreed, payment pending' : d.settlement === 'refunded' ? 'Sold, then refunded' : d.settlement === 'rehearsal' ? 'Rehearsal deal (no money moved)' : d.wonVs ? `Sold, beat ${d.wonVs} rival${d.wonVs === 1 ? '' : 's'}` : 'Sold') : d.outcome === 'lost' ? `Lost to a cheaper stall${d.lostByPct !== undefined ? d.lostByPct === 0 ? ', within 5%' : `, about ${d.lostByPct}% higher` : ''}` : d.settlement === 'failed' ? 'Payment unsuccessful' : 'No deal'}</td>
                  <td>{d.price !== undefined ? money(d.price, l.currency) : '-'}</td>
                  <td>{d.price !== undefined ? money(d.price - l.floorPrice, l.currency) : '-'}</td>
                  <td>{d.rounds ?? '-'}</td>
                  <td>{d.buyerPersona === 'friendly' ? 'Charmer' : d.buyerPersona === 'stubborn' ? 'Hardliner' : 'Showman'}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="help">This page refreshes every few seconds. Buyers never see your floor or this table.</p>
    </section>
  );
}
