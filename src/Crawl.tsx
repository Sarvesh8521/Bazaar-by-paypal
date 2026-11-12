import { motion } from 'framer-motion';
import { Lantern, type Mood } from './art';
import { BUYER_STYLES, SELLER_STYLES, money, type PublicListing, type SessionView } from './api';
import { Bubble, PriceTag } from './stage';
import type { AState } from './state';

export type Speaking = { lane: string | null; side: 'buyer' | 'seller' } | null;

/* One horizontal bar per stall: the buyer's offer and the stall's ask close in on each other, under the buyer's current limit. */
export function LaneBar({ list, cap, buyer, seller, held, currency }: { list: number; cap?: number; buyer?: number; seller?: number; held?: number; currency: string }) {
  const lo = list * 0.4;
  const hi = list * 1.03;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  const spring = { type: 'spring' as const, stiffness: 140, damping: 20 };
  const both = buyer !== undefined && seller !== undefined && held === undefined;
  return (
    <div className="lbar" role="img" aria-label={`Offer ${buyer !== undefined ? money(buyer, currency) : 'none yet'}, stall asks ${seller !== undefined ? money(seller, currency) : 'list price'}${cap !== undefined ? `, limit ${money(cap, currency)}` : ''}`}>
      <div className="lbar-rail" />
      {both && <motion.div className="lbar-gap" initial={false} animate={{ left: `${pct(buyer)}%`, width: `${Math.max(0, pct(seller) - pct(buyer))}%` }} transition={spring} />}
      {cap !== undefined && <div className="lbar-cap" style={{ left: `${pct(cap)}%` }} title={`Your limit ${money(cap, currency)}`} />}
      {held === undefined && buyer !== undefined && (
        <motion.div className="lbar-pin buyer" initial={false} animate={{ left: `${pct(buyer)}%` }} transition={spring}>
          <span>{money(buyer, currency)}</span>
        </motion.div>
      )}
      {held === undefined && seller !== undefined && (
        <motion.div className="lbar-pin seller" initial={false} animate={{ left: `${pct(seller)}%` }} transition={spring}>
          <span>{money(seller, currency)}</span>
        </motion.div>
      )}
      {held !== undefined && (
        <motion.div className="lbar-pin held" initial={false} animate={{ left: `${pct(held)}%` }} transition={spring}>
          <span>{money(held, currency)}</span>
        </motion.div>
      )}
    </div>
  );
}

type Status = 'wait' | 'live' | 'held' | 'won' | 'lost' | 'out';

function LaneCard({ item, st, cap, winner, ended, speaking }: { item: PublicListing; st: AState; cap?: number; winner?: string; ended: boolean; speaking: Speaking }) {
  const ls = st.lanes[item.id] ?? { turns: [], guards: [] };
  const lastSeller = [...ls.turns].reverse().find((t) => t.side === 'seller' && t.price != null);
  const lastBuyer = [...ls.turns].reverse().find((t) => t.side === 'buyer' && t.price != null);
  const last = ls.turns.at(-1);
  const status: Status = ended && winner === item.id ? 'won' : ended && ls.held ? 'lost' : ended ? 'out' : ls.held ? 'held' : ls.turns.length ? 'live' : 'wait';
  const label: Record<Status, string> = {
    wait: 'Waiting for round 1',
    live: 'Haggling',
    held: `Deal in hand at ${ls.held ? money(ls.held.price, item.currency) : ''}`,
    won: `Winner at ${ls.held ? money(ls.held.price, item.currency) : ''}`,
    lost: `Lost: it had agreed ${ls.held ? money(ls.held.price, item.currency) : ''}`,
    out: cap !== undefined && lastSeller?.price != null && lastSeller.price > cap ? `Out: its last ask of ${money(lastSeller.price, item.currency)} stayed above your limit` : 'Out: no agreement reached',
  };
  const talking = speaking?.lane === item.id && speaking.side === 'seller';
  const mood: Mood = status === 'won' ? 'delighted' : status === 'lost' || status === 'out' ? 'sulking' : status === 'held' ? 'pleased' : talking ? 'scheming' : 'calm';
  return (
    <li className={`lane ${status}`}>
      <div className="lane-head">
        <Lantern tone="seller" persona={item.sellerPersona} mood={mood} speaking={talking} size={54} />
        <div>
          <h3>{item.title}</h3>
          <p className="muted small">
            List {money(item.listPrice, item.currency)}. {SELLER_STYLES[item.sellerPersona]}.
          </p>
        </div>
        <span className={`lane-status ${status}`}>{label[status]}</span>
      </div>
      <LaneBar list={item.listPrice} cap={cap} buyer={lastBuyer?.price ?? undefined} seller={lastSeller?.price ?? undefined} held={ls.held?.price} currency={item.currency} />
      {last && <p className="lane-line">{last.side === 'buyer' ? `Your agent: ${last.line}` : `${item.title.split(',')[0]}: ${last.line}`}</p>}
    </li>
  );
}

