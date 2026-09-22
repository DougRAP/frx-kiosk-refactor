/* ============================================================================
 * GET /p/:code  →  302 a la Stripe Checkout Session (KIOSK-16).
 * ----------------------------------------------------------------------------
 * El fallback TECLEABLE del QR del kiosk: el asociado dicta "furniturerx punto
 * net barra p barra CODIGO" y el teléfono aterriza en el mismo checkout que el
 * QR. netlify.toml (y kiosk/netlify.toml, proxy) reescriben /p/* →
 * /.netlify/functions/pay-redirect?code=:splat.
 *
 * - vigente   → 302 Location: stripe_url (+ marca opened_at la PRIMERA vez:
 *               señal "el cliente ya abrió la página de pago" para la espera C7)
 * - expirado  → 410 con página HTML amable
 * - inexistente/malformado → 404 misma página (sin oráculo de validez)
 * Sin cache en todas las respuestas; el código viaja en la URL, nunca se loguea
 * la stripe_url.
 * ==========================================================================*/

'use strict';

import { pgrest } from './_lib/supabase.mjs';
import { normalizeShortCode } from './_lib/shortcode.mjs';

function page(status, title, msg) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>'
    + '<style>body{font-family:Inter,system-ui,Arial,sans-serif;max-width:420px;margin:15vh auto 0;padding:0 20px;color:#0e1418;line-height:1.55}h1{font-size:1.2rem}p{color:#4a5560}</style>'
    + '</head><body><h1>' + title + '</h1><p>' + msg + '</p></body></html>';
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
  });
}
const notFound = () => page(404, 'Payment link not found',
  'Check the code and try again, or ask the store associate to start a new sale.');

export default async function handler(req) {
  if (req.method !== 'GET') return page(405, 'Method not allowed', 'This link only supports GET.');

  const code = normalizeShortCode(new URL(req.url).searchParams.get('code'));
  if (!code) return notFound();

  let row = null;
  try {
    const { status, data } = await pgrest(process.env,
      `/pay_links?code=eq.${code}&select=stripe_url,expires_at,opened_at&limit=1`);
    if (status < 300 && Array.isArray(data) && data[0]) row = data[0];
  } catch (err) {
    console.error('[pay-redirect] lookup:', err.message);
    return page(502, 'Something went wrong', 'Please try again in a moment.');
  }
  if (!row || !row.stripe_url) return notFound();
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return page(410, 'This payment link expired', 'Ask the store associate to start a new sale.');
  }

  if (!row.opened_at) {   /* primera apertura → señal para la pantalla de espera (C7). Fail-soft. */
    try {
      await pgrest(process.env, `/pay_links?code=eq.${code}&opened_at=is.null`, {
        method: 'PATCH', prefer: 'return=minimal', body: { opened_at: new Date().toISOString() }
      });
    } catch { /* best-effort */ }
  }

  return new Response(null, {
    status: 302,
    headers: { Location: row.stripe_url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
  });
}
