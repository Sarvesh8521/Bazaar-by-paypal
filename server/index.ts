import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import express, { type Request, type Response, type NextFunction } from 'express';
import { pickLlm } from './agents.ts';
import { paypalApi, paypalConfigured, verifyWebhookSignature } from './paypal.ts';
import { channel3Configured, channel3Status, marketReference, productCards, searchProducts } from './channel3.ts';
import { HttpError, applyPayPalEvent, approveSession, assertRunnable, createListing, createSession, getListing, getSession, listPublicListings, loadStore, publicListing, publicPassport, reconcileHolds, requireBuyer, runSession, saveStore, seedListings, sellerView, sessionView, setChangeHook, takeBuyerToken, touchStore, verifyPassport } from './sessions.ts';

// Many WSL and VPN setups have a broken IPv6 route, which shows up as "fetch failed" to PayPal, Channel3 or the AI provider.
dns.setDefaultResultOrder(process.env.BAZAAR_DNS_ORDER === 'verbatim' ? 'verbatim' : 'ipv4first');

const port = Number(process.env.PORT ?? 3000);
const baseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const { llm, mode } = pickLlm();
const pay = paypalConfigured() ? paypalApi : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render's proxy
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '50kb' }));

/* tiny in-memory per-IP rate limits for the endpoints that cost money (LLM calls, PayPal orders, Channel3 credits) */
function limiter(maxPerHour: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'x';
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= maxPerHour) return next(new HttpError(429, 'Too many requests, please try again later'));
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3_600_000)) hits.delete(k);
    next();
  };
}
const limited = limiter(Number(process.env.RATE_LIMIT_PER_HOUR ?? 30));
const searchLimited = limiter(Number(process.env.SEARCH_LIMIT_PER_HOUR ?? 60));
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, agents: mode, paypal: pay ? 'sandbox' : 'not_configured', channel3: channel3Status() });
});

/* ---------------------------- listings ---------------------------- */

app.get('/api/listings', (_req, res) => {
  res.json(listPublicListings());
});

app.post('/api/listings', limited, (req, res) => {
  const l = createListing(req.body);
  // The seller token is shown exactly once. Floor price is never returned.
  res.status(201).json({ listing: publicListing(l), sellerToken: l.sellerToken });
});

app.get('/api/listings/:id/seller', (req, res) => {
  res.json(sellerView(req.params.id, req.header('x-seller-token')));
});

/** Channel3 product search, used by the seller form to start a listing from a real product. */
app.get(
  '/api/products',
  searchLimited,
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 80);
    if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters to search');
    if (!channel3Configured()) throw new HttpError(503, 'Product search needs a Channel3 key on the server');
    res.json(productCards(await searchProducts(q, 8)));
  }),
);

/* ---------------------------- sessions ---------------------------- */

app.post(
  '/api/sessions',
  limited,
  wrap(async (req, res) => {
    const s = await createSession(req.body, {
      pay,
      baseUrl,
      searchMarket: async (title) => marketReference(await searchProducts(title, 5)),
    });
    // The buyer token is shown exactly once. Only its hash is stored, and every later request must present it.
    res.status(201).json({ ...sessionView(s), buyerToken: takeBuyerToken(s) });
  }),
);

app.get('/api/sessions/:id', (req, res) => {
  res.json(sessionView(requireBuyer(req.params.id, req.header('x-buyer-token'))));
});

