/* B.3 — checkout-status expone `opened` desde pay_links.opened_at (C7 fase 2).
 * Stripe queda en fail-soft (sin STRIPE_SECRET_KEY) — lo que se testea es el join
 * a pay_links y que un fallo de BD nunca rompa el poll. */
import { makeT } from './helpers.mjs';

const t = makeT('checkout-status');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
delete process.env.STRIPE_SECRET_KEY;   // getStripe falla → rama fail-soft {done:false}

let payLinkRow = null;
let dbFails = false;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });
  if (u.includes('/pay_links')) {
    if (dbFails) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify(payLinkRow ? [payLinkRow] : []), { status: 200 });
  }
  throw new Error('unexpected fetch ' + u);
};

const handler = (await import('../../netlify/functions/checkout-status.mjs')).default;
const post = () => handler(new Request('https://kiosk.test/api/checkout-status', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session_id: 'cs_test_a1B2c3D4e5F6g7' })
}));

{
  payLinkRow = { opened_at: '2026-07-06T10:00:00.000Z' };
  const d = await (await post()).json();
  t(d.opened === true, 'checkout-status: opened_at presente → opened:true');
  t(d.done === false && d.expired === false, 'checkout-status: Stripe caído sigue fail-soft {done:false}');
}
{
  payLinkRow = { opened_at: null };
  const d = await (await post()).json();
  t(d.opened === false, 'checkout-status: sin opened_at → opened:false');
}
{
  payLinkRow = null;
  const d = await (await post()).json();
  t(d.opened === false, 'checkout-status: sin fila pay_link → opened:false');
}
{
  dbFails = true;
  const res = await post();
  const d = await res.json();
  t(res.status === 200 && d.opened === false, 'checkout-status: error de BD → fail-soft, el poll no se rompe');
}

t.done();
