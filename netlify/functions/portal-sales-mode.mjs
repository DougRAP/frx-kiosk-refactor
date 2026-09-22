/* ============================================================================
 * /.netlify/functions/portal-sales-mode — KIOSK-22 + PORT-28 (portal).
 *   GET  [?org_id] → link ACTIVO: { code, url, created_at } | { code:null }.
 *                    Admin DEBE nombrar el org (su vista es Dealer Admin, cross-dealer);
 *                    el dealer omite el parámetro y el server usa el org de su token.
 *   POST { org_id, action }  — ADMIN-ONLY:
 *     generate|rotate (default) → desactiva los activos + inserta uno nuevo → { code, url }.
 *     disable                   → desactiva todos los activos          → { disabled:true }.
 *
 * PORT-28: el dealer LEE su propio link/QR (lo necesita para vender: lo imprime en tienda y
 * lo abre en sus dispositivos), pero generarlo, rotarlo o apagarlo sigue siendo de RAP —
 * mismo modelo que las comisiones: el dealer ve, RAP controla. El acotado lo hace
 * readOrgScope: pedir el org AJENO devuelve 404, no 403 (no confirma que exista).
 *
 * El `code` es durable (va en /s/{code} y el QR); el resolver acuña un handoff one-time
 * por visita, así que no hay bearer estático.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, readOrgScope, shortLinkBase, auditRow, PortalError } from './_lib/portal.mjs';
import { newShortCode } from './_lib/shortcode.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}
function linkUrl(world, code, req) { return shortLinkBase(world, req) + 's/' + code; }   // /s/ vive en la raíz (dev) / dominio kiosk (prod)

async function dealerOf(env, orgId) {
  const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name,world&limit=1`);
  return (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
}

export default async function handler(req) {
  const env = process.env;

  let ctx, scope, gate = null;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    /* PORT-28: leer se acota por scope (el dealer ve el SUYO); escribir sigue admin-only. */
    if (req.method === 'GET') gate = readOrgScope(scope, new URL(req.url).searchParams.get('org_id'));
    else assertAdmin(scope);
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-sales-mode] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    /* Sin org efectivo = admin que no nombró dealer (su vista es cross-dealer, en Dealer Admin). */
    const orgId = gate.orgId;
    if (!orgId) return json(400, { error: 'org_id_required' });
    const dealer = await dealerOf(env, orgId);
    if (!dealer) return json(404, { error: 'not_found' });
    const r = await pgrest(env, `/sales_mode_links?org_id=eq.${encodeURIComponent(orgId)}&active=is.true&select=code,created_at&order=created_at.desc&limit=1`);
    const row = (r.status < 300 && Array.isArray(r.data) && r.data[0]) || null;
    if (!row) return json(200, { code: null });
    return json(200, { code: row.code, url: linkUrl(dealer.world, row.code, req), created_at: row.created_at });
  }

  if (req.method === 'POST') {
    let body = null; try { body = await req.json(); } catch { /* → 400 abajo */ }
    const orgId = body && typeof body.org_id === 'string' ? body.org_id : null;
    if (!orgId) return json(400, { error: 'org_id_required' });
    const dealer = await dealerOf(env, orgId);
    if (!dealer) return json(404, { error: 'not_found' });
    const action = (body && typeof body.action === 'string') ? body.action : 'generate';

    /* rotar y deshabilitar comparten esto: mata los activos del org (append-only + active). */
    await pgrest(env, `/sales_mode_links?org_id=eq.${encodeURIComponent(orgId)}&active=is.true`, {
      method: 'PATCH', prefer: 'return=minimal', body: { active: false }
    });

    if (action === 'disable') {
      await writeAudit(env, auditRow({
        actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
        category: 'Change', action: 'sales_mode_disabled', target: dealer.name,
        details: 'sales-mode link disabled', org_id: orgId
      }));
      return json(200, { disabled: true });
    }

    /* Unicidad por el UNIQUE de la tabla: 409 → regenerar (hasta 3 intentos). */
    for (let i = 0; i < 3; i++) {
      const code = newShortCode();
      const ins = await pgrest(env, '/sales_mode_links', {
        method: 'POST', prefer: 'return=minimal',
        body: { code, org_id: orgId, org_name: dealer.name, created_by: ctx.userId }
      });
      if (ins.status === 201) {
        await writeAudit(env, auditRow({
          actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
          category: 'Change', action: 'sales_mode_generated', target: code,
          details: `org ${dealer.name}`, org_id: orgId
        }));
        return json(200, { code, url: linkUrl(dealer.world, code, req) });
      }
      if (ins.status !== 409) { console.error('[portal-sales-mode] insert status', ins.status); return json(502, { error: 'upstream' }); }
    }
    return json(502, { error: 'code_collision' });
  }

  return json(405, { error: 'method_not_allowed' });
}
