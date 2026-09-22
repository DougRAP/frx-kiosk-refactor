/* ============================================================================
 * POST /.netlify/functions/portal-cancel-subscription — PORT-24C (quick action).
 * Doug 17-jul: "cancel subscription… only works if you are a RAP admin. But you
 * leave the button so everybody can see it." → botón visible a todos (UI), pero
 * el backend EXIGE admin (assertAdmin). Cancela al FINAL del periodo vigente
 * (cancel_at_period_end) para que no haya más cobros y la cobertura corra hasta
 * fin de mes (coincide con "each contract terminates 30 days from start").
 * Fail-soft con Stripe: una sub sintética (demo) no revienta la acción; se audita.
 * Body: { contract } (RX-#### o RX-####-NN).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, assertAdmin, auditRow, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';
import { getStripe } from './_lib/stripe.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let ctx, scope, rs;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    assertAdmin(scope);                                  // Doug: solo RAP admin puede ejecutar
    rs = readOrgScope(scope, null);
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-cancel-subscription] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  let body = null;
  try { body = await req.json(); } catch { /* → 400 */ }
  const raw = body && typeof body.contract === 'string' ? body.contract.trim() : '';
  const master = raw.replace(/-\d+$/, '');
  if (!/^RX-\d+$/i.test(master)) return json(400, { error: 'invalid_contract' });

  let row;
  try {
    const q = await pgrest(env, `/subscriptions?master_no=eq.${encodeURIComponent(master.toUpperCase())}`
      + '&kind=eq.protection&select=stripe_subscription_id,dealer_id,status&limit=1');
    row = (q.status < 300 && Array.isArray(q.data) && q.data[0]) || null;
  } catch (err) { console.error('[portal-cancel-subscription] lookup:', err.message); return json(502, { error: 'upstream' }); }
  if (!row) return json(404, { error: 'not_found' });

  /* Stripe: marca cancel_at_period_end. Fail-soft: sub sintética/inexistente → seguimos y auditamos
   * el intento (la baja real la refleja el webhook cuando Stripe cierra el periodo). */
  let stripeOk = false;
  if (row.stripe_subscription_id) {
    try {
      const stripe = getStripe(env);
      await stripe.subscriptions.update(row.stripe_subscription_id, { cancel_at_period_end: true });
      stripeOk = true;
    } catch (err) { console.warn('[portal-cancel-subscription] stripe fail-soft:', err.message); }
  }

  await writeAudit(env, auditRow({
    actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
    category: 'Change', action: 'subscription_cancel_scheduled', target: master.toUpperCase(),
    details: stripeOk ? 'cancel_at_period_end via Stripe' : 'recorded (Stripe not reached)',
    org_id: rs.all ? row.dealer_id : rs.orgId
  }));
  return json(200, { scheduled: true, stripe: stripeOk });
}
