/* ============================================================================
 * GET /api/account-me — la vista de cuenta para el usuario LOGUEADO (AUTH-1).
 * ----------------------------------------------------------------------------
 * Bearer de GoTrue (Authorization) → requireUser → buildAccountView(email):
 * la MISMA forma rica que account-view (?t=), así account.html pinta ambas
 * puertas con un solo render(). get-my-account (forma plana) queda intacto
 * para dashboard.html.
 * ==========================================================================*/

'use strict';

import { requireUser, AuthError } from './_lib/auth.mjs';
import { buildAccountView } from './_lib/account.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private, must-revalidate' }
  });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let user;
  try {
    user = await requireUser(req, env);
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.code });
    console.error('[account-me] auth failed:', err.message);
    return json(500, { error: 'auth_error' });
  }

  try {
    return json(200, await buildAccountView(env, user.email));
  } catch (err) {
    console.error('[account-me] error:', err.message);
    return json(502, { error: 'upstream' });
  }
}
