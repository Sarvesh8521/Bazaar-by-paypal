import test from 'node:test';
import assert from 'node:assert/strict';
import { runToEnd, mockLlm, geminiLlm, openaiCompatLlm, throttle, type AgentCtx, type Deal, type LlmFn, type NegEvent } from './agents.ts';

const deal = (over: Partial<Deal> = {}): Deal => ({
  item: { title: 'Brass lantern', listPrice: 200, currency: 'USD' },
  buyer: { maxBudget: 150, persona: 'friendly' },
  seller: { floorPrice: 100, persona: 'stubborn' },
  ...over,
});

const find = <T extends NegEvent['type']>(evs: NegEvent[], t: T) => evs.find((e) => e.type === t) as Extract<NegEvent, { type: T }> | undefined;

test('mock agents reach a deal inside both mandates', async () => {
  const evs = await runToEnd(deal(), mockLlm);
  const d = find(evs, 'deal');
  assert.ok(d, 'expected a deal');
  assert.ok(d.price >= 100 && d.price <= 150, `price ${d.price} outside [100,150]`);
  assert.ok(d.price <= 200);
  assert.ok(find(evs, 'reveal'));
});

test('a reckless buyer agent can never exceed the budget cap', async () => {
  const reckless: LlmFn = async ({ ctx }) =>
    ctx.side === 'buyer'
      ? JSON.stringify({ action: 'offer', price: 9999, line: 'Money is no object!', tactic: 'yolo' })
      : JSON.stringify({ action: 'offer', price: 190, line: 'Hmm.', tactic: 'hold' });
  const evs = await runToEnd(deal(), reckless);
  assert.ok(evs.some((e) => e.type === 'guardrail' && e.kind === 'over_budget'));
  const d = find(evs, 'deal');
  assert.ok(!d || d.price <= 150);
  for (const e of evs) if (e.type === 'turn' && e.turn.side === 'buyer' && e.turn.price != null) assert.ok(e.turn.price <= 150);
});

test('a reckless seller agent can never go below the floor', async () => {
  const giveaway: LlmFn = async ({ ctx }) =>
    ctx.side === 'seller'
      ? JSON.stringify({ action: 'offer', price: 1, line: 'Free!', tactic: 'panic' })
      : JSON.stringify({ action: 'offer', price: 20, line: 'Low.', tactic: 'anchor' });
  const evs = await runToEnd(deal(), giveaway);
  assert.ok(evs.some((e) => e.type === 'guardrail' && e.kind === 'below_floor'));
  for (const e of evs) if (e.type === 'turn' && e.turn.side === 'seller' && e.turn.price != null) assert.ok(e.turn.price >= 100);
  const d = find(evs, 'deal');
  assert.ok(!d || d.price >= 100);
});

test('accepting a price beyond the mandate is blocked', async () => {
  const eager: LlmFn = async ({ ctx }) =>
    ctx.side === 'buyer'
      ? JSON.stringify({ action: 'accept', price: 200, line: 'Deal!', tactic: 'eager' })
      : JSON.stringify({ action: 'offer', price: 200, line: 'Full price.', tactic: 'hold' });
  const evs = await runToEnd(deal(), eager);
  assert.ok(evs.some((e) => e.type === 'guardrail' && e.kind === 'accept_blocked'));
  const d = find(evs, 'deal');
  assert.ok(!d || d.price <= 150);
});

test('no overlap between budget and floor ends with no_deal', async () => {
  const evs = await runToEnd(deal({ buyer: { maxBudget: 60, persona: 'friendly' }, seller: { floorPrice: 120, persona: 'stubborn' } }), mockLlm);
  assert.equal(find(evs, 'deal'), undefined);
  assert.ok(find(evs, 'no_deal'));
});

test('the secret limit is redacted if an agent blurts it out', async () => {
  const blabber: LlmFn = async ({ ctx }) =>
    ctx.side === 'buyer'
      ? JSON.stringify({ action: 'offer', price: 80, line: 'I could never pay more than 150.', tactic: 'oops' })
      : JSON.stringify({ action: 'offer', price: 190, line: 'No.', tactic: 'hold' });
  const evs = await runToEnd(deal(), blabber);
  assert.ok(evs.some((e) => e.type === 'guardrail' && e.kind === 'secret_leak'));
  for (const e of evs) if (e.type === 'turn') assert.ok(!e.turn.line.includes('150'));
});

