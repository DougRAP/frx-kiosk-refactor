/* GIFT-1 — gift coupon codes (spec misc/spec-dash-block-08jul.md §F, parte backend de F8).
 * Se testean create-gift-checkout (function pública) y los exports directos del webhook
 * (handleGiftPurchase + markGiftRedeemed, patrón sessionPayload) con TODO mockeado vía
 * globalThis.fetch — por eso el código nuevo usa fetch directo a api.stripe.com y NO el
 * SDK (el SDK no pasa por globalThis.fetch). Mock enrutado por substring, como billing. */
import { makeT } from './helpers.mjs';

const t = makeT('gift');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.SITE_URL = 'https://site.test';
process.env.STRIPE_PRICE_STAIN = 'price_stain';
process.env.STRIPE_PRICE_STAIN_MECH = 'price_sm';
process.env.STRIPE_PRICE_MEMBERSHIP = 'price_mem';
process.env.EMAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_test';
process.env.FROM_EMAIL = 'gifts@test.co';

/* Estado por caso: `S = fresh()` resetea knobs + capturas. */
const fresh = () => ({
  giftRows: [],                    // GET /rest/v1/gift_codes (tope de 5 / fila del 409)
  insertStatus: 201,               // POST /rest/v1/gift_codes (409 = reentrega)
  patchStatus: 204,
  sessionStatus: 200, sessionData: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' },
  couponGetStatus: 404,            // 404 = coupon aún no existe (camino "primera vez")
  couponPostStatus: 200, couponData: { id: 'gift-membership-3mo' },
  priceData: { id: 'price_mem', product: 'prod_mem1' },
  promoPostStatus: 200, promoPostData: { id: 'promo_new' },
  promoPostError: null,            // {error:{message:'... already exists ...'}} → 400
  promoListData: { data: [{ id: 'promo_prev' }] },
  promoGetStatus: 200, promoGetData: { id: 'promo_1', metadata: { gift: '1' } },
  emailStatus: 200,
  calls: {
    sessions: [], giftInserts: [], giftGets: [], giftPatches: [],
    couponGets: 0, couponPosts: [], priceGets: 0,
    promoPosts: [], promoLists: 0, promoGets: 0, emails: []
  }
});
let S = fresh();

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  const body = opts && typeof opts.body === 'string' ? opts.body : '';
  const R = (status, data) => new Response(data === undefined ? null : JSON.stringify(data), { status });
  if (u.includes('rate_limit_hit')) return R(200, [{ allowed: true, hits: 1, retry_after: 0 }]);   // limiter sano → pasa
  if (u.includes('/rest/v1/gift_codes')) {
    if (method === 'POST') {
      S.calls.giftInserts.push(JSON.parse(body));
      return S.insertStatus === 201
        ? R(201, [JSON.parse(body)])
        : R(S.insertStatus, { message: 'duplicate key value violates unique constraint' });
    }
    if (method === 'PATCH') { S.calls.giftPatches.push({ url: u, body: JSON.parse(body) }); return R(S.patchStatus, undefined); }
    S.calls.giftGets.push(u);
    return R(200, S.giftRows);
  }
  if (u.includes('api.stripe.com/v1/checkout/sessions')) { S.calls.sessions.push(body); return R(S.sessionStatus, S.sessionData); }
  if (u.includes('api.stripe.com/v1/prices/')) { S.calls.priceGets++; return R(200, S.priceData); }
  if (u.includes('api.stripe.com/v1/coupons') && method === 'POST') { S.calls.couponPosts.push(body); return R(S.couponPostStatus, S.couponData); }
  if (u.includes('api.stripe.com/v1/coupons/')) { S.calls.couponGets++; return R(S.couponGetStatus, S.couponData); }
  if (u.includes('api.stripe.com/v1/promotion_codes?')) { S.calls.promoLists++; return R(200, S.promoListData); }
  if (u.includes('api.stripe.com/v1/promotion_codes/')) { S.calls.promoGets++; return R(S.promoGetStatus, S.promoGetData); }
  if (u.includes('api.stripe.com/v1/promotion_codes') && method === 'POST') {
    S.calls.promoPosts.push(body);
    if (S.promoPostError) return R(400, S.promoPostError);
    return R(S.promoPostStatus, S.promoPostData);
  }
  if (u.includes('api.resend.com/emails')) { S.calls.emails.push(JSON.parse(body)); return R(S.emailStatus, { id: 'email_1' }); }
  throw new Error('unexpected fetch ' + u);
};

