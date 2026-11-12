import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { negotiate, redactFor, type Deal, type GuardKind, type LlmFn, type NegEvent, type Persona, type Turn } from './agents.ts';
import { crawl, type CrawlLane, type CrawlResult } from './crawl.ts';
import type { PayApi } from './paypal.ts';
import { canTransition, countsAsSale, isVerifiedRevenue, paymentOutcome } from './paymentStatus.ts';

/* ------------------------------------------------------------------ *
 * Marketplace state: listings (seller secrets live here, server-side
 * only), buyer sessions, the PayPal authorize -> negotiate -> capture/void
 * state machine, and the Deal Passport.
 * Held in memory and snapshotted to a JSON file (see saveStore/loadStore below).
 * ------------------------------------------------------------------ */

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const PERSONAS: Persona[] = ['friendly', 'stubborn', 'dramatic'];
const CURRENCY = 'USD'; // PayPal sandbox + Channel3 default locale
const MAX_MONEY = 100_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_MONEY;
/** Seller text ends up inside LLM prompts, so keep it on one line without control characters. */
const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

let changeHook: ((immediate?: boolean) => void) | null = null;
export const setChangeHook = (fn: ((immediate?: boolean) => void) | null) => {
  changeHook = fn;
};
/** Tell the persistence layer something changed. `immediate` saves now (used right after money moves). */
export const touchStore = (immediate = false) => changeHook?.(immediate);

/* ------------------------------- listings ------------------------------- */

interface DealRecord {
  id: string;
  at: string;
  outcome: 'deal' | 'no_deal' | 'lost'; // lost = the buyer's agent took a cheaper stall
  price?: number;
  rounds?: number;
  buyerPersona: Persona;
  crawl?: boolean; // this haggle was a street crawl
  settlement?: 'completed' | 'pending' | 'rehearsal' | 'refunded' | 'failed'; // what PayPal says about the money for a sale
  wonVs?: number; // sold: how many competing stalls it beat
  lostByPct?: number; // lost: roughly how far above the winning price it was, in 5% bands
}
export interface Listing {
  id: string;
  title: string;
  description?: string;
  imageUrl?: string;
  category: string; // stalls in the same category compete in a street crawl
  listPrice: number;
  currency: string;
  floorPrice: number; // SECRET: never leaves the server except via sellerView()
  persona: Persona;
  sellerTokenHash: string; // SECRET: sha256 of the seller key. The key itself is shown once and never stored.
  createdAt: string;
  deals: DealRecord[];
}
export interface PublicListing {
  id: string;
  title: string;
  description?: string;
  imageUrl?: string;
  category: string;
  listPrice: number;
  currency: string;
  sellerPersona: Persona;
}

const listings = new Map<string, Listing>();
const sessions = new Map<string, Session>();

export function resetStore() {
  listings.clear();
  sessions.clear();
}

export type NewListing = Listing & { sellerToken: string };

export function createListing(input: any): NewListing {
  const title = oneLine(input?.title, 500);
  if (title.length < 3 || title.length > 80) throw new HttpError(400, 'title must be 3-80 characters');
  if (!isMoney(input?.listPrice)) throw new HttpError(400, 'listPrice must be a positive number');
  if (!isMoney(input?.floorPrice) || input.floorPrice > input.listPrice) throw new HttpError(400, 'floorPrice must be a positive number no higher than listPrice');
  const imageUrl = typeof input?.imageUrl === 'string' && input.imageUrl.startsWith('https://') ? input.imageUrl.slice(0, 500) : undefined;
  const l: Listing = {
    id: randomUUID().slice(0, 8),
    title,
    description: oneLine(input?.description, 300) || undefined,
    imageUrl,
    category: oneLine(input?.category, 30).toLowerCase() || 'misc',
    listPrice: r2(input.listPrice),
    currency: CURRENCY,
    floorPrice: r2(input.floorPrice),
    persona: PERSONAS.includes(input?.persona) ? input.persona : 'stubborn',
    sellerTokenHash: '',
    createdAt: new Date().toISOString(),
    deals: [],
  };
  const sellerToken = randomBytes(18).toString('hex');
  l.sellerTokenHash = sha(sellerToken).toString('hex');
  listings.set(l.id, l);
  touchStore();
  return { ...l, sellerToken }; // the raw key leaves here, once
}

export function publicListing(l: Listing): PublicListing {
  return { id: l.id, title: l.title, description: l.description, imageUrl: l.imageUrl, category: l.category, listPrice: l.listPrice, currency: l.currency, sellerPersona: l.persona };
}
export const listPublicListings = () => [...listings.values()].map(publicListing);

export function getListing(id: string): Listing {
  const l = listings.get(id);
  if (!l) throw new HttpError(404, 'Listing not found');
  return l;
}

export function seedListings(): Listing[] {
  return [
    { category: 'headphones', title: 'Wireless noise-cancelling headphones', description: 'Over-ear, 30h battery. Barely used.', listPrice: 180, floorPrice: 115, persona: 'stubborn' },
    { category: 'headphones', title: 'Noise-cancelling headphones, boxed', description: 'Sealed box, full warranty.', listPrice: 165, floorPrice: 100, persona: 'friendly' },
    { category: 'headphones', title: 'Studio wireless headphones, open box', description: 'Opened once, like new.', listPrice: 150, floorPrice: 92, persona: 'dramatic' },
    { category: 'keyboards', title: 'Mechanical keyboard, hot-swap 75%', description: 'Tactile switches, PBT keycaps.', listPrice: 120, floorPrice: 70, persona: 'friendly' },
    { category: 'keyboards', title: 'Compact wireless mechanical keyboard', description: 'Three device pairing, backlit.', listPrice: 110, floorPrice: 72, persona: 'stubborn' },
    { category: 'cameras', title: 'Instant film camera', description: 'Works great, includes strap.', listPrice: 95, floorPrice: 60, persona: 'dramatic' },
    { category: 'cameras', title: 'Vintage 35mm film camera', description: 'Fully serviced, new light seals.', listPrice: 130, floorPrice: 82, persona: 'stubborn' },
  ].map(createListing);
}

