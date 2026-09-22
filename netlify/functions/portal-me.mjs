/* ============================================================================
 * GET /.netlify/functions/portal-me — identidad del portal (PORT-1).
 * ----------------------------------------------------------------------------
 * Devuelve lo que el shell necesita: role/tier/world/org derivados del TOKEN
 * (nunca del cliente, §0). Si el usuario no es del portal (sin app_metadata.portal_role)
 * → 403 not_portal_user (un cliente normal de AUTH-2 no entra al portal).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, appUrlFor, PortalError } from './_lib/portal.mjs';
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
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-me] auth failed:', err.message);
    return json(500, { error: 'auth_error' });
  }

  const s = ctx.scope;
  if (!s) return json(403, { error: 'not_portal_user' });

  /* PORT-19D: rap_id del dealer para el hdr del mock ("Dealer ID #SHF-2048").
   * Fail-soft: sin fila o hipo de BD → null (el front cae al org_id, jamás inventa). */
  let rapId = null;
  if (s.org_id) {
    try {
      const r = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(s.org_id)}&select=rap_id&limit=1`);
      rapId = (r.status < 300 && Array.isArray(r.data) && r.data[0] && r.data[0].rap_id) || null;
    } catch (err) { console.warn('[portal-me] rap_id fail-soft:', err.message); }
  }

  return json(200, {
    rap_id: rapId,
    user_id: ctx.userId,
    email: ctx.email,
    name: ctx.name || ctx.email,
    role: s.role,
    tier: s.tier,
    world: s.world,
    org_id: s.org_id,
    org_name: s.org_name,
    sub_entity_id: s.sub_entity_id,
    sub_entity_name: s.sub_entity_name,
    app_url: appUrlFor(s.world, req),
    caps: {
      export: s.canExport, api: s.canApi, stripe: s.canStripe,
      referral_view: s.canReferralView, referral_create: s.canReferralCreate, admin: s.canAdmin
    }
  });
}
