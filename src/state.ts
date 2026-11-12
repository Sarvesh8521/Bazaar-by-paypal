import type { Turn } from '../server/agents.ts';
import type { NegEvent, Passport, SessionView, ViewEvent } from './api';

/* ------------------------------------------------------------------ *
 * Everything the arena shows is derived from the stream of events.
 * Pure functions here, so the same code serves live play and reloads.
 * ------------------------------------------------------------------ */

export type DealEv = Extract<ViewEvent, { type: 'deal' }>;
export type PayEv = Extract<ViewEvent, { type: 'payment' }>;
export type GuardEv = Extract<NegEvent, { type: 'guardrail' }>;
export type CrawlEndEv = Extract<ViewEvent, { type: 'crawl_end' }>;
export type UiTurn = Turn & { lane?: string };

export interface LaneState {
  turns: Turn[];
  guards: GuardEv[];
  held?: DealEv; // this stall agreed to a price (a crawl may still pick a cheaper one)
  noDeal?: string;
}
export interface AState {
  turns: UiTurn[];
  guards: GuardEv[];
  lanes: Record<string, LaneState>;
  deal?: DealEv;
  noDeal?: string;
  payment?: PayEv;
  passport?: Passport;
  error?: string;
  best?: { lane: string; price: number; cap: number };
  crawlEnd?: CrawlEndEv;
}
export type Act = { type: 'event'; ev: ViewEvent } | { type: 'hydrate'; events: ViewEvent[]; passport?: Passport };

export const emptyState = (): AState => ({ turns: [], guards: [], lanes: {} });

function applyLane(l: LaneState, ev: NegEvent): LaneState {
  switch (ev.type) {
    case 'turn':
      return { ...l, turns: [...l.turns, ev.turn] };
    case 'guardrail':
      return { ...l, guards: [...l.guards, ev] };
    case 'deal':
      return { ...l, held: ev };
    case 'no_deal':
      return { ...l, noDeal: ev.reason };
    default:
      return l;
  }
}

export function apply(s: AState, ev: ViewEvent): AState {
  switch (ev.type) {
    case 'turn':
      return { ...s, turns: [...s.turns, ev.turn] };
    case 'guardrail':
      return { ...s, guards: [...s.guards, ev] };
    case 'deal':
      return { ...s, deal: ev };
    case 'no_deal':
      return { ...s, noDeal: ev.reason };
    case 'payment':
      return { ...s, payment: ev };
    case 'passport':
      return { ...s, passport: ev.passport };
    case 'error':
      return { ...s, error: ev.message };
    case 'lane': {
      const cur = s.lanes[ev.lane] ?? { turns: [], guards: [] };
      const next: AState = { ...s, lanes: { ...s.lanes, [ev.lane]: applyLane(cur, ev.ev) } };
      if (ev.ev.type === 'turn') next.turns = [...s.turns, { ...ev.ev.turn, lane: ev.lane }];
      if (ev.ev.type === 'guardrail') next.guards = [...s.guards, ev.ev];
      return next;
    }
    case 'best':
      return { ...s, best: { lane: ev.lane, price: ev.price, cap: ev.cap } };
    case 'crawl_end':
      return { ...s, crawlEnd: ev };
    default:
      return s;
  }
}

export function reducer(s: AState, a: Act): AState {
  if (a.type === 'event') return apply(s, a.ev);
  return a.events.reduce(apply, { ...emptyState(), passport: a.passport });
}

/** Rebuild the event stream from a saved session (page reload, or following a run in progress). */
export function eventsFromSession(s: SessionView): ViewEvent[] {
  if (s.mode === 'single') return s.events;
  const evs: ViewEvent[] = Object.entries(s.lanes).flatMap(([lane, list]) => list.map((ev): ViewEvent => ({ type: 'lane', lane, ev })));
  if (s.best) evs.push({ type: 'best', ...s.best });
  if (s.crawl) evs.push({ type: 'crawl_end', ...s.crawl });
  return evs;
}

export const hydrateFrom = (s: SessionView): Act => ({ type: 'hydrate', events: eventsFromSession(s), passport: s.passport });

/**
 * A recorded crawl, as a stream you can play. The saved view keeps each stall's events separately, so this
 * interleaves them round by round (the order they really happened in) and puts each "limit lowered" update
 * right after the deal that caused it.
 */
export function replayEvents(s: SessionView): ViewEvent[] {
  const finish = (): ViewEvent[] => (s.passport ? [{ type: 'passport', passport: s.passport }] : []);
  if (s.mode === 'single') return [...s.events, ...finish()];

  const lanes = s.items.map((i) => ({ id: i.id, evs: [...(s.lanes[i.id] ?? [])] }));
  const bests = [...(s.bests ?? [])];
  const out: ViewEvent[] = [];
  const emit = (lane: string, ev: NegEvent) => {
    out.push({ type: 'lane', lane, ev });
    if (ev.type === 'deal') {
      const i = bests.findIndex((b) => b.lane === lane && b.price === ev.price);
      if (i >= 0) out.push({ type: 'best', ...bests.splice(i, 1)[0] });
    }
  };
  const maxRound = Math.max(0, ...lanes.flatMap((l) => l.evs.flatMap((e) => (e.type === 'turn' ? [e.turn.round] : []))));
  for (let r = 1; r <= maxRound; r++) {
    for (const l of lanes) {
      while (l.evs.length) {
        const e = l.evs[0];
        if (e.type === 'turn' && e.turn.round > r) break;
        l.evs.shift();
        emit(l.id, e);
      }
    }
  }
  for (const l of lanes) for (const e of l.evs) emit(l.id, e);
  if (s.crawl) out.push({ type: 'crawl_end', ...s.crawl });
  const w = s.crawl?.winner;
  if (w) out.push({ type: 'deal', price: w.price, rounds: w.rounds, savings: w.savings, savingsPct: w.savingsPct, currency: s.items[0].currency });
  return [...out, ...finish()];
}
