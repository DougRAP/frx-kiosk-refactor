/* ============================================================================
 * GET /.netlify/functions/portal-subscribers — lista de suscriptores (PORT-5).
 * Scoped por org (readOrgScope): org/sub ven SOLO su org; admin filtra o ve all.
 * 🔒 El filtro dealer_id sale del TOKEN (readOrgScope), nunca de un param como grant.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, mapSubscriberRow, excludedOrgIds, rollupExclusion, PortalError } from './_lib/portal.mjs';
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
    rs = readOrgScope(scope, new URL(req.url).searchParams.get('org_id'));
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-subscribers] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  let q = '/subscriptions?kind=eq.protection'
    + '&select=id,master_no,tier,kind,status,started_at,canceled_at,sub_entity_id,sales_associate,profiles(full_name,email),sub_entities(name)'
    + '&order=started_at.desc&limit=5000';   // PORT-21: el front pagina a 50; 250 truncaba dealers grandes
  if (!rs.all) q += `&dealer_id=eq.${encodeURIComponent(rs.orgId)}`;
  else q += rollupExclusion('dealer_id', await excludedOrgIds(env));   // PORT-21

  let result;
  try { result = await pgrest(env, q); } catch (err) { console.error('[portal-subscribers] pgrest:', err.message); return json(502, { error: 'upstream' }); }
  if (result.status >= 300) return json(502, { error: 'upstream' });

  const now = Date.now();
  const rows = (Array.isArray(result.data) ? result.data : []).map((r) => mapSubscriberRow(r, now));

  /* PORT-24C: enciende la columna SR de Subscribers (Tanda B) con data REAL — masters con un SR
   * abierto. Fail-soft: un hipo aquí no rompe la lista (las filas quedan sin sr_status). */
  try {
    let sq = '/service_requests?status=eq.open&select=contract_number&limit=20000';
    if (!rs.all) sq += `&org_id=eq.${encodeURIComponent(rs.orgId)}`;
    const sr = await pgrest(env, sq);
    if (sr.status < 300 && Array.isArray(sr.data)) {
      const openMasters = new Set(sr.data.map((s) => String(s.contract_number || '').replace(/-\d{1,2}$/, '')));
      for (const row of rows) {
        const master = String(row.contract_number || '').replace(/-\d{1,2}$/, '');
        if (master && openMasters.has(master)) row.sr_status = 'open';
      }
    }
  } catch (err) { console.warn('[portal-subscribers] sr:', err.message); }

  return json(200, { rows, total: rows.length });
}
