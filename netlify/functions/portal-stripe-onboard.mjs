/* ============================================================================
 * /.netlify/functions/portal-stripe-onboard — Stripe Connect onboarding por dealer.
 *   Admin-only. Fuente: revisiones/ChangesBLS.srt 00:37–02:05 · spec: misc/spec-stripe-onboarding.md.
 *   GET  ?org_id  → estado: { account_id, charges_enabled, payouts_enabled, details_submitted }
 *                   | { account_id:null } si el dealer aún no tiene cuenta.
 *   POST { org_id } → asegura la cuenta Express (la crea y guarda el acct_id si falta) y devuelve
 *                     un onboarding link fresco: { account_id, onboarding_url, ...flags }.
 * "we send the invite link, they set up Stripe, we get the account id and we link it" (Doug/Adrian).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, auditRow, PortalError, portalLinkBase } from './_lib/portal.mjs';
import { stripeApi, stripeLivemode } from './_lib/stripe.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';
import { ensureConnectAccount, ensureOnboardLink, onboardUrl } from './_lib/connect.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}
async function dealerOf(env, orgId) {
  const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name,stripe_account_id,stripe_account_livemode&limit=1`);
  return (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
}
const statusOf = (acct) => ({
  charges_enabled: !!(acct && acct.charges_enabled),
  payouts_enabled: !!(acct && acct.payouts_enabled),
  details_submitted: !!(acct && acct.details_submitted)
});

export default async function handler(req) {
  const env = process.env;

  let ctx, scope;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    assertAdmin(scope);                       // Dealer Admin es admin-only
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-stripe-onboard] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    const orgId = new URL(req.url).searchParams.get('org_id');
    if (!orgId) return json(400, { error: 'org_id_required' });
    const dealer = await dealerOf(env, orgId);
    if (!dealer) return json(404, { error: 'not_found' });
    /* DEAL-5: una cuenta del OTRO modo de Stripe no existe para esta clave. Antes se
       preguntaba igual y el 404 salía como 502, dejando la pantalla rota sin explicar
       por qué. Se reporta como no conectado, que es la verdad en este modo. */
    if (!dealer.stripe_account_id) return json(200, { account_id: null });
    if (dealer.stripe_account_livemode != null && dealer.stripe_account_livemode !== stripeLivemode(env)) {
      return json(200, { account_id: null, other_mode: true });
    }
    const acct = await stripeApi(env, 'GET', '/accounts/' + encodeURIComponent(dealer.stripe_account_id));
    if (acct.status === 404 && acct.data && acct.data.error && acct.data.error.code === 'resource_missing') {
      return json(200, { account_id: null, other_mode: true });
    }
    if (acct.status >= 300) { console.error('[portal-stripe-onboard] retrieve', acct.status); return json(502, { error: 'stripe_error' }); }
    return json(200, { account_id: dealer.stripe_account_id, ...statusOf(acct.data) });
  }

  if (req.method === 'POST') {
    let body = null; try { body = await req.json(); } catch { /* → 400 abajo */ }
    const orgId = body && typeof body.org_id === 'string' ? body.org_id : null;
    if (!orgId) return json(400, { error: 'org_id_required' });
    const dealer = await dealerOf(env, orgId);
    if (!dealer) return json(404, { error: 'not_found' });

    /* DEAL-5: la creación vive en _lib/connect (guard de modo, auto-reparación,
       Idempotency-Key y reclamo atómico). Antes esto era un read-modify-write sin
       protección: dos clics creaban dos cuentas Express y el dealer quedaba atado a
       la que perdió la carrera. */
    const ensured = await ensureConnectAccount(env, dealer);
    if (ensured.error) return json(502, { error: 'stripe_error' });
    const acctId = ensured.acctId;
    const acct = ensured.acct;

    /* El refresh_url apuntaba a la home del portal, donde el dealer no es admin: un
       link caducado era un callejón sin salida. Ahora vuelve al link DURABLE, que
       acuña otro y lo reenvía sin que el dealer note nada. */
    const base = portalLinkBase(req, env);
    const durable = await ensureOnboardLink(env, dealer, ctx.userId);
    const backTo = durable ? onboardUrl(base, durable) : base;

    const link = await stripeApi(env, 'POST', '/account_links', { account: acctId, type: 'account_onboarding', refresh_url: backTo, return_url: base + '?payouts=done' });
    if (link.status >= 300 || !link.data || !link.data.url) { console.error('[portal-stripe-onboard] link', link.status); return json(502, { error: 'stripe_error' }); }

    await writeAudit(env, auditRow({
      actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
      category: 'Change', action: 'stripe_onboarding_link', target: dealer.name,
      details: `acct ${acctId}`, org_id: orgId
    }));

    return json(200, { account_id: acctId, onboarding_url: link.data.url, ...statusOf(acct) });
  }

  return json(405, { error: 'method_not_allowed' });
}
