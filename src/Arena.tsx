import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Lantern, ProductArt, ShieldIcon, type Mood } from './art';
import { BUYER_STYLES, PAYMENT_TEXT, aiLabel, getSession, money, paymentOutcome, rememberHaggle, streamNegotiation, verifyPassportLive, type Verification, type Health, type Passport, type SessionView, type ViewEvent } from './api';
import type { GuardKind } from '../server/agents.ts';
import { CrawlStage, type Speaking } from './Crawl';
import { chime, fxOn, setFx, speak } from './fx';
import { Bubble, PriceTag, reduced, sleep } from './stage';
import { emptyState, hydrateFrom, reducer, replayEvents, type AState, type GuardEv, type UiTurn } from './state';

/* ---------------------------------- the page ---------------------------------- */

export interface ReplayInfo {
  view: SessionView;
  recordedAt: string;
  ai: string;
}

export function Arena({ id, cancelled, health, replay }: { id: string; cancelled: boolean; health: Health | null; replay?: ReplayInfo }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [st, dispatch] = useReducer(reducer, undefined, emptyState);
  const [running, setRunning] = useState(false);
  const [shock, setShock] = useState(false);
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const passportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  const refresh = useCallback(async () => {
    const s = await getSession(id);
    if (alive.current) setSession(s);
    return s;
  }, [id]);

  useEffect(() => {
    if (replay) {
      setSession(replay.view);
      return;
    }
    refresh()
      .then((s) => dispatch(hydrateFrom(s)))
      .catch((e: Error) => setLoadError(e.message));
  }, [refresh, replay]);

  // The page was reloaded while a negotiation was running: follow it by polling.
  useEffect(() => {
    if (replay || running || session?.state !== 'negotiating') return;
    const t = setInterval(() => {
      refresh()
        .then((s) => dispatch(hydrateFrom(s)))
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(t);
  }, [session?.state, running, refresh]);

  // A blocked proposal makes the buyer lantern flinch for a moment.
  useEffect(() => {
    if (!st.guards.length) return;
    setShock(true);
    const t = setTimeout(() => setShock(false), 1500);
    return () => clearTimeout(t);
  }, [st.guards.length]);

  // Optional sound and voices, only while a run is playing (never on a reload).
  const [fx, setFxState] = useState(fxOn);
  const toggleFx = () => {
    const next = !fx;
    setFx(next);
    setFxState(next);
    if (next) chime('held');
  };
  useEffect(() => {
    const t = st.turns.at(-1);
    if (!running || !t) return;
    chime(t.side === 'buyer' ? 'buyer' : 'seller');
    if (t.side !== 'mediator') speak(t.line, t.side, (t.lane ?? 'a').charCodeAt(0));
  }, [st.turns.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (running && st.guards.length) chime('block');
  }, [st.guards.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (running && st.best) chime('held');
  }, [st.best?.price]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (running && st.deal) chime('deal');
  }, [st.deal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (running && (st.noDeal || (st.crawlEnd && !st.crawlEnd.winner))) chime('nodeal');
  }, [st.noDeal, st.crawlEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (st.passport && running === false && st.turns.length) passportRef.current?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  }, [st.passport, running, st.turns.length]);

  useEffect(() => {
    const p = st.passport;
    if (p && session && !replay) rememberHaggle({ id, title: p.item.title, at: p.createdAt, outcome: p.outcome, price: p.agreedPrice, pending: ['pending', 'unverified'].includes(paymentOutcome(p.payment)) });
  }, [st.passport, session, id]);

  const start = useCallback(async () => {
    if (running) return;
    setRunning(true);
    dispatch({ type: 'hydrate', events: [] });
    const q: ViewEvent[] = [];
    let done = false;
    const ctl = new AbortController();
    abort.current = ctl;
    // Events are replayed at a readable pace even when the model answers instantly.
    const pump = (async () => {
      while (alive.current && !(done && q.length === 0)) {
        const ev = q.shift();
        if (!ev) {
          await sleep(100);
          continue;
        }
        dispatch({ type: 'event', ev });
        await sleep(ev.type === 'turn' ? 1500 : ev.type === 'guardrail' ? 900 : ev.type === 'deal' ? 1400 : 700);
      }
    })();
    try {
      if (replay) replayEvents(replay.view).forEach((e) => q.push(e));
      else await streamNegotiation(id, (e) => q.push(e), ctl.signal);
    } catch (e) {
      if (!ctl.signal.aborted) q.push({ type: 'error', message: e instanceof Error ? e.message : 'Connection lost' });
    } finally {
      done = true;
    }
    await pump;
    if (alive.current) {
      setRunning(false);
      if (!replay) await refresh().catch(() => undefined);
    }
  }, [id, running, refresh]);

  if (loadError)
    return (
      <section className="page narrow">
        <p className="banner bad" role="alert">
          {loadError}.
        </p>
        <p className="muted">A haggle is private to the browser that started it. If you were sent a link to a finished one, open its shared passport instead.</p>
        <a className="ghost" href={`#/p/${id}`}>
          Open the shared passport
        </a>
        <a className="ghost" href="#/">
          Back to the street
        </a>
      </section>
    );
  if (!session) return <section className="page narrow muted">Opening the stall…</section>;

  const { item } = session;
  const isCrawl = session.mode === 'crawl';
  const titles: Record<string, string> = Object.fromEntries(session.items.map((i) => [i.id, i.title]));
  const lastTurn = st.turns.at(-1);
  const lastBuyer = [...st.turns].reverse().find((t) => t.side === 'buyer');
  const lastSeller = [...st.turns].reverse().find((t) => t.side === 'seller');
  const dealPrice = st.deal?.price ?? st.crawlEnd?.winner?.price ?? (st.passport?.outcome === 'deal' ? st.passport.agreedPrice : undefined);
  const ended = replay ? Boolean(st.passport) : Boolean(st.passport) || ['settled', 'pending_payment', 'no_deal', 'failed'].includes(session.state);
  const noDeal = Boolean(st.noDeal) || st.passport?.outcome === 'no_deal' || Boolean(st.crawlEnd && !st.crawlEnd.winner);
  const speaking = running && lastTurn && lastTurn.side !== 'mediator' ? lastTurn.side : null;
  const crawlSpeaking: Speaking = speaking ? { lane: lastTurn?.lane ?? null, side: speaking } : null;
  const buyerPriced = [...st.turns].reverse().find((t) => t.side === 'buyer' && t.price != null)?.price ?? undefined;
  const sellerPriced = [...st.turns].reverse().find((t) => t.side === 'seller' && t.price != null)?.price ?? undefined;

  const mood = (side: 'buyer' | 'seller'): Mood => {
    if (dealPrice !== undefined) return side === 'buyer' ? 'delighted' : 'pleased';
    if (noDeal) return 'sulking';
    if (side === 'buyer' && shock) return 'shocked';
    if (side === 'buyer' && st.best) return 'pleased';
    if (lastTurn && lastTurn.side === side) return 'scheming';
    return 'calm';
  };

  const tagValue = dealPrice ?? lastTurn?.price ?? item.listPrice;
  const tagCaption = dealPrice !== undefined ? 'Deal' : lastTurn?.price != null ? (lastTurn.side === 'buyer' ? 'Your agent offers' : 'Seller asks') : 'List price';
  const idle = !running && !ended && (replay ? true : session.state === 'ready') && st.turns.length === 0;

  return (
    <section className="page arena">
      <div className="arena-head">
        <a className="back" href="#/">
          Back to the street
        </a>
        <h1>{isCrawl ? `The ${item.category} row` : item.title}</h1>
        <p className="muted">
          {isCrawl ? `${session.items.length} stalls, one PayPal authorization.` : `Listed at ${money(item.listPrice, item.currency)}.`} {session.limitHidden ? "The buyer's limit stays private in a recording." : `Your limit is ${money(session.maxBudget, item.currency)}, known only to you.`}
        </p>
        <button className="ghost fx" aria-pressed={fx} onClick={toggleFx} title="Chimes, a gong on the deal, and the lanterns speaking aloud">
          Sound and voices: {fx ? 'on' : 'off'}
        </button>
      </div>

      {replay && (
        <p className="banner" role="note">
          Recorded run from {new Date(replay.recordedAt).toLocaleString()}. Agents: {replay.ai === 'mock' ? 'offline demo agents (scripted, not real AI)' : aiLabel(replay.ai)}.
        </p>
      )}
      {cancelled && session.state === 'awaiting_approval' && (
        <p className="banner warn" role="status">
          You cancelled the PayPal approval, so the agents can't start yet. Authorize again below to continue.
        </p>
      )}
      {st.error && (
        <p className="banner bad" role="alert">
          {st.error}
        </p>
      )}

      {isCrawl ? (
        <CrawlStage session={session} st={st} shock={shock} speaking={crawlSpeaking} mood={mood('buyer')} />
      ) : (
        <>
      <div className="stage">
        <div className="side buyer-side">
          <Bubble tone="buyer" turn={lastBuyer} active={speaking === 'buyer'} empty="Ready when you are." />
          <Lantern tone="buyer" mood={mood('buyer')} persona={session.buyerPersona} speaking={speaking === 'buyer'} size={150} />
          <div className="who">
            Your agent <span>{BUYER_STYLES[session.buyerPersona].name}</span>
          </div>
        </div>
        <PriceTag value={tagValue} caption={tagCaption} swing={lastTurn?.side === 'buyer' ? 1 : -1} swingKey={`${st.turns.length}-${dealPrice ?? ''}`} deal={dealPrice !== undefined} currency={item.currency} />
        <div className="side seller-side">
          <Bubble tone="seller" turn={lastSeller} active={speaking === 'seller'} empty={`Welcome! ${money(item.listPrice, item.currency)}, a fair price.`} />
          <Lantern tone="seller" mood={mood('seller')} persona={item.sellerPersona} speaking={speaking === 'seller'} size={150} />
          <div className="who">
            Seller's agent <span>{item.sellerPersona === 'friendly' ? 'Chatty' : item.sellerPersona === 'stubborn' ? 'Hardliner' : 'Showman'}</span>
          </div>
        </div>
      </div>

      <HaggleLine list={item.listPrice} cap={session.maxBudget} market={session.market.reference} buyer={buyerPriced} seller={sellerPriced} deal={dealPrice} currency={item.currency} />

        </>
      )}

      {!ended && (
        <div className="actions">
          {session.state === 'awaiting_approval' ? (
            <>
              <a className="primary" href={session.payment.approveUrl}>
                Authorize up to {money(session.maxBudget, item.currency)} with PayPal
              </a>
              <p className="help">Sign in with your PayPal sandbox buyer account. Nothing is charged until the agents agree on a price.</p>
            </>
          ) : (
            <>
              <button className="primary" onClick={start} disabled={running || !idle}>
                {running ? (replay ? 'Playing the recording…' : 'The agents are haggling…') : replay ? 'Play the recording' : 'Release the agents'}
              </button>
              {idle && <p className="help">{replay ? 'Nothing here is live. This replays a finished haggle exactly as it happened, with no keys, PayPal login or waiting.' : session.payment.rehearsal ? 'This is a rehearsal by choice: PayPal is skipped, so nothing will be charged and no sandbox login is needed.' : session.payment.mode === 'paypal_sandbox' ? `PayPal is holding up to ${money(session.maxBudget, item.currency)} in the sandbox. Only the agreed price will be captured.` : 'No payment is attached, so this is a rehearsal. Nothing will be charged.'}</p>}
            </>
          )}
        </div>
      )}

      {st.passport && (
        <div ref={passportRef} className="passport-wrap">
          <PassportCard p={st.passport} />
        </div>
      )}
      {ended && !st.passport && !st.error && <p className="muted">This haggle has finished.</p>}

      <div className="grid">
        <Timeline turns={st.turns} labels={titles} />
        <aside className="panels">
          <PaymentPanel session={session} st={st} cap={session.maxBudget} currency={item.currency} />
          <ShieldPanel guards={st.guards} />
          <MarketPanel session={session} health={health} />
        </aside>
      </div>
    </section>
  );
}

/* ------------------------------ the haggle line ------------------------------ */

export function HaggleLine({ list, cap, market, buyer, seller, deal, currency }: { list: number; cap: number; market: { store: string; price: number }[]; buyer?: number; seller?: number; deal?: number; currency: string }) {
  const pts = [list, cap, ...market.map((m) => m.price), buyer, seller, deal].filter((n): n is number => typeof n === 'number');
  const lo = Math.max(0, Math.min(list * 0.4, Math.min(...pts) * 0.9));
  const hi = Math.max(...pts) * 1.04;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  const spring = { type: 'spring' as const, stiffness: 140, damping: 20 };
  const both = buyer !== undefined && seller !== undefined && deal === undefined;
  const capNearList = Math.abs(pct(cap) - pct(list)) < 22;

  return (
    <figure className="hline" aria-label={`Haggle line from ${money(lo, currency)} to ${money(hi, currency)}${buyer !== undefined ? `. Your agent offers ${money(buyer, currency)}` : ''}${seller !== undefined ? `. Seller asks ${money(seller, currency)}` : ''}`}>
      <div className="hl-rail" />
      {both && (
        <>
          <motion.div className="hl-gap" initial={false} animate={{ left: `${pct(buyer)}%`, width: `${Math.max(0, pct(seller) - pct(buyer))}%` }} transition={spring} />
          <motion.div className="hl-gap-label" initial={false} animate={{ left: `${(pct(buyer) + pct(seller)) / 2}%` }} transition={spring}>
            {money(Math.max(0, seller - buyer), currency)} apart
          </motion.div>
        </>
      )}
      {market.map((m, i) => (
        <div key={m.store} className="hl-mk" style={{ left: `${pct(m.price)}%`, ['--row' as string]: i % 2 }}>
          <i />
          <span>
            {m.store} {money(m.price, currency)}
          </span>
        </div>
      ))}
      <div className="hl-end" style={{ left: `${pct(list)}%` }}>
        <i />
        <span>List {money(list, currency)}</span>
      </div>
      <div className={`hl-cap${capNearList ? ' high' : ''}`} style={{ left: `${pct(cap)}%` }}>
        <i />
        <span>Your limit {money(cap, currency)}</span>
      </div>
      {buyer !== undefined && deal === undefined && (
        <motion.div className="hl-pin buyer" initial={false} animate={{ left: `${pct(buyer)}%` }} transition={spring}>
          <span>{money(buyer, currency)}</span>
          <b />
        </motion.div>
      )}
      {seller !== undefined && deal === undefined && (
        <motion.div className="hl-pin seller" initial={false} animate={{ left: `${pct(seller)}%` }} transition={spring}>
          <span>{money(seller, currency)}</span>
          <b />
        </motion.div>
      )}
      {deal !== undefined && (
        <div className="hl-deal" style={{ left: `${pct(deal)}%` }}>
          {Array.from({ length: 14 }, (_, i) => (
            <u key={i} style={{ ['--a' as string]: `${(360 / 14) * i}deg`, ['--d' as string]: `${46 + (i % 3) * 14}px` }} />
          ))}
          <b />
          <span>Deal {money(deal, currency)}</span>
        </div>
      )}
    </figure>
  );
}

/* -------------------------------- timeline -------------------------------- */

function Timeline({ turns, labels }: { turns: UiTurn[]; labels?: Record<string, string> }) {
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
  }, [turns.length]);
  return (
    <div className="timeline">
      <h2>What was said</h2>
      {turns.length === 0 ? (
        <p className="muted">Nothing yet. Each offer and its tactic will appear here.</p>
      ) : (
        <ol ref={box}>
          {turns.map((t, i) => {
            const stall = t.lane ? labels?.[t.lane] : undefined;
            return (
              <motion.li key={i} className={`turn ${t.side}`} initial={{ opacity: 0, x: t.side === 'buyer' ? -14 : 14 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }}>
                <div className="turn-top">
                  <span className="turn-who">{t.side === 'buyer' ? (stall ? `Your agent to ${stall}` : 'Your agent') : t.side === 'seller' ? (stall ?? 'Seller') : 'Bazaar elder'}</span>
                  {t.price != null && <strong>{money(t.price)}</strong>}
                  <span className="chip">{t.action === 'accept' ? 'accepts' : t.tactic}</span>
                </div>
                <p>{t.line}</p>
              </motion.li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* --------------------------------- panels --------------------------------- */

const GUARD_TEXT: Partial<Record<GuardKind, string>> = {
  over_budget: 'Your agent tried to offer more than your limit. Blocked and held at your limit.',
  no_retreat: 'Your agent tried to take back an earlier offer. Blocked.',
  accept_blocked: 'Your agent tried to accept a price above your limit. Blocked.',
  secret_leak: 'Your agent almost said your limit out loud. The line was replaced.',
  bad_json: 'The AI gave an unusable reply. Bazaar retried, or used its built-in offline agent for that move.',
};

function ShieldPanel({ guards }: { guards: GuardEv[] }) {
  return (
    <section className={`panel shield${guards.length ? ' hit' : ''}`}>
      <h2>
        <ShieldIcon /> Limit guard
      </h2>
      <p className="muted small">The AI proposes. Plain code checks every offer against your limit before anyone sees it.</p>
      {guards.length === 0 ? (
        <p className="small">Nothing blocked so far.</p>
      ) : (
        <ul>
          {guards.map((g, i) => (
            <motion.li key={i} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
              {GUARD_TEXT[g.kind] ?? g.detail}
            </motion.li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MarketPanel({ session, health }: { session: SessionView; health: Health | null }) {
  const m = session.market;
  return (
    <section className="panel">
      <h2>Market prices</h2>
      {m.reference.length > 0 ? (
        <>
          <p className="muted small">
            Similar items found with Channel3 (not guaranteed identical). Your agent can cite these.
            {m.retrievedAt ? ` Retrieved ${new Date(m.retrievedAt).toLocaleTimeString()}.` : ''}
          </p>
          <ul className="market">
            {m.reference.map((r) => (
              <li key={r.store}>
                <span>
                  {r.url && r.url.startsWith('https://') ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      {r.store}
                    </a>
                  ) : (
                    r.store
                  )}
                  {r.title && <small>{r.title}</small>}
                </span>
                <strong>{money(r.price)}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">{health?.channel3 === 'failing' ? 'Channel3 could not be reached, so your agent has no market prices to cite.' : health?.channel3 === 'configured' ? 'Channel3 found no similar items for this search, so your agent has no market prices to cite.' : 'No market prices. Add a Channel3 key so your agent can cite real merchant prices.'}</p>
      )}
    </section>
  );
}

export function PaymentPanel({ session, st, cap, currency }: { session: SessionView; st: AState; cap: number; currency: string }) {
  const p = st.passport?.payment ?? session.payment;
  const ev = st.payment;
  let title = 'No payment attached';
  let body = 'PayPal is not connected on this server, so nothing will be charged.';
  let tone: 'ok' | 'bad' | 'plain' = 'plain';

  // Once PayPal has said anything about the capture, the shared resolver decides what it means, and nothing else may.
  if (p.captureStatus || p.captureId) {
    const o = paymentOutcome(p);
    title = PAYMENT_TEXT[o].title;
    body = ev && (o === 'completed' || o === 'pending') && (ev.status === 'captured' || ev.status === 'pending') ? ev.message : PAYMENT_TEXT[o].body;
    tone = o === 'completed' ? 'ok' : o === 'unsuccessful' ? 'bad' : 'plain';
  } else if (ev) {
    title = ev.status === 'voided' ? 'Hold released' : ev.status === 'failed' ? 'Payment problem' : 'No payment made';
    body = ev.message;
    tone = ev.status === 'failed' ? 'bad' : 'plain';
  } else if (p.voided) {
    title = 'Hold released';
    body = 'No deal, so the authorization was voided and nothing was charged.';
  } else if (session.state === 'awaiting_approval') {
    title = 'Waiting for your approval';
    body = `Approve up to ${money(cap, currency)} in PayPal to let the agents start.`;
  } else if (p.authId) {
    title = 'Hold placed';
    body = `PayPal is holding up to ${money(cap, currency)} in the sandbox. Only the agreed price will be captured.`;
  }
  return (
    <section className={`panel pay ${tone}`}>
      <h2>{title}</h2>
      <p className="small">{body}</p>
      {p.error && <p className="small bad-text">{p.error}</p>}
      {p.webhook && <p className="small muted">Confirmed by a verified PayPal webhook ({p.webhook.event.replace('PAYMENT.CAPTURE.', '').toLowerCase()}).</p>}
    </section>
  );
}

/* ----------------------------- the Deal Passport ----------------------------- */

export function PassportCard({ p }: { p: Passport }) {
  const deal = p.outcome === 'deal';
  const cur = p.item.currency;
  const pay = paymentOutcome(p.payment);
  const unfinished = deal && (pay === 'pending' || pay === 'unverified');
  const [copied, setCopied] = useState(false);
  const [check, setCheck] = useState<Verification | { error: string } | 'busy' | null>(null);
  async function verify() {
    setCheck('busy');
    try {
      setCheck(await verifyPassportLive(p.id));
    } catch (e) {
      setCheck({ error: e instanceof Error ? e.message : 'Could not reach the server' });
    }
  }
  const summary = `I sent an AI agent to haggle for "${p.item.title}" on Bazaar: ${money(p.item.listPrice, cur)} down to ${p.agreedPrice !== undefined ? money(p.agreedPrice, cur) : '?'} in ${p.rounds ?? '?'} rounds (PayPal sandbox, no real money).`;

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `bazaar-passport-${p.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${summary} ${window.location.origin}/#/p/${p.id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <motion.article className="passport" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} aria-labelledby="pp-title">
      <header>
        <h2 id="pp-title">Deal Passport</h2>
        <span className="badge">PayPal sandbox</span>
      </header>

      <div className="pp-main">
        <div className="pp-art">{p.item.imageUrl ? <img src={p.item.imageUrl} alt="" referrerPolicy="no-referrer" /> : <ProductArt title={p.item.title} />}</div>
        <div className="pp-deal">
          <p className="pp-item">{p.item.title}</p>
          {deal ? (
            <>
              <p className="pp-price">{money(p.agreedPrice!, cur)}</p>
              <p className="pp-save">
                You saved {money(p.savings ?? 0, cur)} ({p.savingsPct}% off the list price of {money(p.item.listPrice, cur)}) in {p.rounds} {p.rounds === 1 ? 'round' : 'rounds'}.
              </p>
              {unfinished && <p className="pp-save">{PAYMENT_TEXT[pay].body}</p>}
            </>
          ) : (
            <>
              <p className="pp-price none">No deal</p>
              <p className="pp-save">The agents couldn't agree inside both limits. Nothing was charged.</p>
            </>
          )}
        </div>
        <motion.div className={`stamp${deal && !unfinished && pay !== 'refunded' ? '' : ' none'}`} initial={{ scale: 2.2, opacity: 0, rotate: -18 }} animate={{ scale: 1, opacity: 1, rotate: -9 }} transition={{ delay: 0.5, type: 'spring', stiffness: 260, damping: 18 }}>
          {!deal ? 'No deal' : unfinished ? 'Pending' : pay === 'refunded' || pay === 'partially_refunded' ? 'Refunded' : 'Settled'}
        </motion.div>
      </div>

      <dl className="checks">
        <div>
          <dt>Why this result</dt>
          <dd>{p.explanation}</dd>
        </div>
        <div>
          <dt>The limit</dt>
          <dd>
            {p.mandate.buyerCap === undefined
              ? deal
                ? 'The price was inside the buyer\'s private limit. The limit itself is not shown on a shared passport.'
                : 'Nothing was charged. The limit is not shown on a shared passport.'
              : deal
                ? `The price is inside your ${money(p.mandate.buyerCap, cur)} limit.`
                : `You were never charged. Limit was ${money(p.mandate.buyerCap, cur)}.`}
          </dd>
        </div>
        {p.crawl && (
          <div>
            <dt>Street crawl</dt>
            <dd>
              <ul className="crawl-sum">
                {p.crawl.stalls.map((x) => (
                  <li key={x.title} className={x.result}>
                    <span>{x.title}</span>
                    <strong>{x.result === 'won' ? `Won at ${money(x.price ?? 0, cur)}` : x.result === 'lost' ? `Lost, had agreed ${money(x.price ?? 0, cur)}` : x.lastAsk !== undefined ? `No deal, last ask ${money(x.lastAsk, cur)}` : 'No deal'}</strong>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        <div>
          <dt>Limit guard</dt>
          <dd>{p.mandate.guardrailBlocks ? `${p.mandate.guardrailBlocks} unsafe ${p.mandate.guardrailBlocks === 1 ? 'proposal' : 'proposals'} blocked.` : 'No proposals needed blocking.'}</dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>
            {p.agents.ai === 'mock'
              ? 'Offline demo agents. These were scripted, not real AI.'
              : !p.agents.usage || p.agents.usage.moves === 0
                ? `${aiLabel(p.agents.ai)}, a real AI model on both sides.`
                : p.agents.usage.fallbackMoves === 0
                  ? `${aiLabel(p.agents.ai)}: all ${p.agents.usage.moves} moves came from the AI model.`
                  : `${aiLabel(p.agents.ai)}: ${p.agents.usage.moves - p.agents.usage.fallbackMoves} of ${p.agents.usage.moves} moves came from the AI model and ${p.agents.usage.fallbackMoves} from Bazaar's built-in fallback agent, used when the model failed or answered unusably.`}
          </dd>
        </div>
        <div>
          <dt>Market evidence</dt>
          <dd>{p.market.reference.length ? p.market.reference.map((r) => `${r.store} ${money(r.price, cur)}`).join(', ') : 'None used.'}</dd>
        </div>
        <div>
          <dt>PayPal</dt>
          <dd>
            {p.payment.mode === 'not_configured' ? (
              p.payment.rehearsal ? 'Rehearsal by choice: PayPal was skipped and nothing was charged.' : 'Not connected, so no payment was attempted.'
            ) : (
              <>
                <strong>{PAYMENT_TEXT[pay].title}.</strong>{' '}
                {pay === 'completed' || pay === 'pending' || pay === 'refunded' || pay === 'partially_refunded' ? `Capture of ${p.agreedPrice !== undefined ? money(p.agreedPrice, cur) : 'the agreed price'}. ` : ''}
                {pay === 'none' && p.payment.voided ? 'The authorization was voided. ' : ''}
                {p.payment.finalAuthStatus ? `Authorization ${p.payment.finalAuthStatus.toLowerCase()}. ` : ''}
                {p.payment.webhook ? 'Confirmed by a verified PayPal webhook. ' : ''}
                <span className="ids">
                  {p.payment.orderId && <code>order {p.payment.orderId}</code>}
                  {p.payment.authId && <code>auth {p.payment.authId}</code>}
                  {p.payment.captureId && <code>capture {p.payment.captureId}</code>}
                </span>
                {deal && (
                  <span className="verify">
                    <button type="button" className="ghost" onClick={verify} disabled={check === 'busy'}>
                      {check === 'busy' ? 'Asking PayPal…' : 'Verify with PayPal now'}
                    </button>
                    {check && check !== 'busy' && (
                      <span role="status" className={`verify-result${'error' in check ? ' bad-text' : 'verified' in check && check.verified ? ' good' : ''}`}>
                        {'error' in check
                          ? check.error
                          : check.reason
                            ? check.reason
                            : check.verified
                              ? `PayPal reports the capture as ${check.status} for ${money(check.amount ?? 0, check.currency)}, which matches this passport.`
                              : `PayPal reports the capture as ${check.status}${check.matchesPassport === false ? ` for ${money(check.amount ?? 0, check.currency)}, which does NOT match this passport` : ', so it is not confirmed yet'}.`}
                        {'checkedAt' in check ? ` Checked ${new Date(check.checkedAt).toLocaleTimeString()}.` : ''}
                      </span>
                    )}
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
      </dl>

      <details className="transcript">
        <summary>Full transcript ({p.transcript.length} moves)</summary>
        <ol>
          {p.transcript.map((t, i) => (
            <li key={i}>
              <strong>{t.stall ? `${t.side === 'buyer' ? 'Your agent to' : ''} ${t.stall}`.trim() : t.side === 'buyer' ? 'Your agent' : t.side === 'seller' ? 'Seller' : 'Bazaar elder'}</strong>
              {t.price != null ? ` ${money(t.price, cur)}` : ''}: {t.line}
            </li>
          ))}
        </ol>
      </details>

      <footer>
        <a className="primary" href="#/">
          Haggle for something else
        </a>
        {deal && (
          <button className="ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy shareable summary'}
          </button>
        )}
        <button className="ghost" onClick={download}>
          Download passport
        </button>
        <button className="ghost" onClick={() => window.print()}>
          Print
        </button>
      </footer>
    </motion.article>
  );
}
