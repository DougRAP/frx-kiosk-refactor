/* ============================================================================
 * GET /s/:code  →  302 al kiosk en modo venta (KIOSK-22).
 * ----------------------------------------------------------------------------
 * El link permanente por dealer (bookmark + QR). En cada visita se acuña un
 * handoff ONE-TIME (kind:'handoff', sales_mode=true, TTL 120s; solo el hash en la
 * BD) y se redirige a `{kiosk}?pt=<token>`. El kiosk lo canjea con el redeem del
 * SSO (portal-app-redeem) → sesión 12h + badge "Selling as", con el link Dashboard
 * OCULTO (sales_mode). Atribución método A (el dealer sale del token).
 * No hay bearer estático en la URL: el ?pt= es one-time y expira en 120s.
 * netlify.toml reescribe /s/* → /.netlify/functions/sales-mode-redirect?code=:splat.
 * ==========================================================================*/

'use strict';

import { pgrest } from './_lib/supabase.mjs';
import { normalizeShortCode } from './_lib/shortcode.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { newToken, hashToken } from './_lib/referral.mjs';
import { appUrlFor } from './_lib/portal.mjs';

const HANDOFF_TTL_MS = 120 * 1000;

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
const notFound = () => page(404, 'Sales link not found',
  'Check the link, or ask an administrator to generate a new sales-mode link.');

export default async function handler(req) {
  if (req.method !== 'GET') return page(405, 'Method not allowed', 'This link only supports GET.');
  const env = process.env;

  const code = normalizeShortCode(new URL(req.url).searchParams.get('code'));
  if (!code) return notFound();

  /* Anti-adivinación de codes (fail-open: un hipo del limiter no bloquea la venta). */
  try {
    const rl = await checkRate(env, { prefix: 'salesmode', ip: clientIp(req), limit: 30, windowSec: 60 });
    if (!rl.allowed) return page(429, 'Too many requests', 'Please wait a moment and try again.');
  } catch { /* fail-open */ }

  let link = null;
  try {
    const { status, data } = await pgrest(env,
      `/sales_mode_links?code=eq.${encodeURIComponent(code)}&active=is.true&select=org_id,org_name,return_url,return_label,dealers(world)&limit=1`);
    if (status < 300 && Array.isArray(data) && data[0]) link = data[0];
  } catch (err) {
    console.error('[sales-mode-redirect] lookup:', err.message);
    return page(502, 'Something went wrong', 'Please try again in a moment.');
  }
  if (!link) return notFound();

  const world = (link.dealers && link.dealers.world) || 'retailer';
  /* KIOSK-23: the sales link's return_url travels in the handoff. https-only
     and DB-only (never read from the client URL: open redirect). */
  const returnUrl = (typeof link.return_url === 'string' && /^https:\/\//.test(link.return_url))
    ? link.return_url : null;
  /* KIOSK-23b: button label ("Go to <label>"); plain short text. */
  const returnLabel = (typeof link.return_label === 'string' && link.return_label.trim())
    ? link.return_label.trim().slice(0, 60) : null;
  const token = newToken();
  const ins = await pgrest(env, '/kiosk_sessions', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      kind: 'handoff', token_hash: hashToken(token), sales_mode: true,
      org_id: link.org_id, org_name: link.org_name || null,
      return_url: returnUrl, return_label: returnLabel,
      expires_at: new Date(Date.now() + HANDOFF_TTL_MS).toISOString()
    }
  });
  if (ins.status >= 300) { console.error('[sales-mode-redirect] handoff insert', ins.status); return page(502, 'Something went wrong', 'Please try again in a moment.'); }

  return new Response(null, {
    status: 302,
    headers: { Location: appUrlFor(world, req) + '?pt=' + encodeURIComponent(token), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
  });
}
