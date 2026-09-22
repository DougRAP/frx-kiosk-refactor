/* ============================================================================
 * _lib/token.mjs — token de acceso al dashboard SIN login (link hasheado simple).
 *
 * Token = base64url(JSON{e,exp}) + "." + base64url(HMAC-SHA256(payload, secret)).
 *   · `e`   = email (lowercased) del cliente
 *   · `exp` = epoch (segundos) de expiración (default 14 días — C4: link de acceso a PII)
 * STATELESS: no toca la DB. Inadivinable: nadie puede forjar el token de otro
 * email sin el secret (DASHBOARD_LINK_SECRET). Revocable: rotando el secret.
 * Comparación de firma timing-safe. Date.now() es válido aquí (función Node).
 * ==========================================================================*/

'use strict';

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload, secret) => b64url(createHmac('sha256', secret).update(payload).digest());

export function signAccountToken(email, secret, ttlDays = 14) {
  if (!secret) throw new Error('missing DASHBOARD_LINK_SECRET');
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const payload = b64url(JSON.stringify({ e: String(email || '').trim().toLowerCase(), exp }));
  return payload + '.' + sign(payload, secret);
}

/* Devuelve { email, exp } si el token es válido y NO expiró; null si no. */
export function verifyAccountToken(token, secret) {
  if (!secret || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;   // firma inválida

  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!obj || typeof obj.e !== 'string' || typeof obj.exp !== 'number') return null;
  if (obj.exp < Math.floor(Date.now() / 1000)) return null;          // expirado

  return { email: obj.e, exp: obj.exp };
}

/* ----------------------------------------------------------------------------
 * Token EFÍMERO del kiosk-handoff (single-QR): liga la fila `kiosk_handoffs` por id.
 * Mismo esquema HMAC-SHA256 timing-safe, pero TTL corto (default 15 min) y payload
 * `{h:id, exp}`. El QR lleva SOLO este token opaco (sin PII). Reusa sign/b64url.
 * -------------------------------------------------------------------------- */
export function signHandoffToken(id, secret, ttlMin = 15) {
  if (!secret) throw new Error('missing DASHBOARD_LINK_SECRET');
  const exp = Math.floor(Date.now() / 1000) + ttlMin * 60;
  const payload = b64url(JSON.stringify({ h: String(id || ''), exp }));
  return payload + '.' + sign(payload, secret);
}

/* Devuelve { id, exp } si el token es válido y NO expiró; null si no. */
export function verifyHandoffToken(token, secret) {
  if (!secret || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;   // firma inválida

  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!obj || typeof obj.h !== 'string' || typeof obj.exp !== 'number') return null;
  if (obj.exp < Math.floor(Date.now() / 1000)) return null;          // expirado

  return { id: obj.h, exp: obj.exp };
}