/** Seller-only view: includes the floor and every deal on this listing. */
export function sellerView(listingId: string, token: string | undefined) {
  const l = getListing(listingId);
  if (!token || !l.sellerTokenHash || !timingSafeEqual(sha(token), Buffer.from(l.sellerTokenHash, 'hex'))) throw new HttpError(403, 'Invalid seller token');
  const dealt = l.deals.filter((d) => d.outcome === 'deal');
  const settled = (k: DealRecord['settlement']) => dealt.filter((d) => d.settlement === k);
  const verified = dealt.filter((d) => d.settlement === undefined || d.settlement === 'completed'); // confirmed PayPal captures (older records had no marker)
  const sum = (xs: DealRecord[]) => r2(xs.reduce((t, d) => t + (d.price ?? 0), 0));
  const n = l.deals.length;
  return {
    listing: { ...publicListing(l), floorPrice: l.floorPrice },
    deals: l.deals,
    stats: {
      negotiations: n,
      agreed: dealt.length, // a price was agreed (paid, pending, rehearsal or later refunded)
      agreementPct: n ? Math.round((dealt.length / n) * 100) : null,
      sold: verified.length, // only confirmed PayPal captures
      conversionPct: n ? Math.round((verified.length / n) * 100) : null,
      revenue: sum(verified), // verified revenue only
      simulatedDeals: settled('rehearsal').length, // rehearsals: no money moved
      simulatedValue: sum(settled('rehearsal')),
      pendingPayments: settled('pending').length,
      pendingValue: sum(settled('pending')),
      refundedValue: sum(settled('refunded')),
      noDeal: l.deals.filter((d) => d.outcome === 'no_deal').length,
      lost: l.deals.filter((d) => d.outcome === 'lost').length,
      wonVsCompetitors: dealt.filter((d) => d.crawl).length,
      avgPrice: verified.length ? r2(sum(verified) / verified.length) : null,
      avgMarginOverFloor: verified.length ? r2((sum(verified) - l.floorPrice * verified.length) / verified.length) : null,
    },
  };
}

/* ------------------------------- sessions ------------------------------- */

export type SessionState = 'awaiting_approval' | 'ready' | 'negotiating' | 'settled' | 'pending_payment' | 'no_deal' | 'failed';

export interface PaymentInfo {
  mode: 'paypal_sandbox' | 'not_configured';
  orderId?: string;
  approveUrl?: string;
  authId?: string;
  authStatus?: string;
  captureId?: string;
  captureStatus?: string;
  finalAuthStatus?: string;
  voided?: boolean;
  error?: string;
  webhook?: { event: string; at: string }; // a verified PayPal webhook confirmed the outcome
  webhookEventIds?: string[]; // recent webhook deliveries, so a replay is ignored
  rehearsal?: boolean; // the buyer chose to skip PayPal (no sandbox login, nothing charged)
  /** Written and saved BEFORE the capture call, so a crash mid-capture can be recovered by replaying the same idempotent request. */
  captureIntent?: { price: number; currency: string; requestId: string; invoiceId: string; note: string; at: string };
  /** PayPal reported an amount or currency that does not match the agreed deal. Such a payment is never treated as paid. */
  mismatch?: { amount?: number; currency?: string; at: string };
}
export interface MarketRef {
  store: string;
  price: number;
  title?: string; // the specific product that offer is for (similar items, not necessarily identical)
  url?: string;
}
export interface MarketInfo {
  source: 'channel3' | 'none';
  reference: MarketRef[];
  retrievedAt?: string;
}
export interface Session {
  id: string;
  listingId: string; // the first stall
  listingIds: string[]; // one stall = a normal haggle; 2-4 = a street crawl
  maxBudget: number;
  buyerPersona: Persona;
  state: SessionState;
  createdAt: string;
  buyerTokenHash?: string; // sha256 of the buyer's secret access token; the token itself is never stored
  payment: PaymentInfo;
  market: MarketInfo;
  events: NegEvent[]; // internal log (single stall): contains secrets, never serialised directly
  lanes?: Record<string, NegEvent[]>; // internal log per stall (crawl): contains secrets
  turnLog?: PassportTurn[]; // every turn in arrival order (crawl)
  winnerId?: string; // the stall that won (set once a deal is agreed)
  agreed?: { price: number; rounds: number; savings: number; savingsPct: number; currency: string }; // the deal, saved before any money moves
  aiMode?: string; // which AI provider ran this haggle (needed to rebuild a passport after a crash)
  best?: { lane: string; price: number; cap: number };
  bestLog?: { lane: string; price: number; cap: number }[]; // every update, in order (for replays)
  crawlEnd?: CrawlEnd;
  passport?: Passport;
}
export type PassportTurn = Turn & { stall?: string };
export interface CrawlEnd {
  winner: { lane: string; price: number; rounds: number; savings: number; savingsPct: number } | null;
  results: CrawlResult[];
}

export interface Passport {
  id: string;
  createdAt: string;
  settledAt: string;
  item: { title: string; imageUrl?: string; listPrice: number; currency: string };
  outcome: 'deal' | 'no_deal';
  explanation: string; // why this result, in plain words (never reveals a hidden limit)
  agreedPrice?: number;
  savings?: number;
  savingsPct?: number;
  rounds?: number;
  mandate: { buyerCap?: number; respected: boolean; guardrailBlocks: number; blockedKinds: GuardKind[] };
  market: MarketInfo;
  payment: PaymentInfo;
  agents: { buyer: Persona; seller: Persona; ai: string; usage?: { moves: number; fallbackMoves: number } };
  crawl?: { stalls: { title: string; result: 'won' | 'lost' | 'no_deal'; price?: number; lastAsk?: number }[] };
  transcript: PassportTurn[];
}

