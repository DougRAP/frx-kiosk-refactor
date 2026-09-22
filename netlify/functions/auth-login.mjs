/* ============================================================================
 * POST /api/auth-login — login con email + contraseña (AUTH-1).
 * ----------------------------------------------------------------------------
 * GoTrue `/token?grant_type=password` SERVER-SIDE (el browser no tiene llave de
 * Supabase). Éxito → { access_token, refresh_token, expires_at }.
 * 🔒 Fallo UNIFORME: password mala, email inexistente o malformado devuelven el
 * MISMO 401 {error:'invalid_credentials'} — sin oráculo de qué cuentas existen.
 * ==========================================================================*/

'use strict';

import { EMAIL_RE, canonicalEmail } from './_lib/validate.mjs';
import { gotrue } from './_lib/supabase.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { tempPasswordExpired } from './_lib/temppw.mjs';

const MAX_BODY_BYTES = 1024;

const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
});
const uniform = () => json(401, { error: 'invalid_credentials' });

/* Sesión mínima para el browser: nunca re-emitimos el objeto user de GoTrue. */
export function sessionPayload(data) {
  const out = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600)
  };
  /* AUTH-2: la cuenta nació con contraseña temporal (webhook) → el front fuerza el
   * cambio ANTES de entrar. Aplica igual al login por password y al OTP (comparten esto). */
  if (data.user && data.user.user_metadata && data.user.user_metadata.must_change_password === true) {
    out.must_change_password = true;
  }
  return out;
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  const rl = await checkRate(env, { prefix: 'auth-login', ip: clientIp(req), limit: 5, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const email = canonicalEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  /* Entrada inválida → el MISMO uniforme (no revelamos qué parte falló). */
  if (!email || !EMAIL_RE.test(email) || !password || password.length > 200) return uniform();

  /* SEC-2: segundo bucket por CUENTA, encima del de IP. Sin él, 5 intentos/min por IP
   * se convierten en miles contra la misma cuenta repartiendo el ataque entre IPs
   * (credential stuffing). Va DESPUÉS de validar el email para no contar basura, y
   * el email es el canónico → no se evade cambiando mayúsculas o espacios.
   * 20/15min: un humano nunca lo toca, y quien quiera agotarlo para dejar fuera a la
   * víctima paga además el límite por IP. Spec: misc/spec-sec2-ratelimit.md §4b. */
  const rlUser = await checkRate(env, { prefix: 'auth-login-u', subject: email, limit: 20, windowSec: 900 });
  if (!rlUser.allowed) return json(429, { error: 'rate_limited', retry_after: rlUser.retryAfter }, { 'Retry-After': String(rlUser.retryAfter) });

  try {
    const { status, data } = await gotrue(env, '/token', {
      method: 'POST', query: { grant_type: 'password' }, body: { email, password }
    });
    if (status === 200 && data && data.access_token) {
      /* SEC-3a: la contraseña temporal del welcome CADUCA (TEMP_PASSWORD_TTL_DAYS, 7 por
       * defecto). Pasada la ventana no se emite sesión: el correo de bienvenida deja de ser
       * una credencial permanente en el buzón. El cliente NO queda sin acceso — el mensaje
       * del front ya ofrece el código de un solo uso, y auth-otp sigue intacto a propósito
       * (prueba de posesión del buzón) y le lleva a la pantalla de cambio.
       * Se responde 401 como cualquier otro fallo, con código propio solo para dejar rastro
       * en el server; no es un oráculo: para llegar aquí hay que ACERTAR la temporal. */
      if (tempPasswordExpired(data.user, env)) {
        console.warn('[auth-login] contraseña temporal caducada');   // nunca el email
        return json(401, { error: 'temp_password_expired' });
      }
      return json(200, sessionPayload(data));
    }
  } catch (err) {
    console.warn('[auth-login]', err.message);   // nunca el email ni la password
  }
  return uniform();
}
