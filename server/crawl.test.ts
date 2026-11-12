import test from 'node:test';
import assert from 'node:assert/strict';
import { mockLlm, type Deal, type LlmFn } from './agents.ts';
import { crawl, type CrawlEvent, type CrawlLane } from './crawl.ts';

const lane = (id: string, list: number, floor: number, persona: Deal['seller']['persona'] = 'stubborn'): CrawlLane => ({
  id,
  title: `Stall ${id}`,
  deal: { item: { title: `Stall ${id}`, listPrice: list, currency: 'USD' }, buyer: { maxBudget: 150, persona: 'friendly' }, seller: { floorPrice: floor, persona }, rivals: 2 },
});

async function run(lanes: CrawlLane[], llm: LlmFn = mockLlm, max = 150) {
  const evs: CrawlEvent[] = [];
  for await (const e of crawl(lanes, llm, max)) evs.push(e);
  return evs;
}
const end = (evs: CrawlEvent[]) => evs.find((e) => e.type === 'crawl_end') as Extract<CrawlEvent, { type: 'crawl_end' }>;

test('three stalls haggle in parallel and the cheapest deal wins', async () => {
  const evs = await run([lane('a', 200, 120), lane('b', 180, 95), lane('c', 190, 110)]);
  const e = end(evs);
  assert.ok(e.winner, 'expected a winner');
  const held = e.results.filter((r) => r.outcome === 'held').map((r) => r.price!);
  assert.equal(e.winner!.price, Math.min(...held));
  assert.ok(e.winner!.price <= 150);
  assert.equal(e.results.length, 3);
  // every stall produced events
  for (const id of ['a', 'b', 'c']) assert.ok(evs.some((x) => x.type === 'lane' && x.lane === id && x.ev.type === 'turn'), `no turns for ${id}`);
});

test('stalls move in lockstep: nobody starts round N+1 before everyone finished round N', async () => {
  const evs = await run([lane('a', 200, 100), lane('b', 200, 105), lane('c', 200, 110)]);
  const rounds = evs.flatMap((x) => (x.type === 'lane' && x.ev.type === 'turn' ? [x.ev.turn.round] : []));
  for (let i = 1; i < rounds.length; i++) assert.ok(rounds[i] >= rounds[i - 1], `round went backwards at event ${i}: ${rounds.join(',')}`);
});

test('after one stall holds a deal, the buyer can never again offer more than that price in any other stall', async () => {
  const offers: { lane: string; price: number; atHeld: number | null }[] = [];
  let heldBest: number | null = null;
  const spy: LlmFn = async (call) => {
    const out = JSON.parse(await mockLlm(call));
    if (call.ctx.side === 'buyer' && out.action === 'offer') offers.push({ lane: call.system.match(/<listing>(Stall \w)<\/listing>/)?.[1] ?? '?', price: out.price, atHeld: heldBest });
    return JSON.stringify(out);
  };
  const lanes = [lane('a', 200, 100), lane('b', 200, 90), lane('c', 200, 140)];
  for await (const e of crawl(lanes, spy, 150)) {
    if (e.type === 'best') heldBest = e.price;
    if (e.type === 'lane' && e.ev.type === 'turn' && e.ev.turn.side === 'buyer' && e.ev.turn.price != null && heldBest !== null && e.ev.turn.action === 'offer') {
      assert.ok(e.ev.turn.price < heldBest + 1e-9, `buyer offered ${e.ev.turn.price} after a deal at ${heldBest} was in hand`);
    }
  }
  assert.ok(offers.length > 0);
});

test('a held deal lowers the buyer cap in every other stall, and the cheaper stall wins', async () => {
  // Stall a's seller grabs the buyer's very first offer; b and c keep haggling.
  const eagerA: LlmFn = async (call) => {
    if (call.ctx.side === 'seller' && call.system.includes('Stall a') && call.ctx.lastTheirs != null) {
      return JSON.stringify({ action: 'accept', price: call.ctx.lastTheirs, line: 'Sold!', tactic: 'quick close' });
    }
    return mockLlm(call);
  };
  const caps: Record<string, number[]> = { b: [], c: [] };
  const spy: LlmFn = async (call) => {
    if (call.ctx.side === 'buyer') for (const k of ['b', 'c']) if (call.system.includes(`Stall ${k}`)) caps[k].push(call.ctx.bound);
    return eagerA(call);
  };
  const evs: CrawlEvent[] = [];
  for await (const e of crawl([lane('a', 200, 60), lane('b', 200, 100), lane('c', 200, 110)], spy, 150)) evs.push(e);

  const best = evs.find((e) => e.type === 'best') as Extract<CrawlEvent, { type: 'best' }>;
  assert.equal(best.lane, 'a');
  assert.equal(best.price, 110, 'the buyer opens at 55% of 200');
  assert.equal(best.cap, 109.99);
  for (const k of ['b', 'c']) {
    assert.equal(caps[k][0], 150, `${k} starts with the full limit`);
    assert.ok(caps[k].length > 1, `${k} should have had a second round`);
    assert.ok(caps[k].slice(1).every((c) => c <= 109.99 + 1e-9), `${k} cap after the held deal: ${caps[k]}`);
  }
  const e = end(evs);
  assert.ok(e.winner && e.winner.price <= 110);
});

test('buyer intel mentions the other stalls but never any stall\'s secret floor', async () => {
  const intel: string[] = [];
  const sellerPrompts: string[] = [];
  const spy: LlmFn = async (call) => {
    if (call.ctx.side === 'buyer') intel.push(call.user);
    else sellerPrompts.push(call.system + call.user);
    return mockLlm(call);
  };
  await run([lane('a', 200, 111.11), lane('b', 200, 122.22), lane('c', 200, 133.33)], spy);
  const joined = intel.join('\n');
  assert.ok(/Other stalls on this street right now: .*Stall [abc]/.test(joined), 'buyer should be told about rival stalls');
  for (const f of ['111.11', '122.22', '133.33']) assert.ok(!joined.includes(f), `buyer prompt leaked floor ${f}`);
  // sellers know rivals exist, but never see another stall's asks, floor or the buyer's cap
  for (const p of sellerPrompts) {
    assert.ok(!/Other stalls on this street right now/.test(p));
    assert.ok(!p.includes('150.00'), 'seller prompt leaked the buyer cap');
  }
});

test('no overlap anywhere means no winner', async () => {
  const e = end(await run([lane('a', 200, 180), lane('b', 200, 190)], mockLlm, 100));
  assert.equal(e.winner, null);
  assert.ok(e.results.every((r) => r.outcome === 'no_deal'));
});

test('a stall whose model keeps failing falls back and the crawl still finishes', async () => {
  const flaky: LlmFn = async (call) => {
    if (call.system.includes('Stall b')) throw new Error('boom');
    return mockLlm(call);
  };
  const e = end(await run([lane('a', 200, 100), lane('b', 200, 100)], flaky));
  assert.equal(e.results.length, 2);
});

test('a single stall still works through the crawl path', async () => {
  const e = end(await run([lane('a', 200, 100)]));
  assert.ok(e.winner && e.winner.price >= 100 && e.winner.price <= 150);
});
