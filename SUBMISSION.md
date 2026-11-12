# Bazaar: Devpost submission kit

Everything below describes only what the code does today. Items marked **VERIFY** depend on your own accounts and must be confirmed by running the project before you submit. Delete this file's checklist section (or the whole file) from the public repo if you prefer.

## Before you submit (all must be true)

- [ ] `npm test` passes on your machine (133 tests).
- [ ] `package-lock.json` is committed to the repo.
- [ ] `npm run preflight` says "Safe to push" (run it before the first push and again before you submit).
- [ ] Optional: the PayPal webhook is added in the dashboard, `PAYPAL_WEBHOOK_ID` is set on Render, and a haggle's passport shows "Confirmed by a verified PayPal webhook". Skip the webhook line in the Devpost text if you do not do this.
- [ ] You ran one **street crawl** on the hosted site (the headphones row) and the winner's price was the only thing captured.
- [ ] `npm run spike` ran against your PayPal sandbox and showed the authorization capturing only the smaller negotiated amount. **VERIFY.** If PayPal behaved differently, change the PayPal paragraph below to match what you saw.
- [ ] `/api/health` on the hosted site says `agents` is a real model (not `mock`), `paypal: sandbox`, `channel3: configured`.
- [ ] You completed one full haggle on the hosted site with a sandbox buyer account and saw the capture in the PayPal sandbox dashboard.
- [ ] You also ran one no-deal haggle (set a limit below the seller's floor, for example $40 on the $95 camera) and saw the hold voided.
- [ ] You replaced the offline sample recording with a REAL one: after a real haggle run `npm run sample -- <sessionId>` and commit `public/sample-crawl.json` (check `#/replay` says it was recorded with a real model).
- [ ] A public GitHub repo with `LICENSE` visible, and no `.env` or `data/` committed.
- [ ] YouTube video is public and under 3:00.
- [ ] Testing instructions below contain a working sandbox buyer login for judges.
- [ ] The Devpost description names both PayPal and AI.
- [ ] Re-open the two Baymard sources in the Impact section on the day you submit, and update the figures if they changed.

## Project name

Bazaar

## Tagline

Send an AI agent to work the whole street. It plays the stalls against each other, and PayPal charges only the winning price.

## Inspiration

In a bazaar, a price is a conversation. Online, it is a fixed number, so shoppers overpay and small sellers lose sales they would have taken at a slightly lower price. We wanted a checkout where an AI agent does the haggling on each side, and where nobody has to trust the AI with their money.

## What it does

A seller opens a stall with a list price and a secret floor. A buyer sets a secret limit and a style for their agent, authorizes up to that limit with PayPal, and either haggles with one stall or sends the agent down a whole row of similar stalls. In a street crawl, up to four sellers' agents haggle at the same time. Whenever one stall agrees to a price, the buyer's limit in every other stall drops to just under it, so the agent can only improve on a deal it already holds. The cheapest deal wins. The buyer watches the offers close in on a "haggle line" that also shows the real market prices their agent is citing. When the agents agree, PayPal captures only the winning price. If they cannot agree, the authorization is voided and nothing is charged. Every haggle ends in a Deal Passport: the terms, a check that the limit held, the PayPal order, authorization and capture IDs, and the full transcript. Sellers get a private desk showing their floor, every haggle, verified revenue (only confirmed PayPal captures), rehearsal value kept separate, pending payments, margins, and the haggles they lost to a cheaper stall. Optional chimes and voices let you hear the lanterns haggle.

## Potential impact

**The problem, with sources.** Online prices are fixed, and shoppers walk away when the total is wrong for them.
- Baymard Institute's average across 50 published studies (2006 to 2025) is that about 70% of online shopping carts are abandoned (70.22%). Source: baymard.com/lists/cart-abandonment-rate, also summarised at redstagfulfillment.com/percentage-of-online-shoppers-abandon-their-cart/. Baymard updates this list from time to time, so quote the figure as it appears on the page the day you submit.
- In Baymard's 2023 survey of 2,219 US adults (a historical finding, not a 2026 measurement), the most common reason given for abandoning a checkout was that extra costs (shipping, tax, fees) were too high: 47%. Source: baymard.com/research, reported at optinmonster.com/cart-abandonment-statistics/.

**What the research does and does not show.** It shows that checkout abandonment is a large problem and that cost is the leading reason people give. It does not show that negotiation would recover those sales: extra costs such as shipping and tax are not fixed by a lower item price. **Our hypothesis** is that some buyers would complete a purchase at a price the seller would gladly accept, if anyone asked. Bazaar is a way to test that hypothesis, with a seller floor the agent can never cross. Proving real conversion gains needs a pilot with real merchants, which we have not done. Negotiating shipping and other terms is a planned next step, not something Bazaar does today.

**Who benefits.**
- *Buyers* get a better price without spending time haggling, and a hard guarantee that their agent can never spend above their limit, because PayPal itself holds only that amount and captures only the winning price.
- *Small sellers* recover sales they would have taken at a lower price, while the minimum they set is enforced in code. Their desk shows conversion, revenue, margin over their floor, and how close they were when they lost to a cheaper stall.
- *PayPal and merchants* see more completed payments from carts that would otherwise be abandoned.

**What we have and have not shown.** Everything runs in the PayPal sandbox with demo stalls. We make no claim about real-world uplift. The honest next step is a pilot with a few real sellers and a comparison of conversion with and without negotiation.

## How PayPal is used

- **Orders v2 with intent `AUTHORIZE`** for the buyer's maximum. The buyer approves it once in PayPal, then the server places the authorization hold.
- **Payments v2 capture** of only the negotiated price (`final_capture: true`), so the buyer is charged less than they authorized.
- **Void** when there is no deal, when a capture fails, or if PayPal leaves an unused remainder open.
- The server re-checks the agreed price against both mandates immediately before any capture, as a second guard independent of the AI.
- A capture counts as paid only when PayPal reports it `COMPLETED` (pending and denied captures are handled separately), captures use a stable request id so a retry cannot charge twice, and the authorized amount must match the buyer's limit exactly.
- Optional, if you configured it: signature-verified PayPal webhooks confirm captures server-side. A public "Verify with PayPal now" button on every passport checks the capture live. A pending capture is shown as pending and adds no revenue until PayPal completes it.
- Everything runs in the PayPal sandbox. No real money moves.

## How AI is used

Two separate LLM agents, one per side, each with its own private instructions, a personality, and a hidden limit. The buyer's agent also receives real market prices and, in a crawl, the other stalls' real public asks, and cites them as leverage. The AI only proposes moves (offer, accept, walk) as structured JSON. Plain code decides what is allowed: it clamps offers to each side's limit, blocks retreating or raising a price, redacts any line that would say a secret number aloud, and falls back to an offline agent if the model returns something unusable. An automated test checks that neither agent's prompt ever contains the other's secret. The "Limit guard" panel shows every proposal the code blocked.

## How Channel3 is used

Channel3's product search supplies real merchant prices that the buyer's agent cites during the haggle, the market ticks on the haggle line, and the product photos on the stalls. Sellers can also start a listing from a real Channel3 product. If Channel3 returns nothing, Bazaar shows no market data and never invents any.

## How we built it

TypeScript end to end. An Express API holds listings, sessions and the payment state machine; a React and Framer Motion interface draws the street, the lantern agents and the haggle line; state is saved to a JSON file. 133 automated tests cover the guardrails, the parallel crawl (lockstep rounds, the tightening limit, privacy between stalls), PayPal edge cases (pending, denied, retried and lost captures), access control, and a real-HTTP suite that tries to break the server, the payment flow (with a fake PayPal), privacy of each side's secrets, persistence, Channel3 parsing and the UI rendering. The project was built with the help of an AI coding assistant, and its final behaviour was checked by running it.

## Challenges

Keeping each side's secret actually secret, not only hidden in the UI: the seller's floor lives only on the server, the buyer's browser receives events filtered per viewer, every private route needs a buyer key that is stored only as a hash, and tests assert nothing leaks. A live test also caught a bug where one bad request could crash the server; it is fixed and now covered. Making an AI safe to hand a payment: we let it propose and made code the only thing that can approve. Free-tier AI rate limits, which we handled with spacing and a fallback.

## Accomplishments

A complete flow from listing to PayPal capture to a verifiable receipt, with a no-deal path that releases the hold, and an interface where the negotiation is the thing you watch.

## What we learned

An agent that can spend money needs a mandate enforced outside the model. PayPal's authorize-then-capture split maps naturally onto that idea.

## What's next

Verifying the PayPal webhook flow live and adding invoices as receipts, negotiating terms such as warranty, shipping and returns as well as price, a real database instead of one JSON file, and a pilot with real sellers.

## Built with

TypeScript, Node.js, Express, React, Vite, Framer Motion, PayPal REST API (Orders v2, Payments v2, sandbox), Channel3 API, Google Gemini API (or Anthropic Claude API, whichever you ran), Render. List only what you actually used in the submitted build.

## Testing instructions (paste into Devpost)

1. Open the live site: `<your Render URL>` (the free plan may take up to a minute to wake). The "Judges' guide" page explains everything below and shows what is real on the server.
2. Check the status chips at the top: real AI agents, PayPal sandbox, live market prices.
3. Choose "Send your agent down the whole row" on the headphones row (or any single stall), set a limit, choose an agent style and click "Authorize up to $X with PayPal".
4. Sign in to the PayPal sandbox with this buyer account: `<sandbox buyer email>` / `<sandbox buyer password>` (a fake sandbox account made for judging).
5. After approving you return to the arena (use the same browser: your haggle is private to it). Click "Release the agents" and watch the stalls haggle. Turn on "Sound and voices" if you like. The Deal Passport shows the winning stall and the PayPal capture IDs.
6. To see the no-deal path, set a limit far below every list price (for example $40 on the headphones row).
7. No PayPal sandbox account? Tick "Rehearsal" when you start, or press "Watch a recorded crawl" on the home page. Neither needs a login.
8. Optional: open "Open a stall" to sell something. Copy the seller key and open your desk.

## Demo video script (target 2:45, never over 3:00)

Record on the hosted site with real AI agents (not the offline demo agents), screen at 1080p, your own voice, Sound and voices turned on. No copyrighted music, no third-party logos.

| Time | On screen | Say |
|---|---|---|
| 0:00 | The street at night, stalls lighting up | "Seven in ten online carts are abandoned. Online, a price is a fixed number. In a bazaar, it is a conversation, and a smart shopper works the whole street. Bazaar sends an AI agent to do exactly that." Put a small on-screen caption: "Baymard Institute, average of 50 studies". |
| 0:15 | The seller form with a secret floor, then the desk | "A seller opens a stall with a secret floor. Their agent can never sell below it." |
| 0:25 | Headphones row, "Send your agent down the whole row", set the limit | "I set a secret limit and send my agent down the whole row of three stalls." |
| 0:40 | PayPal sandbox approval | "I authorize up to my limit with PayPal, once, for all three. Nothing is charged yet." |
| 0:55 | Crawl arena: three lanes haggle at once | "Three sellers' agents haggle with mine at the same time. Each bar shows where my offer and their ask stand." |
| 1:25 | The first stall agrees, my limit chip drops | "The moment one stall agrees to a price, my agent's limit drops below it everywhere else. It can only do better than a deal it already has." |
| 1:50 | Another stall undercuts, winner highlighted | "Now the stalls compete for me. The cheapest deal wins." |
| 2:05 | Deal Passport, then the PayPal sandbox dashboard | "PayPal captures only the winning price, not my whole authorization. Here is the capture in the sandbox." |
| 2:25 | A Limit guard entry (if one fired), then the seller desk showing "Lost to a cheaper stall" | "The AI only proposes; code enforces the limits. And sellers see exactly which haggles they lost, but never another stall's price." |
| 2:40 | Street, logo | "Bazaar. Your agent works the street, your limit holds, PayPal settles." |

Tips: the Limit guard only shows when the AI genuinely tries something out of bounds, so if it does not fire in your take, skip that beat rather than staging it. Open the site a minute earlier so the free-plan server is awake. A crawl makes many AI calls, so on a free Gemini key it can take a minute or two; rehearse, and trim the waiting in the edit. Hide your PayPal developer credentials and API keys in the recording.
