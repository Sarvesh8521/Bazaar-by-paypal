# BAZAAR

**Send an AI agent to work the whole street. Your limit holds, and PayPal settles the winning deal.**

A buyer gives their agent a secret maximum budget. A seller gives theirs a secret price floor and a personality. The two agents bargain live; the agreed price becomes a real PayPal **sandbox** payment. Built for the PayPal AI Hackathon.

## The Street Crawl

Stalls that sell similar things stand in a **row** (headphones, keyboards, cameras). A buyer can haggle with one stall, or send their agent **down the whole row**:

- Up to four stalls' agents haggle **at the same time**, in lockstep rounds, with one PayPal authorization for the buyer's limit.
- The buyer's agent sees every stall's latest public ask and can use them as leverage.
- When a stall agrees to a price, the buyer's limit in every other stall **drops to just under it**, so the agent can only improve on a deal it already holds.
- The cheapest agreed deal wins and PayPal captures only that price. Stalls that also had a deal see "Lost to a cheaper stall" on their desk; no stall ever learns another's price or floor.
- Optional sound: chimes, a gong on the deal, and the lanterns speaking aloud (toggle in the arena, off by default).

## How it works

- **Agents propose, code enforces.** The LLMs only suggest offers. Plain code (`server/agents.ts`) clamps every price to each side's mandate, blocks retreating or price hikes, redacts secret leaks, and falls back to an offline agent if the model misbehaves. Tests prove an agent can never overspend or undersell.
- **PayPal enforces the cap too.** The buyer approves an `AUTHORIZE` order for their max once; BAZAAR then captures only the negotiated price (`server/paypal.ts`). Sandbox only, hard-coded.

## Quick start (Node 22 recommended, 20.19 or newer required)

```bash
cp .env.example .env      # then fill in the keys
npm install
npm test                  # 133 tests, no keys needed
```

Run it in one of two ways:

```bash
# A) Production style: one server on http://localhost:3000
npm run build && npm start

# B) Development: two terminals, UI hot-reloads on http://localhost:5173
npm run dev               # terminal 1: API on :3000
npm run dev:ui            # terminal 2: UI on :5173 (proxies /api to :3000)
```

For option B set `PUBLIC_BASE_URL=http://localhost:5173` in `.env`, so PayPal sends you back to the UI. For option A (and on Render) set it to the server's own URL.

Try the whole flow (works offline with mock agents and without PayPal keys):

