/* ============================================================================
 * GET /.netlify/functions/portal-reconciliation — PORT-24 Tanda D (review 17-jul).
 * Doug: "duplicate the Subscribers page and replace the Stripe page" — reconciliación
 * contable. Cada fila = un suscriptor (clon de portal-subscribers) + el ÚLTIMO pago
 * REAL de su ledger: Stripe payment number (stripe_invoice_id) + payment date (paid_at).
 * "An accountant is going to say: how do I know I got all my payments? It's right here."
 *
 * Guard: assertCanStripe (org + admin; store/sub → 403) — misma frontera que la
 * pantalla Stripe/commissions. §5.9: se muestra la REFERENCIA del pago (+ fecha + status),
 * jamás importes de revenue. El stripe_subscription_id real solo se usa server-side para
 * el join; nunca viaja al cliente.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, assertCanStripe, mapSubscriberRow, excludedOrgIds, rollupExclusion, PortalError } from './_lib/portal.mjs';
import { pgrest } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let scope, rs;
  try {
    const ctx = await requirePortalUser(req, env);
    if (!ctx.scope) return json(403, { error: 'not_portal_user' });
    scope = ctx.scope;
    assertCanStripe(scope);
    rs = readOrgScope(scope, new URL(req.url).searchParams.get('org_id'));
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-reconciliation] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  /* 1) suscripciones (mismo shape que portal-subscribers) + stripe_subscription_id para el join */
  let q = '/subscriptions?kind=eq.protection'
    + '&select=id,master_no,tier,kind,status,started_at,canceled_at,sub_entity_id,sales_associate,stripe_subscription_id,profiles(full_name,email),sub_entities(name)'
    + '&order=started_at.desc&limit=5000';
  if (!rs.all) q += `&dealer_id=eq.${encodeURIComponent(rs.orgId)}`;
  else q += rollupExclusion('dealer_id', await excludedOrgIds(env));

  let subsRes;
  try { subsRes = await pgrest(env, q); } catch (err) { console.error('[portal-reconciliation] subs:', err.message); return json(502, { error: 'upstream' }); }
  if (subsRes.status >= 300) return json(502, { error: 'upstream' });
  const subs = Array.isArray(subsRes.data) ? subsRes.data : [];

  /* 2) último pago por suscripción desde el ledger (payment number + date REALES) */
  let lq = '/commission_ledger?select=stripe_subscription_id,stripe_invoice_id,paid_at&order=paid_at.desc&limit=20000';
  if (!rs.all) lq += `&org_id=eq.${encodeURIComponent(rs.orgId)}`;
  else lq += rollupExclusion('org_id', await excludedOrgIds(env));

  const lastBySub = {};
  try {
    const led = await pgrest(env, lq);
    if (led.status < 300 && Array.isArray(led.data)) {
      for (const l of led.data) {                       // orden paid_at.desc → el primero visto es el más reciente
        const k = l.stripe_subscription_id;
        if (k && !lastBySub[k]) lastBySub[k] = l;
      }
    }
  } catch (err) { console.warn('[portal-reconciliation] ledger:', err.message); }

  /* 3) merge: fila de suscriptor + su último pago (o — si aún no pagó; cero fabricación) */
  const now = Date.now();
  const rows = subs.map((r) => {
    const m = mapSubscriberRow(r, now);
    const last = lastBySub[r.stripe_subscription_id];
    m.stripe_payment_no = last ? last.stripe_invoice_id : null;
    m.payment_date = last ? String(last.paid_at || '').slice(0, 10) : null;
    return m;
  });

  return json(200, { rows, total: rows.length });
}
