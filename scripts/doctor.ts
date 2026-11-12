import { existsSync, accessSync, constants, mkdirSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ *
 * `npm run doctor`: check the whole setup in one go and print a report
 * that is safe to paste into a chat (it never prints a key or secret).
 * Every outside dependency is injected, so the checks themselves are tested.
 * ------------------------------------------------------------------ */

export type Status = 'ok' | 'warn' | 'fail' | 'skip';
export interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}
export interface Deps {
  fetch: typeof fetch;
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  canListen: (port: number) => Promise<boolean>;
  exists: (file: string) => boolean;
  writable: (dir: string) => boolean;
  nodeVersion: string;
}

const TIMEOUT = 12_000;
const causeOf = (e: unknown) => {
  const c = (e as { cause?: { code?: string; message?: string } })?.cause;
  return c?.code ?? c?.message ?? (e instanceof Error ? e.message : String(e));
};
const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail });
const fail = (name: string, detail: string, fix?: string): Check => ({ name, status: 'fail', detail, fix });
const warn = (name: string, detail: string, fix?: string): Check => ({ name, status: 'warn', detail, fix });
const skip = (name: string, detail: string, fix?: string): Check => ({ name, status: 'skip', detail, fix });

function netFix(cause: string): string {
  if (/ENOTFOUND|EAI_AGAIN/.test(cause)) return 'DNS cannot find this host from your machine. In WSL try: echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf, or restart WSL with `wsl --shutdown` from PowerShell, and check any VPN.';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|AbortError|timed out/i.test(cause)) return 'The connection timed out: a firewall, VPN or antivirus may be blocking it. Try another network (a phone hotspot is a quick test), and run the server with NODE_OPTIONS=--dns-result-order=ipv4first.';
  if (/ECONNREFUSED|ECONNRESET/.test(cause)) return 'The connection was refused or reset: a firewall, proxy or VPN is in the way.';
  if (/CERT|SSL|TLS/i.test(cause)) return 'A TLS/certificate problem: a corporate proxy or antivirus may be intercepting HTTPS.';
  return 'A network problem reaching this service. Try another network and check any VPN or antivirus.';
}

async function post(d: Deps, url: string, init: { headers: Record<string, string>; body: string }) {
  return d.fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: AbortSignal.timeout(TIMEOUT) });
}

