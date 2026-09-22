/* ============================================================================
 * _lib/referral.mjs — PORT-9/9b/4b/10: atribución A/B + plan_terms + tokens de kiosk.
 * Canon 15-jul (Doug): la comisión se atribuye por EXACTAMENTE dos vías:
 *   A) venta desde kiosk con SESIÓN (dealer del token, jamás de un org_id del body:
 *      un org_id forjado robaría comisiones);
 *   B) referral code tecleado en el cart (igual en kiosk/tech/D2C).
 * Hashed URL descartado por Doug ("too much for now"). Decisión Adrian 15-jul:
 * código de dealer APAGADO = inválido → la venta SIGUE sin atribución.
 *
 * Todo lo de aquí es PURO salvo resolveAttribution (que consulta BD) — los puros
 * se testean en circuit.test.mjs sin stubs.
 * ==========================================================================*/

'use strict';

import { createHash, randomBytes } from 'node:crypto';
import { pgrest } from './supabase.mjs';
import { dealerCanSell } from './portal.mjs';

/* ---- método B: referral codes ---- */

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,22}[A-Z0-9]$/;

/* Normaliza lo que el cliente tecleó: trim + upper. Inválido → null (se IGNORA, jamás 400). */
export function normalizeReferralCode(v) {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

/* Genera un código server-side: PREFIJO del org (3 letras, fallback RAP) + 4 random
 * de un alfabeto sin ambiguos (sin 0/O/1/I). Unicidad la garantiza el UNIQUE de la tabla
 * (el caller reintenta ante 409). */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function generateReferralCode(orgName) {
  const letters = String(orgName || '').toUpperCase().replace(/[^A-Z]/g, '');
  const prefix = letters.slice(0, 3) || 'RAP';
  const bytes = randomBytes(4);
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}-${suffix}`;
}

/* Atribución del método B. Código inactivo o dealer no-vendible → null (venta sigue). */
export function referralAttribution(codeRow, dealerRow, nowMs) {
  if (!codeRow || codeRow.active !== true || !dealerRow) return null;
  if (!dealerCanSell(dealerRow, nowMs).ok) return null;      // dealer apagado/fuera de ventana → código inválido
  return { dealer_id: codeRow.org_id, source: 'referral_code', code: codeRow.code };
}

/* ---- método A: sesión de kiosk (PORT-10) ---- */

/* sha256 hex — la BD solo guarda el hash del token (kiosk_sessions.token_hash). */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function newToken() { return randomBytes(32).toString('base64url'); }

/* Atribución del método A desde una fila de kiosk_sessions. Solo kind 'session' viva. */
export function sessionAttribution(row, nowMs) {
  if (!row || row.kind !== 'session' || !row.org_id) return null;
  const exp = Date.parse(row.expires_at || '');
  if (!Number.isFinite(exp) || exp <= nowMs) return null;
  return { dealer_id: row.org_id, source: 'kiosk_session' };
}

/* ---- PORT-4b: qué versión de T&C corresponde a (dealer, sku) ---- */

/* Fila del dealer GANA; sin ella (o inactiva) cae a la genérica (org_id null). */
export function termsFor(rows, orgId, sku) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r.plan_sku === sku && r.active !== false);
  const own = orgId ? list.find((r) => r.org_id === orgId) : null;
  const generic = list.find((r) => r.org_id == null);
  const hit = own || generic;
  return hit ? { terms_version: hit.terms_version, doc_url: hit.doc_url || null } : null;
}

/* ---- PORT-19C: métricas por código para la pantalla del mock (PURO) ----
 * Uses = checkouts iniciados con el código (leads); Attributed subs = suscripciones
 * nacidas con él; Credit earned = comisión total (cash + reinsurance) del ledger de
 * ESAS suscripciones. Todo data real, cero estimaciones. */
export function referralStats(codes, leadCodes, subs, ledger) {
  const credit = {};
  for (const l of ledger || []) {
    credit[l.stripe_subscription_id] = (credit[l.stripe_subscription_id] || 0)
      + (l.stripe_amount_cents | 0) + (l.reinsurance_amount_cents | 0);
  }
  const out = {};
  for (const c of codes || []) out[c] = { uses: 0, attributed: 0, credit_cents: 0 };
  for (const lc of leadCodes || []) if (out[lc]) out[lc].uses++;
  for (const s of subs || []) {
    const st = out[s.referral_code];
    if (!st) continue;
    st.attributed++;
    st.credit_cents += credit[s.stripe_subscription_id] || 0;
  }
  return out;
}

/* ---- resolución completa en el checkout (única pieza con BD) ----
 * Precedencia A sobre B. TODO es fail-soft: un hipo de BD jamás bloquea la venta
 * (mismo criterio que el rate-limit); simplemente no atribuye. Devuelve
 * { dealer_id, source, code? } | null. */
export async function resolveAttribution(env, { kioskSessionToken, referralCodeRaw }, nowMs) {
  const now = nowMs || Date.now();

  if (kioskSessionToken && typeof kioskSessionToken === 'string' && kioskSessionToken.length <= 256) {
    try {
      const h = hashToken(kioskSessionToken);
      const r = await pgrest(env, `/kiosk_sessions?token_hash=eq.${encodeURIComponent(h)}&kind=eq.session&select=kind,org_id,org_name,expires_at&limit=1`);
      const row = (r.status < 300 && Array.isArray(r.data) && r.data[0]) || null;
      const a = sessionAttribution(row, now);
      if (a) return a;
    } catch (err) { console.warn('[attr] session fail-soft:', err.message); }
  }

  const code = normalizeReferralCode(referralCodeRaw);
  if (code) {
    try {
      const r = await pgrest(env, `/referral_codes?code=eq.${encodeURIComponent(code)}&select=code,org_id,active&limit=1`);
      const codeRow = (r.status < 300 && Array.isArray(r.data) && r.data[0]) || null;
      if (codeRow) {
        const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(codeRow.org_id)}&select=id,selling_enabled,access_start,access_end&limit=1`);
        const dealerRow = (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
        const a = referralAttribution(codeRow, dealerRow, now);
        if (a) return a;
      }
    } catch (err) { console.warn('[attr] code fail-soft:', err.message); }
  }
  return null;
}
