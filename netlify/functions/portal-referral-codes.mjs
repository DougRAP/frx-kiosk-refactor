/* ============================================================================
 * /.netlify/functions/portal-referral-codes — PORT-9 (portal).
 *   GET  → lista de códigos del scope (org ve los suyos; admin filtra o ve all).
 *          Guard: canReferralView (org + admin; store/sub → 403, API-CONTRACT §5.5).
 *   POST → genera un código para un org. SOLO admin (canReferralCreate): "the
 *          dealer referral code that we generate for the dealer" (Doug 15-jul).
 * 🔒 El org efectivo sale del TOKEN (readOrgScope), nunca de un param como grant.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, excludedOrgIds, rollupExclusion, PortalError } from './_lib/portal.mjs';
import { generateReferralCode, referralStats } from './_lib/referral.mjs';
import { clean } from './_lib/validate.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';
import { auditRow } from './_lib/portal.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

export default async function handler(req) {
  const env = process.env;

  let ctx, scope;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    if (!scope) return json(403, { error: 'not_portal_user' });
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-referral-codes] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    if (!scope.canReferralView) return json(403, { error: 'forbidden' });
    let rs;
    try { rs = readOrgScope(scope, new URL(req.url).searchParams.get('org_id')); }
    catch (err) { return err instanceof PortalError ? json(err.status, { error: err.code }) : json(500, { error: 'scope_error' }); }

    /* PORT-21: en "All", fuera los dealers con include_in_rollups=false (los códigos
     * de un dealer excluido no aparecen; con su scope propio sí). */
    const excl = rs.all ? await excludedOrgIds(env) : [];
    const orgFilter = rs.all ? rollupExclusion('org_id', excl) : `&org_id=eq.${encodeURIComponent(rs.orgId)}`;
    const dealerFilter = rs.all ? rollupExclusion('dealer_id', excl) : `&dealer_id=eq.${encodeURIComponent(rs.orgId)}`;
    let result, leadsQ, subsQ, ledQ;
    try {
      /* PORT-19C: las columnas del mock (Uses / Attributed subs / Credit earned) con data REAL.
       * PORT-21: limits a 20k (un año de un dealer de 1000 subs son ~12k pagos). */
      [result, leadsQ, subsQ, ledQ] = await Promise.all([
        pgrest(env, `/referral_codes?select=code,label,org_id,active,created_at,dealers(name)&order=created_at.desc&limit=200${rs.all ? (excl.length ? `&org_id=not.in.(${excl.map(encodeURIComponent).join(',')})` : '') : orgFilter}`),
        pgrest(env, `/leads?select=code:payload->>referral_code&payload->>referral_code=not.is.null&limit=20000${rs.all ? '' : `&payload->>dealer_id=eq.${encodeURIComponent(rs.orgId)}`}`),
        pgrest(env, `/subscriptions?referral_code=not.is.null&select=referral_code,stripe_subscription_id&limit=20000${dealerFilter}`),
        pgrest(env, `/commission_ledger?select=stripe_subscription_id,stripe_amount_cents,reinsurance_amount_cents&limit=20000${orgFilter}`)
      ]);
    } catch (err) { console.error('[portal-referral-codes] pgrest:', err.message); return json(502, { error: 'upstream' }); }
    if (result.status >= 300) return json(502, { error: 'upstream' });

    const base = Array.isArray(result.data) ? result.data : [];
    const stats = referralStats(
      base.map((r) => r.code),
      ((leadsQ.status < 300 && Array.isArray(leadsQ.data)) ? leadsQ.data : []).map((l) => l.code),
      (subsQ.status < 300 && Array.isArray(subsQ.data)) ? subsQ.data : [],
      (ledQ.status < 300 && Array.isArray(ledQ.data)) ? ledQ.data : []
    );
    const rows = base.map((r) => ({
      code: r.code, label: r.label || null, org_id: r.org_id,
      org_name: (r.dealers && r.dealers.name) || null,
      active: r.active, created_at: r.created_at,
      uses: stats[r.code].uses, attributed: stats[r.code].attributed, credit_cents: stats[r.code].credit_cents
    }));
    return json(200, { rows, total: rows.length });
  }

  if (req.method === 'POST') {
    if (!scope.canReferralCreate) return json(403, { error: 'forbidden' });   // crear = admin
    let body = null;
    try { body = await req.json(); } catch { /* body inválido → 400 abajo */ }
    const orgId = body && typeof body.org_id === 'string' ? body.org_id : null;
    if (!orgId) return json(400, { error: 'org_id_required' });

    const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name&limit=1`);
    const dealer = (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
    if (!dealer) return json(404, { error: 'not_found' });

    const label = clean(body.label, 64);   // PORT-19C: la columna Campaign del mock (opcional)

    /* Unicidad por el UNIQUE de la tabla: 409 → regenerar (hasta 3 intentos). */
    for (let i = 0; i < 3; i++) {
      const code = generateReferralCode(dealer.name);
      const ins = await pgrest(env, '/referral_codes', {
        method: 'POST', prefer: 'return=minimal',
        body: { code, org_id: orgId, created_by: ctx.userId, label }
      });
      if (ins.status === 201) {
        await writeAudit(env, auditRow({
          actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
          category: 'Change', action: 'referral_code_created', target: code,
          details: `org ${dealer.name}`, org_id: orgId
        }));
        return json(200, { code, org_id: orgId, org_name: dealer.name });
      }
      if (ins.status !== 409) { console.error('[portal-referral-codes] insert status', ins.status); return json(502, { error: 'upstream' }); }
    }
    return json(502, { error: 'code_collision' });
  }

  return json(405, { error: 'method_not_allowed' });
}
