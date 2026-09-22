/* ============================================================================
 * POST /api/create-gift-checkout — compra de un gift coupon code (GIFT-1, §F3).
 * ----------------------------------------------------------------------------
 * Body: { email, tier }. El comprador paga months × precio de lista (pago
 * ÚNICO, mode:payment) y el webhook, al confirmarse el pago, emite el
 * promotion code y se lo manda por email. El PRECIO se calcula AQUÍ, del
 * catálogo server-side (GIFT_TIERS): el cliente jamás manda montos.
 *
 * fetch DIRECTO a api.stripe.com (form-encoded) y NO el SDK: el harness de
 * tests mockea globalThis.fetch y el SDK usa su propio http client (mismo
 * criterio que create-portal-session / get-billing).
 *
 * Anti-abuso: rate limit 3/min por IP + tope de 5 códigos ACTIVOS (status
 * 'created') por buyer_email → 409 gift_limit. El resto (1 canje, 90 días,
 * cliente-nuevo) lo enforza Stripe en el promotion code.
 * ==========================================================================*/

'use strict';

import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { EMAIL_RE, canonicalEmail } from './_lib/validate.mjs';
import { GIFT_TIERS, GIFT_MONTHS } from './_lib/gift.mjs';
import { pgrest } from './_lib/supabase.mjs';
import { resolveReturnBase } from './_lib/checkout.mjs';

/* Límite de industria (evidencia auditada 08-jul): 5 gifts sin canjear por
 * comprador. Frena la compra masiva de códigos (reventa) sin castigar el uso real. */
const MAX_ACTIVE_GIFTS = 5;

const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
});

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  /* Rate limit ANTES de todo: cada hit feliz crea una Checkout Session en Stripe. */
  const rl = await checkRate(env, { prefix: 'gift', ip: clientIp(req), limit: 3, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > 2048) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_json' });

  /* Email canónico (lowercase+trim): el tope de 5 se cuenta por buyer_email —
   * sin canonicalizar, "A@x.co" y "a@x.co" serían compradores distintos. */
  const email = canonicalEmail(body.email);
  if (!email || !EMAIL_RE.test(email)) return json(400, { error: 'invalid_email' });
  const tier = typeof body.tier === 'string' ? body.tier : '';
  if (!Object.prototype.hasOwnProperty.call(GIFT_TIERS, tier)) return json(400, { error: 'invalid_tier' });
  const gift = GIFT_TIERS[tier];

  /* Sin llave de Stripe no hay nada que vender (entorno a medio configurar). */
  if (!env.STRIPE_SECRET_KEY) return json(503, { error: 'gift_not_configured' });

  /* Tope: 5 códigos ACTIVOS (comprados y aún sin canjear) por comprador. */
  try {
    const { status, data } = await pgrest(env,
      `/gift_codes?buyer_email=eq.${encodeURIComponent(email)}&status=eq.created&select=id`);
    if (status >= 300) throw new Error(`gift_codes count failed (${status})`);
    if (Array.isArray(data) && data.length >= MAX_ACTIVE_GIFTS) return json(409, { error: 'gift_limit' });
  } catch (err) {
    console.error('[gift] limit check:', err.message);
    return json(502, { error: 'gift_failed' });
  }

  /* Checkout Session de pago único, form-encoded como pide la API de Stripe
   * (claves anidadas line_items[0][price_data][...]). metadata.intent='gift'
   * es la señal que desvía el webhook al flujo gift (no hay client_reference_id
   * ni lead: este pago NO crea cuenta ni cobertura, solo el código). */
  /* QA-2 (BUG-01 de Jakob): misma allowlist de origin que el checkout principal — un gift
   * comprado desde el kiosk vuelve AL KIOSK, no al site principal. */
  const site = resolveReturnBase(req, env);
  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('line_items[0][price_data][currency]', 'usd');
  form.append('line_items[0][price_data][product_data][name]', `Gift: ${GIFT_MONTHS} months of ${gift.label}`);
  form.append('line_items[0][price_data][unit_amount]', String(gift.cents * GIFT_MONTHS));
  form.append('line_items[0][quantity]', '1');
  form.append('customer_email', email);
  form.append('metadata[intent]', 'gift');
  form.append('metadata[tier]', tier);
  form.append('metadata[months]', String(GIFT_MONTHS));
  form.append('metadata[buyer_email]', email);
  /* Gift EN CONTEXTO (09-jul): si la compra nace en el dashboard, Stripe devuelve ALLÍ (el
   * cliente no queda varado en el site). `source` es un ENUM (solo 'account' se reconoce);
   * jamás una URL del cliente — sin open redirect. */
  const returnBase = body.source === 'account' ? `${site}/account.html` : `${site}/`;
  form.append('success_url', `${returnBase}?gift=sent`);
  form.append('cancel_url', `${returnBase}?gift=canceled`);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const data = res.status < 300 ? await res.json().catch(() => null) : null;
    if (!data || !data.url) {
      console.error('[gift] stripe session failed (status', res.status + ')');   // NUNCA loguear urls/tokens
      return json(502, { error: 'gift_failed' });
    }
    return json(200, { url: data.url });
  } catch (err) {
    console.error('[gift] stripe:', err.message);
    return json(502, { error: 'gift_failed' });
  }
}
