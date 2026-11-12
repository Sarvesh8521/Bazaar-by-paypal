import type { NegEvent, Persona } from '../server/agents.ts';
import type { MarketInfo, Passport, PaymentInfo, PublicListing, SessionState, ViewEvent, sellerView, sessionView } from '../server/sessions.ts';
import type { ProductCard } from '../server/channel3.ts';

export type { NegEvent, Persona, MarketInfo, Passport, PaymentInfo, PublicListing, SessionState, ViewEvent, ProductCard };
export type SellerData = ReturnType<typeof sellerView>;

export interface Health {
  ok: boolean;
  agents: 'anthropic' | 'gemini' | 'openai' | 'mock';
  paypal: 'sandbox' | 'not_configured';
  channel3: 'configured' | 'failing' | 'not_configured';
}
/** Exactly what GET /api/sessions/:id returns (derived from the server, so the two cannot drift apart). */
export type SessionView = ReturnType<typeof sessionView>;

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}
const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const getHealth = () => fetch('/api/health').then(parse<Health>);
export const getListings = () => fetch('/api/listings').then(parse<PublicListing[]>);
/** The secret that proves this browser started a haggle. Saved when the haggle is created, sent with every private request. */
export const buyerToken = (id: string) => recentHaggles().find((r) => r.id === id)?.token ?? '';
const authed = (id: string): HeadersInit => ({ 'x-buyer-token': buyerToken(id) });

export const getSession = (id: string) => fetch(`/api/sessions/${encodeURIComponent(id)}`, { headers: authed(id) }).then(parse<SessionView>);
export const getPublicPassport = (id: string) => fetch(`/api/passport/${encodeURIComponent(id)}/public`).then(parse<Passport>);
export interface Verification {
  verified: boolean;
  checkedAt: string;
  reason?: string;
  status?: string;
  amount?: number;
  currency?: string;
  matchesPassport?: boolean;
}
/** Ask the server to check this passport's payment against PayPal right now. */
export const verifyPassportLive = (id: string) => fetch(`/api/passport/${encodeURIComponent(id)}/verify`).then(parse<Verification>);
export { paymentOutcome, PAYMENT_TEXT } from '../server/paymentStatus.ts';
export const createSession = (b: { listingId?: string; listingIds?: string[]; maxBudget: number; buyerPersona: Persona; rehearsal?: boolean }) => post('/api/sessions', b).then(parse<SessionView & { buyerToken: string }>);

export const searchProducts = (q: string) => fetch(`/api/products?q=${encodeURIComponent(q)}`).then(parse<ProductCard[]>);
export const openStall = (b: { title: string; category?: string; listPrice: number; floorPrice: number; persona: Persona; description?: string; imageUrl?: string }) =>
  post('/api/listings', b).then(parse<{ listing: PublicListing; sellerToken: string }>);
export const getSellerData = (id: string, token: string) =>
  fetch(`/api/listings/${encodeURIComponent(id)}/seller`, { headers: { 'x-seller-token': token } }).then(parse<SellerData>);

/* --------- small things this browser remembers (never secrets of other people) --------- */

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or storage full: remembering is optional */
  }
}
export interface Recent {
  id: string;
  title: string;
  at: string;
  outcome?: 'deal' | 'no_deal';
  price?: number;
  pending?: boolean; // the deal was agreed but PayPal had not completed the payment
  token?: string; // this browser's private key to the haggle
}
export const recentHaggles = () => read<Recent[]>('bazaar.haggles', []);
export function rememberHaggle(r: Recent) {
  const all = recentHaggles();
  const prev = all.find((x) => x.id === r.id);
  write('bazaar.haggles', [{ ...prev, ...r }, ...all.filter((x) => x.id !== r.id)].slice(0, 12));
}
export const sellerTokens = () => read<Record<string, string>>('bazaar.sellerTokens', {});
export const saveSellerToken = (id: string, token: string) => write('bazaar.sellerTokens', { ...sellerTokens(), [id]: token });

/** Reads the newline-delimited JSON stream from POST /api/sessions/:id/negotiate. */
export async function streamNegotiation(id: string, onEvent: (e: ViewEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/negotiate`, { method: 'POST', signal, headers: authed(id) });
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({}));
    throw new Error((b as { error?: string }).error ?? `Could not start the negotiation (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as ViewEvent);
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as ViewEvent);
}

export function money(n: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
}

export const BUYER_STYLES: Record<Persona, { name: string; blurb: string }> = {
  friendly: { name: 'Charmer', blurb: 'Warm and chatty. Gives ground in small friendly steps.' },
  stubborn: { name: 'Hardliner', blurb: 'Blunt and proud. Makes the seller work for every dollar.' },
  dramatic: { name: 'Showman', blurb: 'Sighs, gasps and speeches, but still bargains sharply.' },
};
export const SELLER_STYLES: Record<Persona, string> = {
  friendly: 'Chatty and easy to charm',
  stubborn: 'Holds the line',
  dramatic: 'All sighs and speeches',
};

export const aiLabel = (a?: string) =>
  a === 'anthropic' ? 'Claude agents' : a === 'gemini' ? 'Gemini agents' : a === 'openai' ? 'AI agents' : a === 'mock' ? 'Offline demo agents' : 'Agents';
