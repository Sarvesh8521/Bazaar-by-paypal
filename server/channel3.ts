/* ------------------------------------------------------------------ *
 * Channel3 product search (POST https://api.trychannel3.com/v1/search,
 * auth via x-api-key). Gives the buyer agent real market evidence.
 * If the key is missing or the call fails we return nothing: we never
 * invent market data.
 * ------------------------------------------------------------------ */

export interface MarketOffer {
  store: string;
  price: number;
  currency: string;
  url?: string;
}
export interface MarketProduct {
  id: string;
  title: string;
  imageUrl?: string;
  offers: MarketOffer[];
}

export const channel3Configured = () => Boolean(process.env.CHANNEL3_API_KEY);

let lastCall: 'unknown' | 'ok' | 'failing' = 'unknown';
/** What the status chip should say: a key alone is not proof that market prices are actually arriving. */
export const channel3Status = (): 'configured' | 'failing' | 'not_configured' => (!channel3Configured() ? 'not_configured' : lastCall === 'failing' ? 'failing' : 'configured');

// The docs show price either as a number or as {price|amount, currency}; accept all of them.
function priceOf(v: any): { amount: number; currency?: string } | null {
  if (typeof v === 'number' && Number.isFinite(v)) return { amount: v };
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return { amount: Number(v) };
  if (v && typeof v === 'object') {
    const inner = priceOf(v.price ?? v.amount);
    if (inner) return { amount: inner.amount, currency: typeof v.currency === 'string' ? v.currency : inner.currency };
  }
  return null;
}

export function parseProducts(json: any): MarketProduct[] {
  const list: any[] = Array.isArray(json?.products) ? json.products : [];
  return list
    .map((p): MarketProduct | null => {
      if (!p || typeof p.title !== 'string') return null;
      const images: any[] = Array.isArray(p.images) ? p.images : [];
      const img = images.find((i) => i?.is_cleaned_image && typeof i.url === 'string') ?? images.find((i) => typeof i?.url === 'string');
      const offers: MarketOffer[] = (Array.isArray(p.offers) ? p.offers : [])
        .map((o: any): MarketOffer | null => {
          const pr = priceOf(o?.price);
          if (!pr || pr.amount <= 0) return null;
          return { store: String(o.domain ?? o.merchant ?? 'unknown store'), price: pr.amount, currency: pr.currency ?? o?.currency ?? 'USD', url: typeof o.url === 'string' ? o.url : undefined };
        })
        .filter((o: MarketOffer | null): o is MarketOffer => o !== null);
      return { id: String(p.id ?? ''), title: p.title, imageUrl: img?.url, offers };
    })
    .filter((p): p is MarketProduct => p !== null);
}

export async function searchProducts(query: string, limit = 5): Promise<MarketProduct[]> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch('https://api.trychannel3.com/v1/search', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      lastCall = 'failing';
      console.warn(`[channel3] search failed: HTTP ${res.status}${res.status === 402 ? ' (out of credits?)' : res.status === 401 ? ' (check CHANNEL3_API_KEY)' : ''}`);
      return [];
    }
    const products = parseProducts(await res.json());
    lastCall = 'ok';
    return products;
  } catch (e) {
    lastCall = 'failing';
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    console.warn('[channel3] search error:', e instanceof Error ? e.message : e, cause?.code ?? cause?.message ?? '');
    return [];
  }
}

/**
 * Real offers for similar items: for each of the top results take its cheapest offer in one currency, keep which
 * product and link it was, then keep the cheapest per merchant (max 4). These are comparable items, not
 * guaranteed identical products, and the callers say so.
 */
export function marketReference(products: MarketProduct[], currency = 'USD'): { store: string; price: number; title?: string; url?: string }[] {
  const best = new Map<string, { store: string; price: number; title: string; url?: string }>();
  for (const p of products.slice(0, 5)) {
    for (const o of p.offers) {
      if (o.currency !== currency) continue;
      const cur = best.get(o.store);
      if (!cur || o.price < cur.price) best.set(o.store, { store: o.store, price: Math.round(o.price * 100) / 100, title: p.title.slice(0, 80), ...(o.url ? { url: o.url } : {}) });
    }
  }
  return [...best.values()].sort((a, b) => a.price - b.price).slice(0, 4);
}

export interface ProductCard {
  id: string;
  title: string;
  imageUrl?: string;
  price: number; // best offer, in one currency
  store: string;
  offers: { store: string; price: number; url?: string }[]; // up to three, cheapest first
  retrievedAt: string;
}

/** One card per product: its cheapest offers in the given currency. Products without any are dropped. */
export function productCards(products: MarketProduct[], currency = 'USD', now = new Date()): ProductCard[] {
  return products.flatMap((p) => {
    const offers = p.offers.filter((o) => o.currency === currency).sort((a, b) => a.price - b.price);
    if (!offers.length) return [];
    return [
      {
        id: p.id,
        title: p.title.slice(0, 80),
        imageUrl: p.imageUrl,
        price: Math.round(offers[0].price * 100) / 100,
        store: offers[0].store,
        offers: offers.slice(0, 3).map((o) => ({ store: o.store, price: Math.round(o.price * 100) / 100, ...(o.url ? { url: o.url } : {}) })),
        retrievedAt: now.toISOString(),
      },
    ];
  });
}