const giftCheckout = (await import('../../netlify/functions/create-gift-checkout.mjs')).default;
const { handleGiftPurchase, markGiftRedeemed } = await import('../../netlify/functions/stripe-webhook.mjs');
const env = process.env;

const post = (body, method = 'POST') => giftCheckout(new Request('https://site.test/api/create-gift-checkout', {
  method, headers: { 'Content-Type': 'application/json' },
  body: method === 'POST' ? JSON.stringify(body) : undefined
}));

/* Alfabeto sin ambiguos de gift.mjs: sin 0/O, 1/I/L (mayúsculas + 2-9). */
const CODE_RE = /^GIFT-[A-HJKMNP-Z2-9]{8}$/;

/* ════ create-gift-checkout ════ */

/* ── feliz membership: unit_amount 5997 (1999 × 3) + metadata completa ── */
{
  S = fresh();
  const res = await post({ email: 'Buyer@X.co', tier: 'membership' });
  const d = await res.json();
  t(res.status === 200 && d.url === 'https://checkout.stripe.com/c/pay/cs_1', 'feliz: 200 + { url } de la session');
  const form = new URLSearchParams(S.calls.sessions[0]);
  t(form.get('mode') === 'payment', 'feliz: mode=payment (pago único, no suscripción)');
  t(form.get('line_items[0][price_data][unit_amount]') === '5997', 'membership: unit_amount 5997 = 1999 × 3 (server-side)');
  t(form.get('line_items[0][price_data][currency]') === 'usd' && form.get('line_items[0][quantity]') === '1',
    'feliz: currency usd + quantity 1');
  t(form.get('line_items[0][price_data][product_data][name]') === 'Gift: 3 months of Repair Safety Net membership',
    'feliz: product_data.name con el label del catálogo');
  t(form.get('customer_email') === 'buyer@x.co', 'feliz: customer_email canonicalizado (lowercase)');
  t(form.get('metadata[intent]') === 'gift' && form.get('metadata[tier]') === 'membership'
    && form.get('metadata[months]') === '3' && form.get('metadata[buyer_email]') === 'buyer@x.co',
    'feliz: metadata COMPLETA (intent/tier/months/buyer_email) — el webhook enruta por intent');
  t(form.get('success_url') === 'https://site.test/?gift=sent' && form.get('cancel_url') === 'https://site.test/?gift=canceled',
    'feliz: success/cancel_url en SITE_URL con ?gift=sent|canceled');
  t(S.calls.giftGets.length === 1 && S.calls.giftGets[0].includes('buyer_email=eq.buyer%40x.co')
    && S.calls.giftGets[0].includes('status=eq.created') && S.calls.giftGets[0].includes('select=id'),
    'feliz: el tope consulta gift_codes por buyer_email + status=created');
}

/* ── gift EN CONTEXTO (09-jul): comprado desde el dashboard → Stripe devuelve a account.html ── */
{
  S = fresh();
  const res = await post({ email: 'buyer@x.co', tier: 'stain', source: 'account' });
  t(res.status === 200, 'source account: 200');
  const form = new URLSearchParams(S.calls.sessions[0]);
  t(form.get('success_url') === 'https://site.test/account.html?gift=sent'
    && form.get('cancel_url') === 'https://site.test/account.html?gift=canceled',
    'source account: success/cancel vuelven al DASHBOARD, no al site');
}
{
  S = fresh();
  await post({ email: 'buyer@x.co', tier: 'stain', source: 'https://evil.example/phish' });
  const form = new URLSearchParams(S.calls.sessions[0]);
  t(form.get('success_url') === 'https://site.test/?gift=sent',
    'source desconocido: se IGNORA (enum, jamás una URL del cliente — sin open redirect)');
}