export type ViewEvent =
  | NegEvent
  | { type: 'payment'; status: 'captured' | 'pending' | 'voided' | 'skipped' | 'failed'; amount?: number; currency?: string; captureId?: string; authStatus?: string; message: string }
  | { type: 'passport'; passport: Passport }
  | { type: 'error'; message: string }
  | { type: 'lane'; lane: string; ev: NegEvent } // one stall's (already redacted) event during a crawl
  | { type: 'best'; lane: string; price: number; cap: number }
  | ({ type: 'crawl_end' } & CrawlEnd);

export interface CreateDeps {
  pay: PayApi | null;
  baseUrl: string;
  searchMarket: (title: string) => Promise<MarketRef[]>;
}
export interface RunDeps {
  llm: LlmFn;
  pay: PayApi | null;
  aiMode: string;
}

export function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new HttpError(404, 'Session not found');
  return s;
}

const sha = (v: string) => createHash('sha256').update(v).digest();
const issuedTokens = new WeakMap<Session, string>();
/** The raw buyer token exists only at creation: hand it to the buyer once, then forget it. */
export const takeBuyerToken = (s: Session) => {
  const t = issuedTokens.get(s);
  issuedTokens.delete(s);
  return t;
};
/** Buyer-only access: a session id alone is not enough to read a haggle or release the agents. */
export function requireBuyer(id: string, token: string | undefined): Session {
  const s = getSession(id);
  if (!token || !s.buyerTokenHash || !timingSafeEqual(sha(token), Buffer.from(s.buyerTokenHash, 'hex'))) {
    throw new HttpError(403, 'This haggle belongs to the browser that started it');
  }
  return s;
}
/** The shareable version of a passport: no limits, no PayPal identifiers or approval links. */
export function publicPassport(p: Passport): Passport {
  return { ...p, mandate: { ...p.mandate, buyerCap: undefined }, payment: { mode: p.payment.mode, rehearsal: p.payment.rehearsal, captureStatus: p.payment.captureStatus, finalAuthStatus: p.payment.finalAuthStatus, voided: p.payment.voided } };
}

export async function createSession(input: any, deps: CreateDeps): Promise<Session> {
  const ids: string[] = Array.isArray(input?.listingIds) ? [...new Set<string>(input.listingIds.map(String))] : [String(input?.listingId ?? '')];
  if (ids.length < 1 || ids.length > 4) throw new HttpError(400, 'Pick between one and four stalls');
  const targets = ids.map(getListing);
  if (targets.some((t) => t.category !== targets[0].category || t.currency !== targets[0].currency)) {
    throw new HttpError(400, 'All stalls in a street crawl must be in the same row and the same currency');
  }
  if (!isMoney(input?.maxBudget)) throw new HttpError(400, 'maxBudget must be a positive number');
  const id = randomUUID();
  const l = targets[0];
  const reference = await deps.searchMarket(l.title).catch(() => []);
  const s: Session = {
    id,
    listingId: l.id,
    listingIds: targets.map((t) => t.id),
    maxBudget: r2(input.maxBudget),
    buyerPersona: PERSONAS.includes(input?.buyerPersona) ? input.buyerPersona : 'friendly',
    state: 'ready',
    createdAt: new Date().toISOString(),
    payment: { mode: 'not_configured' },
    market: { source: reference.length ? 'channel3' : 'none', reference, retrievedAt: reference.length ? new Date().toISOString() : undefined },
    events: [],
  };
  const rehearsal = input?.rehearsal === true;
  if (rehearsal) s.payment = { mode: 'not_configured', rehearsal: true };
  const buyerToken = randomBytes(24).toString('hex');
  s.buyerTokenHash = sha(buyerToken).toString('hex');
  issuedTokens.set(s, buyerToken);
  if (deps.pay && !rehearsal) {
    // The buyer authorises their MAX once; only the negotiated price will ever be captured.
    const order = await deps.pay.createOrder({
      maxAmount: s.maxBudget,
      currency: l.currency,
      description: targets.length > 1 ? `BAZAAR street crawl: ${l.category}` : `BAZAAR mandate for: ${l.title}`,
      returnUrl: `${deps.baseUrl}/api/paypal/return?session=${id}`,
      cancelUrl: `${deps.baseUrl}/api/paypal/cancel?session=${id}`,
    });
    s.payment = { mode: 'paypal_sandbox', orderId: order.id, approveUrl: order.approveUrl };
    s.state = 'awaiting_approval';
  }
  sessions.set(id, s);
  touchStore();
  return s;
}

/** Called when the buyer comes back from PayPal: verify approval, then place the authorization hold. */
export async function approveSession(id: string, pay: PayApi): Promise<Session> {
  const s = getSession(id);
  if (s.state !== 'awaiting_approval') return s; // idempotent
  const status = await pay.getOrderStatus(s.payment.orderId!);
  if (status !== 'APPROVED') throw new HttpError(409, `PayPal order is ${status}, not APPROVED yet`);
  const a = await pay.authorize(s.payment.orderId!);
  const currency = getListing(s.listingId).currency;
  if (Math.abs(a.amount - s.maxBudget) > 0.005 || a.currency !== currency) {
    // PayPal must hold exactly the buyer's limit, in the expected currency. Anything else is released untouched.
    await pay.void(a.authId).catch(() => undefined);
    throw new HttpError(409, `PayPal authorized ${a.amount} ${a.currency}, not your ${s.maxBudget} ${currency} limit. The hold was released and nothing will be charged.`);
  }
  s.payment.authId = a.authId;
  s.payment.authStatus = a.status;
  s.state = 'ready';
  touchStore();
  return s;
}

