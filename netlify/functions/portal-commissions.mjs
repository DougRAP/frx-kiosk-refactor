/* ============================================================================
 * GET /.netlify/functions/portal-commissions — PORT-8 (lectura del portal).
 * Ledger de comisiones scoped por org. Guard: assertCanStripe (org + admin;
 * store/sub → 403). §5.9 HARD: el payload SOLO lleva montos de COMISIÓN (cash +
 * reinsurance) — "RAP's gross subscription revenue must not appear in any of
 * these payloads — not as a field the UI hides, not at all." El ledger, por
 * construcción, no contiene revenue: solo la comisión ya calculada.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, assertCanStripe, excludedOrgIds, rollupExclusion, PortalError } from './_lib/portal.mjs';
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
    console.error('[portal-commissions] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  /* PORT-21: los TOTALES se calculan sobre el ledger completo (250 truncaba dealers
   * grandes: un año de un dealer con 1000 subs son ~12k pagos); la TABLA devuelve
   * solo los 250 más recientes para no ahogar el DOM del front. */
  let q = '/commission_ledger?select=plan_sku,qty,stripe_amount_cents,reinsurance_amount_cents,status,paid_at'
    + '&order=paid_at.desc&limit=20000';
  if (!rs.all) q += `&org_id=eq.${encodeURIComponent(rs.orgId)}`;
  else q += rollupExclusion('org_id', await excludedOrgIds(env));   // PORT-21

  let result;
  try { result = await pgrest(env, q); } catch (err) { console.error('[portal-commissions] pgrest:', err.message); return json(502, { error: 'upstream' }); }
  if (result.status >= 300) return json(502, { error: 'upstream' });

  const rows = Array.isArray(result.data) ? result.data : [];
  const totals = rows.reduce((a, r) => {
    a.cash_cents += r.stripe_amount_cents | 0;
    a.reinsurance_cents += r.reinsurance_amount_cents | 0;
    return a;
  }, { cash_cents: 0, reinsurance_cents: 0 });
  return json(200, { rows: rows.slice(0, 250), totals, total: rows.length });
}
