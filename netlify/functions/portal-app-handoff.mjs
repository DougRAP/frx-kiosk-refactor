/* ============================================================================
 * POST /.netlify/functions/portal-app-handoff — PORT-10 (SSO portal→kiosk), mitad 1.
 * Emite un token ONE-TIME (kind:'handoff', TTL 120s; la BD guarda solo el sha256)
 * para abrir el kiosk YA identificado como el org del portal user. El kiosk lo
 * canjea en portal-app-redeem por una sesión (12h) → método A de atribución de
 * comisiones (PORT-9b): el dealer sale del TOKEN, jamás de un org_id del body.
 * Admin: pasa org_id en el body (cross-world); org/sub: SIEMPRE su propio org.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, appUrlFor, PortalError } from './_lib/portal.mjs';
import { newToken, hashToken } from './_lib/referral.mjs';
import { pgrest } from './_lib/supabase.mjs';

const HANDOFF_TTL_MS = 120 * 1000;

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let ctx, scope;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    if (!scope) return json(403, { error: 'not_portal_user' });
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-app-handoff] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  let body = null;
  try { body = await req.json(); } catch { /* opcional */ }
  /* El org efectivo: admin puede elegir; org/sub quedan CLAVADOS a su org del token. */
  const orgId = scope.isAdmin
    ? (body && typeof body.org_id === 'string' ? body.org_id : null)
    : scope.org_id;
  if (!orgId) return json(400, { error: 'org_id_required' });

  const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name,world&limit=1`);
  const dealer = (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
  if (!dealer) return json(404, { error: 'not_found' });

  const token = newToken();
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS).toISOString();
  const ins = await pgrest(env, '/kiosk_sessions', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      kind: 'handoff', token_hash: hashToken(token),
      org_id: orgId, org_name: dealer.name, portal_user_id: ctx.userId,
      expires_at: expiresAt
    }
  });
  if (ins.status >= 300) { console.error('[portal-app-handoff] insert status', ins.status); return json(502, { error: 'upstream' }); }

  const base = appUrlFor(dealer.world || scope.world || 'retailer', req);   // dev-aware (localhost en netlify dev)
  return json(200, { url: `${base}?pt=${encodeURIComponent(token)}`, expires_at: expiresAt });
}
