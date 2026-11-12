import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Real HTTP against a real server process, with offline mock agents and
 * every API key blanked (so a developer's .env can never leak into a test).
 * ------------------------------------------------------------------ */

const port = 3200 + (process.pid % 500);
const base = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let log = '';

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_LLM: '1',
      DATA_FILE: path.join(mkdtempSync(path.join(tmpdir(), 'bazaar-http-')), 'store.json'),
      PUBLIC_BASE_URL: base,
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '',
      PAYPAL_WEBHOOK_ID: '',
      GEMINI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      CHANNEL3_API_KEY: '',
      OPENAI_BASE_URL: '',
      RATE_LIMIT_PER_HOUR: '1000',
    },
  });
  server.stdout?.on('data', (d) => (log += d));
  server.stderr?.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${log}`);
});
after(() => server?.kill());

const json = (r: Response) => r.json() as Promise<any>;
const alive = async () => assert.equal((await fetch(`${base}/api/health`)).status, 200, 'the server must still be running');

async function openSession(extra: object = {}) {
  const listings = (await fetch(`${base}/api/listings`).then(json)) as { id: string; category: string }[];
  const ids = listings.filter((l) => l.category === 'headphones').map((l) => l.id);
  const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingIds: ids, maxBudget: 140, ...extra }) });
  assert.equal(r.status, 201);
  return (await r.json()) as { id: string; buyerToken: string };
}

test('requests without the right buyer key are refused and can never crash the server', async () => {
  const s = await openSession();
  const wrongKeys: HeadersInit[] = [{}, { 'x-buyer-token': 'wrong' }];
  for (const headers of wrongKeys) {
    assert.equal((await fetch(`${base}/api/sessions/${s.id}`, { headers })).status, 403);
    const neg = await fetch(`${base}/api/sessions/${s.id}/negotiate`, { method: 'POST', headers });
    assert.equal(neg.status, 403);
    assert.match((await neg.json()).error, /belongs to the browser/);
    assert.equal((await fetch(`${base}/api/passport/${s.id}`, { headers })).status, 403);
    await alive();
  }
  // unknown session ids are an ordinary 404, not a crash
  assert.equal((await fetch(`${base}/api/sessions/nope/negotiate`, { method: 'POST', headers: { 'x-buyer-token': 'x' } })).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/nope`)).status, 404);
  await alive();
});

test('malformed and oversized bodies are 4xx answers, not crashes', async () => {
  const bad = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  const huge = await fetch(`${base}/api/listings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(200_000) }) });
  assert.equal(huge.status, 413);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  await alive();
});

test('the buyer can run their own crawl end to end with their key, and the stream carries no secrets', async () => {
  const s = await openSession({ buyerPersona: 'dramatic' });
  const res = await fetch(`${base}/api/sessions/${s.id}/negotiate`, { method: 'POST', headers: { 'x-buyer-token': s.buyerToken } });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const evs = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.type === 'crawl_end'));
  assert.ok(evs.some((e) => e.type === 'passport'));
  assert.ok(!/floorPrice|sellerToken|"reveal"/.test(raw), 'secrets leaked into the stream');
  // a finished haggle cannot be run twice
  const again = await fetch(`${base}/api/sessions/${s.id}/negotiate`, { method: 'POST', headers: { 'x-buyer-token': s.buyerToken } });
  assert.equal(again.status, 409);
  await alive();
});

test('the private passport needs the key, the shared one never contains the limit or PayPal ids', async () => {
  const s = await openSession();
  await (await fetch(`${base}/api/sessions/${s.id}/negotiate`, { method: 'POST', headers: { 'x-buyer-token': s.buyerToken } })).text();
  const full = await fetch(`${base}/api/passport/${s.id}`, { headers: { 'x-buyer-token': s.buyerToken } }).then(json);
  assert.equal(full.mandate.buyerCap, 140);
  const shared = await fetch(`${base}/api/passport/${s.id}/public`).then(json);
  assert.equal(shared.mandate.buyerCap, undefined);
  assert.ok(!JSON.stringify(shared).includes('buyerCap'));
  assert.ok(shared.explanation.length > 10);
});

test('webhooks answer 503 when not configured, listings never expose floors, and security headers are set', async () => {
  const hook = await fetch(`${base}/api/paypal/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(hook.status, 503);
  const listings = await fetch(`${base}/api/listings`).then(json);
  assert.ok(listings.length >= 7);
  assert.ok(!JSON.stringify(listings).match(/floor|sellerToken/i));
  const h = await fetch(`${base}/api/health`);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(h.headers.get('x-frame-options'), 'DENY');
  assert.equal(h.headers.get('x-powered-by'), null);
  assert.equal((await fetch(`${base}/api/seller-secrets`)).status, 404);
});

test('the live verification endpoint is public, refuses before a haggle ends, and never claims a payment that does not exist', async () => {
  const s = await openSession();
  assert.equal((await fetch(`${base}/api/passport/${s.id}/verify`)).status, 404, 'nothing to verify before the haggle ends');
  await (await fetch(`${base}/api/sessions/${s.id}/negotiate`, { method: 'POST', headers: { 'x-buyer-token': s.buyerToken } })).text();
  const r = await fetch(`${base}/api/passport/${s.id}/verify`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.verified, false);
  assert.match(body.reason, /not connected/);
  assert.ok(!JSON.stringify(body).match(/CAP|AUTH|ORDER|buyerCap/));
  await alive();
});
