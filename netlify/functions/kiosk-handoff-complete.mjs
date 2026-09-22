/* ============================================================================
 * POST /.netlify/functions/kiosk-handoff-complete
 * ----------------------------------------------------------------------------
 * El TELÉFONO toca "Pagar". Tomamos el recibo YA atado a la FILA (nunca del cliente),
 * re-validamos el config completo con requireReceipt:true (el gate del recibo lo hace
 * validateCheckout → un plan sin recibo NO crea sesión), y creamos la Stripe Checkout
 * Session por el helper COMPARTIDO (mismo camino que el D2C → el webhook reconcilia igual).
 * Idempotente: un 2º tap devuelve la misma URL (sin duplicar lead/sesión).
 * ==========================================================================*/

'use strict';

import { validateCheckout } from './_lib/validate.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { verifyHandoffToken } from './_lib/token.mjs';
import { getHandoff, updateHandoff } from './_lib/supabase.mjs';
import { createCheckoutSession } from './_lib/checkout.mjs';

const MAX_BODY_BYTES = 1024;

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...(headers || {}) } });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  const rl = await checkRate(env, { prefix: 'handoff_complete', ip: clientIp(req), limit: 5, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  const ctype = req.headers.get('content-type') || '';
  if (!ctype.includes('application/json')) return json(415, { error: 'unsupported_media_type' });
  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const v = verifyHandoffToken(body && body.token, env.DASHBOARD_LINK_SECRET);
  if (!v) return json(400, { error: 'invalid_token' });

  let row;
  try { row = await getHandoff(env, v.id); } catch { return json(502, { error: 'handoff_failed' }); }
  if (!row || (row.expires_at && new Date(row.expires_at).getTime() < Date.now())) return json(410, { error: 'expired' });

  /* Idempotencia: si ya hay sesión, devolver la misma URL (2º tap / doble submit). */
  if (row.status === 'session_created' && row.stripe_session_url) {
    return json(200, { url: row.stripe_session_url });
  }

  /* El recibo sale de la FILA (no del cliente). validateCheckout con requireReceipt:true HACE el gate:
   * un plan sin receipt_path → { error:'receipt_required' }. Y revalida precios/shape del config guardado. */
  const config = row.config || {};
  config.receipt_path = row.receipt_path || null;
  const val = validateCheckout(config, { requireReceipt: true });
  if (!val.ok) return json(400, { error: val.error });

  /* Mismo helper que el D2C. return_to '/' → el teléfono aterriza en su raíz; kiosk:true para el
   * fallback de path; deliver:'redirect' → el teléfono redirige a Stripe. Origin del teléfono en ALLOWED_ORIGINS. */
  const r = await createCheckoutSession(env, req, {
    fields: val.fields,
    /* TECH-2a: el source viaja en el config guardado del handoff (enum re-validado en trialDaysFor) */
    body: { return_to: '/', kiosk: true, deliver: 'redirect', source: config.source === 'tech' ? 'tech' : undefined }
  });
  if (r.status !== 200) return json(r.status, r.data);

  /* Guardar la sesión en la fila. Guard `status=eq.receipt_uploaded` → serializa taps concurrentes
   * (si otro tap ya la creó, este PATCH no matchea; igual devolvemos la URL recién creada). */
  try {
    await updateHandoff(env, v.id,
      { stripe_session_id: r.data.id, stripe_session_url: r.data.url, status: 'session_created' },
      'status=eq.receipt_uploaded');
  } catch (err) { console.warn('[kiosk-handoff-complete] update', err.message); }

  return json(200, { url: r.data.url });
}