```bash
# 1. pick a listing
curl -s localhost:3000/api/listings
# 2. open a buyer session with a secret max budget (creates a PayPal sandbox authorization order if PayPal is configured)
curl -s -X POST localhost:3000/api/sessions -H 'content-type: application/json' \
  -d '{"listingId":"<id from step 1>","maxBudget":150,"buyerPersona":"dramatic"}'
# 3. (PayPal configured) open "payment.approveUrl" and approve with the sandbox buyer account
# 4. watch the agents negotiate and settle (streams newline-delimited JSON)
curl -N -X POST -H "x-buyer-token: <buyerToken from step 2>" localhost:3000/api/sessions/<session id>/negotiate
# 5. the Deal Passport (the private one needs the key, the shared one does not)
curl -s -H "x-buyer-token: <buyerToken>" localhost:3000/api/passport/<session id>
curl -s localhost:3000/api/passport/<session id>/public
# 6. ask PayPal right now whether the payment in that passport is real
curl -s localhost:3000/api/passport/<session id>/verify
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Which AI, PayPal and Channel3 modes are active |
| `GET /api/products?q=` | Channel3 product search for the seller form |
| `GET/POST /api/listings` | Public listings (no secrets) / create one. The seller token is returned once. |
| `GET /api/listings/:id/seller` | Seller-only (`x-seller-token`): floor price, deals, margins |
| `POST /api/sessions` | Buyer session + PayPal authorization order for the buyer's max. Returns the buyer key **once**. |
| `GET /api/paypal/return` | PayPal redirects here after approval; places the authorization hold |
| `POST /api/sessions/:id/negotiate` | Streams the haggle, then captures the agreed price (or voids on no deal) |
| `GET /api/passport/:id` | The buyer's full Deal Passport (needs the `x-buyer-token` key) |
| `GET /api/passport/:id/public` | The shareable passport: no limit, no PayPal ids |
| `GET /api/passport/:id/verify` | Public live check against PayPal: status, amount, currency (never ids) |
| `POST /api/paypal/webhook` | Optional: PayPal webhooks, signature-verified |

## Payment safety

- A capture is only called **paid** when PayPal says `COMPLETED`. One shared rule (`server/paymentStatus.ts`) is used by the server, the arena, the passport and the seller desk. `PENDING` is an agreed deal but not a sale: it adds no revenue and no conversion until PayPal completes it. `DENIED`/`DECLINED` releases the hold and fails the haggle.
- Captures use a stable PayPal request id, so a retry after a network error can never charge twice. If the answer is lost, Bazaar asks PayPal whether the capture happened before doing anything irreversible, and never voids a hold it cannot confirm.
- At approval, the authorized amount and currency must equal the buyer's limit exactly, or the hold is released.
- PayPal statuses only move forward (`PENDING` to `COMPLETED` to `REFUNDED`): a late or replayed webhook can never undo a completed capture.
- On startup, Bazaar asks PayPal about every hold a failed or interrupted haggle left. A hold still open is released. If PayPal says it was captured and Bazaar saved its capture intent first, the same idempotent request is replayed to get the original capture back, and the passport and the sellers' records are rebuilt exactly as a normal finish would. If that is not possible it is flagged for review and never voided; a hold that cannot be checked is left alone.
- The agreed deal and a capture intent are written to disk BEFORE PayPal is asked to capture, and the capture id and status are saved together the moment PayPal answers, so a crash can never leave a half-recorded payment.
- Capture answers, webhooks and live verification all go through one forward-only status rule, so a webhook that lands while a capture is in flight is never overwritten by the older answer.
- A webhook or a live PayPal lookup is believed only if its capture id, invoice, **amount and currency** match the agreed deal. A COMPLETED capture of the wrong amount (or with no amount) is flagged and never settles the sale or counts as revenue.
- `GET /api/passport/:id/verify` asks PayPal live whether a passport's payment is real and matches the agreed amount, and repairs a missed webhook.
- Optional webhooks: add `<PUBLIC_BASE_URL>/api/paypal/webhook` in the PayPal developer dashboard (events: Payment capture completed, denied, pending, refunded) and set `PAYPAL_WEBHOOK_ID`. Verified events update the passport.

## Access control

Creating a haggle returns a secret buyer key once; only its hash is stored. The same goes for a seller's key. Reading a haggle, releasing the agents and reading the full passport all require it, so a leaked session id exposes nothing. The shareable passport (`#/p/<id>`) never contains the limit or PayPal ids. Seller text is cleaned and fenced as data inside the AI prompts. A real-HTTP test suite starts the server and tries to break it (bad keys, unknown ids, malformed and oversized bodies).

## Privacy model

Listings keep the seller's floor price server-side. A buyer's client only ever receives events passed through `redactFor`, so it never sees the seller's floor, the seller's guardrail notices, or the post-deal "reveal". The seller's view never contains a buyer's cap.

## If something does not work: `npm run doctor`

One command checks your whole setup and prints a report that contains no keys, so you can paste it straight into a chat: Node version, which AI the server will use and whether it really answers, your PayPal sandbox credentials, Channel3 (DNS first, then the search, with the real network cause such as `ENOTFOUND` or `ETIMEDOUT` and a matching fix), the port, the build, the data folder and `PUBLIC_BASE_URL`. The server also prefers IPv4 for every outside call, which fixes the most common cause of `fetch failed` on WSL and VPN setups (set `BAZAAR_DNS_ORDER=verbatim` to turn that off).

## Before you push to a public repo: `npm run preflight`

It checks the one mistake that cannot be undone. It fails if any value from your `.env` appears in any file (it names the setting, never the value), if a file looks like it contains a real key, if `.env`, `data/`, `dist/` or `node_modules/` would be published, or if the licence is missing. It also lists placeholders you still have to fill in `SUBMISSION.md`, and warns if the recorded crawl is still the offline sample.

## Made to be judged

- **Rehearsal:** tick it when starting a haggle to skip PayPal entirely (no sandbox login, nothing charged). The agents still haggle for real.
- **Recorded crawl:** `#/replay` plays a finished haggle with no keys, no PayPal login and no waiting. A recording is safe to publish: the buyer's limit, every PayPal identifier, webhook ids and approval links are removed before it is written, and only a street crawl can be recorded. The repo ships one made with the offline demo agents and labelled as such. After your first real run, replace it with a real recording: `npm run sample -- <sessionId>` (the id is in the `#/arena/<id>` address), then commit `public/sample-crawl.json`.
- **Judges' guide:** `#/guide` explains how to try Bazaar in 90 seconds and shows, live, which parts are real on this server (AI model, PayPal sandbox, Channel3) and which are demo data.
- **Verify with PayPal now:** a button on every passport that checks the payment against PayPal.