/* ── feliz stain: unit_amount 2997 (999 × 3) ── */
{
  S = fresh();
  const res = await post({ email: 'buyer@x.co', tier: 'stain' });
  t(res.status === 200, 'stain: 200');
  const form = new URLSearchParams(S.calls.sessions[0]);
  t(form.get('line_items[0][price_data][unit_amount]') === '2997', 'stain: unit_amount 2997 = 999 × 3');
  t(form.get('line_items[0][price_data][product_data][name]') === 'Gift: 3 months of Stain Protection',
    'stain: name con el label de stain');
}

/* ── validación ── */
{
  S = fresh();
  let res = await post({ email: 'buyer@x.co', tier: 'yearly' });
  t(res.status === 400 && (await res.json()).error === 'invalid_tier', 'tier fuera de GIFT_TIERS → 400 invalid_tier');
  res = await post({ email: 'no-es-email', tier: 'stain' });
  t(res.status === 400 && (await res.json()).error === 'invalid_email', 'email malformado → 400 invalid_email');
  t(S.calls.sessions.length === 0, 'validación: NUNCA llegó a Stripe');
}

/* ── tope de 5 activos → 409 gift_limit ── */
{
  S = fresh();
  S.giftRows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const res = await post({ email: 'buyer@x.co', tier: 'stain' });
  t(res.status === 409 && (await res.json()).error === 'gift_limit', '5 códigos con status created → 409 gift_limit');
  t(S.calls.sessions.length === 0, 'tope: no se crea session en Stripe');
}

/* ── Stripe caído → 502 gift_failed ── */
{
  S = fresh();
  S.sessionStatus = 500;
  const res = await post({ email: 'buyer@x.co', tier: 'stain' });
  t(res.status === 502 && (await res.json()).error === 'gift_failed', 'Stripe 500 → 502 gift_failed');
}

/* ── sin STRIPE_SECRET_KEY → 503 gift_not_configured ── */
{
  S = fresh();
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const res = await post({ email: 'buyer@x.co', tier: 'stain' });
  process.env.STRIPE_SECRET_KEY = saved;
  t(res.status === 503 && (await res.json()).error === 'gift_not_configured', 'sin llave de Stripe → 503 gift_not_configured');
}

/* ── método ── */
{
  S = fresh();
  const res = await post(null, 'GET');
  t(res.status === 405 && (await res.json()).error === 'method_not_allowed', 'GET → 405 method_not_allowed');
}

/* ════ handleGiftPurchase (export del webhook, patrón sessionPayload) ════ */

const giftSession = (over = {}) => ({
  id: 'cs_gift_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1',
  customer_email: 'buyer@x.co',
  metadata: { intent: 'gift', tier: 'membership', months: '3', buyer_email: 'buyer@x.co' },
  ...over
});

