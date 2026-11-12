import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { Awning, Bunting, Lantern, ProductArt, ShieldIcon, type Mood } from './art';
import { HaggleLine, PassportCard, PaymentPanel } from './Arena';
import { DeskView, SellForm } from './Seller';
import { CrawlStage } from './Crawl';
import { Guide, rows } from './App';
import { emptyState, eventsFromSession, hydrateFrom, reducer, replayEvents } from './state';
import { mockLlm } from '../server/agents.ts';
import { readFileSync } from 'node:fs';
import { createListing, createSession, publicPassport, resetStore, runSession, sessionView } from '../server/sessions.ts';
import type { Passport, SellerData, SessionView } from './api';

// React inserts <!-- --> between adjacent text nodes; strip them so text can be matched.
const html = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, '');

test('every lantern mood and persona renders', () => {
  const moods: Mood[] = ['calm', 'scheming', 'pleased', 'delighted', 'shocked', 'sulking'];
  for (const tone of ['buyer', 'seller'] as const)
    for (const persona of ['friendly', 'stubborn', 'dramatic'] as const)
      for (const mood of moods) {
        const out = html(<Lantern tone={tone} persona={persona} mood={mood} speaking={mood === 'calm'} />);
        assert.ok(out.includes('<svg') && out.includes(`aria-label="${tone === 'buyer' ? 'Your' : 'Seller'} agent, ${mood}"`), `${tone}/${persona}/${mood}`);
      }
});

test('decor and product art render', () => {
  assert.ok(html(<Bunting />).includes('bunt-lamp'));
  assert.ok(html(<Awning />).includes('awn-trim'));
  assert.ok(html(<ShieldIcon />).includes('<svg'));
  for (const t of ['Wireless headphones', 'Mechanical keyboard', 'Instant film camera', 'Vintage lamp']) assert.ok(html(<ProductArt title={t} />).includes(`Illustration for ${t}`));
});

test('haggle line shows list, limit, market ticks and both live positions', () => {
  const out = html(<HaggleLine list={200} cap={150} market={[{ store: 'shop.test', price: 130 }, { store: 'other.test', price: 175 }]} buyer={110} seller={170} currency="USD" />);
  for (const s of ['List $200', 'Your limit $150', 'shop.test $130', 'other.test $175', '$110', '$170', '$60 apart']) assert.ok(out.includes(s), `missing "${s}"`);
  assert.ok(!out.includes('hl-deal'));
});

test('haggle line without offers still shows the limit and list', () => {
  const out = html(<HaggleLine list={95} cap={80} market={[]} currency="USD" />);
  assert.ok(out.includes('Your limit $80') && out.includes('List $95'));
});

test('haggle line on a deal shows the burst instead of the pins', () => {
  const out = html(<HaggleLine list={200} cap={150} market={[]} buyer={139} seller={139} deal={139} currency="USD" />);
  assert.ok(out.includes('Deal $139'));
  assert.equal((out.match(/<u /g) ?? []).length, 14);
  assert.ok(!out.includes('hl-pin'));
});

const passport = (over: Partial<Passport> = {}): Passport => ({
  id: 'abcd1234-0000',
  createdAt: new Date().toISOString(),
  settledAt: new Date().toISOString(),
  item: { title: 'Instant film camera', listPrice: 95, currency: 'USD' },
  outcome: 'deal',
  explanation: 'Instant film camera agreed to 76.00 USD, inside your limit, and PayPal was asked to capture only that amount.',
  agreedPrice: 76,
  savings: 19,
  savingsPct: 20,
  rounds: 4,
  mandate: { buyerCap: 85, respected: true, guardrailBlocks: 1, blockedKinds: ['over_budget'] },
  market: { source: 'channel3', reference: [{ store: 'shop.test', price: 90 }] },
  payment: { mode: 'paypal_sandbox', orderId: 'ORD1', authId: 'AUTH1', captureId: 'CAP1', captureStatus: 'COMPLETED', finalAuthStatus: 'CAPTURED' },
  agents: { buyer: 'friendly', seller: 'dramatic', ai: 'gemini' },
  transcript: [{ round: 1, side: 'buyer', action: 'offer', price: 52, line: 'Hello', tactic: 'anchor low' }],
  ...over,
});

