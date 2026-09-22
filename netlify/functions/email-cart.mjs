/* ============================================================================
 * POST /api/email-cart — "Email my cart to myself", el envío REAL (C.5 / BE-3).
 * ----------------------------------------------------------------------------
 * El front mandaba una confirmación FINGIDA (stub sin backend, audit C5). Este
 * endpoint arma el resumen del carrito con precios del SERVER (PRICE_CENTS +
 * catálogo care_kits — nunca los montos del cliente) y lo envía vía sendEmail
 * (_lib/email.mjs, Resend). Fail-HONESTO: si el envío falla, 502 email_failed
 * y el front lo dice; nunca se confirma un email que no salió.
 * Nada del cliente entra al HTML: labels y precios son strings del server; el
 * email destino solo viaja en el campo `to`.
 * ==========================================================================*/

'use strict';

import { PRICE_CENTS, KIT_SKUS, MAX_PLANS, MAX_KIT_QTY, EMAIL_RE, canonicalEmail, PIECE_TYPES } from './_lib/validate.mjs';
import { kitCharges } from './_lib/checkout.mjs';
import { getCareKitsBySku } from './_lib/supabase.mjs';
import { sendEmail } from './_lib/email.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';

const MAX_BODY_BYTES = 4096;
const MEMBERSHIP_CENTS = 1999;        // standalone; el cobro real siempre lo fija Stripe
const COV_LABEL = { 'stain': 'Stain protection', 'stain-mech': 'Stain + Structure' };

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' }
});
const usd = (cents) => '$' + (cents / 100).toFixed(2);

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  const rl = await checkRate(env, { prefix: 'emailcart', ip: clientIp(req), limit: 3, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter });

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const email = canonicalEmail(body.email);
  if (!email || !EMAIL_RE.test(email)) return json(400, { error: 'invalid_email' });

  /* Planes: solo cov conocidos y term monthly (lo único comprable); precio SIEMPRE de PRICE_CENTS. */
  const plans = (Array.isArray(body.plans) ? body.plans : [])
    .filter((p) => p && PRICE_CENTS[p.cov] !== undefined && p.term === 'monthly')
    .map((p) => ({
      cov: p.cov,
      type: PIECE_TYPES.includes(p.type) ? p.type : 'furniture',
      count: Math.max(1, Math.min(MAX_PLANS, parseInt(p.count, 10) || 1))
    }));

  const kitsIn = (Array.isArray(body.kits) ? body.kits : [])
    .filter((k) => k && KIT_SKUS.includes(k.sku))
    .map((k) => ({ sku: k.sku, quantity: Math.max(1, Math.min(MAX_KIT_QTY, parseInt(k.quantity, 10) || 1)) }));

  const membership = !!body.membership;
  if (!plans.length && !kitsIn.length && !membership) return json(400, { error: 'empty_cart' });

  /* Kits: nombre + precio del catálogo canónico (server), nunca del cliente. */
  let kits = [];
  if (kitsIn.length) {
    try {
      const catalog = await getCareKitsBySku(env, kitsIn.map((k) => k.sku));
      kits = kitsIn
        .filter((k) => catalog[k.sku])
        .map((k) => ({ name: catalog[k.sku].name || k.sku, quantity: k.quantity, cents: catalog[k.sku].price_cents }));
    } catch (err) {
      console.error('[email-cart] catalog:', err.message);
      return json(502, { error: 'catalog_failed' });
    }
  }

  /* Resumen (montos del server). Recurrente /mo = planes + membership de pago (MEM-7);
     one-time = kits + S&H + tax (BE-5). */
  const lines = [];
  let monthly = 0, oneTime = 0;
  for (const p of plans) {
    const cents = PRICE_CENTS[p.cov] * p.count;
    monthly += cents;
    lines.push(`${COV_LABEL[p.cov]} (${p.type})${p.count > 1 ? ` x${p.count}` : ''} — ${usd(cents)}/mo`);
  }
  if (membership) {
    /* MEM-7 (14-ago): la membership del carrito es SIEMPRE la de pago ($19.99); la incluida con
       el plan es un entitlement del server, no una línea. El email espeja lo que Stripe cobra. */
    monthly += MEMBERSHIP_CENTS;
    lines.push(`Repair Safety Net — ${usd(MEMBERSHIP_CENTS)}/mo`);
  }
  for (const k of kits) {
    const cents = k.cents * k.quantity;
    oneTime += cents;
    lines.push(`${k.name}${k.quantity > 1 ? ` x${k.quantity}` : ''} — ${usd(cents)} one-time`);
  }
  /* BE-5 (14-ago): los kits cobran S&H + tax al cliente; el email espeja lo que Stripe cobrará. */
  if (kits.length) {
    const { shCents, taxCents } = kitCharges(kits.map((k) => ({ quantity: k.quantity, unit_price_cents: k.cents })), env);
    if (shCents > 0) { oneTime += shCents; lines.push(`Shipping & handling — ${usd(shCents)} one-time`); }
    if (taxCents > 0) { oneTime += taxCents; lines.push(`Sales tax (6%) — ${usd(taxCents)} one-time`); }
  }
  const totals = [];
  if (monthly > 0) totals.push(`${usd(monthly)}/mo`);
  if (oneTime > 0) totals.push(`${usd(oneTime)} one-time`);

  const siteUrl = (env.SITE_URL || '').replace(/\/+$/, '');
  const html = '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0e1418">'
    + '<h2>Your Furniture-Rx cart</h2>'
    + '<p>Here is the cart you saved — no payment has been taken.</p>'
    + '<ul>' + lines.map((l) => '<li>' + l + '</li>').join('') + '</ul>'
    + '<p><strong>Total: ' + totals.join(' + ') + '</strong></p>'
    + (siteUrl ? '<p><a href="' + siteUrl + '" style="display:inline-block;background:#e8590c;color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none;font-weight:600">Pick up where you left off &rarr;</a></p>' : '')
    + '<p style="color:#667;font-size:13px">Your cart also stays saved on the device where you built it.</p>'
    + '</div>';
  const text = 'Your Furniture-Rx cart (no payment taken):\n'
    + lines.map((l) => '- ' + l).join('\n')
    + '\nTotal: ' + totals.join(' + ')
    + (siteUrl ? '\n' + siteUrl : '');

  const r = await sendEmail(env, { to: email, subject: 'Your Furniture-Rx cart', html, text });
  if (!r.ok) {
    console.warn('[email-cart] send failed:', r.error);   // nunca el html ni el destino completo
    return json(502, { error: 'email_failed' });
  }
  return json(200, { sent: true });
}
