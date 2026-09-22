/* ============================================================================
 * POST /.netlify/functions/create-checkout-session
 * ----------------------------------------------------------------------------
 * Punto de entrada del checkout D2C. Valida, luego delega el núcleo (lead +
 * Stripe Checkout Session) al helper compartido _lib/checkout.mjs — el MISMO
 * que usa el kiosk single-QR (kiosk-handoff-complete), así el origin-allowlist,
 * el return_to, el precio server-side y la metadata (lead_id) viven en un solo
 * lugar y ambos caminos alimentan idéntico al webhook.
 *
 * El lead_id se genera server-side y viaja como client_reference_id → el webhook
 * lo usa para reconciliar el pago (evita que el cliente inyecte un lead_id ajeno).
 * ==========================================================================*/

'use strict';

import { validateCheckout } from './_lib/validate.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { createCheckoutSession } from './_lib/checkout.mjs';

const MAX_BODY_BYTES = 4096;

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const rl = await checkRate(process.env, { prefix: 'checkout', ip: clientIp(req), limit: 5, windowSec: 60 });
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

  const r = await createCheckoutSession(process.env, req, { fields: v.fields, body });
  return json(r.status, r.data);
}
