/* ============================================================================
 * GET /api/get-billing — panel Billing del dashboard (item 5, spec 08-jul §C5;
 * v2 con description + billing_address, item 14 §D-backend).
 * ----------------------------------------------------------------------------
 * SOLO lectura: card en archivo, dirección de facturación del mismo payment
 * method, próximo cargo y últimas facturas (con descripción). El browser
 * NUNCA ve la llave de Stripe — este proxy consulta con STRIPE_SECRET_KEY y
 * devuelve un resumen mínimo (brand/last4/exp, nunca el PAN ni ids de Stripe).
 *
 * fetch DIRECTO a api.stripe.com y NO el SDK: el harness de tests mockea
 * globalThis.fetch y el SDK de stripe usa su propio http client (no mockeable).
 *
 * Contrato de fallos, deliberadamente asimétrico:
 *   - lookup principal (fila de subscriptions / GET subscription) roto → 502
 *     billing_failed: sin eso no hay NADA que mostrar.
 *   - sin fila con stripe_subscription_id → 200 { billing:null }: cuenta
 *     solo-kit, NO es un error (el front oculta el panel).
 *   - upcoming/invoices/card-fallback rotos → FAIL-SOFT (null / []): el panel
 *     muestra lo que haya en vez de romperse entero por una pieza secundaria.
 *
 * Logs SOLO con status — nunca urls/tokens/datos de tarjeta.
 * ==========================================================================*/

'use strict';

import { requireUser, AuthError } from './_lib/auth.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { pgrest } from './_lib/supabase.mjs';