/* ── feliz primera vez: fila + coupon nuevo (product resuelto) + promo + PATCH + email ── */
{
  S = fresh();
  await handleGiftPurchase(env, giftSession());
  const ins = S.calls.giftInserts[0];
  t(!!ins && CODE_RE.test(ins.code), 'fila: code GIFT-XXXXXXXX con alfabeto sin ambiguos');
  t(ins.buyer_email === 'buyer@x.co' && ins.tier === 'membership' && ins.months === 3,
    'fila: buyer_email/tier/months desde la metadata de la session');
  t(ins.price_cents === 5997, 'fila: price_cents 5997 recalculado del catálogo (no de Stripe)');
  t(ins.stripe_payment_intent === 'pi_1', 'fila: stripe_payment_intent = candado de idempotencia');

  t(S.calls.couponGets === 1 && S.calls.priceGets === 1 && S.calls.couponPosts.length === 1,
    'coupon: GET 404 → resuelve el product del price y hace el POST');
  const cf = new URLSearchParams(S.calls.couponPosts[0]);
  t(cf.get('id') === 'gift-membership-3mo', 'coupon: id FIJO gift-{tier}-{months}mo');
  t(cf.get('percent_off') === '100' && cf.get('duration') === 'repeating' && cf.get('duration_in_months') === '3',
    'coupon: 100% × repeating × 3 meses');
  t(cf.getAll('applies_to[products][]').join(',') === 'prod_mem1',
    'coupon: applies_to[products][] = product RESUELTO del price del tier');

  const pf = new URLSearchParams(S.calls.promoPosts[0]);
  t(pf.get('coupon') === 'gift-membership-3mo' && pf.get('code') === ins.code && pf.get('max_redemptions') === '1',
    'promo: cuelga del coupon, con el code de la fila y 1 solo canje');
  t(pf.get('restrictions[first_time_transaction]') === 'true', 'promo: restricción cliente-nuevo');
  const exp = Number(pf.get('expires_at'));
  const want = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
  t(Number.isInteger(exp) && Math.abs(exp - want) < 60, 'promo: expires_at ≈ now + 90 días en EPOCH segundos');
  t(pf.get('metadata[gift]') === '1' && pf.get('metadata[tier]') === 'membership' && pf.get('metadata[buyer_email]') === 'buyer@x.co',
    'promo: metadata gift=1 (ancla del marcado de canje) + tier + buyer');

  t(S.calls.giftPatches.length === 1 && S.calls.giftPatches[0].body.stripe_promo_id === 'promo_new'
    && S.calls.giftPatches[0].url.includes('stripe_payment_intent=eq.pi_1'),
    'PATCH: stripe_promo_id en la fila, filtrado por payment_intent');

  const em = S.calls.emails[0];
  t(!!em && em.to[0] === 'buyer@x.co' && em.subject === 'Your FurnitureRx gift code',
    'email: al comprador con subject "Your FurnitureRx gift code"');
  t(em.html.includes(ins.code) && em.text.includes(ins.code), 'email: lleva el código en html y text');
  t(em.html.includes('3 months of Repair Safety Net membership'), 'email: dice qué regala');
  t(!em.html.includes('promo_new') && !em.html.includes('pi_1') && !em.text.includes('promo_new'),
    'email: JAMÁS lleva ids de Stripe');
}

/* ── coupon ya existente (GET 200) → sin lookup del price ni POST del coupon ── */
{
  S = fresh();
  S.couponGetStatus = 200;
  await handleGiftPurchase(env, giftSession());
  t(S.calls.priceGets === 0 && S.calls.couponPosts.length === 0, 'coupon existente: NO resuelve product ni re-crea');
  t(S.calls.promoPosts.length === 1 && S.calls.emails.length === 1, 'coupon existente: promo + email salen igual');
}

/* ── reentrega COMPLETA: 409 y la fila YA tiene promo_id → ack sin Stripe ni email ── */
{
  S = fresh();
  S.insertStatus = 409;
  S.giftRows = [{ code: 'GIFT-ABCDEFGH', stripe_promo_id: 'promo_old' }];
  let threw = false;
  try { await handleGiftPurchase(env, giftSession()); } catch { threw = true; }
  t(!threw, '409 con promo_id: return sin lanzar (ack del reintento)');
  t(S.calls.couponGets === 0 && S.calls.promoPosts.length === 0 && S.calls.giftPatches.length === 0,
    '409 con promo_id: cero llamadas a Stripe y cero PATCH');
  t(S.calls.emails.length === 0, '409 con promo_id: NO re-envía el email');
}

/* ── reintento A MEDIAS: 409 sin promo_id → retoma desde el coupon con el code EXISTENTE ── */
{
  S = fresh();
  S.insertStatus = 409;
  S.giftRows = [{ code: 'GIFT-ABCDEFGH', stripe_promo_id: null }];
  await handleGiftPurchase(env, giftSession());
  const pf = new URLSearchParams(S.calls.promoPosts[0]);
  t(pf.get('code') === 'GIFT-ABCDEFGH', '409 sin promo_id: el promo usa el code de la fila EXISTENTE (no genera otro)');
  t(S.calls.giftPatches.length === 1 && S.calls.emails.length === 1, '409 sin promo_id: completa PATCH + email');
}

/* ── promo "already exists" (reintento murió tras crearlo) → GET por code y reuso ── */
{
  S = fresh();
  S.promoPostError = { error: { message: 'An active promotion code with `code: GIFT-X` already exists.' } };
  await handleGiftPurchase(env, giftSession());
  t(S.calls.promoLists === 1, 'already exists: GET /v1/promotion_codes?code=X&limit=1');
  t(S.calls.giftPatches.length === 1 && S.calls.giftPatches[0].body.stripe_promo_id === 'promo_prev',
    'already exists: reusa el id del promo previo en el PATCH');
  t(S.calls.emails.length === 1, 'already exists: el email sale igual');
}