test('deal passport shows price, savings, limit check and PayPal ids', () => {
  const out = html(<PassportCard p={passport()} />);
  for (const s of ['Deal Passport', 'Settled', '$76', 'You saved $19', '20% off', 'inside your $85 limit', '1 unsafe proposal blocked', 'Gemini agents', 'shop.test $90', 'Payment completed', 'Capture of $76', 'Verify with PayPal now', 'order ORD1', 'capture CAP1', 'Copy shareable summary', 'Why this result', 'agreed to 76.00 USD'])
    assert.ok(out.includes(s), `missing "${s}"`);
});

test('mock agents are labelled honestly on the passport', () => {
  const out = html(<PassportCard p={passport({ agents: { buyer: 'friendly', seller: 'dramatic', ai: 'mock' }, payment: { mode: 'not_configured' } })} />);
  assert.ok(out.includes('scripted, not real AI'));
  assert.ok(out.includes('Not connected, so no payment was attempted'));
});

test('no-deal passport says nothing was charged', () => {
  const out = html(<PassportCard p={passport({ outcome: 'no_deal', agreedPrice: undefined, savings: undefined, payment: { mode: 'paypal_sandbox', orderId: 'ORD1', authId: 'AUTH1', voided: true, finalAuthStatus: 'VOIDED' } })} />);
  for (const s of ['No deal', 'Nothing was charged', 'Authorization voided']) assert.ok(out.includes(s), `missing "${s}"`);
  assert.ok(!out.includes('Copy shareable summary'));
});

const desk = (over: Partial<SellerData> = {}): SellerData => ({
  listing: { id: 'l1', title: 'Brass lantern', category: 'lamps', listPrice: 200, currency: 'USD', sellerPersona: 'stubborn', floorPrice: 100 },
  deals: [
    { id: 'aaaa1111', at: '2026-10-30T10:00:00.000Z', outcome: 'deal', price: 141, rounds: 3, buyerPersona: 'dramatic' },
    { id: 'bbbb2222', at: '2026-10-30T10:05:00.000Z', outcome: 'no_deal', buyerPersona: 'friendly' },
    { id: 'cccc3333', at: '2026-10-30T10:09:00.000Z', outcome: 'lost', price: 133, buyerPersona: 'stubborn' },
  ],
  stats: { negotiations: 3, agreed: 1, agreementPct: 33, sold: 1, conversionPct: 33, revenue: 141, simulatedDeals: 0, simulatedValue: 0, pendingPayments: 0, pendingValue: 0, refundedValue: 0, noDeal: 1, lost: 1, wonVsCompetitors: 1, avgPrice: 141, avgMarginOverFloor: 41 },
  ...over,
});

test('seller desk shows the private floor, stats and every haggle', () => {
  const out = html(<DeskView data={desk()} />);
  for (const s of ['Your secret floor', '$100', 'Only you can see this', 'Sold', '$141', 'Average above your floor', '$41', 'Lost to a cheaper stall', '$133', 'Verified sales', 'Verified revenue', 'Deals agreed', '33%', 'Won against rivals', 'holds the line', 'Showman', 'Charmer', 'No deal'])
    assert.ok(out.toLowerCase().includes(s.toLowerCase()), `missing "${s}"`);
  assert.ok(out.includes('<table') && out.includes('scope="col"'));
});