test('invalid model output falls back to the offline agent and still finishes', async () => {
  const garbage: LlmFn = async () => 'sorry, I am a teapot';
  const evs = await runToEnd(deal(), garbage);
  assert.ok(evs.some((e) => e.type === 'guardrail' && e.kind === 'bad_json'));
  assert.ok(find(evs, 'deal') || find(evs, 'no_deal'));
});

test('prompts never leak the other side\'s secret', async () => {
  const seen: { side: string; text: string }[] = [];
  const spy: LlmFn = async (call) => {
    seen.push({ side: call.ctx.side, text: call.system + '\n' + call.user });
    return mockLlm(call);
  };
  await runToEnd(deal({ buyer: { maxBudget: 141.41, persona: 'dramatic' }, seller: { floorPrice: 73.37, persona: 'friendly' } }), spy);
  assert.ok(seen.length > 0);
  for (const s of seen) {
    if (s.side === 'buyer') assert.ok(!s.text.includes('73.37'), 'buyer prompt leaked the floor');
    if (s.side === 'seller') assert.ok(!s.text.includes('141.41'), 'seller prompt leaked the budget');
  }
});

const ctx = {} as AgentCtx;

test('Gemini adapter sends the right request and parses the reply', async () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; headers: any; body: any } | null = null;
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"action":"walk"}' }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const out = await geminiLlm('KEY', 'gemini-test')({ system: 'sys', user: 'usr', ctx });
    assert.equal(out, '{"action":"walk"}');
    assert.ok(seen!.url.endsWith('/models/gemini-test:generateContent'));
    assert.equal(seen!.headers['x-goog-api-key'], 'KEY');
    assert.equal(seen!.body.systemInstruction.parts[0].text, 'sys');
    assert.equal(seen!.body.contents[0].parts[0].text, 'usr');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Gemini and OpenAI-compatible adapters raise readable errors', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(geminiLlm('K', 'm')({ system: '', user: '', ctx }), /Gemini 429: quota exceeded/);
    await assert.rejects(openaiCompatLlm('K', 'http://x/v1/', 'm')({ system: '', user: '', ctx }), /LLM 429: quota exceeded/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI-compatible adapter hits /chat/completions and parses choices', async () => {
  const realFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (u: any) => {
    url = String(u);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await openaiCompatLlm('K', 'http://localhost:11434/v1/', 'm')({ system: '', user: '', ctx }), 'hello');
    assert.equal(url, 'http://localhost:11434/v1/chat/completions');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('throttle spaces calls apart', async () => {
  const stamps: number[] = [];
  const fn = throttle(async () => (stamps.push(Date.now()), 'x'), 120);
  await Promise.all([fn({ system: '', user: '', ctx }), fn({ system: '', user: '', ctx }), fn({ system: '', user: '', ctx })]);
  assert.ok(stamps[1] - stamps[0] >= 100 && stamps[2] - stamps[1] >= 100, `gaps too small: ${stamps.map((t) => t - stamps[0])}`);
});

test('a stalled model provider times out instead of freezing the crawl', async () => {
  const realFetch = globalThis.fetch;
  const old = process.env.BAZAAR_LLM_TIMEOUT_MS;
  process.env.BAZAAR_LLM_TIMEOUT_MS = '60';
  // a provider that never answers but honours the abort signal, like a real fetch
  globalThis.fetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
  const keepAlive = setTimeout(() => undefined, 5000); // AbortSignal.timeout does not keep the process alive by itself; a real socket would
  try {
    const started = Date.now();
    await assert.rejects(geminiLlm('K', 'm')({ system: '', user: '', ctx }));
    await assert.rejects(openaiCompatLlm('K', 'http://x/v1', 'm')({ system: '', user: '', ctx }));
    assert.ok(Date.now() - started < 2000, 'both calls must give up quickly');
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = realFetch;
    if (old === undefined) delete process.env.BAZAAR_LLM_TIMEOUT_MS;
    else process.env.BAZAAR_LLM_TIMEOUT_MS = old;
  }
});

test('when the model times out the negotiation still finishes, and the moves are marked as fallback', async () => {
  const stalled: LlmFn = async () => {
    throw new DOMException('The operation timed out', 'TimeoutError');
  };
  const evs = await runToEnd(deal(), stalled);
  assert.ok(evs.some((e) => e.type === 'deal') || evs.some((e) => e.type === 'no_deal'));
  assert.ok(evs.filter((e) => e.type === 'turn').every((e) => (e as { turn: { fallback?: boolean } }).turn.fallback === true));
});
