/* ============================================================================
 * POST /api/create-portal-session — botón "Manage billing" del dashboard (DASH-1)
 * y chip "Cancel plan" por card (DASH-1b, review Doug 08-jul).
 * ----------------------------------------------------------------------------
 * El Customer Portal de Stripe resuelve cancel/update-payment SIN UI propia
 * (OJO: el portal NO ofrece pause; eso sería un endpoint nuestro, fase 2):
 * nosotros solo creamos la sesión del portal y devolvemos { url }; Stripe hostea
 * el resto y el usuario vuelve a /account.html (return_url).
 *
 * DASH-1b: con body JSON { subscription: 'sub_x' } el portal abre DIRECTO en la
 * confirmación de cancelación de ESA suscripción (flow_data subscription_cancel).
 * Propiedad re-verificada server-side: el sub id debe existir en subscriptions
 * para ESTE user; si no → 404 uniforme (sin oráculo). La cancelación de Stripe
 * opera sobre la COMPRA completa (varias filas comparten el sub id); el aviso
 * al cliente vive en el front.
 *
 * fetch DIRECTO a api.stripe.com y NO el SDK: el harness de tests mockea
 * globalThis.fetch y el SDK de stripe usa su propio http client (no mockeable).
 * El SDK queda reservado para verificar la firma del webhook + checkout.
 *
 * CONFIG (Adrian): activar el portal en Stripe (Settings → Billing → Customer
 * portal) CON cancelación habilitada (Cancel subscriptions → a fin de período).
 *
 * Flujo: rate limit (5/min por IP) → requireUser (Bearer) → fila subscriptions
 * (la dirigida del body, o la más reciente) → GET subscription (→ customer) →
 * POST /v1/billing_portal/sessions [+ flow_data] → { url }. Fallo de Stripe →
 * 502 portal_failed.
 * ==========================================================================*/

'use strict';

import { requireUser, AuthError } from './_lib/auth.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { pgrest } from './_lib/supabase.mjs';

/* La URL del portal es un enlace con sesión embebida → no-store SIEMPRE. */
const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
});

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  /* Rate limit ANTES de tocar GoTrue/Stripe: cada hit feliz crea una sesión de portal. */
  const rl = await checkRate(env, { prefix: 'portal', ip: clientIp(req), limit: 5, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  /* Auth: 401 uniforme sin sesión válida (mismo mensaje con o sin Bearer — sin oráculo). */
  let userId;
  try {
    ({ userId } = await requireUser(req, env));
  } catch (err) {
    if (err instanceof AuthError) return json(err.status || 401, { error: 'invalid_token' });
    console.warn('[portal] auth error:', err.message);
    return json(401, { error: 'invalid_token' });
  }

  /* DASH-1b: body opcional { subscription } → flow dirigido de cancelación. Formato
   * validado ANTES de tocar la BD; presente pero malformado → 400. */
  let wanted = null;
  const body = await req.json().catch(() => null);
  if (body && body.subscription !== undefined) {
    if (typeof body.subscription !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(body.subscription)) {
      return json(400, { error: 'invalid_subscription' });
    }
    wanted = body.subscription;
  }

  /* Fila de subscriptions del user: la DIRIGIDA (ownership check: user_id + sub id) o la
   * más reciente con stripe_subscription_id (una compra = varias filas con el MISMO sub
   * id → cualquiera sirve; el portal genérico opera a nivel customer). */
  const q = wanted
    ? '/subscriptions?user_id=eq.' + encodeURIComponent(userId)
      + '&stripe_subscription_id=eq.' + encodeURIComponent(wanted) + '&select=stripe_subscription_id&limit=1'
    : '/subscriptions?user_id=eq.' + encodeURIComponent(userId)
      + '&stripe_subscription_id=not.is.null&select=stripe_subscription_id&order=started_at.desc&limit=1';
  const { status, data } = await pgrest(env, q);
  if (status >= 300) {
    console.warn('[portal] subscriptions lookup failed (status', status + ')');
    return json(502, { error: 'portal_failed' });
  }
  const subId = Array.isArray(data) && data[0] && data[0].stripe_subscription_id;
  if (!subId) return json(404, { error: 'no_subscription' });

  try {
    const auth = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY };

    /* a) La suscripción → su customer (string, o objeto expandido con .id). */
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, { headers: auth });
    const sub = subRes.status < 300 ? await subRes.json().catch(() => null) : null;
    const customer = sub && (typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id));
    if (!customer) {
      console.warn('[portal] stripe GET subscription failed (status', subRes.status + ')');   // NUNCA loguear urls/tokens
      return json(502, { error: 'portal_failed' });
    }

    /* b) Sesión del portal (form-encoded, como pide la API de Stripe). Con flow dirigido,
     * el portal abre YA en la confirmación de cancelación de esa suscripción. */
    const returnUrl = (env.SITE_URL || '').replace(/\/+$/, '') + '/account.html';
    const params = new URLSearchParams({ customer, return_url: returnUrl });
    if (wanted) {
      params.append('flow_data[type]', 'subscription_cancel');
      params.append('flow_data[subscription_cancel][subscription]', wanted);
    }
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const portal = portalRes.status < 300 ? await portalRes.json().catch(() => null) : null;
    if (!portal || !portal.url) {
      console.warn('[portal] stripe portal session failed (status', portalRes.status + ')');
      return json(502, { error: 'portal_failed' });
    }

    return json(200, { url: portal.url });
  } catch (err) {
    console.warn('[portal] stripe error:', err.message);
    return json(502, { error: 'portal_failed' });
  }
}