test('seller desk handles a stall with no haggles yet', () => {
  const out = html(<DeskView data={desk({ deals: [], stats: { negotiations: 0, agreed: 0, agreementPct: null, sold: 0, conversionPct: null, revenue: 0, simulatedDeals: 0, simulatedValue: 0, pendingPayments: 0, pendingValue: 0, refundedValue: 0, noDeal: 0, lost: 0, wonVsCompetitors: 0, avgPrice: null, avgMarginOverFloor: null } })} />);
  assert.ok(out.includes('No haggles yet') && out.includes('None yet') && !out.includes('<table'));
});

test('the stall form explains the secret floor and offers Channel3 search only when configured', () => {
  const on = html(<SellForm health={{ ok: true, agents: 'gemini', paypal: 'sandbox', channel3: 'configured' }} />);
  const off = html(<SellForm health={{ ok: true, agents: 'mock', paypal: 'not_configured', channel3: 'not_configured' }} />);
  for (const out of [on, off]) for (const s of ['Open your own stall', 'Secret floor', 'Buyers never see the floor', 'Open the stall']) assert.ok(out.includes(s), `missing "${s}"`);
  assert.ok(on.includes('Start from a real product'));
  assert.ok(!off.includes('Start from a real product'));
});

/* ------------------------- street crawl, end to end through server + UI state ------------------------- */

async function realCrawl() {
  resetStore();
  const stalls = [
    createListing({ title: 'Headphones A', category: 'headphones', listPrice: 200, floorPrice: 120 }),
    createListing({ title: 'Headphones B', category: 'headphones', listPrice: 180, floorPrice: 95 }),
    createListing({ title: 'Headphones C', category: 'headphones', listPrice: 190, floorPrice: 110 }),
  ];
  const s = await createSession({ listingIds: stalls.map((l) => l.id), maxBudget: 150, buyerPersona: 'dramatic' }, { pay: null, baseUrl: 'http://x', searchMarket: async () => [{ store: 'shop.test', price: 130 }] });
  const events = [];
  for await (const e of runSession(s.id, { llm: mockLlm, pay: null, aiMode: 'mock' })) events.push(e);
  return { view: sessionView(s), events };
}

test('stalls are grouped into rows, biggest row first', () => {
  const l = (id: string, category: string) => ({ id, title: id, category, listPrice: 10, currency: 'USD', sellerPersona: 'friendly' as const });
  const r = rows([l('a', 'cameras'), l('b', 'headphones'), l('c', 'headphones'), l('d', 'cameras'), l('e', 'headphones')]);
  assert.deepEqual(r.map((x) => [x.category, x.stalls.length]), [['headphones', 3], ['cameras', 2]]);
});

test('crawl UI state: live events and a reload rebuild the same picture', async () => {
  const { view, events } = await realCrawl();
  // live: fold the stream
  const live = events.reduce((s, ev) => reducer(s, { type: 'event', ev }), emptyState());
  // reload: rebuild from the saved session
  const back = reducer(emptyState(), hydrateFrom(view));
  assert.equal(Object.keys(live.lanes).length, 3);
  assert.deepEqual(Object.keys(back.lanes).sort(), Object.keys(live.lanes).sort());
  for (const id of Object.keys(live.lanes)) assert.equal(back.lanes[id].turns.length, live.lanes[id].turns.length, 'same turns per stall after a reload');
  assert.deepEqual(back.crawlEnd?.winner, live.crawlEnd?.winner);
  assert.deepEqual(back.best, live.best);
  assert.ok(live.crawlEnd?.winner, 'the mock crawl should find a winner');
  assert.ok(live.turns.every((t) => typeof t.lane === 'string'));
  assert.ok(eventsFromSession(view).every((e) => e.type === 'lane' || e.type === 'best' || e.type === 'crawl_end'));
});

