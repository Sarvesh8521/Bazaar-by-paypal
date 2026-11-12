import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Awning, Bunting, Lantern, ProductArt } from './art';
import { Arena, PassportCard, type ReplayInfo } from './Arena';
import { Desk, SellForm } from './Seller';
import { BUYER_STYLES, SELLER_STYLES, aiLabel, createSession, getHealth, getListings, getPublicPassport, money, recentHaggles, rememberHaggle, searchProducts, type Health, type Passport, type Persona, type ProductCard, type PublicListing } from './api';

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const [route, query = ''] = hash.replace(/^#/, '').split('?');
  const match = route.match(/^\/(?:arena|passport)\/([^/]+)/);
  const desk = route.match(/^\/desk\/([^/]+)/);
  const shared = route.match(/^\/p\/([^/]+)/);
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setOffline(true));
  }, []);

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/" aria-label="Bazaar, back to the street">
          <svg viewBox="0 0 24 34" width="22" height="31" aria-hidden="true">
            <rect x="7" y="1" width="10" height="4" rx="1.5" fill="var(--brass-deep)" />
            <path d="M7 6 C0 14 0 22 7 28 H17 C24 22 24 14 17 6 Z" fill="var(--seller)" />
            <rect x="7" y="27" width="10" height="3" rx="1.5" fill="var(--brass-deep)" />
          </svg>
          <span>Bazaar</span>
        </a>
        <nav className="nav" aria-label="Main">
          <a href="#/">The street</a>
          <a href="#/sell">Open a stall</a>
          <a href="#/guide">Judges' guide</a>
        </nav>
        {health && (
          <ul className="status" aria-label="System status">
            <li className={health.agents === 'mock' ? 'warn' : 'ok'} title={health.agents === 'mock' ? 'No AI key is set, so scripted offline agents are negotiating. Add GEMINI_API_KEY or ANTHROPIC_API_KEY.' : 'Real AI model negotiates for both sides'}>
              {aiLabel(health.agents)}
              {health.agents === 'mock' ? ' (not real AI)' : ''}
            </li>
            <li className={health.paypal === 'sandbox' ? 'ok' : 'warn'} title="All payments use the PayPal sandbox. No real money moves.">
              {health.paypal === 'sandbox' ? 'PayPal sandbox' : 'PayPal not connected'}
            </li>
            <li className={health.channel3 === 'configured' ? 'ok' : 'warn'} title={health.channel3 === 'failing' ? 'Channel3 could not be reached, so stalls show no photos and agents get no market prices.' : undefined}>
              {health.channel3 === 'configured' ? 'Live market prices' : health.channel3 === 'failing' ? 'Market prices unreachable' : 'No market prices'}
            </li>
          </ul>
        )}
      </header>

      {offline && (
        <p className="banner bad" role="alert">
          Can't reach the Bazaar server. Start it with <code>npm run dev</code> and reload this page.
        </p>
      )}

      <main>
        {match ? (
          <Arena id={decodeURIComponent(match[1])} cancelled={new URLSearchParams(query).has('cancelled')} health={health} />
        ) : desk ? (
          <Desk id={decodeURIComponent(desk[1])} />
        ) : shared ? (
          <PublicPassport id={decodeURIComponent(shared[1])} />
        ) : route === '/replay' ? (
          <Replay health={health} />
        ) : route === '/guide' ? (
          <Guide health={health} />
        ) : route === '/sell' ? (
          <SellForm health={health} />
        ) : (
          <Street health={health} />
        )}
      </main>

      <footer className="foot">
        <p>Bazaar runs on the PayPal sandbox. No real money moves, and agents can only spend up to the limit you set.</p>
      </footer>
    </div>
  );
}

/* ------------------------------- the street ------------------------------- */

/** Stalls in the same category stand in one row; rows with several stalls can be crawled. */
export function rows(listings: PublicListing[]) {
  const by = new Map<string, PublicListing[]>();
  for (const l of listings) by.set(l.category, [...(by.get(l.category) ?? []), l]);
  return [...by.entries()].map(([category, stalls]) => ({ category, stalls })).sort((a, b) => b.stalls.length - a.stalls.length);
}

