import test from 'node:test';
import assert from 'node:assert/strict';
import { render, runDoctor, type Deps } from '../scripts/doctor.ts';

const KEYS = {
  PAYPAL_CLIENT_ID: 'fake-paypal-id-ZQ1',
  PAYPAL_CLIENT_SECRET: 'fake-paypal-pw-ZQ2',
  GEMINI_API_KEY: 'fake-gemini-ZQ3',
  CHANNEL3_API_KEY: 'fake-ch3-ZQ4',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  PORT: '3000',
};

type Answer = { status: number; body?: unknown } | Error;
function deps(answers: Record<string, Answer> = {}, over: Partial<Deps> = {}): Deps & { urls: string[] } {
  const urls: string[] = [];
  const fakeFetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    const key = Object.keys(answers).find((k) => u.includes(k));
    const a = key ? answers[key] : { status: 200, body: { products: [{}, {}] } };
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    canListen: async () => true,
    exists: () => true,
    writable: () => true,
    nodeVersion: 'v22.22.0',
    urls,
    ...over,
  };
}
const by = (checks: { name: string }[], name: string) => checks.find((c) => c.name === name) as { name: string; status: string; detail: string; fix?: string };
const netErr = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

test('doctor: a healthy setup reports everything ok and never prints a key', async () => {
  const checks = await runDoctor(KEYS, deps());
  assert.ok(checks.every((c) => c.status === 'ok'), JSON.stringify(checks.filter((c) => c.status !== 'ok')));
  const text = render(checks);
  for (const k of ['ZQ1', 'ZQ2', 'ZQ3', 'ZQ4']) assert.ok(!text.includes(k), `the report leaked ${k}`);
  assert.match(text, /Everything checks out/);
  assert.match(text, /paste this block back \(it contains no keys\)/);
});

test('doctor: rejected PayPal credentials say to use SANDBOX credentials', async () => {
  const checks = await runDoctor(KEYS, deps({ 'api-m.sandbox.paypal.com': { status: 401 } }));
  const c = by(checks, 'PayPal sandbox');
  assert.equal(c.status, 'fail');
  assert.match(c.fix!, /SANDBOX/);
  assert.match(render(checks), /problem to fix first/);
});

test('doctor: Channel3 DNS failure is reported as DNS and the search is not even attempted', async () => {
  const d = deps({}, { lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  const checks = await runDoctor(KEYS, d);
  assert.equal(by(checks, 'Channel3 DNS').status, 'fail');
  assert.match(by(checks, 'Channel3 DNS').fix!, /DNS|resolv|wsl/i);
  assert.equal(by(checks, 'Channel3 search'), undefined);
  assert.ok(!d.urls.some((u) => u.includes('trychannel3')));
});

test('doctor: a network error reaching Channel3 shows the real cause and a matching fix', async () => {
  const timeout = by(await runDoctor(KEYS, deps({ 'api.trychannel3.com': netErr('ETIMEDOUT') })), 'Channel3 search');
  assert.equal(timeout.status, 'fail');
  assert.match(timeout.detail, /ETIMEDOUT/);
  assert.match(timeout.fix!, /firewall|VPN|ipv4first/i);
  const tls = by(await runDoctor(KEYS, deps({ 'api.trychannel3.com': netErr('CERT_HAS_EXPIRED') })), 'Channel3 search');
  assert.match(tls.fix!, /certificate|TLS/i);
});

test('doctor: Channel3 status codes get their own advice', async () => {
  const run = async (status: number) => by(await runDoctor(KEYS, deps({ 'api.trychannel3.com': { status } })), 'Channel3 search');
  assert.match((await run(401)).fix!, /key/i);
  assert.match((await run(402)).fix!, /PAYPAL-HACKATHON-2026/);
  assert.equal((await run(500)).status, 'fail');
});

test('doctor: Gemini problems are told apart (bad key, wrong model, rate limit)', async () => {
  const run = async (status: number) => by(await runDoctor(KEYS, deps({ 'generativelanguage.googleapis.com': { status } })), 'Gemini call');
  assert.match((await run(400)).fix!, /aistudio|key/i);
  const nf = await run(404);
  assert.equal(nf.status, 'fail');
  assert.match(nf.fix!, /BAZAAR_MODEL/);
  assert.equal((await run(429)).status, 'warn');
  assert.equal((await run(200)).status, 'ok');
});

test('doctor: with no keys everything is explained, nothing crashes, and mock agents are called out as not real AI', async () => {
  const checks = await runDoctor({ PORT: '3000' }, deps());
  assert.equal(by(checks, 'AI agents').status, 'warn');
  assert.match(by(checks, 'AI agents').detail, /not real AI/);
  assert.equal(by(checks, 'PayPal sandbox').status, 'skip');
  assert.equal(by(checks, 'Channel3').status, 'skip');
  assert.ok(!checks.some((c) => c.status === 'fail'));
  assert.match(render(checks), /Read the notes above/);
});

test('doctor: it picks the provider the server would pick, and warns when two AI keys are set', async () => {
  const both = await runDoctor({ ...KEYS, ANTHROPIC_API_KEY: 'fake-anthropic-ZQ5' }, deps());
  assert.match(by(both, 'AI agents').detail, /anthropic/);
  assert.equal(by(both, 'AI keys').status, 'warn');
  assert.ok(!render(both).includes('ZQ5'));
  assert.equal(by(await runDoctor({ ...KEYS, MOCK_LLM: '1' }, deps()), 'AI agents').status, 'warn');
});

test('doctor: local problems are found (old Node, busy port, missing build, wrong base URL, unwritable data)', async () => {
  const checks = await runDoctor({ ...KEYS, PUBLIC_BASE_URL: 'http://localhost:5173' }, deps({}, { nodeVersion: 'v18.19.0', canListen: async () => false, exists: () => false, writable: () => false }));
  assert.equal(by(checks, 'Node.js').status, 'fail');
  assert.equal(by(checks, 'Port').status, 'warn');
  assert.match(by(checks, 'Port').fix!, /Ctrl\+C|pkill/);
  assert.equal(by(checks, 'Built interface').status, 'warn');
  assert.equal(by(checks, 'Data folder').status, 'fail');
  assert.equal(by(checks, 'PUBLIC_BASE_URL').status, 'warn');
  assert.match(by(checks, 'PUBLIC_BASE_URL').fix!, /3000/);
  // https hosts (Render) are never flagged for their port
  assert.equal(by(await runDoctor({ ...KEYS, PUBLIC_BASE_URL: 'https://bazaar.onrender.com' }, deps()), 'PUBLIC_BASE_URL').status, 'ok');
  assert.equal(by(await runDoctor({ ...KEYS, PUBLIC_BASE_URL: 'not a url' }, deps()), 'PUBLIC_BASE_URL').status, 'fail');
});