test('crawl stage shows every stall, the lowered limit and the winner', async () => {
  const { view, events } = await realCrawl();
  const st = events.reduce((s, ev) => reducer(s, { type: 'event', ev }), emptyState());
  const out = html(<CrawlStage session={view} st={st} shock={false} speaking={null} mood="delighted" />);
  for (const t of ['Headphones A', 'Headphones B', 'Headphones C']) assert.ok(out.includes(t), `missing stall ${t}`);
  assert.ok(out.includes('Your limit now') && out.includes('The crawl is over'));
  assert.ok(out.includes('Winner at'));
  assert.equal((out.match(/class="lane won"/g) ?? []).length, 1, 'exactly one winning stall');
  assert.ok(out.includes('Winner: Headphones'));
});

test('crawl stage before the haggle starts invites the buyer and shows every stall waiting', async () => {
  const { view } = await realCrawl();
  const out = html(<CrawlStage session={view} st={emptyState()} shock={false} speaking={null} mood="calm" />);
  assert.ok(out.includes('about to work 3 stalls'));
  assert.equal((out.match(/Waiting for round 1/g) ?? []).length, 3);
  assert.ok(out.includes('Only you can see this'));
});

test('the crawl passport lists every stall and who won', async () => {
  const { events } = await realCrawl();
  const p = (events.find((e) => e.type === 'passport') as { passport: Passport }).passport;
  const out = html(<PassportCard p={p} />);
  assert.ok(out.includes('Street crawl'));
  assert.equal((out.match(/Won at/g) ?? []).length, 1);
  for (const t of ['Headphones A', 'Headphones B', 'Headphones C']) assert.ok(out.includes(t));
  assert.ok(!/floor/i.test(out.replace(/Authorization/gi, '')), 'passport must not mention any floor');
});

test('a shared passport shows the outcome and why, but never the limit or PayPal ids', () => {
  const pub = publicPassport(passport());
  const out = html(<PassportCard p={pub} />);
  for (const t of ['Why this result', 'agreed to 76.00 USD', 'not shown on a shared passport', '$76']) assert.ok(out.includes(t), `missing "${t}"`);
  for (const secret of ['$85', 'ORD1', 'AUTH1', 'CAP1']) assert.ok(!out.includes(secret), `shared passport leaked ${secret}`);
});

test('a pending capture is never shown as captured, and a webhook confirmation is shown', () => {
  const pending = html(<PassportCard p={passport({ payment: { mode: 'paypal_sandbox', orderId: 'O', authId: 'A', captureId: 'C', captureStatus: 'PENDING' } })} />);
  assert.ok(pending.includes('pending') && !/Captured \$76/.test(pending));
  const hooked = html(<PassportCard p={passport({ payment: { mode: 'paypal_sandbox', orderId: 'O', authId: 'A', captureId: 'C', captureStatus: 'COMPLETED', webhook: { event: 'PAYMENT.CAPTURE.COMPLETED', at: 'now' } } })} />);
  assert.ok(hooked.includes('verified PayPal webhook'));
});

test('a stall that could not get under the limit says why it is out', async () => {
  resetStore();
  const stalls = [createListing({ title: 'Pricey A', category: 'x', listPrice: 300, floorPrice: 250 }), createListing({ title: 'Pricey B', category: 'x', listPrice: 320, floorPrice: 260 })];
  const s = await createSession({ listingIds: stalls.map((l) => l.id), maxBudget: 100 }, { pay: null, baseUrl: 'http://x', searchMarket: async () => [] });
  const events = [];
  for await (const e of runSession(s.id, { llm: mockLlm, pay: null, aiMode: 'mock' })) events.push(e);
  const st = events.reduce((acc, ev) => reducer(acc, { type: 'event', ev }), emptyState());
  const out = html(<CrawlStage session={sessionView(s)} st={st} shock={false} speaking={null} mood="sulking" />);
  assert.ok(out.includes('Out: its last ask of'), 'a stall that stayed above the limit explains itself');
  assert.ok(out.includes('No stall could agree') || out.includes('The crawl is over'));
});

/* ------------------------- one resolver, used everywhere ------------------------- */

