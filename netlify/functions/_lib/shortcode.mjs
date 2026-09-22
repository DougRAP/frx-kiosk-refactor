/* ============================================================================
 * _lib/shortcode.mjs — códigos cortos TECLEABLES para /p/CODIGO → 302 a Stripe.
 * (KIOSK-16) La URL bajo el QR existe para que el cliente la teclee en su
 * teléfono cuando el QR no escanea; la de Stripe (~250 chars) es intecleable.
 * Alfabeto sin ambiguos (sin 0/O, 1/I/L, B/8) y case-insensitive al resolver:
 * 8 chars ≈ 39 bits — suficiente con TTL corto y pocas ventas activas, y aún
 * dictable en voz alta. Sin acortadores de terceros.
 * ==========================================================================*/

'use strict';

import { randomBytes } from 'node:crypto';

export const CODE_ALPHABET = '23456789ACDEFGHJKMNPQRSTUVWXYZ';   // 30 chars, sin 0/O/1/I/L/B
export const CODE_LEN = 8;

/* DEAL-5: el código de onboarding de Connect NO se dicta ni se teclea — se clica
 * desde un email y vive semanas, no minutos. Los 8 chars (≈39 bits) se eligieron
 * para ser dictables con TTL corto; aquí el premio de adivinar es el alta bancaria
 * de un dealer, así que 24 chars (≈117 bits) y el adivinado deja de ser una
 * categoría de riesgo, en vez de depender solo del rate limit. */
export const ONBOARD_CODE_LEN = 24;

/* Aleatorio criptográfico SIN sesgo de módulo: rechaza bytes >= 240 (8 * 30). */
export function newCode(len = CODE_LEN) {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 240) { out += CODE_ALPHABET[b % CODE_ALPHABET.length]; if (out.length === len) break; }
    }
  }
  return out;
}
export const newShortCode = () => newCode(CODE_LEN);

/* Tolerante a cómo lo teclea un humano: mayúsculas/minúsculas, espacios y guiones.
 * Devuelve el código canónico o null si no puede ser un código válido.
 * El charset estricto es además lo que hace seguro meterlo en un filtro `eq.` de
 * PostgREST: una coma o un paréntesis sin filtrar ahí sería inyección de query. */
export function normalizeCode(raw, len = CODE_LEN) {
  if (typeof raw !== 'string') return null;
  const up = raw.toUpperCase().replace(/[\s-]/g, '');
  if (up.length !== len) return null;
  for (const c of up) if (!CODE_ALPHABET.includes(c)) return null;
  return up;
}
export const normalizeShortCode = (raw) => normalizeCode(raw, CODE_LEN);
