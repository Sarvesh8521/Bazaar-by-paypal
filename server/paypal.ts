import { randomUUID } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Thin PayPal REST client. SANDBOX ONLY by design: the base URL is
 * hard-coded so this project can never touch real money.
 *
 * BAZAAR's "mandate" pattern:
 *   1. create an order with intent AUTHORIZE for the buyer's MAX budget
 *   2. buyer approves it once in PayPal
 *   3. agents haggle; the agreed price is captured (partial capture,
 *      final_capture=true) so PayPal itself enforces the cap
 * ------------------------------------------------------------------ */

const BASE = 'https://api-m.sandbox.paypal.com';

let token: { value: string; exp: number } | null = null;

/** An HTTP error from PayPal (as opposed to a network failure, which surfaces as a plain TypeError). */
export class PayPalError extends Error {
  constructor(message: string, public status: number, public debugId?: string) {
    super(message);
  }
}

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.exp - 30_000) return token.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (sandbox app credentials)');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${body.error_description ?? body.error ?? 'check your sandbox Client ID/Secret'}`);
  token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function pp<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(method === 'POST' ? { 'PayPal-Request-Id': requestId ?? randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const issues = (json.details ?? []).map((d: any) => `${d.issue}${d.description ? ': ' + d.description : ''}`).join(' | ');
    throw new PayPalError(`PayPal ${method} ${path} -> ${res.status} ${json.name ?? ''} ${json.message ?? ''} ${issues} (debug_id ${json.debug_id ?? 'n/a'})`.trim(), res.status, json.debug_id);
  }
  return json as T;
}

const amt = (value: number, currency: string) => ({ currency_code: currency, value: value.toFixed(2) });

export async function createAuthorizeOrder(p: { maxAmount: number; currency: string; description: string; returnUrl: string; cancelUrl: string }) {
  return pp('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{ reference_id: 'bazaar', description: p.description.slice(0, 120), amount: amt(p.maxAmount, p.currency) }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'BAZAAR',
          user_action: 'PAY_NOW',
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          return_url: p.returnUrl,
          cancel_url: p.cancelUrl,
        },
      },
    },
  });
}

export const getOrder = (orderId: string) => pp('GET', `/v2/checkout/orders/${orderId}`);
export const authorizeOrder = (orderId: string) => pp('POST', `/v2/checkout/orders/${orderId}/authorize`, {});
export const getAuthorization = (authId: string) => pp('GET', `/v2/payments/authorizations/${authId}`);
export const voidAuthorization = (authId: string) => pp('POST', `/v2/payments/authorizations/${authId}/void`, {});

/** Capture only the negotiated price. final_capture=true tells PayPal no further captures will follow. */
export const capturePartial = (authId: string, price: number, currency: string, note: string, invoiceId?: string, requestId?: string) =>
  pp(
    'POST',
    `/v2/payments/authorizations/${authId}/capture`,
    {
      amount: amt(price, currency),
      final_capture: true,
      note_to_payer: note.slice(0, 255),
      ...(invoiceId ? { invoice_id: invoiceId } : {}),
    },
    requestId, // a stable id makes a retry return the first result instead of capturing twice
  );

export function approvalUrl(order: any): string | undefined {
  return order?.links?.find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
}

/* ----------------- injectable payment interface (used by sessions + tests) ----------------- */

export interface PayApi {
  createOrder(p: { maxAmount: number; currency: string; description: string; returnUrl: string; cancelUrl: string }): Promise<{ id: string; status: string; approveUrl?: string }>;
  getOrderStatus(orderId: string): Promise<string>;
  authorize(orderId: string): Promise<{ authId: string; status: string; amount: number; currency: string }>;
  capture(authId: string, price: number, currency: string, note: string, invoiceId: string, requestId: string): Promise<{ captureId: string; status: string }>;
  getAuthStatus(authId: string): Promise<string>;
  getCapture(captureId: string): Promise<{ status: string; amount: number; currency: string }>;
  void(authId: string): Promise<void>;
}

export const paypalConfigured = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

export const paypalApi: PayApi = {
  async createOrder(p) {
    const o = await createAuthorizeOrder(p);
    return { id: o.id, status: o.status, approveUrl: approvalUrl(o) };
  },
  async getOrderStatus(orderId) {
    return (await getOrder(orderId)).status;
  },
  async authorize(orderId) {
    const r = await authorizeOrder(orderId);
    const a = r.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!a) throw new Error('PayPal returned no authorization for the approved order');
    return { authId: a.id, status: a.status, amount: Number(a.amount?.value), currency: String(a.amount?.currency_code ?? '') };
  },
  async capture(authId, price, currency, note, invoiceId, requestId) {
    const c = await capturePartial(authId, price, currency, note, invoiceId, requestId);
    return { captureId: c.id, status: c.status };
  },
  async getAuthStatus(authId) {
    return (await getAuthorization(authId)).status;
  },
  async getCapture(captureId) {
    const c = await pp('GET', `/v2/payments/captures/${captureId}`);
    return { status: String(c.status), amount: Number(c.amount?.value), currency: String(c.amount?.currency_code ?? '') };
  },
  async void(authId) {
    await voidAuthorization(authId);
  },
};

/** Ask PayPal whether a webhook delivery is genuine (signature check). Needs the Webhook ID from the PayPal dashboard. */
export async function verifyWebhookSignature(headers: Record<string, string | string[] | undefined>, event: unknown, webhookId: string): Promise<boolean> {
  const h = (k: string) => String(headers[k] ?? '');
  const r = await pp('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return r.verification_status === 'SUCCESS';
}