export function sessionView(s: Session) {
  const items = s.listingIds.map(getListing).map(publicListing);
  const redact = (evs: NegEvent[]) => evs.map((e) => redactFor('buyer', e)).filter((e): e is NegEvent => e !== null);
  return {
    id: s.id,
    state: s.state,
    mode: s.listingIds.length > 1 ? ('crawl' as const) : ('single' as const),
    item: items[0],
    items,
    maxBudget: s.maxBudget, // the viewer's own secret
    limitHidden: false as boolean, // true only in a public recording, where the limit is removed
    buyerPersona: s.buyerPersona,
    payment: s.payment,
    market: s.market,
    events: redact(s.events),
    lanes: Object.fromEntries(Object.entries(s.lanes ?? {}).map(([lane, evs]) => [lane, redact(evs)])),
    best: s.best,
    bests: s.bestLog ?? [],
    crawl: s.crawlEnd,
    passport: s.passport,
  };
}

type DealEv = Extract<NegEvent, { type: 'deal' }>;

function dealFor(s: Session, l: Listing, rivals: number): Deal {
  return {
    item: { title: l.title, listPrice: l.listPrice, currency: l.currency },
    buyer: { maxBudget: s.maxBudget, persona: s.buyerPersona, marketPrices: s.market.reference },
    seller: { floorPrice: l.floorPrice, persona: l.persona },
    rivals: rivals || undefined,
  };
}

/** Refuse (409) before anything starts if the haggle cannot be run right now. */
export function assertRunnable(s: Session) {
  if (s.state !== 'ready') {
    throw new HttpError(409, s.state === 'awaiting_approval' ? 'Approve the PayPal authorization first' : `Session is already ${s.state}`);
  }
}

export async function* runSession(id: string, deps: RunDeps): AsyncGenerator<ViewEvent> {
  const s = getSession(id);
  assertRunnable(s);
  const targets = s.listingIds.map(getListing);
  s.state = 'negotiating';
  touchStore();

  let winner: Listing | undefined;
  let dealEv: DealEv | undefined;
  try {
    if (targets.length === 1) {
      for await (const ev of negotiate(dealFor(s, targets[0], 0), deps.llm)) {
        s.events.push(ev);
        if (ev.type === 'deal') dealEv = ev;
        const v = redactFor('buyer', ev);
        if (v) yield v;
      }
      if (dealEv) winner = targets[0];
    } else {
      s.lanes = {};
      s.turnLog = [];
      const titles = new Map(targets.map((t) => [t.id, t.title]));
      const lanes: CrawlLane[] = targets.map((t) => ({ id: t.id, title: t.title, deal: dealFor(s, t, targets.length - 1) }));
      for await (const ce of crawl(lanes, deps.llm, s.maxBudget)) {
        if (ce.type === 'lane') {
          (s.lanes[ce.lane] ??= []).push(ce.ev);
          if (ce.ev.type === 'turn') s.turnLog.push({ ...ce.ev.turn, stall: titles.get(ce.lane) });
          const v = redactFor('buyer', ce.ev);
          if (v) yield { type: 'lane', lane: ce.lane, ev: v };
        } else if (ce.type === 'best') {
          s.best = { lane: ce.lane, price: ce.price, cap: ce.cap };
          (s.bestLog ??= []).push({ lane: ce.lane, price: ce.price, cap: ce.cap });
          yield ce;
        } else {
          s.crawlEnd = { winner: ce.winner, results: ce.results };
          yield { type: 'crawl_end', winner: ce.winner, results: ce.results };
          if (ce.winner) {
            winner = getListing(ce.winner.lane);
            dealEv = { type: 'deal', price: ce.winner.price, rounds: ce.winner.rounds, savings: ce.winner.savings, savingsPct: ce.winner.savingsPct, currency: winner.currency };
            yield dealEv;
          }
        }
      }
    }
  } catch (e) {
    s.state = 'failed';
    const message = e instanceof Error ? e.message : 'negotiation failed';
    yield* releaseHold(s, deps.pay);
    yield { type: 'error', message };
    return;
  }

  if (dealEv && winner) {
    // Write the agreed deal down BEFORE any money moves, so a crash at any later point can be recovered.
    s.agreed = { price: dealEv.price, rounds: dealEv.rounds, savings: dealEv.savings, savingsPct: dealEv.savingsPct, currency: dealEv.currency };
    s.winnerId = winner.id;
    s.aiMode = deps.aiMode;
    touchStore(true);
  }

  /* ---- settle on PayPal ---- */
  let failed = false;
  if (dealEv && winner) {
    const price = dealEv.price;
    const withinMandates = price <= s.maxBudget + 1e-9 && price >= winner.floorPrice - 1e-9;
    if (!withinMandates) {
      // Cannot happen (the engine clamps), but money code gets a second, independent check.
      failed = true;
      s.payment.error = 'Agreed price outside the mandates; payment blocked';
      yield* releaseHold(s, deps.pay);
      yield { type: 'payment', status: 'failed', message: s.payment.error };
    } else if (deps.pay && s.payment.authId) {
      failed = yield* captureWinner(s, winner, price, deps.pay);
    } else {
      yield { type: 'payment', status: 'skipped', message: s.payment.rehearsal ? 'This was a rehearsal: PayPal was skipped by choice, so nothing was charged.' : 'PayPal is not configured on this server, so no payment was made.' };
    }
  } else {
    yield* releaseHold(s, deps.pay);
  }

  finalizeSession(s, targets, winner, dealEv, failed, deps.aiMode);
  yield { type: 'passport', passport: s.passport! };
}

/**
 * Close a haggle: decide its state from what PayPal says, tell every stall's desk, and write the passport.
 * Used at the end of a normal run and by crash recovery, so both produce exactly the same records.
 */
