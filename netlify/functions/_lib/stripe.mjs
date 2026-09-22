/* ============================================================================
 * _lib/stripe.mjs — cliente Stripe compartido (singleton lazy) + mapeo price↔tier.
 * STRIPE_SECRET_KEY solo por env. El singleton se reusa entre invocaciones calientes.
 * ==========================================================================*/

'use strict';

import Stripe from 'stripe';

let _stripe = null;

export function getStripe(env) {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) throw new Error('missing STRIPE_SECRET_KEY');
    _stripe = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

/* tier ('stain' | 'stain_mech') → price ID de env. La cobertura 'stain-mech' del
 * cliente se normaliza a 'stain_mech' en validate.mjs (tier). */
/* Stripe REST directo (fetch) para llamadas de PLATAFORMA fuera del checkout (Connect
 * onboarding). Igual que el runbook (curl) y el precedente de seed-demo-afc. Testeable con
 * el stub de globalThis.fetch del harness; NO toca getStripe (el cliente del checkout intacto).
 * `form`: objeto plano → application/x-www-form-urlencoded (Stripe acepta corchetes URL-encoded). */
export async function stripeApi(env, method, path, form, extraHeaders) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('missing STRIPE_SECRET_KEY');
  const opts = { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, ...(extraHeaders || {}) } };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const res = await fetch('https://api.stripe.com/v1' + path, opts);
  let data = null; try { data = await res.json(); } catch { /* respuesta vacía */ }
  return { status: res.status, data };
}

/* DEAL-5: ¿en qué modo habla esta plataforma con Stripe? El prefijo de la clave es
 * el ÚNICO dato fiable: un `acct_...` no lleva ninguna marca de modo, así que dos
 * cuentas de universos distintos son indistinguibles por inspección. Nunca se asume
 * live por defecto: sin clave, test. Cubre también las restricted keys (rk_). */
export function stripeLivemode(env) {
  return /^(sk|rk)_live_/.test((env && env.STRIPE_SECRET_KEY) || '');
}

export function priceForTier(env, tier) {
  const map = {
    stain: env.STRIPE_PRICE_STAIN,
    stain_mech: env.STRIPE_PRICE_STAIN_MECH
  };
  const price = map[tier];
  if (!price) throw new Error(`no price configured for tier ${tier}`);
  return price;
}

/* Precio recurrente de la Repair Membership ($19.99/mo). Producto APARTE de los planes. */
export function priceForMembership(env) {
  const price = env.STRIPE_PRICE_MEMBERSHIP;
  if (!price) throw new Error('no price configured for membership');
  return price;
}

/* MEM-7 (reunión 14-ago, "we're going to activate a repair membership for EVERY subscription…
 * at no additional charge"): la membership INCLUIDA ya no se vende como item — es un
 * ENTITLEMENT computado (plan activo ⇒ Repair Safety Net activa, ver _lib/account.mjs). La
 * membership DE PAGO (mueble usado, "Cover your used furniture") vale SIEMPRE $19.99: la
 * matemática del upsell de Doug ($8 plan + $8 membership = $16/cliente) exige precio completo.
 * Murió la Arquitectura B del 06-jul (FREE con stain-mech / HALF con stain): los prices
 * STRIPE_PRICE_MEMBERSHIP_FREE y _HALF ya no se usan para VENDER; el webhook los sigue
 * reconociendo para las suscripciones legacy que los llevan. */
export function pickMembershipPrice(env) {
  return priceForMembership(env);
}
