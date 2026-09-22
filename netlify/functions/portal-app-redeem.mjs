/* ============================================================================
 * POST /.netlify/functions/portal-app-redeem — PORT-10 (SSO portal→kiosk), mitad 2.
 * Canjea el handoff one-time por una SESIÓN de kiosk (kind:'session', TTL 12h).
 * Single-use race-safe: el PATCH lleva guard redeemed_at=is.null (dos taps
 * concurrentes → solo uno gana; patrón updateHandoff). El kiosk guarda el token
 * de sesión y lo manda como body.kiosk_session en el checkout → método A.
 * PÚBLICO: el token ES la credencial (random 32B, la BD solo tiene el hash).
 * ==========================================================================*/

'use strict';

import { newToken, hashToken } from './_lib/referral.mjs';
import { pgrest } from './_lib/supabase.mjs';

const SESSION_TTL_MS = 12 * 3600 * 1000;

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let body = null;
  try { body = await req.json(); } catch { /* → 400 abajo */ }
  const token = body && typeof body.token === 'string' && body.token.length <= 256 ? body.token : null;
  if (!token) return json(400, { error: 'token_required' });

  try {
    /* Canje single-use: PATCH con guards (kind, vigencia, no-canjeado). 0 filas = inválido/usado/vencido. */
    const nowIso = new Date().toISOString();
    const q = `/kiosk_sessions?token_hash=eq.${encodeURIComponent(hashToken(token))}`
      + `&kind=eq.handoff&redeemed_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`;
    const upd = await pgrest(env, q, {
      method: 'PATCH', prefer: 'return=representation', body: { redeemed_at: nowIso }
    });
    const handoff = (upd.status < 300 && Array.isArray(upd.data) && upd.data[0]) || null;
    if (!handoff) return json(401, { error: 'invalid_token' });

    const session = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const ins = await pgrest(env, '/kiosk_sessions', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        kind: 'session', token_hash: hashToken(session),
        org_id: handoff.org_id, org_name: handoff.org_name || null,
        portal_user_id: handoff.portal_user_id || null,
        sales_mode: !!handoff.sales_mode,           // KIOSK-22: el kiosk oculta el link Dashboard
        return_url: handoff.return_url || null,     // KIOSK-23: return button to the dealer's site
        return_label: handoff.return_label || null, // KIOSK-23b: button label
        expires_at: expiresAt
      }
    });
    if (ins.status >= 300) { console.error('[portal-app-redeem] session insert status', ins.status); return json(502, { error: 'upstream' }); }

    /* Purga oportunista de filas vencidas (efímeras; patrón purgeExpiredHandoffs). */
    if (Math.random() < 0.05) {
      try {
        await pgrest(env, `/kiosk_sessions?expires_at=lt.${encodeURIComponent(nowIso)}`, {
          method: 'DELETE', prefer: 'return=minimal'
        });
      } catch { /* best-effort */ }
    }

    return json(200, { session, org_id: handoff.org_id, org_name: handoff.org_name || null, sales_mode: !!handoff.sales_mode, return_url: handoff.return_url || null, return_label: handoff.return_label || null, expires_at: expiresAt });
  } catch (err) {
    console.error('[portal-app-redeem]', err.message);
    return json(502, { error: 'upstream' });
  }
}