function finalizeSession(s: Session, targets: Listing[], winner: Listing | undefined, dealEv: DealEv | undefined, failed: boolean, aiMode: string) {
  const agreed = Boolean(dealEv && winner) && !failed;
  const paid = paymentOutcome(s.payment);
  s.winnerId = agreed ? winner!.id : undefined;
  // Two separate questions: was a price agreed, and did PayPal actually complete the payment?
  s.state = failed ? 'failed' : !dealEv ? 'no_deal' : countsAsSale(paid) ? 'settled' : 'pending_payment';
  const settlement = paid === 'rehearsal' ? 'rehearsal' : isVerifiedRevenue(paid) ? 'completed' : 'pending';
  const at = new Date().toISOString();
  const crawlMode = targets.length > 1;
  const mine = s.id.slice(0, 8);
  for (const t of targets) {
    if (t.deals.some((d) => d.id === mine)) continue; // already recorded (recovery is safe to repeat)
    const held = s.crawlEnd?.results.find((r) => r.lane === t.id && r.outcome === 'held');
    const base = { id: mine, at, buyerPersona: s.buyerPersona, crawl: crawlMode || undefined };
    if (agreed && t.id === winner!.id) t.deals.push({ ...base, outcome: 'deal', settlement, price: dealEv!.price, rounds: dealEv!.rounds, wonVs: crawlMode ? targets.length - 1 : undefined });
    else if (agreed && held) {
      // Tell the loser roughly how far off it was (in 5% bands), never the winner's exact price.
      const gap = ((held.price! - dealEv!.price) / dealEv!.price) * 100;
      t.deals.push({ ...base, outcome: 'lost', price: held.price, lostByPct: Math.max(0, Math.round(gap / 5) * 5) });
    } else t.deals.push({ ...base, outcome: 'no_deal' });
  }
  s.passport = buildPassport(s, targets, winner, dealEv, aiMode);
  touchStore(true);
}

/** No deal (or a failure): void the authorization so the buyer's hold is released. */
async function* releaseHold(s: Session, pay: PayApi | null): AsyncGenerator<ViewEvent> {
  if (!pay || !s.payment.authId || s.payment.captureId) {
    if (!s.payment.authId) yield { type: 'payment', status: 'skipped', message: 'No payment hold was placed, so nothing was charged.' };
    return;
  }
  try {
    await pay.void(s.payment.authId);
    s.payment.voided = true;
    s.payment.finalAuthStatus = await pay.getAuthStatus(s.payment.authId).catch(() => 'VOIDED');
    yield { type: 'payment', status: 'voided', authStatus: s.payment.finalAuthStatus, message: 'No deal, so the PayPal authorization was voided and nothing was charged.' };
  } catch (e) {
    s.payment.error = `Could not void the authorization: ${e instanceof Error ? e.message : e}`;
    yield { type: 'payment', status: 'failed', message: s.payment.error };
  }
}

/**
 * Capture the winning price and decide, from what PayPal actually says, what happened.
 * Returns true when the payment failed. Never trusts "the request succeeded" as "the money moved".
 */
async function* captureWinner(s: Session, winner: Listing, price: number, pay: PayApi): AsyncGenerator<ViewEvent, boolean> {
  const authId = s.payment.authId!;
  const cur = winner.currency;
  const requestId = `bazaar-capture-${s.id}`; // stable: a retry can never capture twice
  const note = `BAZAAR negotiated price for ${winner.title}`.slice(0, 120);
  const invoiceId = `BAZAAR-${s.id.slice(0, 8)}`;
  s.payment.captureIntent = { price, currency: cur, requestId, invoiceId, note, at: new Date().toISOString() };
  touchStore(true); // saved BEFORE PayPal is asked: a crash mid-capture can be recovered by replaying this exact request
  let cap: { captureId: string; status: string } | undefined;
  let lastError = 'capture failed';
  for (let attempt = 0; attempt < 2 && !cap; attempt++) {
    try {
      cap = await pay.capture(authId, price, cur, note, invoiceId, requestId);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number }).status;
      if (status !== undefined && status < 500) break; // PayPal said no: retrying cannot help
    }
  }

  if (!cap) {
    // We do not know whether PayPal captured. Ask it before doing anything irreversible.
    let authStatus: string | undefined;
    try {
      authStatus = await pay.getAuthStatus(authId);
    } catch {
      authStatus = undefined;
    }
    if (authStatus === 'CAPTURED' || authStatus === 'PARTIALLY_CAPTURED') {
      s.payment.captureStatus = 'RECONCILED';
      s.payment.finalAuthStatus = authStatus;
      yield { type: 'payment', status: 'captured', amount: price, currency: cur, authStatus, message: `PayPal confirmed the capture of ${price.toFixed(2)} ${cur} after a connection problem (PayPal sandbox).` };
      return false;
    }
    if (authStatus === undefined) {
      s.payment.error = `Could not confirm the payment status with PayPal (${lastError}). Check the PayPal sandbox dashboard before trying again. The hold was left untouched.`;
      yield { type: 'payment', status: 'failed', message: s.payment.error };
      return true;
    }
    s.payment.error = lastError;
    yield* releaseHold(s, pay); // nothing was captured, so releasing the hold is safe
    yield { type: 'payment', status: 'failed', message: lastError };
    return true;
  }

  const reported = String(cap.status).toUpperCase();
  // A webhook may already have said something newer while this request was in flight: statuses only move forward.
  if (!s.payment.captureStatus || canTransition(s.payment.captureStatus, reported)) s.payment.captureStatus = reported;
  const st = String(s.payment.captureStatus).toUpperCase();
  if (st !== 'COMPLETED' && st !== 'PENDING') {
    // DECLINED, DENIED, FAILED...: PayPal did not take the money.
    touchStore(true);
    s.payment.error = `PayPal capture ended as ${st || 'UNKNOWN'}, so nothing was charged`;
    yield* releaseHold(s, pay);
    yield { type: 'payment', status: 'failed', message: s.payment.error };
    return true;
  }
  setCapture(s, cap.captureId, st); // id and status written together and saved at once
  s.payment.finalAuthStatus = await pay.getAuthStatus(authId).catch(() => undefined);
  // If PayPal keeps the unused remainder of the hold open, release it explicitly.
  if (st === 'COMPLETED' && s.payment.finalAuthStatus && !['CAPTURED', 'VOIDED'].includes(s.payment.finalAuthStatus)) {
    try {
      await pay.void(authId);
      s.payment.voided = true;
      s.payment.finalAuthStatus = await pay.getAuthStatus(authId).catch(() => 'VOIDED');
    } catch (e) {
      s.payment.error = `Captured, but releasing the remaining hold failed: ${e instanceof Error ? e.message : e}`;
    }
  }
  if (st === 'PENDING') {
    yield { type: 'payment', status: 'pending', amount: price, currency: cur, captureId: cap.captureId, authStatus: s.payment.finalAuthStatus, message: `PayPal accepted the capture of ${price.toFixed(2)} ${cur} but it is still pending, so it is not final yet. Check the PayPal sandbox dashboard.` };
    return false;
  }
  yield { type: 'payment', status: 'captured', amount: price, currency: cur, captureId: cap.captureId, authStatus: s.payment.finalAuthStatus, message: `Captured ${price.toFixed(2)} ${cur} of the ${s.maxBudget.toFixed(2)} ${cur} authorization (PayPal sandbox).` };
  return false;
}