## The two sides of the street

- **Buyers** pick a stall, set a secret limit and an agent style, authorize up to that limit in PayPal, and release the agents. The result is a Deal Passport.
- **Sellers** open a stall at `#/sell` (optionally starting from a real Channel3 product), set a secret floor, and get a private desk at `#/desk/<id>` with every haggle, margins over the floor and stats. The seller key is shown once and saved in the browser.

Haggles and listings are saved to `data/store.json` (git-ignored, mode 0600) so a restart keeps them. On Render's free plan the disk is wiped on redeploy, and demo stalls are re-created.

## Deploy to Render

1. Push this repo to GitHub (public, with the MIT `LICENSE`).
2. In Render choose **New > Web Service**, connect the repo, and set:
   - Build command: `npm install --include=dev && npm run build`
   - Start command: `npm start`
   - Health check path: `/api/health`
   - Environment: `NODE_VERSION=22`
3. Add environment variables (never commit them): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `CHANNEL3_API_KEY`, one of `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`, and `PUBLIC_BASE_URL=https://<your-service>.onrender.com`.
4. Open `/api/health`. It should report `agents` as your real model, `paypal: sandbox` and `channel3: configured`.

`render.yaml` describes the same service if you prefer a Blueprint.

**Saved data on Render.** On the free plan the disk is ephemeral: haggles, stalls you listed and passports are lost when the service sleeps or is redeployed, and the demo stalls are simply re-created. That is fine for judging. To keep data, use a paid plan, add a disk mounted at `/var/data` and set `DATA_FILE=/var/data/store.json`. The free plan sleeps after inactivity, so open the site a minute before recording or sharing it.

## Testing with a PayPal sandbox buyer

Create a **personal** sandbox account in the PayPal developer dashboard and use it on the PayPal approval screen. Anyone testing the project needs a sandbox buyer account; real PayPal accounts do not work in the sandbox.

## Not built (yet)

The webhook handler and live verification are implemented and unit-tested, but they need a webhook subscription in your PayPal dashboard and a live run before you can claim them as verified. Invoices and the PayPal Agent Toolkit/MCP are not used. Negotiation is about price only (warranty, shipping and returns are not negotiated). The seller desk is a plain table, not AG Grid. Saved state is one JSON file: on Render's free plan it is wiped when the service is redeployed.

## Choosing the AI provider (set one key in `.env`)

| Key | Cost | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Free tier, no card | Google AI Studio. Free-tier prompts may be used by Google to improve products, so keep personal data out. |
| `ANTHROPIC_API_KEY` | Pay per token | Default model `claude-haiku-5-5` |
| `OPENAI_BASE_URL` + `BAZAAR_MODEL` | Varies | Groq, OpenRouter or local Ollama |
| none | Free | Offline mock agents |

## PayPal sandbox spike

Verifies authorize max, capture less, and what happens to the remainder:

```bash
npm run spike             # authorize 150, capture 112.50
npm run spike -- 200 140  # custom max / captured price
```

Open the printed link and approve with your **sandbox personal** account.

## Layout

```
server/agents.ts        negotiation engine + guardrails + privacy filter + LLM providers
server/sessions.ts      listings, sessions, PayPal state machine, Deal Passport
server/paypal.ts        PayPal sandbox REST helpers
server/channel3.ts      Channel3 product search (market evidence + seller product picker)
server/index.ts         Express API (also serves the built UI from dist/)
server/*.test.ts        agent, crawl, payment-safety, access-control, doctor and real-HTTP tests
scripts/doctor.ts       npm run doctor: checks the whole setup, paste-safe
src/App.tsx             street of stalls, limit sheet, recent haggles
src/Seller.tsx          open a stall + the seller's private desk
src/Arena.tsx           negotiation arena, haggle line, Deal Passport
src/art.tsx             SVG artwork: lantern agents, bunting, awnings
src/api.ts              API client + stream reader
src/styles.css          the night-market look
src/ui.test.tsx         render tests
scripts/paypal-spike.ts sandbox risk check
```

## Security

Secrets live in `.env` (git-ignored). Never commit keys. PayPal calls are sandbox-only.

## License

MIT