export async function runDoctor(env: NodeJS.ProcessEnv, d: Deps): Promise<Check[]> {
  const out: Check[] = [];

  // ---- Node ----
  const [maj, min] = d.nodeVersion.replace(/^v/, '').split('.').map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 12) || (maj === 20 && min >= 19);
  out.push(nodeOk ? ok('Node.js', `${d.nodeVersion}`) : fail('Node.js', `${d.nodeVersion} is too old for the locked dependencies`, 'Install Node 22 (nvm install 22) and run npm install again.'));

  // ---- which AI the server will actually use ----
  const provider = env.MOCK_LLM === '1' ? 'mock' : env.ANTHROPIC_API_KEY ? 'anthropic' : env.GEMINI_API_KEY ? 'gemini' : env.OPENAI_BASE_URL && env.BAZAAR_MODEL ? 'openai' : 'mock';
  out.push(provider === 'mock' ? warn('AI agents', 'No AI key is set (or MOCK_LLM=1), so the server will use the offline demo agents, which are not real AI.', 'Put GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in .env. The final demo and video must use a real model.') : ok('AI agents', `the server will use: ${provider}`));
  if (env.ANTHROPIC_API_KEY && env.GEMINI_API_KEY) out.push(warn('AI keys', 'Both ANTHROPIC_API_KEY and GEMINI_API_KEY are set. Anthropic wins.', 'Leave ANTHROPIC_API_KEY empty if you meant to use Gemini.'));

  // ---- AI provider live call ----
  if (provider === 'gemini') {
    const model = env.BAZAAR_MODEL || 'gemini-3.5-flash-lite';
    try {
      const r = await post(d, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY!, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 20 } }),
      });
      if (r.ok) out.push(ok('Gemini call', `model ${model} answered`));
      else if (r.status === 400 || r.status === 403) out.push(fail('Gemini call', `HTTP ${r.status}: the key was rejected`, 'Create a new key at aistudio.google.com and paste it with no spaces or quotes.'));
      else if (r.status === 404) out.push(fail('Gemini call', `HTTP 404: the model "${model}" does not exist for this key`, 'Open AI Studio, copy a current Flash-Lite model ID, and set BAZAAR_MODEL=<that id> in .env.'));
      else if (r.status === 429) out.push(warn('Gemini call', 'HTTP 429: rate or daily limit reached', 'Wait a minute, or pick a Flash-Lite model, which has a higher free limit. A street crawl makes many calls.'));
      else out.push(fail('Gemini call', `HTTP ${r.status}`));
    } catch (e) {
      const c = causeOf(e);
      out.push(fail('Gemini call', `network error: ${c}`, netFix(c)));
    }
  } else if (provider === 'anthropic') {
    const model = env.BAZAAR_MODEL || 'claude-haiku-5-5';
    try {
      const r = await post(d, 'https://api.anthropic.com/v1/messages', {
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
      });
      if (r.ok) out.push(ok('Anthropic call', `model ${model} answered`));
      else if (r.status === 401) out.push(fail('Anthropic call', 'HTTP 401: the key was rejected', 'Check ANTHROPIC_API_KEY in .env, or leave it empty and use GEMINI_API_KEY.'));
      else if (r.status === 400 || r.status === 402) out.push(fail('Anthropic call', `HTTP ${r.status}: usually no credit on the account`, 'Add a few dollars of credit in the Anthropic console, or use GEMINI_API_KEY instead.'));
      else if (r.status === 404) out.push(fail('Anthropic call', `HTTP 404: model "${model}" not found`, 'Set BAZAAR_MODEL to a current model ID.'));
      else out.push(fail('Anthropic call', `HTTP ${r.status}`));
    } catch (e) {
      const c = causeOf(e);
      out.push(fail('Anthropic call', `network error: ${c}`, netFix(c)));
    }
  } else if (provider === 'openai') {
    try {
      const r = await post(d, `${env.OPENAI_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || 'none'}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.BAZAAR_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
      });
      out.push(r.ok ? ok('OpenAI-compatible call', 'answered') : fail('OpenAI-compatible call', `HTTP ${r.status}`, 'Check OPENAI_BASE_URL, OPENAI_API_KEY and BAZAAR_MODEL.'));
    } catch (e) {
      const c = causeOf(e);
      out.push(fail('OpenAI-compatible call', `network error: ${c}`, netFix(c)));
    }
  }

  // ---- PayPal sandbox ----
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    out.push(skip('PayPal sandbox', 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, so payments are off.', 'developer.paypal.com > Apps & Credentials > Sandbox > your app: copy the Client ID and Secret into .env.'));
  } else {
    try {
      const r = await post(d, 'https://api-m.sandbox.paypal.com/v1/oauth2/token', {
        headers: { Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      if (r.ok) out.push(ok('PayPal sandbox', 'credentials accepted (an access token was issued)'));
      else if (r.status === 401) out.push(fail('PayPal sandbox', 'HTTP 401: the Client ID or Secret was rejected', 'Make sure the toggle on the PayPal page says SANDBOX (not Live) and that you copied the Secret in full, with no spaces or quotes.'));
      else out.push(fail('PayPal sandbox', `HTTP ${r.status}`));
    } catch (e) {
      const c = causeOf(e);
      out.push(fail('PayPal sandbox', `network error: ${c}`, netFix(c)));
    }
  }

  // ---- Channel3 (DNS first, so the real cause is visible) ----
  if (!env.CHANNEL3_API_KEY) {
    out.push(skip('Channel3', 'CHANNEL3_API_KEY is not set, so there are no photos or market prices.', 'Copy your key from the Channel3 dashboard (API Keys) into .env.'));
  } else {
    let dnsOk = true;
    try {
      const addrs = await d.lookup('api.trychannel3.com');
      out.push(ok('Channel3 DNS', `api.trychannel3.com resolves (${addrs.map((a) => `IPv${a.family}`).join(', ')})`));
    } catch (e) {
      dnsOk = false;
      const c = causeOf(e);
      out.push(fail('Channel3 DNS', `cannot resolve api.trychannel3.com: ${c}`, netFix('ENOTFOUND')));
    }
    if (dnsOk) {
      try {
        const r = await post(d, 'https://api.trychannel3.com/v1/search', { headers: { 'x-api-key': env.CHANNEL3_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'lamp', limit: 2 }) });
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { products?: unknown[] };
          out.push(ok('Channel3 search', `answered with ${Array.isArray(j.products) ? j.products.length : '?'} products`));
        } else if (r.status === 401 || r.status === 403) out.push(fail('Channel3 search', `HTTP ${r.status}: the key was rejected`, 'Copy the key again from the Channel3 dashboard; no spaces or quotes.'));
        else if (r.status === 402) out.push(fail('Channel3 search', 'HTTP 402: out of credits', 'Apply promo code PAYPAL-HACKATHON-2026 in the Channel3 billing page, or ask in the PayPal Discord.'));
        else out.push(fail('Channel3 search', `HTTP ${r.status}`));
      } catch (e) {
        const c = causeOf(e);
        out.push(fail('Channel3 search', `network error: ${c}`, netFix(c)));
      }
    }
  }

  // ---- local things ----
  const port = Number(env.PORT ?? 3000);
  out.push((await d.canListen(port)) ? ok('Port', `${port} is free`) : warn('Port', `${port} is already in use`, 'Another server is running (maybe an old npm start). Press Ctrl+C in that terminal, or stop it with: pkill -f "tsx server/index.ts"'));
  out.push(d.exists('dist/index.html') ? ok('Built interface', 'dist/ exists') : warn('Built interface', 'dist/ is missing, so npm start will serve only the API', 'Run: npm run build'));
  const dataDir = path.dirname(env.DATA_FILE ?? 'data/store.json');
  out.push(d.writable(dataDir) ? ok('Data folder', `${dataDir} is writable`) : fail('Data folder', `${dataDir} cannot be written`, 'Check folder permissions, or set DATA_FILE to a writable path.'));
  const base = env.PUBLIC_BASE_URL ?? '';
  let basePort = '';
  let baseSecure = false;
  try {
    if (base) {
      const u = new URL(base);
      basePort = u.port;
      baseSecure = u.protocol === 'https:';
    }
  } catch {
    out.push(fail('PUBLIC_BASE_URL', `"${base}" is not a valid URL`, `Use something like http://localhost:${port}`));
  }
  if (base && !out.some((c) => c.name === 'PUBLIC_BASE_URL')) {
    out.push(
      !baseSecure && basePort !== String(port)
        ? warn('PUBLIC_BASE_URL', `${base} does not match the port ${port}, so PayPal would send you back to the wrong place`, `For npm start set PUBLIC_BASE_URL=http://localhost:${port} (5173 is only for npm run dev:ui).`)
        : ok('PUBLIC_BASE_URL', base),
    );
  } else if (!base) out.push(ok('PUBLIC_BASE_URL', '(default)'));
  return out;
}

export function render(checks: Check[]): string {
  const icon: Record<Status, string> = { ok: '✔', warn: '!', fail: '✘', skip: '-' };
  const lines = checks.map((c) => `${icon[c.status]} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ''}`);
  const bad = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn' || c.status === 'skip').length;
  const verdict = bad ? `${bad} problem${bad === 1 ? '' : 's'} to fix first.` : warns ? 'No failures. Read the notes above (!) and (-) before recording the demo.' : 'Everything checks out.';
  const paste = checks.map((c) => `${c.status.toUpperCase()} ${c.name}: ${c.detail}`).join('\n');
  return `${lines.join('\n')}\n\n${verdict}\n\n----- paste this block back (it contains no keys) -----\n${paste}\n-----------------------------------------------------`;
}

async function main() {
  await import('dotenv/config');
  const net = await import('node:net');
  const deps: Deps = {
    fetch,
    lookup: (host) => dnsLookup(host, { all: true }),
    canListen: (port) =>
      new Promise((resolve) => {
        const s = createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(port, '127.0.0.1');
        void net;
      }),
    exists: (f) => existsSync(f),
    writable: (dir) => {
      try {
        mkdirSync(dir, { recursive: true });
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    nodeVersion: process.version,
  };
  console.log('Bazaar doctor: checking your setup (this takes a few seconds)...\n');
  const checks = await runDoctor(process.env, deps);
  console.log(render(checks));
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
