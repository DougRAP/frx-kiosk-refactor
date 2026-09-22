/* C.5 — POST /api/email-cart: el "Email my cart to myself" REAL (spec: misc/spec-work-order-06jul.md).
 * Unit tests del handler con Resend y PostgREST mockeados vía fetch global. */
import { makeT } from './helpers.mjs';

const t = makeT('email-cart');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.FROM_EMAIL = 'no-reply@test.dev';

const calls = { resend: [], supa: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.resend.com')) {
    calls.resend.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
  }
  if (u.includes('supa.test')) {
    /* el rate limiter usa la MISMA base (rpc/rate_limit_hit): se mockea sano (SEC-2) */
    if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });
    calls.supa.push(u);
    return new Response(JSON.stringify([
      { id: 'k1', sku: 'CARE-WOOD-001', name: 'Wood Care Kit', price_cents: 4999 }
    ]), { status: 200 });
  }
  throw new Error('unexpected fetch ' + u);
};

const handler = (await import('../../netlify/functions/email-cart.mjs')).default;
const post = (body) => handler(new Request('https://kiosk.test/api/email-cart', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}));
const PLAN = { cov: 'stain', term: 'monthly', type: 'furniture', count: 1 };

{
  const res = await handler(new Request('https://kiosk.test/api/email-cart'));
  t(res.status === 405, 'email-cart: solo POST');
}
{
  const res = await post({ email: 'nope', plans: [PLAN] });
  t(res.status === 400 && (await res.json()).error === 'invalid_email', 'email-cart: email inválido → 400');
}
{
  const res = await post({ email: 'a@b.co', plans: [], kits: [], membership: false });
  t(res.status === 400 && (await res.json()).error === 'empty_cart', 'email-cart: carrito vacío → 400');
}
{
  calls.resend.length = 0; calls.supa.length = 0;
  const res = await post({ email: 'Test@Example.com', plans: [PLAN], kits: [], membership: false });
  const d = await res.json();
  t(res.status === 200 && d.sent === true, 'email-cart: happy path → {sent:true}');
  t(calls.resend.length === 1, 'email-cart: un solo envío a Resend');
  const mail = calls.resend[0] || {};
  t(Array.isArray(mail.to) && mail.to[0] === 'test@example.com', 'email-cart: to = email canónico (lowercase)');
  t(/cart/i.test(mail.subject || ''), 'email-cart: subject habla del carrito');
  t(/Stain protection/.test(mail.html || '') && /\$9\.99/.test(mail.html || ''), 'email-cart: el HTML lista el plan con precio del SERVER');
  t(calls.supa.length === 0, 'email-cart: sin kits NO se consulta el catálogo');
}
{
  calls.resend.length = 0;
  const res = await post({ email: 'a@b.co', plans: [PLAN], kits: [{ sku: 'CARE-WOOD-001', quantity: 2 }], membership: true });
  const d = await res.json();
  t(res.status === 200 && d.sent === true, 'email-cart: con kits + membership → {sent:true}');
  const html = (calls.resend[0] || {}).html || '';
  t(/Wood Care Kit x2/.test(html) && /\$99\.98 one-time/.test(html), 'email-cart: kit con nombre y total de línea del catálogo');
  /* BE-5 (14-ago): el email espeja los cargos reales de Stripe — S&H $11/kit + tax 6% kit-only. */
  t(/Shipping & handling — \$22\.00 one-time/.test(html), 'BE-5: S&H $11 × 2 kits en el email');
  t(/Sales tax \(6%\) — \$6\.00 one-time/.test(html), 'BE-5: tax 6% del retail de kits (99.98 → 6.00)');
  t(/Repair Safety Net/.test(html), 'email-cart: la Repair Safety Net aparece en el resumen (naming call 06-jul)');
  /* MEM-7 (14-ago): la membership del carrito es SIEMPRE la de pago → $19.99, sin 50%. */
  t(/Repair Safety Net — \$19\.99\/mo/.test(html) && !/50% off/.test(html), 'email-cart: con plan Stain la membership va a $19.99 (MEM-7, sin tiers)');
}
{
  /* MEM-7: el precio no depende de la composición del carrito */
  calls.resend.length = 0;
  await post({ email: 'a@b.co', plans: [], kits: [], membership: true });
  t(/Repair Safety Net — \$19\.99\/mo/.test((calls.resend[0] || {}).html || ''), 'email-cart: membership standalone → $19.99/mo');
  calls.resend.length = 0;
  await post({ email: 'a@b.co', plans: [{ cov: 'stain-mech', term: 'monthly', type: 'furniture', count: 1 }], kits: [], membership: true });
  const mh = (calls.resend[0] || {}).html || '';
  t(/Repair Safety Net — \$19\.99\/mo/.test(mh) && !/included with your plan/.test(mh), 'email-cart: con stain-mech TAMBIÉN $19.99 (la incluida es entitlement, no línea)');
}
{
  /* alias RESEND_FROM_EMAIL: mismo comportamiento que FROM_EMAIL (canónico) */
  calls.resend.length = 0;
  const savedFrom = process.env.FROM_EMAIL;
  delete process.env.FROM_EMAIL;
  process.env.RESEND_FROM_EMAIL = 'alias@test.dev';
  const res = await post({ email: 'a@b.co', plans: [PLAN] });
  t(res.status === 200 && (calls.resend[0] || {}).from === 'alias@test.dev', 'email-cart: RESEND_FROM_EMAIL funciona como alias de FROM_EMAIL');
  delete process.env.RESEND_FROM_EMAIL;
  process.env.FROM_EMAIL = savedFrom;
}
{
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const res = await post({ email: 'a@b.co', plans: [PLAN] });
  const d = await res.json();
  t(res.status === 502 && d.error === 'email_failed', 'email-cart: sin key → 502 email_failed (nunca finge)');
  process.env.RESEND_API_KEY = savedKey;
}

t.done();
