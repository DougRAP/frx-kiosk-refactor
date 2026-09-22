/* ============================================================================
 * POST /api/auth-set-password — fija/cambia la contraseña del usuario (AUTH-1).
 * ----------------------------------------------------------------------------
 * Usos: aterrizaje del INVITE post-compra (hash de GoTrue), "Change password"
 * con sesión viva, y el cierre del flujo forgot-password (OTP → aquí).
 * Recibe { access_token, password } → GoTrue PUT /user con ESE bearer (la
 * autorización es el propio token del usuario; el server solo hace de proxy
 * porque el browser no tiene llave de Supabase).
 * ==========================================================================*/

'use strict';

import { gotrue } from './_lib/supabase.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';

const MAX_BODY_BYTES = 4096;   // el access_token es un JWT (~1KB)
const PW_MIN = 8, PW_MAX = 72;

const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
});

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  const rl = await checkRate(env, { prefix: 'setpw', ip: clientIp(req), limit: 5, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const token = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!token) return json(401, { error: 'set_password_failed' });
  if (password.length < PW_MIN || password.length > PW_MAX) return json(400, { error: 'weak_password' });

  try {
    /* AUTH-2: al fijar password se APAGA must_change_password (GoTrue mergea user_metadata).
     * Inofensivo cuando el flag no existía (change password normal, invite, forgot). */
    const { status, data } = await gotrue(env, '/user', {
      method: 'PUT', bearer: token, body: { password, data: { must_change_password: false } }
    });
    if (status === 200 && data && data.id) return json(200, { ok: true });
  } catch (err) {
    console.warn('[auth-set-password]', err.message);
  }
  return json(401, { error: 'set_password_failed' });
}
