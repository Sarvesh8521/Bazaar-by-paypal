import { cleanText, negotiate, type Deal, type LlmFn, type NegEvent } from './agents.ts';

/* ------------------------------------------------------------------ *
 * The Street Crawl: one buyer agent works several stalls at once.
 *
 *  - Every stall runs the normal 1:1 negotiation (same guardrails).
 *  - Stalls advance in lockstep rounds (a barrier), so the buyer's agent
 *    always sees every stall's latest public ask before its next move.
 *  - When a stall reaches a deal it is "held". From then on the buyer's cap
 *    in every other stall drops to just under the best held price, so the
 *    agent can only ever improve on a deal it already has.
 *  - The cheapest held deal wins. One PayPal authorization, one capture.
 *
 * Privacy: each stall only ever sees the buyer's own spoken lines. Rival
 * asks are public to the buyer (they are offers made to the buyer) and are
 * given to the buyer's agent only.
 * ------------------------------------------------------------------ */

export interface CrawlLane {
  id: string;
  title: string;
  deal: Deal; // each lane has its own Deal object (its own buyer cap)
}

export interface CrawlResult {
  lane: string;
  outcome: 'held' | 'no_deal';
  price?: number; // the deal that stall agreed to
  lastAsk?: number; // the stall's final public ask
}

export type CrawlEvent =
  | { type: 'lane'; lane: string; ev: NegEvent } // internal events: callers must redact before showing a client
  | { type: 'best'; lane: string; price: number; cap: number }
  | { type: 'crawl_end'; winner: { lane: string; price: number; rounds: number; savings: number; savingsPct: number } | null; results: CrawlResult[] };

const r2 = (n: number) => Math.round(n * 100) / 100;
const CENT = 0.01;

export async function* crawl(lanes: CrawlLane[], llm: LlmFn, buyerMax: number): AsyncGenerator<CrawlEvent> {
  const queue: CrawlEvent[] = [];
  let wake: (() => void) | null = null;
  let live = lanes.length;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const push = (e: CrawlEvent) => {
    queue.push(e);
    poke();
  };

  /* --- barrier: a round starts only when every still-active stall is ready for it --- */
  const active = new Set(lanes.map((l) => l.id));
  const arrived = new Map<number, Set<string>>();
  const waiting = new Map<number, Array<() => void>>();
  const release = (round: number) => {
    const here = arrived.get(round);
    if (!here) return;
    for (const id of active) if (!here.has(id)) return;
    const fns = waiting.get(round) ?? [];
    waiting.delete(round);
    for (const f of fns) f();
  };
  const barrier = (round: number, id: string) =>
    new Promise<void>((resolve) => {
      if (!arrived.has(round)) arrived.set(round, new Set());
      if (!waiting.has(round)) waiting.set(round, []);
      arrived.get(round)!.add(id);
      waiting.get(round)!.push(resolve);
      release(round);
    });

  /* --- shared public state --- */
  const held = new Map<string, { price: number; rounds: number; savings: number; savingsPct: number }>();
  const lastAsk = new Map<string, number>();
  const best = () => [...held.entries()].sort((a, b) => a[1].price - b[1].price)[0];
  const capNow = () => {
    const b = best();
    return b ? Math.max(0, r2(Math.min(buyerMax, b[1].price - CENT))) : buyerMax;
  };
  const intelFor = (id: string) =>
    lanes
      .filter((l) => l.id !== id)
      .map((l) => {
        const h = held.get(l.id);
        if (h) return `"${cleanText(l.title)}" already agreed to ${h.price}, so you must beat that`;
        const a = lastAsk.get(l.id);
        return a !== undefined ? `"${cleanText(l.title)}" currently asks ${a}` : `"${cleanText(l.title)}" has not named a price yet`;
      })
      .join('; ');

  const run = async (lane: CrawlLane) => {
    try {
      const hooks = {
        beforeRound: async (round: number) => {
          await barrier(round, lane.id);
          lane.deal.buyer.maxBudget = capNow();
        },
        buyerIntel: () => intelFor(lane.id),
      };
      for await (const ev of negotiate(lane.deal, llm, hooks)) {
        if (ev.type === 'turn' && ev.turn.side === 'seller' && ev.turn.price != null) lastAsk.set(lane.id, ev.turn.price);
        if (ev.type === 'deal') held.set(lane.id, { price: ev.price, rounds: ev.rounds, savings: ev.savings, savingsPct: ev.savingsPct });
        push({ type: 'lane', lane: lane.id, ev });
        if (ev.type === 'deal') {
          const b = best()!;
          push({ type: 'best', lane: b[0], price: b[1].price, cap: capNow() });
        }
      }
    } catch (e) {
      console.warn(`[crawl] stall "${lane.title}" failed:`, e instanceof Error ? e.message : e);
      push({ type: 'lane', lane: lane.id, ev: { type: 'no_deal', reason: 'This stall went quiet' } });
    } finally {
      active.delete(lane.id);
      for (const round of [...arrived.keys()]) release(round);
      live--;
      poke();
    }
  };

  const tasks = lanes.map(run);
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (live === 0) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await Promise.all(tasks);
  while (queue.length) yield queue.shift()!;

  const results: CrawlResult[] = lanes.map((l) => {
    const h = held.get(l.id);
    return h ? { lane: l.id, outcome: 'held', price: h.price, lastAsk: lastAsk.get(l.id) } : { lane: l.id, outcome: 'no_deal', lastAsk: lastAsk.get(l.id) };
  });
  const w = best();
  yield { type: 'crawl_end', winner: w ? { lane: w[0], ...w[1] } : null, results };
}
