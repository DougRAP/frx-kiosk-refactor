/* ============================================================================
 * /.netlify/functions/portal-plan-terms — PORT-25 (Dealer Setup, admin-only).
 * Expone el "T&C SKU" (terms_version) + doc_url POR DEALER y POR plan_sku, sobre la
 * tabla plan_terms que YA existe (mig 20260715110000). La genérica (org_id NULL) es
 * el fallback; la fila del dealer, cuando existe y está activa, GANA (ver termsFor()
 * en _lib/referral.mjs — este endpoint NO toca esa resolución de runtime).
 *
 *   GET  ?org_id → { skus:[ { plan_sku, override|null, generic|null, effective|null } x2 ] }
 *   POST { org_id, plan_sku, terms_version, doc_url? } → upsert de la fila del dealer.
 *   POST { org_id, plan_sku, action:'clear' }          → desactiva la fila (cae a genérica).
 *
 * 🔒 SOLO admin (assertAdmin) — es la pantalla Dealer Admin. Audit por cada cambio.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, auditRow, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

const SKUS = ['stain', 'stain_mech'];   // canónicos (validate.mjs / plan_terms_sku_chk)

async function dealerOf(env, orgId) {
  const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name,world&limit=1`);
  return (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
}

export default async function handler(req) {
  const env = process.env;

  let ctx, scope;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    assertAdmin(scope);                       // Dealer Admin es admin-only
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-plan-terms] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    const orgId = new URL(req.url).searchParams.get('org_id');
    if (!orgId) return json(400, { error: 'org_id_required' });
    const dealer = await dealerOf(env, orgId);
    if (!dealer) return json(404, { error: 'not_found' });

    /* Una sola query: override del dealer + genéricas (org_id null), solo activas. */
    const r = await pgrest(env, `/plan_terms?or=(org_id.eq.${encodeURIComponent(orgId)},org_id.is.null)&active=is.true&select=org_id,plan_sku,terms_version,doc_url`);
    const rows = (r.status < 300 && Array.isArray(r.data)) ? r.data : [];

    const skus = SKUS.map((sku) => {
      const own = rows.find((x) => x.plan_sku === sku && x.org_id === orgId) || null;
      const gen = rows.find((x) => x.plan_sku === sku && x.org_id == null) || null;
      const pick = (row) => row ? { terms_version: row.terms_version, doc_url: row.doc_url || null } : null;
      const effective = own
        ? { terms_version: own.terms_version, doc_url: own.doc_url || null, source: 'dealer' }
        : (gen ? { terms_version: gen.terms_version, doc_url: gen.doc_url || null, source: 'generic' } : null);
      return { plan_sku: sku, override: pick(own), generic: pick(gen), effective };
    });
    return json(200, { skus });
  }

  if (req.method === 'POST') {
    let body = null; try { body = await req.json(); } catch { /* → 400 abajo */ }
    const orgId = body && typeof body.org_id === 'string' ? body.org_id : null;
    if (!orgId) return json(400, { error: 'org_id_required' });
    const sku = body && typeof body.plan_sku === 'string' ? body.plan_sku : null;
    if (!sku || !SKUS.includes(sku)) return json(400, { error: 'bad_sku' });

    const dealer = await dealerOf(env, orgId);
    if (!dealer) return json(404, { error: 'not_found' });

    const filter = `/plan_terms?org_id=eq.${encodeURIComponent(orgId)}&plan_sku=eq.${encodeURIComponent(sku)}`;

    /* ── clear: la fila del dealer se desactiva (no se borra) → cae a la genérica ── */
    if (body.action === 'clear') {
      await pgrest(env, filter, { method: 'PATCH', prefer: 'return=minimal', body: { active: false } });
      await writeAudit(env, auditRow({
        actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
        category: 'Change', action: 'plan_terms_cleared', target: dealer.name,
        details: `sku ${sku} → generic`, org_id: orgId
      }));
      return json(200, { cleared: true, plan_sku: sku });
    }

    /* ── save: upsert de la fila del dealer ── */
    const tv = typeof body.terms_version === 'string' ? body.terms_version.trim() : '';
    if (!tv || tv.length > 60) return json(400, { error: 'bad_terms_version' });
    const docUrl = (typeof body.doc_url === 'string' && body.doc_url.trim()) ? body.doc_url.trim().slice(0, 300) : null;

    /* PATCH por (org_id, plan_sku); si no existía (0 filas) → INSERT. active=true reactiva un clear previo. */
    const upd = await pgrest(env, filter, { method: 'PATCH', prefer: 'return=representation', body: { terms_version: tv, doc_url: docUrl, active: true } });
    const hit = (upd.status < 300 && Array.isArray(upd.data) && upd.data.length) ? upd.data[0] : null;
    if (!hit) {
      const ins = await pgrest(env, '/plan_terms', {
        method: 'POST', prefer: 'return=minimal',
        body: { org_id: orgId, plan_sku: sku, terms_version: tv, doc_url: docUrl, active: true }
      });
      if (ins.status >= 300) { console.error('[portal-plan-terms] insert status', ins.status); return json(502, { error: 'upstream' }); }
    }
    await writeAudit(env, auditRow({
      actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
      category: 'Change', action: 'plan_terms_updated', target: dealer.name,
      details: `sku ${sku} → ${tv}`, org_id: orgId
    }));
    return json(200, { saved: true, plan_sku: sku, terms_version: tv });
  }

  return json(405, { error: 'method_not_allowed' });
}