/** Plain-words reasons for the result. Uses only public facts (prices that were offered), never a hidden limit. */
function explain(s: Session, targets: Listing[], winner: Listing | undefined, dealEv: DealEv | undefined, ok: boolean): string {
  const cur = targets[0].currency;
  const m = (n: number) => `${n.toFixed(2)} ${cur}`;
  if (!dealEv || !winner) {
    return targets.length > 1 ? `No stall could agree to a price inside your limit, so nothing was bought and nothing was charged.` : `The two agents could not agree on a price inside both limits, so nothing was bought and nothing was charged.`;
  }
  if (!ok) return `A price was agreed (${m(dealEv.price)}) but the payment did not go through, so nothing was bought.`;
  const po = paymentOutcome(s.payment);
  const tail = po === 'pending' || po === 'unverified' ? ' PayPal has not finished the payment yet, so the sale is not final.' : '';
  if (targets.length === 1) return `${winner.title} agreed to ${m(dealEv.price)}, inside your limit, and PayPal was asked to capture only that amount.${tail}`;
  const others = (s.crawlEnd?.results ?? []).filter((r) => r.lane !== winner.id);
  const worse = others.filter((r) => r.outcome === 'held');
  const out = others.filter((r) => r.outcome === 'no_deal').length;
  return `${winner.title} won because it agreed to the lowest price, ${m(dealEv.price)}, inside your limit.` + (worse.length ? ` ${worse.length === 1 ? 'Another stall' : `${worse.length} other stalls`} also agreed but at a higher price.` : '') + (out ? ` ${out === 1 ? 'One stall' : `${out} stalls`} could not agree below your limit.` : '') + tail;
}

function buildPassport(s: Session, targets: Listing[], winner: Listing | undefined, dealEv: DealEv | undefined, aiMode: string): Passport {
  const l = winner ?? targets[0];
  const crawlMode = targets.length > 1;
  const allEvents = crawlMode ? Object.values(s.lanes ?? {}).flat() : s.events;
  // Only the buyer's OWN guardrail events go into the passport.
  const blocks = allEvents.filter((e): e is Extract<NegEvent, { type: 'guardrail' }> => e.type === 'guardrail' && e.side === 'buyer' && e.kind !== 'bad_json');
  const ok = Boolean(dealEv && winner) && s.state !== 'failed'; // a price was agreed and the payment did not fail
  const turns = crawlMode ? (s.turnLog ?? []) : s.events.flatMap((e) => (e.type === 'turn' ? [e.turn] : []));
  const modelTurns = turns.filter((t) => t.side === 'buyer' || t.side === 'seller');
  return {
    id: s.id,
    createdAt: s.createdAt,
    settledAt: new Date().toISOString(),
    item: { title: crawlMode && !winner ? `The ${l.category} row (${targets.length} stalls)` : l.title, imageUrl: l.imageUrl, listPrice: l.listPrice, currency: l.currency },
    outcome: dealEv && ok ? 'deal' : 'no_deal',
    explanation: explain(s, targets, winner, dealEv, ok),
    agreedPrice: dealEv && ok ? dealEv.price : undefined,
    savings: dealEv && ok ? dealEv.savings : undefined,
    savingsPct: dealEv && ok ? dealEv.savingsPct : undefined,
    rounds: dealEv?.rounds,
    mandate: {
      buyerCap: s.maxBudget,
      respected: !dealEv || dealEv.price <= s.maxBudget + 1e-9,
      guardrailBlocks: blocks.length,
      blockedKinds: [...new Set(blocks.map((b) => b.kind))],
    },
    market: s.market,
    payment: s.payment,
    agents: { buyer: s.buyerPersona, seller: l.persona, ai: aiMode, usage: { moves: modelTurns.length, fallbackMoves: modelTurns.filter((t) => t.fallback).length } },
    crawl: crawlMode
      ? {
          stalls: targets.map((t) => {
            const r = s.crawlEnd?.results.find((x) => x.lane === t.id);
            return {
              title: t.title,
              result: ok && winner && t.id === winner.id ? ('won' as const) : r?.outcome === 'held' ? ('lost' as const) : ('no_deal' as const),
              price: r?.price,
              lastAsk: r?.lastAsk,
            };
          }),
        }
      : undefined,
    transcript: crawlMode ? (s.turnLog ?? []) : s.events.filter((e): e is Extract<NegEvent, { type: 'turn' }> => e.type === 'turn').map((e) => e.turn),
  };
}

/* ---------------------------- PayPal status changes + reconciliation ---------------------------- */

