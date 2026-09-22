/* ============================================================================
 * POST /api/update-profile — "Edit details" del dashboard (item 6, spec 08-jul §C6).
 * ----------------------------------------------------------------------------
 * PATCH parcial de profiles (full_name / phone / address) autenticado por el
 * Bearer del usuario. EMAIL NO EDITABLE: es la identidad de la cuenta (índice
 * de profiles, matching de leads, login) — cambiarlo sería otra feature con
 * verificación propia, no un edit de perfil.
 *
 * Campos OPCIONALES (al menos uno). Semántica de limpieza: '' → null (borra el
 * valor); un valor con contenido se valida fail-closed. Tipos no-string se
 * IGNORAN como ausentes (defensivo: nunca escribir basura en profiles).
 *
 * phone: guardamos SOLO dígitos. No usamos cleanPhone de _lib/validate.mjs
 * a propósito: aquella preserva el formato original (checkout lo muestra tal
 * cual) y devuelve null tanto para vacío como para <7 dígitos — aquí vacío
 * significa LIMPIAR y <7 dígitos es ERROR, dos salidas distintas.
 * ==========================================================================*/

'use strict';

import { requireUser, AuthError } from './_lib/auth.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { pgrest } from './_lib/supabase.mjs';

const MAX_BODY_BYTES = 4096;
const NAME_MAX = 120, ADDRESS_MAX = 300, PHONE_MIN_DIGITS = 7;

const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
});

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  const rl = await checkRate(env, { prefix: 'profile', ip: clientIp(req), limit: 5, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  /* Auth ANTES de leer el body: 401 uniforme gana a cualquier error de payload. */
  let userId;
  try {
    ({ userId } = await requireUser(req, env));
  } catch (err) {
    if (err instanceof AuthError) return json(err.status || 401, { error: 'invalid_token' });
    console.warn('[update-profile] auth error:', err.message);
    return json(401, { error: 'invalid_token' });
  }

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_json' });

  /* Solo los campos PROVISTOS (y de tipo string) entran al PATCH — parcial de verdad. */
  const patch = {};

  if (typeof body.full_name === 'string') {
    const name = body.full_name.trim();
    if (name.length < 1 || name.length > NAME_MAX) return json(400, { error: 'invalid_name' });
    patch.full_name = name;
  }

  if (typeof body.phone === 'string') {
    const digits = body.phone.replace(/\D/g, '');   // solo dígitos: canónico en profiles
    if (!digits) patch.phone = null;                // '' (o sin dígitos) → limpiar
    else if (digits.length < PHONE_MIN_DIGITS) return json(400, { error: 'invalid_phone' });
    else patch.phone = digits;
  }

  if (typeof body.address === 'string') {
    const address = body.address.trim();
    if (address.length > ADDRESS_MAX) return json(400, { error: 'invalid_address' });
    patch.address = address || null;                // '' → limpiar
  }

  if (Object.keys(patch).length === 0) return json(400, { error: 'nothing_to_update' });

  const { status } = await pgrest(env, '/profiles?id=eq.' + encodeURIComponent(userId), {
    method: 'PATCH', prefer: 'return=minimal', body: patch
  });
  if (status >= 300) {
    console.warn('[update-profile] profiles PATCH failed (status', status + ')');
    return json(500, { error: 'update_failed' });
  }

  return json(200, { ok: true });
}