const panel = (captureStatus: string | undefined, extra: object = {}) =>
  html(<PaymentPanel session={{ state: 'settled', payment: { mode: 'paypal_sandbox', authId: 'A', captureId: captureStatus ? 'C' : undefined, captureStatus, ...extra } } as unknown as SessionView} st={emptyState()} cap={150} currency="USD" />);

test('the payment panel never calls a denied, pending or unconfirmed capture "paid"', () => {
  assert.ok(panel('COMPLETED').includes('Payment completed') && !panel('COMPLETED').includes('Payment pending'));
  for (const bad of ['DENIED', 'DECLINED', 'FAILED']) {
    const out = panel(bad);
    assert.ok(out.includes('Payment unsuccessful'), `${bad} must read as unsuccessful`);
    assert.ok(!/Paid in|Payment completed/.test(out), `${bad} must never read as paid`);
  }
  assert.ok(panel('PENDING').includes('Payment pending') && !/Payment completed|Paid in/.test(panel('PENDING')));
  assert.ok(panel('REFUNDED').includes('Payment refunded'));
  assert.ok(panel('PARTIALLY_REFUNDED').includes('partially refunded'));
  assert.ok(panel('RECONCILED').includes('awaiting verification'));
  assert.ok(panel('SOMETHING_NEW').includes('awaiting verification'), 'an unknown status must be treated as unverified, never as paid');
});

test('the passport stamp and wording follow the payment: pending is not settled, denied is not a deal', () => {
  const stampOf = (p: Passport) => html(<PassportCard p={p} />);
  const pending = stampOf(passport({ payment: { mode: 'paypal_sandbox', orderId: 'O', authId: 'A', captureId: 'C', captureStatus: 'PENDING' } }));
  assert.ok(pending.includes('Pending') && !pending.includes('Settled') && pending.includes('not counted until PayPal completes it'));
  const done = stampOf(passport());
  assert.ok(done.includes('Settled') && !done.includes('>Pending<'));
  const refunded = stampOf(passport({ payment: { mode: 'paypal_sandbox', orderId: 'O', authId: 'A', captureId: 'C', captureStatus: 'REFUNDED' } }));
  assert.ok(refunded.includes('Refunded') && !refunded.includes('Settled'));
  const rehearsal = stampOf(passport({ payment: { mode: 'not_configured' } }));
  assert.ok(rehearsal.includes('Not connected') && !rehearsal.includes('Verify with PayPal now'), 'no PayPal, nothing to verify');
});

test('the passport says honestly how many moves came from the AI model and how many from the built-in fallback', () => {
  const row = (ai: string, usage?: { moves: number; fallbackMoves: number }) => html(<PassportCard p={passport({ agents: { buyer: 'friendly', seller: 'dramatic', ai, usage } })} />);
  assert.ok(row('gemini', { moves: 12, fallbackMoves: 0 }).includes('all 12 moves came from the AI model'));
  const mixed = row('gemini', { moves: 12, fallbackMoves: 3 });
  assert.ok(mixed.includes('9 of 12 moves came from the AI model') && mixed.includes('3 from Bazaar&#x27;s built-in fallback'));
  assert.ok(row('mock', { moves: 8, fallbackMoves: 0 }).includes('scripted, not real AI'));
});

test('the seller desk separates payments still pending from completed sales', () => {
  const out = html(<DeskView data={desk({ deals: [{ id: 'p1', at: '2026-11-06T10:00:00.000Z', outcome: 'deal', settlement: 'pending', price: 120, rounds: 3, buyerPersona: 'friendly' }, { id: 'r1', at: '2026-11-06T10:01:00.000Z', outcome: 'deal', settlement: 'refunded', price: 118, rounds: 3, buyerPersona: 'friendly' }, { id: 'f1', at: '2026-11-06T10:02:00.000Z', outcome: 'no_deal', settlement: 'failed', buyerPersona: 'friendly' }], stats: { negotiations: 3, agreed: 2, agreementPct: 67, sold: 0, conversionPct: 0, revenue: 0, simulatedDeals: 0, simulatedValue: 0, pendingPayments: 1, pendingValue: 120, refundedValue: 118, noDeal: 1, lost: 0, wonVsCompetitors: 0, avgPrice: null, avgMarginOverFloor: null } })} />);
  for (const t of ['Payments pending', 'Deal agreed, payment pending', 'Sold, then refunded', 'Payment unsuccessful']) assert.ok(out.includes(t), `missing "${t}"`);
});

