/* ============================================================================
 * /.netlify/functions/portal-dealeradmin — PORT-18 (Dealer/Company Admin).
 *   GET  ?org_id → master data del reseller + sus sub_entities (Stores & Logins v1).
 *   PATCH {org_id, ...campos} → SOLO name/alpha_code/hq_address/access_start/
 *         access_end/key_contacts/selling_enabled/dashboard_enabled (whitelist;
 *         rap_id y frx_account_id NO se editan desde aquí). Audit por cada cambio.
 * 🔒 SOLO admin (assertAdmin) — es la pantalla data-roles="admin" del mock.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, auditRow, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALPHA_RE = /^[A-Z]{3}$/;

/* DEAL-1: el alpha de 3 letras es la llave con la que se identifica al dealer en el
   reporte de underwriting. Se valida aparte de la whitelist porque un valor inválido
   se RECHAZA (400) en vez de ignorarse en silencio: un "Record saved" sobre un código
   que en realidad no se guardó dejaría al dealer sin identificar en el reporte.
   Vacío = limpiar la columna (el dealer aún no tiene código asignado). */
function normAlpha(v) {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  if (!s) return null;
  return ALPHA_RE.test(s) ? s : undefined;
}

/* Whitelist del PATCH: clave → validador/normalizador (inválido → undefined = se ignora). */
const EDITABLE = {
  name: (v) => (typeof v === 'string' && v.trim() && v.length <= 120) ? v.trim() : undefined,
  hq_address: (v) => (typeof v === 'string' && v.length <= 300) ? (v.trim() || null) : undefined,
  access_start: (v) => v === null ? null : (typeof v === 'string' && DATE_RE.test(v) ? v : undefined),
  access_end: (v) => v === null ? null : (typeof v === 'string' && DATE_RE.test(v) ? v : undefined),
  key_contacts: (v) => Array.isArray(v) && v.length <= 20
    ? v.map((c) => ({
        role: String((c && c.role) || '').slice(0, 60),
        name: String((c && c.name) || '').slice(0, 120),
        email: String((c && c.email) || '').slice(0, 200),
        phone: String((c && c.phone) || '').slice(0, 40)
      }))
    : undefined,
  selling_enabled: (v) => typeof v === 'boolean' ? v : undefined,
  dashboard_enabled: (v) => typeof v === 'boolean' ? v : undefined,
  include_in_rollups: (v) => typeof v === 'boolean' ? v : undefined   // PORT-21

};

export default async function handler(req) {
  const env = process.env;

  let ctx;
  try {
    ctx = await requirePortalUser(req, env);
    assertAdmin(ctx.scope);
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-dealeradmin] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    const orgId = new URL(req.url).searchParams.get('org_id');
    if (!orgId) return json(400, { error: 'org_id_required' });
    try {
      const [dq, sq] = await Promise.all([
        pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name,world,rap_id,alpha_code,frx_account_id,hq_address,key_contacts,selling_enabled,dashboard_enabled,include_in_rollups,access_start,access_end&limit=1`),
        pgrest(env, `/sub_entities?org_id=eq.${encodeURIComponent(orgId)}&select=id,name,location,status,world&order=name.asc&limit=200`)
      ]);
      const dealer = (dq.status < 300 && Array.isArray(dq.data) && dq.data[0]) || null;
      if (!dealer) return json(404, { error: 'not_found' });
      const subs = (sq.status < 300 && Array.isArray(sq.data)) ? sq.data : [];
      return json(200, { dealer, sub_entities: subs });
    } catch (err) {
      console.error('[portal-dealeradmin] pgrest:', err.message);
      return json(502, { error: 'upstream' });
    }
  }

  if (req.method === 'PATCH') {
    let body = null;
    try { body = await req.json(); } catch { /* → 400 abajo */ }
    const orgId = body && typeof body.org_id === 'string' ? body.org_id : null;
    if (!orgId) return json(400, { error: 'org_id_required' });

    const patch = {};
    for (const [k, norm] of Object.entries(EDITABLE)) {
      if (body[k] === undefined) continue;
      const v = norm(body[k]);
      if (v !== undefined) patch[k] = v;
    }
    if (body.alpha_code !== undefined) {
      const alpha = normAlpha(body.alpha_code);
      if (alpha === undefined) return json(400, { error: 'invalid_alpha_code' });
      patch.alpha_code = alpha;
    }
    if (!Object.keys(patch).length) return json(400, { error: 'nothing_to_update' });

    try {
      const r = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name`, {
        method: 'PATCH', prefer: 'return=representation', body: patch
      });
      const row = (r.status < 300 && Array.isArray(r.data) && r.data[0]) || null;
      if (!row) return json(r.status === 404 ? 404 : 502, { error: r.status === 404 ? 'not_found' : 'update_failed' });
      await writeAudit(env, auditRow({
        actor_id: ctx.userId, actor_name: ctx.name, actor_role: ctx.scope.role,
        category: 'Change', action: 'dealer_updated', target: row.name || orgId,
        details: 'fields: ' + Object.keys(patch).join(', '), org_id: orgId
      }));
      return json(200, { updated: true, fields: Object.keys(patch) });
    } catch (err) {
      console.error('[portal-dealeradmin] patch:', err.message);
      return json(502, { error: 'upstream' });
    }
  }

  return json(405, { error: 'method_not_allowed' });
}
