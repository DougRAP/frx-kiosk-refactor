/* ============================================================================
 * GET /.netlify/functions/portal-resellers?world=retailer|technician — PORT-1.
 * ----------------------------------------------------------------------------
 * Powers el dropdown "Viewing" del admin (API-CONTRACT §2). SOLO admin
 * (assertAdmin LANZA 403). Devuelve las orgs (dealers) del world pedido como
 * claves NEUTRALES { org_id, org_name }.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, PortalError } from './_lib/portal.mjs';
import { pgrest } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private, must-revalidate' }
  });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let ctx;
  try {
    ctx = await requirePortalUser(req, env);
    assertAdmin(ctx.scope);          // no-admin → 403, la frontera vive aquí
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-resellers] auth failed:', err.message);
    return json(500, { error: 'auth_error' });
  }

  const url = new URL(req.url);
  const world = url.searchParams.get('world') === 'technician' ? 'technician' : 'retailer';

  let result;
  try {
    result = await pgrest(env, `/dealers?world=eq.${world}&select=id,name,alpha_code&order=name.asc`);
  } catch (err) {
    console.error('[portal-resellers] pgrest failed:', err.message);
    return json(502, { error: 'upstream' });
  }
  if (result.status >= 300) return json(502, { error: 'upstream' });

  const rows = (Array.isArray(result.data) ? result.data : []).map((d) => ({ org_id: d.id, org_name: d.name, alpha_code: d.alpha_code || null }));   // DEAL-1: el dropdown rotula "BLS · Nombre"
  return json(200, { rows, total: rows.length });
}