/* ------------------------------ replay, rehearsal, guide ------------------------------ */

test('a replay plays the stalls round by round, puts each limit drop after its deal, and ends with the passport', async () => {
  const { view } = await realCrawl();
  const evs = replayEvents(view);
  const turns = evs.flatMap((e) => (e.type === 'lane' && e.ev.type === 'turn' ? [e.ev.turn.round] : []));
  assert.ok(turns.length > 6);
  for (let i = 1; i < turns.length; i++) assert.ok(turns[i] >= turns[i - 1], `rounds must not go backwards: ${turns.join(',')}`);
  // stalls really interleave (more than one stall appears before the first stall's second round)
  const firstFew = new Set(evs.slice(0, 8).flatMap((e) => (e.type === 'lane' ? [e.lane] : [])));
  assert.ok(firstFew.size > 1, 'the stalls should haggle side by side, not one after another');
  // every limit drop follows the deal that caused it
  evs.forEach((e, i) => {
    if (e.type !== 'best') return;
    const before = evs.slice(0, i).reverse().find((x) => x.type === 'lane' && x.ev.type === 'deal') as Extract<typeof evs[number], { type: 'lane' }> | undefined;
    assert.ok(before && before.lane === e.lane, 'a best-deal update must come right after that stall agreed');
  });
  const types = evs.map((e) => e.type);
  assert.ok(types.indexOf('crawl_end') < types.indexOf('deal') && types.indexOf('deal') < types.indexOf('passport'));
  assert.equal(types.at(-1), 'passport');
  // folding the replay gives the same final picture as the original run
  const st = evs.reduce((acc, ev) => reducer(acc, { type: 'event', ev }), emptyState());
  assert.equal(st.crawlEnd?.winner?.price, view.crawl?.winner?.price);
  assert.equal(st.passport?.id, view.passport?.id);
});

test('the shipped sample recording is valid, honestly labelled and safe to publish', () => {
  const sample = JSON.parse(readFileSync('public/sample-crawl.json', 'utf8'));
  assert.ok(['mock', 'gemini', 'anthropic', 'openai'].includes(sample.ai));
  assert.equal(sample.view.mode, 'crawl');
  assert.equal(sample.view.passport.agents.ai, sample.ai, 'the label on the recording must match the passport');
  assert.equal(sample.view.limitHidden, true, 'a public recording must hide the buyer limit');
  assert.equal(sample.view.maxBudget, 0);
  assert.equal(sample.view.passport.mandate.buyerCap, undefined);
  assert.ok(!/orderId|authId|captureId|webhook|captureIntent/.test(JSON.stringify(sample)), 'no PayPal identifiers in a public file');
  assert.ok(!/approveUrl|buyerTokenHash|sellerToken|floorPrice/.test(JSON.stringify(sample)));
  const evs = replayEvents(sample.view);
  assert.equal(evs.at(-1)?.type, 'passport');
  assert.ok(evs.some((e) => e.type === 'crawl_end'));
});

test('the passport says plainly when PayPal was skipped by choice', () => {
  const out = html(<PassportCard p={passport({ payment: { mode: 'not_configured', rehearsal: true } })} />);
  assert.ok(out.includes('Rehearsal by choice') && !out.includes('Verify with PayPal now'));
});