function Street({ health }: { health: Health | null }) {
  const [hasSample, setHasSample] = useState(false);
  useEffect(() => {
    fetch('/sample-crawl.json', { method: 'HEAD' })
      .then((r) => setHasSample(r.ok && (r.headers.get('content-type') ?? '').includes('json')))
      .catch(() => setHasSample(false));
  }, []);
  const [listings, setListings] = useState<PublicListing[] | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<PublicListing[] | null>(null);

  useEffect(() => {
    getListings().then(setListings).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <section className="hero">
        <Bunting />
        <div className="hero-copy">
          <h1>Send an agent to haggle for you.</h1>
          <p>
            Set a secret limit. Your AI agent bargains with the seller's agent, and PayPal only charges the price they agree on. If they can't agree, the hold is released and you pay nothing.
          </p>
          <p className="hero-links">
            {hasSample && (
              <a className="ghost" href="#/replay">
                Watch a recorded crawl
              </a>
            )}
            <a className="ghost" href="#/guide">
              How to try it in 90 seconds
            </a>
          </p>
        </div>
        <div className="hero-duo" aria-hidden="true">
          <Lantern tone="buyer" persona="friendly" mood="scheming" size={104} />
          <div className="hero-tag">
            <span>Your limit</span>
            <strong>stays secret</strong>
          </div>
          <Lantern tone="seller" persona="stubborn" mood="calm" size={104} />
        </div>
      </section>

      {health && health.channel3 !== 'not_configured' && <MarketCheck />}

      <section className="street" aria-label="Stalls open tonight">
        <h2 className="street-title">Stalls open tonight</h2>
        {error && <p className="banner bad">Couldn't load the stalls: {error}</p>}
        {!listings && !error && <p className="muted">Lighting the lanterns…</p>}
        {listings && listings.length === 0 && <p className="muted">No stalls are open yet. Restart the server to put the demo stalls out.</p>}
        {rows(listings ?? []).map(({ category, stalls }) => (
          <div key={category} className="row-block">
            <div className="row-head">
              <h3>The {category} row</h3>
              {stalls.length > 1 && (
                <button className="crawl-btn" onClick={() => setPicked(stalls)}>
                  Send your agent down the whole row ({stalls.length} stalls)
                </button>
              )}
            </div>
            <div className="stalls">
              {stalls.map((l, i) => (
                <button key={l.id} className={`stall pal-${['ruby', 'teal', 'plum'][i % 3]}`} style={{ ['--i' as string]: i }} onClick={() => setPicked([l])}>
                  <Awning />
                  <div className="stall-counter">
                    <div className="stall-art">{l.imageUrl ? <img src={l.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <ProductArt title={l.title} />}</div>
                    <div className="stall-tag">
                      <span className="stall-name">{l.title}</span>
                      <span className="stall-price">{money(l.listPrice, l.currency)}</span>
                    </div>
                    <div className="stall-keeper">
                      <Lantern tone="seller" persona={l.sellerPersona} mood="calm" size={34} />
                      <span>{SELLER_STYLES[l.sellerPersona]}</span>
                    </div>
                    <span className="stall-cta">Haggle with this stall</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <Recent />

      <AnimatePresence>{picked && <MandateSheet listings={picked} health={health} onClose={() => setPicked(null)} />}</AnimatePresence>
    </>
  );
}

/** Buyer-facing market intelligence: real merchant offers from Channel3, with photos, links and the time they were fetched. */
function MarketCheck() {
  const [q, setQ] = useState('');
  const [cards, setCards] = useState<ProductCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setCards(await searchProducts(q));
    } catch (err) {
      setCards(null);
      setError(err instanceof Error ? err.message : 'Search failed');
    }
    setBusy(false);
  }
  return (
    <details className="marketcheck">
      <summary>Check the market first</summary>
      <p className="muted small">Real merchant offers from Channel3. Your agent uses the same kind of evidence when it haggles.</p>
      <form className="row" onSubmit={search}>
        <input aria-label="Search the market" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. noise-cancelling headphones" minLength={2} />
        <button className="ghost" disabled={busy || q.trim().length < 2}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && <p className="small bad-text">{error}</p>}
      {cards && cards.length === 0 && <p className="small muted">No offers with a USD price found. Try other words.</p>}
      {cards && cards.length > 0 && (
        <>
          <p className="small muted">Retrieved {new Date(cards[0].retrievedAt).toLocaleTimeString()}. Prices are for similar products from different merchants.</p>
          <ul className="offers">
            {cards.map((c) => (
              <li key={c.id || c.title}>
                <span className="oimg">{c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <ProductArt title={c.title} />}</span>
                <strong>{c.title}</strong>
                <ul>
                  {c.offers.map((o) => (
                    <li key={o.store}>
                      {o.url && o.url.startsWith('https://') ? (
                        <a href={o.url} target="_blank" rel="noopener noreferrer">
                          {o.store}
                        </a>
                      ) : (
                        <span>{o.store}</span>
                      )}
                      <b>{money(o.price)}</b>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

/** A recorded crawl, played through the same arena. Works with no keys, no PayPal login and no waiting. */
function Replay({ health }: { health: Health | null }) {
  const [info, setInfo] = useState<ReplayInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/sample-crawl.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('No recorded crawl is available on this server.'))))
      .then((j: { recordedAt: string; ai: string; view: ReplayInfo['view'] }) => setInfo({ view: j.view, recordedAt: j.recordedAt, ai: j.ai }))
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error)
    return (
      <section className="page narrow">
        <p className="banner bad" role="alert">
          {error}
        </p>
        <a className="ghost" href="#/">
          Back to the street
        </a>
      </section>
    );
  if (!info) return <section className="page narrow muted">Loading the recording…</section>;
  return <Arena id={info.view.id} cancelled={false} health={health} replay={info} />;
}

/** What a judge needs: how to try it fast, and an honest list of what is real and what is simulated. */
export function Guide({ health }: { health: Health | null }) {
  const real = (ok: boolean | undefined) => (ok ? 'Real' : 'Not connected here');
  return (
    <section className="page narrow wide guide">
      <a className="back" href="#/">
        Back to the street
      </a>
      <h1>Judges' guide</h1>
      <p className="muted">Try Bazaar in about 90 seconds, and see exactly what is real and what is simulated.</p>

      <ol className="steps">
        <li>
          <strong>Watch first (20 seconds).</strong> Open <a href="#/replay">a recorded crawl</a>. It replays a finished haggle with no login and no waiting.
        </li>
        <li>
          <strong>Run your own (60 seconds).</strong> On the street, press "Send your agent down the whole row" on the headphones row. Set a secret limit and press the start button. Tick <em>Rehearsal</em> if you do not want to sign in to PayPal.
        </li>
        <li>
          <strong>Watch the three stalls haggle at once.</strong> When one stall agrees to a price, your limit drops below it everywhere else. The cheapest deal wins.
        </li>
        <li>
          <strong>Open the Deal Passport.</strong> With PayPal on, press "Verify with PayPal now" to check the payment live. Turn on "Sound and voices" if you want to hear the lanterns.
        </li>
        <li>
          <strong>See the seller side.</strong> Open <a href="#/sell">Open a stall</a>, list something with a secret floor, and open its private desk.
        </li>
      </ol>

      <h2>What is real, and what is not</h2>
      <table className="truth">
        <caption>Status of each part on this server right now</caption>
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">Status</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>AI agents</td>
            <td>{health ? (health.agents === 'mock' ? 'Offline demo agents (scripted, not real AI)' : `Real model: ${aiLabel(health.agents)}`) : 'Checking…'}</td>
            <td>Each passport states how many moves came from the model and how many from the built-in fallback.</td>
          </tr>
          <tr>
            <td>PayPal</td>
            <td>{health ? (health.paypal === 'sandbox' ? 'Real PayPal API, sandbox only' : 'Not connected here') : 'Checking…'}</td>
            <td>Fake sandbox money. Authorize your limit, capture only the winning price, void on no deal. "Rehearsal" skips it.</td>
          </tr>
          <tr>
            <td>Market prices and photos</td>
            <td>{health ? (health.channel3 === 'configured' ? 'Real Channel3 data' : health.channel3 === 'failing' ? 'Channel3 unreachable right now' : real(false)) : 'Checking…'}</td>
            <td>Real merchant offers for similar items, with links and the time they were fetched. Never invented.</td>
          </tr>
          <tr>
            <td>Stalls and sellers</td>
            <td>Demo data</td>
            <td>Seven seeded stalls with made-up floors. Anything you list yourself is saved on this server.</td>
          </tr>
          <tr>
            <td>Seller results</td>
            <td>Simulated traffic</td>
            <td>Revenue and conversion come only from haggles run on this site. No real-world uplift is claimed.</td>
          </tr>
        </tbody>
      </table>
      <p className="help">Nothing here moves real money. A buyer's agent can never offer above the limit, and a seller's agent can never sell below its floor: plain code enforces both, whatever the AI says.</p>
    </section>
  );
}

function PublicPassport({ id }: { id: string }) {
  const [p, setP] = useState<Passport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    getPublicPassport(id).then(setP).catch((e: Error) => setError(e.message));
  }, [id]);
  return (
    <section className="page">
      <a className="back" href="#/">
        Back to the street
      </a>
      <p className="banner">This is a shared passport. It shows what was agreed and how PayPal settled it, never anyone's private limit.</p>
      {error && (
        <p className="banner bad" role="alert">
          {error}
        </p>
      )}
      {!p && !error && <p className="muted">Loading the passport…</p>}
      {p && <PassportCard p={p} />}
    </section>
  );
}

function Recent() {
  const [items] = useState(() => recentHaggles());
  if (!items.length) return null;
  return (
    <section className="recent" aria-label="Your recent haggles">
      <h2>Your recent haggles</h2>
      <ul>
        {items.map((r) => (
          <li key={r.id}>
            <a href={`#/arena/${r.id}`}>
              <span>{r.title}</span>
              <strong className={r.outcome === 'deal' ? 'sold' : ''}>{r.outcome === 'deal' && r.price !== undefined ? (r.pending ? `Agreed at ${money(r.price)}, payment pending` : `Settled at ${money(r.price)}`) : r.outcome === 'no_deal' ? 'No deal' : 'Not finished'}</strong>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------ limit + style + authorize ------------------------ */

function MandateSheet({ listings, health, onClose }: { listings: PublicListing[]; health: Health | null; onClose: () => void }) {
  const crawl = listings.length > 1;
  const listing = listings[0];
  const lists = listings.map((l) => l.listPrice);
  const lowList = Math.min(...lists);
  const highList = Math.max(...lists);
  const lo = Math.max(1, Math.round(lowList * 0.3));
  const hi = Math.round(highList * 1.1);
  const [limit, setLimit] = useState(Math.round(lowList * 0.85));
  const [persona, setPersona] = useState<Persona>('friendly');
  const [rehearsal, setRehearsal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const slider = useRef<HTMLInputElement>(null);
  const paypalOn = health?.paypal === 'sandbox';
  const under = Math.round((1 - limit / lowList) * 100);

  useEffect(() => {
    slider.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function go() {
    setBusy(true);
    setError('');
    try {
      const s = await createSession({ ...(crawl ? { listingIds: listings.map((l) => l.id) } : { listingId: listing.id }), maxBudget: limit, buyerPersona: persona, rehearsal: rehearsal || undefined });
      rememberHaggle({ id: s.id, title: crawl ? `The ${listing.category} row` : listing.title, at: new Date().toISOString(), token: s.buyerToken });
      if (s.payment.approveUrl) window.location.assign(s.payment.approveUrl);
      else window.location.hash = `#/arena/${s.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 30 }} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 id="sheet-title">{crawl ? `The ${listing.category} row` : listing.title}</h2>
        <p className="muted">
          {crawl
            ? `${listings.length} stalls, listed from ${money(lowList, listing.currency)} to ${money(highList, listing.currency)}. Their agents haggle at the same time, and yours plays them against each other.`
            : `Listed at ${money(listing.listPrice, listing.currency)}. ${SELLER_STYLES[listing.sellerPersona]}.`}
        </p>

        <div className="field">
          <label htmlFor="limit">How far will you go?</label>
          <div className="limit-readout">
            <strong>{money(limit, listing.currency)}</strong>
            <span>{under > 0 ? `${under}% under ${crawl ? 'the lowest list price' : 'the list price'}` : under === 0 ? 'The list price' : `${-under}% over the list price`}</span>
          </div>
          <input id="limit" ref={slider} type="range" min={lo} max={hi} step={1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-describedby="limit-help" />
          <p id="limit-help" className="help">
            Your agent can never offer more than this, and the seller never sees it.
          </p>
        </div>

        <fieldset className="field styles">
          <legend>Your agent's style</legend>
          {(Object.keys(BUYER_STYLES) as Persona[]).map((p) => (
            <label key={p} className={`style-opt${persona === p ? ' on' : ''}`}>
              <input type="radio" name="style" value={p} checked={persona === p} onChange={() => setPersona(p)} />
              <Lantern tone="buyer" persona={p} mood={persona === p ? 'pleased' : 'calm'} size={46} />
              <span className="style-name">{BUYER_STYLES[p].name}</span>
              <span className="style-blurb">{BUYER_STYLES[p].blurb}</span>
            </label>
          ))}
        </fieldset>

        {error && (
          <p className="banner bad" role="alert">
            {error}
          </p>
        )}
        {paypalOn && (
          <label className="rehearsal">
            <input type="checkbox" checked={rehearsal} onChange={(e) => setRehearsal(e.target.checked)} />
            <span>
              <strong>Rehearsal: skip PayPal.</strong> No sandbox login needed and nothing is charged. The agents still haggle for real.
            </span>
          </label>
        )}
        <button className="primary" onClick={go} disabled={busy}>
          {busy ? 'Opening the stalls…' : paypalOn && !rehearsal ? `Authorize up to ${money(limit, listing.currency)} with PayPal` : crawl ? 'Start the crawl as a rehearsal' : 'Start as a rehearsal'}
        </button>
        <p className="help">
          {paypalOn && !rehearsal
            ? `PayPal holds up to your limit in the sandbox and captures only the ${crawl ? 'winning stall\'s' : 'agreed'} price. With no deal, the hold is voided.`
            : "PayPal isn't connected on this server, so nothing will be charged."}
        </p>
      </motion.div>
    </motion.div>
  );
}