/* ── email caído → throw (500 del webhook → retry de Stripe; pasos previos idempotentes) ── */
{
  S = fresh();
  S.emailStatus = 500;
  let threw = false;
  try { await handleGiftPurchase(env, giftSession()); } catch { threw = true; }
  t(threw, 'email falla → throw (el retry de Stripe re-entra sin duplicar)');
  t(S.calls.giftPatches.length === 1, 'email falla: el promo_id YA quedó guardado (el retry lo verá y hará ack)');
}

/* ════ markGiftRedeemed (export del webhook) ════ */

/* ── feliz: promo con metadata.gift='1' → PATCH por stripe_promo_id ── */
{
  S = fresh();
  S.promoGetData = { id: 'promo_1', metadata: { gift: '1', tier: 'stain' } };
  await markGiftRedeemed(env, 'promo_1', 'friend@y.co');
  const p = S.calls.giftPatches[0];
  t(!!p && p.url.includes('stripe_promo_id=eq.promo_1'), 'canje: PATCH filtrado por stripe_promo_id');
  t(p.body.status === 'redeemed' && p.body.redeemed_by_email === 'friend@y.co' && typeof p.body.redeemed_at === 'string',
    'canje: status redeemed + quién + cuándo');
}

/* ── promo ajeno (sin metadata.gift) → no-op ── */
{
  S = fresh();
  S.promoGetData = { id: 'promo_mkt', metadata: { campaign: 'verano' } };
  await markGiftRedeemed(env, 'promo_mkt', 'friend@y.co');
  t(S.calls.giftPatches.length === 0, 'promo sin metadata.gift → no-op (promo de marketing ajeno)');
}

/* ── Stripe caído → NUNCA lanza (fail-soft: el webhook de la compra no se rompe) ── */
{
  S = fresh();
  S.promoGetStatus = 500;
  let threw = false;
  try { await markGiftRedeemed(env, 'promo_1', 'friend@y.co'); } catch { threw = true; }
  t(!threw && S.calls.giftPatches.length === 0, 'Stripe caído: markGiftRedeemed no lanza ni patchea');
}

/* ── QA-2: allowlist de origin (mismo returnBase que el checkout principal — BUG-01 de Jakob) ── */
{
  S = fresh();
  process.env.ALLOWED_ORIGINS = 'https://site.test,https://kiosk.test';
  let r = await giftCheckout(new Request('https://site.test/api/create-gift-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://kiosk.test' },
    body: JSON.stringify({ email: 'buyer@x.co', tier: 'membership' })
  }));
  t(r.status === 200, 'QA-2: gift desde origin en allowlist → 200');
  let form = decodeURIComponent(S.calls.sessions[0] || '');
  t(form.includes('success_url=https://kiosk.test/?gift=sent'), 'QA-2: success_url vuelve al ORIGIN que llamó (kiosk)');
  t(form.includes('cancel_url=https://kiosk.test/?gift=canceled'), 'QA-2: cancel_url también');

  S = fresh();
  r = await giftCheckout(new Request('https://site.test/api/create-gift-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
    body: JSON.stringify({ email: 'buyer@x.co', tier: 'membership' })
  }));
  form = decodeURIComponent(S.calls.sessions[0] || '');
  t(r.status === 200 && form.includes('success_url=https://site.test/?gift=sent'), 'QA-2: origin DESCONOCIDO → cae a SITE_URL (sin open-redirect)');

  S = fresh();
  r = await giftCheckout(new Request('https://site.test/api/create-gift-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://kiosk.test' },
    body: JSON.stringify({ email: 'buyer@x.co', tier: 'membership', source: 'account' })
  }));
  form = decodeURIComponent(S.calls.sessions[0] || '');
  t(r.status === 200 && form.includes('success_url=https://kiosk.test/account.html?gift=sent'), 'QA-2: source:account conserva su path sobre el origin resuelto');
  delete process.env.ALLOWED_ORIGINS;
}

t.done();