/** PayPal sends the buyer back here after approval. */
app.get(
  '/api/paypal/return',
  wrap(async (req, res) => {
    const id = String(req.query.session ?? '');
    try {
      if (!pay) throw new HttpError(400, 'PayPal is not configured');
      await approveSession(id, pay);
      res.redirect(`/#/arena/${encodeURIComponent(id)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'approval failed';
      res.status(e instanceof HttpError ? e.status : 500).type('html').send(`<p>Could not finish the PayPal approval: ${msg.replace(/[<>&]/g, '')}</p><p><a href="/">Back to BAZAAR</a></p>`);
    }
  }),
);

app.get('/api/paypal/cancel', (req, res) => {
  res.redirect(`/#/arena/${encodeURIComponent(String(req.query.session ?? ''))}?cancelled=1`);
});

/** Streams newline-delimited JSON events: turns, guardrails, deal, payment, passport. */
app.post(
  '/api/sessions/:id/negotiate',
  limited,
  wrap(async (req, res) => {
  const id = req.params.id;
  assertRunnable(requireBuyer(id, req.header('x-buyer-token'))); // 403/404/409 before we start streaming
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  try {
    for await (const ev of runSession(id, { llm, pay, aiMode: mode })) {
      res.write(JSON.stringify(ev) + '\n');
      if (mode === 'mock' && ev.type === 'turn') await sleep(700); // theatrical pacing for offline mode
    }
  } catch (e) {
    res.write(JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : 'negotiation failed' }) + '\n');
  }
  res.end();
  }),
);

/** The buyer's full passport (includes their own limit and PayPal ids). */
app.get('/api/passport/:id', (req, res) => {
  const s = requireBuyer(req.params.id, req.header('x-buyer-token'));
  if (!s.passport) throw new HttpError(404, 'No passport yet: the negotiation has not finished');
  res.json(s.passport);
});

/** The shareable passport: no limits, no PayPal identifiers, no approval links. */
app.get('/api/passport/:id/public', (req, res) => {
  const s = getSession(req.params.id);
  if (!s.passport) throw new HttpError(404, 'No passport yet: the negotiation has not finished');
  res.json(publicPassport(s.passport));
});

/** Live check against PayPal: is this passport's payment really completed, for the amount it claims? Public, reveals no ids. */
app.get(
  '/api/passport/:id/verify',
  searchLimited,
  wrap(async (req, res) => {
    res.json(await verifyPassport(req.params.id, pay));
  }),
);

/** PayPal webhooks (optional). Set PAYPAL_WEBHOOK_ID after adding this URL in the PayPal developer dashboard. */
app.post(
  '/api/paypal/webhook',
  wrap(async (req, res) => {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!pay || !webhookId) throw new HttpError(503, 'Webhooks are not configured on this server');
    if (!(await verifyWebhookSignature(req.headers, req.body, webhookId))) throw new HttpError(400, 'Invalid webhook signature');
    res.json({ ok: true, applied: applyPayPalEvent(req.body) });
  }),
);

/* ---------------- serve the built UI (npm run build) ---------------- */

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

/* ------------------------------ errors ------------------------------ */

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? 'Request too large' : 'Bad request' });
    return;
  }
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
});

/* ------------------------------ start ------------------------------ */

// Last line of defence: one bad request must never take the server down.
process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('[server] uncaught exception:', e));

const dataFile = process.env.DATA_FILE ?? path.resolve(process.cwd(), 'data/store.json');
const restored = loadStore(dataFile);
let saveTimer: NodeJS.Timeout | undefined;
function saveNow() {
  try {
    saveStore(dataFile);
  } catch (e) {
    console.warn('[store] could not save:', e instanceof Error ? e.message : e);
  }
}
setChangeHook((immediate) => {
  clearTimeout(saveTimer);
  if (immediate) saveNow();
  else saveTimer = setTimeout(saveNow, 400);
});

const seeds = restored && listPublicListings().length ? [] : seedListings();
// Give new demo listings real product photos from Channel3 (best effort, skipped without a key).
void Promise.all(
  seeds.map(async (l) => {
    const top = (await searchProducts(l.title, 1))[0];
    if (top?.imageUrl) {
      getListing(l.id).imageUrl = top.imageUrl;
      touchStore();
    }
  }),
);

if (pay) {
  void reconcileHolds(pay).then(({ released, needsReview, recovered }) => {
    if (recovered) console.log(`  recovered ${recovered} payment${recovered === 1 ? '' : 's'} that PayPal had captured just before the restart`);
    if (released) console.log(`  released ${released} leftover PayPal hold${released === 1 ? '' : 's'} from before the restart`);
    if (needsReview) console.log(`  ${needsReview} payment${needsReview === 1 ? '' : 's'} found captured at PayPal after a restart: check the PayPal sandbox dashboard`);
  });
}

app.listen(port, () => {
  console.log(`BAZAAR server on ${baseUrl}`);
  console.log(`  state: ${restored ? 'restored from ' + dataFile : 'fresh'}`);
  console.log(`  webhooks: ${process.env.PAYPAL_WEBHOOK_ID ? 'verifying PayPal signatures' : 'off (set PAYPAL_WEBHOOK_ID to enable)'}`);
  console.log(`  agents: ${mode} | paypal: ${pay ? 'sandbox' : 'NOT configured (no payments)'} | channel3: ${channel3Configured() ? 'on' : 'off (no market data)'}`);
  if (mode === 'mock') console.log('  Offline mock agents. Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to .env for real AI agents.');
});
