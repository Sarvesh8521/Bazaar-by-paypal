/* ------------------------------------------------------------------ *
 * ONE place that decides what a PayPal capture status means.
 * Pure (no Node imports), so the server and the browser use the same
 * rules and can never disagree about whether money moved.
 * ------------------------------------------------------------------ */

export type PaymentOutcome =
  | 'completed' // PayPal says COMPLETED
  | 'pending' // PayPal accepted the capture but it is not final: do not treat the sale as made
  | 'unverified' // we believe it was captured but PayPal has not confirmed the status
  | 'unsuccessful' // DENIED / DECLINED / FAILED: no money moved
  | 'refunded'
  | 'partially_refunded'
  | 'rehearsal' // PayPal is not connected: nothing was ever going to be charged
  | 'none'; // no capture (yet, or released)

export function paymentOutcome(p: { mode: string; captureStatus?: string; captureId?: string; voided?: boolean; mismatch?: unknown }): PaymentOutcome {
  if (p.mode === 'not_configured') return 'rehearsal';
  if (p.mismatch) return 'unverified'; // PayPal's amount or currency did not match the agreed deal: never treat it as paid
  switch ((p.captureStatus ?? '').toUpperCase()) {
    case 'COMPLETED':
      return 'completed';
    case 'PENDING':
      return 'pending';
    case 'DENIED':
    case 'DECLINED':
    case 'FAILED':
      return 'unsuccessful';
    case 'REFUNDED':
      return 'refunded';
    case 'PARTIALLY_REFUNDED':
      return 'partially_refunded';
    case 'RECONCILED':
      return 'unverified';
    default:
      return p.captureId ? 'unverified' : 'none';
  }
}

export const PAYMENT_TEXT: Record<PaymentOutcome, { title: string; body: string }> = {
  completed: { title: 'Payment completed', body: 'PayPal reports the capture as completed.' },
  pending: { title: 'Payment pending', body: 'PayPal has accepted the capture but it is not final yet. The sale is not counted until PayPal completes it.' },
  unverified: { title: 'Payment awaiting verification', body: 'The capture was found at PayPal but its final status is not confirmed yet.' },
  unsuccessful: { title: 'Payment unsuccessful', body: 'PayPal did not take the money. Nothing was charged.' },
  refunded: { title: 'Payment refunded', body: 'PayPal reports this capture as refunded.' },
  partially_refunded: { title: 'Payment partially refunded', body: 'PayPal reports part of this capture as refunded.' },
  rehearsal: { title: 'No payment attached', body: 'PayPal is not connected, so this was a rehearsal and nothing was charged.' },
  none: { title: 'No payment taken', body: 'Nothing was charged.' },
};

/** The haggle is finished and nothing is outstanding: a confirmed payment, or a rehearsal that never involved money. */
export const countsAsSale = (o: PaymentOutcome) => o === 'completed' || o === 'rehearsal';
/** Only a confirmed PayPal capture is revenue. A rehearsal is simulated value; a pending payment is not yet anything. */
export const isVerifiedRevenue = (o: PaymentOutcome) => o === 'completed';

const RANK: Record<string, number> = { PENDING: 1, COMPLETED: 2, DENIED: 2, DECLINED: 2, FAILED: 2, PARTIALLY_REFUNDED: 3, REFUNDED: 4 };
const FAILURES = ['DENIED', 'DECLINED', 'FAILED'];

/** May a (possibly out-of-order or replayed) PayPal status replace the stored one? Statuses only move forward. */
export function canTransition(current: string | undefined, next: string): boolean {
  const n = next.toUpperCase();
  if (RANK[n] === undefined) return false; // an unknown status never overwrites a known one
  if (!current) return true;
  const c = current.toUpperCase();
  if (c === n) return false;
  if (RANK[c] === undefined) return true; // e.g. our own RECONCILED marker: PayPal's word wins
  if (FAILURES.includes(c)) return false; // a denied capture cannot become anything else
  return RANK[n] > RANK[c];
}