export function CrawlStage({ session, st, shock, speaking, mood }: { session: SessionView; st: AState; shock: boolean; speaking: Speaking; mood: Mood }) {
  const items = session.items;
  const titles = Object.fromEntries(items.map((i) => [i.id, i.title]));
  const currency = items[0].currency;
  const ended = Boolean(st.crawlEnd) || Boolean(st.passport);
  const winnerLane = st.crawlEnd?.winner?.lane;
  const hidden = session.limitHidden; // a public recording never shows the buyer's limit
  const cap: number | undefined = st.best?.cap ?? (hidden ? undefined : session.maxBudget);
  const lowered = st.best !== undefined && (hidden || (cap as number) < session.maxBudget);
  const lastBuyer = [...st.turns].reverse().find((t) => t.side === 'buyer');
  const round = st.turns.reduce((m, t) => Math.max(m, t.round), 0);
  const winnerPrice = st.crawlEnd?.winner?.price;
  const tagValue = winnerPrice ?? st.best?.price ?? Math.min(...items.map((i) => i.listPrice));
  const tagCaption = winnerLane ? `Winner: ${titles[winnerLane]}` : st.best ? `Best deal in hand: ${titles[st.best.lane]}` : 'Lowest list price';
  const summary = ended
    ? winnerPrice !== undefined
      ? `The crawl is over. ${titles[winnerLane!]} won at ${money(winnerPrice, currency)}.`
      : 'The crawl is over. No stall could agree inside your limit.'
    : round === 0
      ? `Your agent is about to work ${items.length} stalls at once.`
      : `Round ${round}.${st.best ? ` Best deal in hand is ${money(st.best.price, currency)}. The buyer's limit is now just under it.` : ' No stall has agreed yet.'}`;

  return (
    <section className="crawl" aria-label={`Street crawl across ${items.length} stalls`}>
      <div className="crawl-top">
        <div className="side buyer-side">
          <Bubble tone="buyer" turn={lastBuyer} label={lastBuyer?.lane ? titles[lastBuyer.lane] : undefined} active={speaking?.side === 'buyer'} empty="Ready to work the whole row." />
          <Lantern tone="buyer" mood={shock ? 'shocked' : mood} persona={session.buyerPersona} speaking={speaking?.side === 'buyer'} size={140} />
          <div className="who">
            Your agent <span>{BUYER_STYLES[session.buyerPersona].name}</span>
          </div>
        </div>
        <PriceTag value={tagValue} caption={tagCaption} swing={1} swingKey={`${st.best?.price ?? ''}-${winnerLane ?? ''}`} deal={winnerPrice !== undefined} currency={currency} />
        <div className={`limit-chip${lowered ? ' lowered' : ''}`}>
          <span>{hidden ? 'Buyer\'s limit' : 'Your limit now'}</span>
          <strong>{cap !== undefined ? money(cap, currency) : 'Private'}</strong>
          <small>{lowered ? (hidden ? `Dropped to just under ${money(st.best!.price, currency)} because a stall had already agreed to that price. The agent can only improve on it.` : `Lowered from ${money(session.maxBudget, currency)} because a stall has already agreed to ${money(st.best!.price, currency)}. Your agent can only improve on it.`) : hidden ? 'A recording never shows the buyer\'s private limit. When a stall agrees to a price, the limit drops below it.' : 'Only you can see this. When a stall agrees to a price, this drops below it.'}</small>
        </div>
      </div>
      <p className="crawl-live" aria-live="polite">
        {summary}
      </p>
      <ul className="lanes">
        {items.map((item) => (
          <LaneCard key={item.id} item={item} st={st} cap={cap} winner={winnerLane} ended={ended} speaking={speaking} />
        ))}
      </ul>
    </section>
  );
}
