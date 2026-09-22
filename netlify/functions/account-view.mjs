/* ============================================================================
 * GET /.netlify/functions/account-view?t=<token>
 * ----------------------------------------------------------------------------
 * Dashboard SIN login: valida el token hasheado (firmado, expira) → resuelve el
 * email → devuelve datos REALES del cliente (perfil + planes + coverage summary
 * + kits) para que account.html los pinte. Todo server-side con service_role.
 *
 * 🔒 El token (HMAC) es la única autorización. NUNCA se acepta un email crudo:
 * sin token válido → 401. service_role BYPASSA RLS, así que cada query filtra
 * por el email/user_id del token; un olvido del filtro expondría toda la BD.
 * ==========================================================================*/

'use strict';

import { buildAccountView } from './_lib/account.mjs';
import { verifyAccountToken } from './_lib/token.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private, must-revalidate' }
  });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  const secret = env.DASHBOARD_LINK_SECRET;
  const claims = verifyAccountToken(token, secret);
  if (!claims) return json(401, { error: 'invalid_or_expired_link' });

  /* AUTH-1: el armado de la vista vive en _lib/account.mjs (compartido con account-me). */
  try {
    return json(200, await buildAccountView(env, claims.email));
  } catch (err) {
    console.error('[account-view] error:', err.message);
    return json(502, { error: 'upstream' });
  }
}
