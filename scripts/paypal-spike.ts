import 'dotenv/config';
import { createAuthorizeOrder, getOrder, authorizeOrder, capturePartial, getAuthorization, voidAuthorization, approvalUrl } from '../server/paypal.ts';

/**
 * Day-1 risk check for BAZAAR's core idea:
 *   authorize the buyer's MAX, capture only the NEGOTIATED price, see what happens to the rest.
 * Usage: npm run spike            (max 150, capture 112.50)
 *        npm run spike -- 200 140
 */
const max = Number(process.argv[2] ?? 150);
const price = Number(process.argv[3] ?? 112.5);
const currency = 'USD';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);

async function main() {
  if (!(price > 0 && price <= max)) throw new Error('capture price must be > 0 and <= max');

  step(1, `Creating AUTHORIZE order for the buyer's max: ${max.toFixed(2)} ${currency}`);
  const order = await createAuthorizeOrder({
    maxAmount: max,
    currency,
    description: 'BAZAAR spike: brass lantern',
    returnUrl: 'http://localhost:3000/return',
    cancelUrl: 'http://localhost:3000/cancel',
  });
  console.log('    order id:', order.id, '| status:', order.status);

  const url = approvalUrl(order);
  if (!url) throw new Error('No approval link in the order response:\n' + JSON.stringify(order.links, null, 2));
  step(2, 'OPEN THIS LINK in your browser and approve with your SANDBOX PERSONAL (buyer) account:');
  console.log('\n    ' + url + '\n');
  console.log('    (after approving, the page may fail to load localhost:3000/return. That is fine, just close it.)');

  step(3, 'Waiting for approval (checks every 3s, up to 10 min)...');
  let status = order.status as string;
  for (let i = 0; i < 200 && status !== 'APPROVED'; i++) {
    await sleep(3000);
    status = (await getOrder(order.id)).status;
    process.stdout.write('.');
  }
  console.log('\n    order status:', status);
  if (status !== 'APPROVED') throw new Error('Order was not approved in time. Re-run the script.');

  step(4, 'Authorizing the order (this places the hold for the max amount)');
  const authed = await authorizeOrder(order.id);
  const auth = authed.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error('No authorization in response:\n' + JSON.stringify(authed, null, 2));
  console.log('    authorization id:', auth.id, '| status:', auth.status, '| amount:', auth.amount?.value, auth.amount?.currency_code);

  step(5, `Capturing ONLY the negotiated price: ${price.toFixed(2)} ${currency} (final_capture = true)`);
  const cap = await capturePartial(auth.id, price, currency, 'BAZAAR negotiated price', `BAZAAR-${Date.now()}`);
  console.log('    capture id:', cap.id, '| status:', cap.status, '| amount:', cap.amount?.value, cap.amount?.currency_code);

  step(6, 'Re-reading the authorization to see what happened to the unused remainder');
  const after = await getAuthorization(auth.id);
  console.log('    authorization status now:', after.status);

  let voided: string = 'not attempted';
  if (after.status !== 'CAPTURED' && after.status !== 'VOIDED') {
    step(7, 'Remainder still open, voiding it explicitly');
    try {
      await voidAuthorization(auth.id);
      voided = 'void succeeded';
    } catch (e) {
      voided = 'void failed: ' + (e as Error).message;
    }
    console.log('    ', voided);
  }

  console.log('\n================ PASTE THIS BLOCK BACK TO CLAUDE ================');
  console.log(
    JSON.stringify(
      { authorized: max, captured: price, orderStatus: status, authStatusAfterCapture: after.status, captureStatus: cap.status, voidStep: voided },
      null,
      2,
    ),
  );
  console.log('=================================================================');
}

main().catch((e) => {
  console.error('\nSPIKE FAILED:', e.message);
  process.exit(1);
});