/**
 * Re-derive the session state, the seller's record and the passport from what PayPal says about the money.
 * One function, used by webhooks, live verification and restart reconciliation, so they cannot disagree.
 */
function syncSettlement(s: Session) {
  if (!s.winnerId) return;
  const o = paymentOutcome(s.payment);
  const winner = listings.get(s.winnerId);
  const rec = winner?.deals.find((d) => d.id === s.id.slice(0, 8) && (d.outcome === 'deal' || d.settlement === 'failed'));
  if (o === 'completed' || o === 'rehearsal') s.state = 'settled';
  else if (o === 'pending' || o === 'unverified') s.state = 'pending_payment';
  else if (o === 'unsuccessful') s.state = 'failed';
  else if (o === 'refunded' || o === 'partially_refunded') s.state = 'settled'; // the sale happened, then money went back
  if (rec) {
    if (o === 'completed') rec.settlement = 'completed';
    else if (o === 'pending' || o === 'unverified') rec.settlement = 'pending';
    else if (o === 'refunded' || o === 'partially_refunded') rec.settlement = 'refunded';
    else if (o === 'unsuccessful') {
      rec.outcome = 'no_deal';
      rec.settlement = 'failed';
      delete rec.price;
    }
  }
  if (s.passport) {
    s.passport.payment = s.payment;
    if (o === 'unsuccessful') {
      s.passport.outcome = 'no_deal';
      s.passport.agreedPrice = s.passport.savings = s.passport.savingsPct = undefined;
      s.passport.explanation = 'A price was agreed but PayPal did not take the payment, so nothing was bought and nothing was charged.';
    }
  }
}

/** Record what PayPal answered for a capture. The id and the status are written together and saved at once; the status obeys the same forward-only rule as webhooks. */
function setCapture(s: Session, captureId: string, status: string) {
  const next = status.toUpperCase();
  s.payment.captureId = captureId;
  if (!s.payment.captureStatus || canTransition(s.payment.captureStatus, next)) s.payment.captureStatus = next;
  touchStore(true);
}

/** Apply a PayPal capture status if it is a legal step forward. Returns whether anything changed. */
export function applyCaptureStatus(s: Session, status: string): boolean {
  const next = status.toUpperCase();
  if (!canTransition(s.payment.captureStatus, next)) return false;
  s.payment.captureStatus = next;
  syncSettlement(s);
  touchStore(true);
  return true;
}

/** Does PayPal's amount and currency equal the agreed deal? A missing amount cannot vouch for it. */
function amountMatches(s: Session, amount: unknown, currency: unknown): boolean {
  if (!s.agreed) return false;
  return Math.abs(Number(amount) - s.agreed.price) < 0.005 && String(currency) === s.agreed.currency;
}

/** Mark a payment as not matching the deal, so it can never count as paid, and re-derive everything from that. */
function flagMismatch(s: Session, amount: unknown, currency: unknown) {
  s.payment.mismatch = { amount: Number.isFinite(Number(amount)) ? Number(amount) : undefined, currency: currency === undefined ? undefined : String(currency), at: new Date().toISOString() };
  syncSettlement(s);
  touchStore(true);
}

/**
 * Apply a (signature-verified) PayPal webhook. A genuine PayPal event is not automatically THIS deal's payment, so
 * the capture id, the invoice, the amount and the currency are all checked before any status is believed.
 * Returns whether a session matched.
 */
export function applyPayPalEvent(ev: any): boolean {
  const type = String(ev?.event_type ?? '');
  const res = ev?.resource ?? {};
  if (!type.startsWith('PAYMENT.CAPTURE.')) return false;
  const invoice = String(res.invoice_id ?? res.supplementary_data?.related_ids?.invoice_id ?? '');
  const s = [...sessions.values()].find((x) => (x.payment.captureId && x.payment.captureId === res.id) || (invoice && invoice === `BAZAAR-${x.id.slice(0, 8)}`));
  if (!s) return false;
  if (s.payment.captureId && res.id && s.payment.captureId !== res.id) return false; // another capture that merely carries our invoice
  const eventId = String(ev?.id ?? '');
  if (eventId) {
    if (s.payment.webhookEventIds?.includes(eventId)) return true; // a replayed delivery changes nothing
    s.payment.webhookEventIds = [...(s.payment.webhookEventIds ?? []), eventId].slice(-20);
  }
  const status = String(res.status ?? type.split('.').pop() ?? '').toUpperCase();
  const confirms = status === 'COMPLETED' || status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED';
  const hasAmount = res.amount?.value !== undefined;
  // Anything that says money moved must carry the right amount in the right currency, or it is flagged and ignored.
  if ((confirms || hasAmount) && !amountMatches(s, res.amount?.value, res.amount?.currency_code)) {
    flagMismatch(s, res.amount?.value, res.amount?.currency_code);
    return true;
  }
  s.payment.captureId ??= String(res.id ?? '');
  const changed = applyCaptureStatus(s, status);
  if (changed || s.payment.captureStatus === status) s.payment.webhook = { event: type, at: new Date().toISOString() };
  touchStore();
  return true;
}

/**
 * Live check of a finished haggle against PayPal. Also repairs a webhook we missed.
 * Reveals only the capture's status, amount and currency, never an id.
 */