/* Datos de facturación con PII → no-store SIEMPRE. */
const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
});

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  /* Rate limit ANTES de tocar GoTrue/Stripe: cada hit feliz son hasta 4 llamadas a Stripe. */
  const rl = await checkRate(env, { prefix: 'billing', ip: clientIp(req), limit: 10, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  /* Auth: 401 uniforme sin sesión válida (mismo mensaje con o sin Bearer — sin oráculo). */
  let userId;
  try {
    ({ userId } = await requireUser(req, env));
  } catch (err) {
    if (err instanceof AuthError) return json(err.status || 401, { error: 'invalid_token' });
    console.warn('[billing] auth error:', err.message);
    return json(401, { error: 'invalid_token' });
  }

  /* Suscripción más reciente del user con stripe_subscription_id (mismo criterio que el
   * portal: varias filas nuestras comparten el MISMO sub id → cualquiera sirve). */
  const { status, data } = await pgrest(env, '/subscriptions?user_id=eq.' + encodeURIComponent(userId)
    + '&stripe_subscription_id=not.is.null&select=stripe_subscription_id&order=started_at.desc&limit=1');
  if (status >= 300) {
    console.warn('[billing] subscriptions lookup failed (status', status + ')');
    return json(502, { error: 'billing_failed' });
  }
  const subId = Array.isArray(data) && data[0] && data[0].stripe_subscription_id;
  if (!subId) return json(200, { ok: true, billing: null });   // cuenta solo-kit: NO es error

  try {
    const auth = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY };

    /* a) La suscripción, con payment method Y customer expandidos. El customer importa:
     * el portal de Stripe ("Billing information") edita la dirección EN EL CUSTOMER,
     * no en el payment method (bug encontrado por Adrian, 08-jul). */
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}?expand[]=default_payment_method&expand[]=customer`, { headers: auth });
    const sub = subRes.status < 300 ? await subRes.json().catch(() => null) : null;
    let cusObj = (sub && sub.customer && typeof sub.customer === 'object') ? sub.customer : null;
    const customer = sub && (typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id));
    if (!customer) {
      console.warn('[billing] stripe GET subscription failed (status', subRes.status + ')');   // NUNCA loguear urls/tokens
      return json(502, { error: 'billing_failed' });
    }

    /* b) Card: primero el default de la sub; si es null, el default del customer
     * (invoice_settings) — FAIL-SOFT: sin card el panel igual muestra facturas. */
    let pm = sub.default_payment_method || null;
    if (!pm) {
      try {
        const cusRes = await fetch(`https://api.stripe.com/v1/customers/${customer}?expand[]=invoice_settings.default_payment_method`, { headers: auth });
        const cus = cusRes.status < 300 ? await cusRes.json().catch(() => null) : null;
        if (cus && !cusObj) cusObj = cus;   // también sirve como fuente de la dirección
        pm = (cus && cus.invoice_settings && cus.invoice_settings.default_payment_method) || null;
      } catch (err) {
        console.warn('[billing] customer lookup fail-soft:', err.message);
        pm = null;
      }
    }
    const card = (pm && pm.card)
      ? { brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year }
      : null;

    /* Dirección de facturación — FUENTES en orden: (1) customer.address, que es lo que el
     * cliente edita en el Customer Portal; (2) pm.billing_details.address, la dirección AVS
     * capturada con la tarjeta (solo cambia si re-ingresan la tarjeta). Leer SOLO el pm era
     * el bug: las ediciones del portal jamás llegaban al dashboard. Formato "line1, city,
     * state postal" con solo las partes presentes. NUNCA loguear la dirección. */
    const formatAddress = (a) => {
      if (!a) return null;
      const statePostal = [a.state, a.postal_code].filter(Boolean).join(' ');
      const parts = [a.line1, a.city, statePostal].filter(Boolean);
      return parts.length ? parts.join(', ') : null;
    };
    const billing_address = formatAddress(cusObj && cusObj.address)
      || formatAddress(pm && pm.billing_details && pm.billing_details.address)
      || null;

    /* c) Próximo cargo: la invoice "upcoming" es VIRTUAL — 404 = sub cancelada, sin
     * próximo cobro → null (no es error). Cualquier otro fallo también FAIL-SOFT. */
    let next_charge = null;
    try {
      const upRes = await fetch(`https://api.stripe.com/v1/invoices/upcoming?customer=${encodeURIComponent(customer)}`, { headers: auth });
      if (upRes.status < 300) {
        const up = await upRes.json().catch(() => null);
        if (up) {
          next_charge = {
            date: new Date(1000 * (up.next_payment_attempt || up.period_end)).toISOString(),
            amount_cents: up.amount_due
          };
        }
      } else if (upRes.status !== 404) {
        console.warn('[billing] upcoming invoice fail-soft (status', upRes.status + ')');
      }
    } catch (err) {
      console.warn('[billing] upcoming invoice fail-soft:', err.message);
    }

    /* d) Historial: últimas 6 facturas. amount_paid cuando hubo pago real (>0);
     * amount_due para las abiertas/fallidas. FAIL-SOFT → []. */
    let invoices = [];
    try {
      const listRes = await fetch(`https://api.stripe.com/v1/invoices?customer=${encodeURIComponent(customer)}&limit=6`, { headers: auth });
      const list = listRes.status < 300 ? await listRes.json().catch(() => null) : null;
      if (list && Array.isArray(list.data)) {
        invoices = list.data.map((inv) => {
          /* Descripción: la primera línea de la invoice (la lista /v1/invoices ya trae
           * lines.data por default — sin request extra); varias líneas → "N items";
           * fallback a inv.description; si no, null. */
          let description = inv.description || null;
          if (inv.lines && Array.isArray(inv.lines.data) && inv.lines.data.length > 1) {
            description = inv.lines.data.length + ' items';
          } else if (inv.lines && Array.isArray(inv.lines.data) && inv.lines.data.length === 1) {
            description = inv.lines.data[0].description || inv.description || null;
          }
          return {
            date: new Date(inv.created * 1000).toISOString(),
            amount_cents: (Number.isInteger(inv.amount_paid) && inv.amount_paid > 0) ? inv.amount_paid : inv.amount_due,
            status: inv.status,
            description
          };
        });
      } else if (listRes.status >= 300) {
        console.warn('[billing] invoices list fail-soft (status', listRes.status + ')');
      }
    } catch (err) {
      console.warn('[billing] invoices list fail-soft:', err.message);
    }

    return json(200, { ok: true, billing: { card, billing_address, next_charge, invoices } });
  } catch (err) {
    console.warn('[billing] stripe error:', err.message);
    return json(502, { error: 'billing_failed' });
  }
}
