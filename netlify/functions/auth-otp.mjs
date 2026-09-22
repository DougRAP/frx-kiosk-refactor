/* ============================================================================
 * POST /api/auth-otp — login sin contraseña con código de un solo uso (AUTH-1).
 * ----------------------------------------------------------------------------
 * Dos modos por forma del body (mismo endpoint, cero estado):
 *   { email }        → GoTrue /otp (create_user:false) manda el código de 6
 *                      dígitos. SIEMPRE responde {sent:true}, exista o no la
 *                      cuenta — sin oráculo. (El email sale por el Custom SMTP
 *                      de Supabase → Resend, configurado el 06-jul.)
 *   { email, code }  → GoTrue /verify (type:'email') → sesión o 401 uniforme.
 * También cubre el "forgot password": OTP → sesión → set-password.
 * ==========================================================================*/

'use strict';

import { EMAIL_RE, canonicalEmail } from './_lib/validate.mjs';
import { gotrue } from './_lib/supabase.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { sessionPayload } from './auth-login.mjs';

const MAX_BODY_BYTES = 1024;
const CODE_RE = /^\d{6,10}$/;   // la LONGITUD del OTP es config de Supabase (6 a 10): no la fijamos en código (prod llegó con 8)

const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
});

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const email = canonicalEmail(body.email);
  const isVerify = body.code !== undefined;

  /* Rate limit por modo: pedir códigos es caro (email), verificar es barato pero fuerza-bruta-able. */
  const rl = await checkRate(env, {
    prefix: isVerify ? 'otp-ver' : 'otp-req',
    ip: clientIp(req),
    limit: isVerify ? 8 : 3,
    windowSec: 60
  });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  /* SEC-2: segundo bucket por CUENTA, encima del de IP y solo con el email ya validado.
   * Verify (10/15min) le quita a la fuerza bruta del código de un solo uso la salida
   * fácil de repartirse entre IPs; request (5/15min) frena el mail bombing a la
   * dirección de una víctima. Buckets separados por modo (pedir y verificar son
   * ataques distintos). Spec: misc/spec-sec2-ratelimit.md §4b. */
  const limitByAccount = async (prefix, limit) => {
    const r = await checkRate(env, { prefix, subject: email, limit, windowSec: 900 });
    return r.allowed ? null
      : json(429, { error: 'rate_limited', retry_after: r.retryAfter }, { 'Retry-After': String(r.retryAfter) });
  };

  if (isVerify) {
    /* Verificación: código malformado → mismo 401 SIN tocar GoTrue (sin oráculo, sin round-trip). */
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!email || !EMAIL_RE.test(email) || !CODE_RE.test(code)) return json(401, { error: 'invalid_code' });
    const capped = await limitByAccount('otp-ver-u', 10);
    if (capped) return capped;
    try {
      const { status, data } = await gotrue(env, '/verify', {
        method: 'POST', body: { type: 'email', email, token: code }
      });
      if (status === 200 && data && data.access_token) return json(200, sessionPayload(data));
    } catch (err) {
      console.warn('[auth-otp] verify:', err.message);
    }
    return json(401, { error: 'invalid_code' });
  }

  /* Petición de código. redirect_to: el email trae ADEMÁS un magic link (plantilla de Supabase);
     sin destino explícito aterriza en el Site URL raíz (el D2C), cuyo head DESPOJA los tokens de la
     URL por seguridad → login perdido. Con /account.html, el link también funciona como entrada. */
  if (!email || !EMAIL_RE.test(email)) return json(400, { error: 'invalid_email' });
  const capped = await limitByAccount('otp-req-u', 5);
  if (capped) return capped;
  try {
    const accountUrl = (env.SITE_URL || '').replace(/\/+$/, '') + '/account.html';
    const { status } = await gotrue(env, '/otp', {
      method: 'POST', query: { redirect_to: accountUrl }, body: { email, create_user: false }
    });
    if (status !== 200) console.warn('[auth-otp] request status', status);   // p.ej. cuenta inexistente
  } catch (err) {
    console.warn('[auth-otp] request:', err.message);
  }
  return json(200, { sent: true });   // SIEMPRE: exista o no la cuenta
}