export async function verifyPassport(id: string, pay: PayApi | null) {
  const s = getSession(id);
  const p = s.passport;
  if (!p) throw new HttpError(404, 'No passport yet: the negotiation has not finished');
  const checkedAt = new Date().toISOString();
  if (p.outcome !== 'deal') return { verified: false, checkedAt, reason: 'No payment was made for this haggle, so there is nothing to verify.' };
  if (!pay || s.payment.mode !== 'paypal_sandbox') return { verified: false, checkedAt, reason: 'PayPal is not connected on this server, so no payment exists to verify.' };
  if (!s.payment.captureId) return { verified: false, checkedAt, reason: 'No capture was recorded for this haggle.' };
  const live = await pay.getCapture(s.payment.captureId);
  const matchesPassport = amountMatches(s, live.amount, live.currency) && Math.abs(live.amount - (p.agreedPrice ?? NaN)) < 0.005 && live.currency === p.item.currency;
  if (!matchesPassport) {
    // PayPal's record is not this deal: never let its status make the sale real.
    flagMismatch(s, live.amount, live.currency);
    return { verified: false, status: live.status, amount: live.amount, currency: live.currency, matchesPassport: false, checkedAt };
  }
  if (s.payment.mismatch) {
    delete s.payment.mismatch; // PayPal now agrees with the deal
    syncSettlement(s);
  }
  applyCaptureStatus(s, live.status); // verification also repairs a missed webhook, but only once the amount is proven
  return { verified: live.status.toUpperCase() === 'COMPLETED', status: live.status, amount: live.amount, currency: live.currency, matchesPassport: true, checkedAt };
}

/**
 * After a restart: look at what PayPal actually says about every hold a failed or interrupted haggle left, and only then act.
 *  - still open: release it
 *  - already captured, and we saved our capture intent first: replay the SAME idempotent request to get the original
 *    capture back, then rebuild the passport and the sellers' records exactly as a normal finish would
 *  - already captured but not recoverable: flag it for review, never void it
 *  - cannot be checked: leave it untouched
 */
export async function reconcileHolds(pay: PayApi): Promise<{ released: number; needsReview: number; recovered: number }> {
  let released = 0;
  let needsReview = 0;
  let recovered = 0;
  for (const s of sessions.values()) {
    if (!s.payment.authId || s.payment.captureId || s.payment.voided) continue;
    if (s.state !== 'failed' && s.state !== 'no_deal') continue;
    try {
      const st = await pay.getAuthStatus(s.payment.authId);
      if (st === 'VOIDED') {
        s.payment.voided = true;
        s.payment.finalAuthStatus = st;
      } else if (st === 'CAPTURED' || st === 'PARTIALLY_CAPTURED') {
        const intent = s.payment.captureIntent;
        const winner = s.winnerId ? listings.get(s.winnerId) : undefined;
        if (intent && s.agreed && winner) {
          try {
            const cap = await pay.capture(s.payment.authId, intent.price, intent.currency, intent.note, intent.invoiceId, intent.requestId);
            setCapture(s, cap.captureId, cap.status);
            delete s.payment.error;
            const dealEv: DealEv = { type: 'deal', ...s.agreed };
            finalizeSession(s, s.listingIds.map(getListing), winner, dealEv, false, s.aiMode ?? 'unknown');
            recovered++;
            continue;
          } catch {
            /* PayPal no longer remembers the request: fall through to a human review */
          }
        }
        s.payment.captureStatus = 'RECONCILED';
        s.payment.finalAuthStatus = st;
        s.payment.error = 'PayPal captured this payment but the server restarted before recording it. Check the PayPal sandbox dashboard.';
        s.state = 'pending_payment';
        needsReview++;
      } else {
        await pay.void(s.payment.authId);
        s.payment.voided = true;
        s.payment.finalAuthStatus = 'VOIDED';
        released++;
      }
    } catch (e) {
      console.warn(`[reconcile] could not check or release the hold for session ${s.id.slice(0, 8)}:`, e instanceof Error ? e.message : e);
    }
  }
  if (released || needsReview || recovered) touchStore(true);
  return { released, needsReview, recovered };
}

/* ---------------------------- persistence (JSON file) ---------------------------- */

/** Atomically snapshot listings and sessions. The file holds secrets (floors, tokens): mode 0600, never commit it. */
export function saveStore(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, listings: [...listings.values()], sessions: [...sessions.values()] }), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Restore a snapshot. A negotiation that was running when the server stopped is marked failed. */
export function loadStore(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d?.v !== 1) return false;
    resetStore();
    for (const l of d.listings ?? []) {
      l.category ??= 'misc';
      if (l.sellerToken && !l.sellerTokenHash) l.sellerTokenHash = sha(l.sellerToken).toString('hex'); // older snapshots kept the key in the clear
      delete l.sellerToken;
      listings.set(l.id, l);
    }
    for (const s of d.sessions ?? []) {
      s.listingIds ??= [s.listingId];
      if (s.state === 'negotiating') {
        s.state = 'failed';
        s.payment = { ...s.payment, error: s.payment?.error ?? 'The server restarted during the negotiation' };
      }
      sessions.set(s.id, s);
    }
    return true;
  } catch (e) {
    console.warn('[store] could not read', file, e instanceof Error ? e.message : e);
    return false;
  }
}

/* ---------------------------- recorded runs (replay) ---------------------------- */

/**
 * A finished street crawl, packaged for a PUBLIC file anyone can replay. Everything private is removed:
 * the buyer's limit, the passport's limit, every PayPal identifier, webhook ids and approval links.
 * What stays is the story: stalls, offers, rounds, the winner, and the outcome.
 */
export function buildSampleExport(id: string) {
  const s = getSession(id);
  if (!s.passport) throw new HttpError(409, 'That haggle has not finished, so it cannot be recorded');
  if (s.listingIds.length < 2) throw new HttpError(409, 'Record a street crawl (two or more stalls): that is what the replay page plays');
  const view = sessionView(s);
  const pass = publicPassport(s.passport);
  return {
    recordedAt: s.passport.settledAt,
    ai: s.passport.agents.ai,
    view: {
      ...view,
      maxBudget: 0, // hidden: see limitHidden
      limitHidden: true,
      payment: { mode: view.payment.mode, rehearsal: view.payment.rehearsal, captureStatus: pass.payment.captureStatus, finalAuthStatus: pass.payment.finalAuthStatus, voided: pass.payment.voided },
      passport: pass,
    },
  };
}