test('the judges guide tells the truth about each part and how to try Bazaar quickly', () => {
  const live = html(<Guide health={{ ok: true, agents: 'gemini', paypal: 'sandbox', channel3: 'configured' }} />);
  for (const t of ['Judges&#x27; guide', 'recorded crawl', 'Rehearsal', 'Verify with PayPal now', 'Real model: Gemini agents', 'Real PayPal API, sandbox only', 'Real Channel3 data', 'Demo data', 'Simulated traffic', 'No real-world uplift is claimed']) assert.ok(live.includes(t), `missing "${t}"`);
  const offline = html(<Guide health={{ ok: true, agents: 'mock', paypal: 'not_configured', channel3: 'failing' }} />);
  assert.ok(offline.includes('Offline demo agents (scripted, not real AI)') && offline.includes('Not connected here') && offline.includes('Channel3 unreachable right now'), 'the guide must never claim a part is live when it is not');
});

test('the seller desk keeps verified revenue apart from rehearsal value, pending and refunded money', () => {
  const out = html(<DeskView data={desk({ deals: [{ id: 'h1', at: '2026-11-08T10:00:00.000Z', outcome: 'deal', settlement: 'rehearsal', price: 99, rounds: 3, buyerPersona: 'friendly' }], stats: { negotiations: 1, agreed: 1, agreementPct: 100, sold: 0, conversionPct: 0, revenue: 0, simulatedDeals: 1, simulatedValue: 99, pendingPayments: 0, pendingValue: 0, refundedValue: 0, noDeal: 0, lost: 0, wonVsCompetitors: 0, avgPrice: null, avgMarginOverFloor: null } })} />);
  for (const t of ['Verified revenue', 'Rehearsal deal value', '1 deal, no money moved', 'Rehearsal deal (no money moved)', '$99']) assert.ok(out.includes(t), `missing "${t}"`);
  assert.ok(/Verified revenue<\/dt><dd>\$0</.test(out), 'a rehearsal must not add to verified revenue');
  const refunds = html(<DeskView data={desk()} />);
  assert.ok(!refunds.includes('>Refunded<'), 'no refunds, no refund card');
});

test('a public recording shows the stalls and the limit dropping, but never the buyer\'s own limit', async () => {
  const { buildSampleExport } = await import('../server/sessions.ts');
  resetStore();
  const stalls = [
    createListing({ title: 'Headphones A', category: 'headphones', listPrice: 200, floorPrice: 120 }),
    createListing({ title: 'Headphones B', category: 'headphones', listPrice: 180, floorPrice: 95 }),
    createListing({ title: 'Headphones C', category: 'headphones', listPrice: 190, floorPrice: 110 }),
  ];
  const s = await createSession({ listingIds: stalls.map((l) => l.id), maxBudget: 149.37 }, { pay: null, baseUrl: 'http://x', searchMarket: async () => [] });
  for await (const _ of runSession(s.id, { llm: mockLlm, pay: null, aiMode: 'mock' })) void _;
  const sample = buildSampleExport(s.id);
  const view = sample.view as unknown as ReturnType<typeof sessionView>;
  const st = replayEvents(view).reduce((acc, ev) => reducer(acc, { type: 'event', ev }), emptyState());
  const out = html(<CrawlStage session={view} st={st} shock={false} speaking={null} mood="delighted" />);
  assert.ok(out.includes('Private') === false || out.includes('Dropped to just under'), 'once a stall agreed, the chip shows the drop, not the original limit');
  assert.ok(!out.includes('149.37') && !out.includes('$149') && !out.includes('Only you can see this'), 'the recording must not show or claim the buyer\'s own limit');
  assert.ok(out.includes('Buyer&#x27;s limit'));
  const pre = html(<CrawlStage session={view} st={emptyState()} shock={false} speaking={null} mood="calm" />);
  assert.ok(pre.includes('Private') && pre.includes('never shows the buyer&#x27;s private limit'));
});
