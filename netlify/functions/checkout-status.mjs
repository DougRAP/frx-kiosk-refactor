/* ============================================================================
 * POST /.netlify/functions/checkout-status   (KIOSK-1 Fase E)
 * ----------------------------------------------------------------------------
 * El kiosk hace POLL de este endpoint mientras muestra el QR/email para saber si
 * el cliente ya pagó en su teléfono (no hay canal push hacia el kiosk).
 *
 * Recibe { session_id } (cs_...). Devuelve SOLO booleanos derivados:
 *   { done, expired }  — NUNCA el objeto crudo de Stripe (trae PII).
 *
 * Señal de éxito = `status === 'complete'` (NO payment_status), para cubrir también
 * el caso $0/bundled (payment_status:'no_payment_required'), que con 'paid' colgaría.
 *
 * Fail-soft: ante error de Stripe devuelve { done:false } (200) para que el poll del
 * kiosk no se rompa por un hipo transitorio. Rate-limit con bucket propio 'status'
 * (holgado: el poll cada 4s ≈ 15/min).
 * ==========================================================================*/

'use strict';

import { getStripe } from './_lib/stripe.mjs';
import { pgrest } from './_lib/supabase.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';

const MAX_BODY_BYTES = 512;
const SESSION_RE = /^cs_[A-Za-z0-9_]{10,80}$/;

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const env = process.env;
  /* Bucket propio holgado (el poll legítimo ≈ 15/min; no reusar 'checkout' 5/min). */
  const rl = await checkRate(env, { prefix: 'status', ip: clientIp(req), limit: 40, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  const ctype = req.headers.get('content-type') || '';
  if (!ctype.includes('application/json')) return json(415, { error: 'unsupported_media_type' });

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const sessionId = body && typeof body.session_id === 'string' ? body.session_id : '';
  if (!SESSION_RE.test(sessionId)) return json(400, { error: 'invalid_session' });   // fail-closed antes de tocar Stripe

  /* B.3 (C7 fase 2): ¿el cliente YA abrió la página de pago? pay-redirect marca
     pay_links.opened_at en el primer hit de /p/<code>; aquí solo se lee. Fail-soft:
     un hipo de la BD nunca rompe el poll (opened:false y seguimos). */
  let opened = false;
  try {
    const { status, data } = await pgrest(env,
      `/pay_links?session_id=eq.${encodeURIComponent(sessionId)}&select=opened_at&limit=1`);
    opened = status < 300 && Array.isArray(data) && !!(data[0] && data[0].opened_at);
  } catch (err) {
    console.warn('[checkout-status] pay_links:', err.message);
  }

  try {
    const s = await getStripe(env).checkout.sessions.retrieve(sessionId);
    return json(200, { done: s.status === 'complete', expired: s.status === 'expired', opened });
  } catch (err) {
    console.warn('[checkout-status]', err.message);   // sin session_id ni PII
    return json(200, { done: false, expired: false, opened });   // fail-soft: el poll sigue
  }
}
