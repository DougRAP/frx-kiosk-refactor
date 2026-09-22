/* ============================================================================
 * POST /.netlify/functions/create-lead
 * ----------------------------------------------------------------------------
 * Inserta un lead con service_role tras validar y recalcular el precio server-side.
 *
 * NOTA: el CHECKOUT ya NO usa este endpoint (pasó a create-checkout-session, que crea
 * el lead + la Stripe Session en una sola llamada). Se mantiene como endpoint
 * reservado para futuros leads (chat / "email your build"). Los futuros leads deben
 * ir SIEMPRE por una Function (service_role), nunca por el navegador.
 *
 * Sin dependencias: fetch global (Node 18+). Credenciales solo por env var.
 * ==========================================================================*/

'use strict';

import { validateCheckout } from './_lib/validate.mjs';
import { insertLead } from './_lib/supabase.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';

const MAX_BODY_BYTES = 4096;

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const rl = await checkRate(process.env, { prefix: 'lead', ip: clientIp(req), limit: 5, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  const ctype = req.headers.get('content-type') || '';
  if (!ctype.includes('application/json')) return json(415, { error: 'unsupported_media_type' });

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const v = validateCheckout(body);
  if (!v.ok) return json(400, { error: v.error });

  try {
    const id = await insertLead(process.env, v.fields);
    return json(200, { id });
  } catch (err) {
    console.error('[create-lead]', err.message);
    return json(502, { error: 'upstream' });
  }
}
