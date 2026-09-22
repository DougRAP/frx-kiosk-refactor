/* ============================================================================
 * POST /.netlify/functions/portal-dealer-login-action — PORT-18 (fila Login).
 *   {org_id, email, action: 'reset' | 'invite'}
 *   reset  → GoTrue /recover (email de reset de contraseña)
 *   invite → GoTrue /invite (reenvía el invite; si ya existe cae a recovery)
 * 🔒 SOLO admin. El email va al audit (mock: "No password is stored or shown").
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, auditRow, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit, sendRecovery, inviteUser } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let ctx;
  try {
    ctx = await requirePortalUser(req, env);
    assertAdmin(ctx.scope);
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-dealer-login-action] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  let body = null;
  try { body = await req.json(); } catch { /* → 400 abajo */ }
  const orgId = body && typeof body.org_id === 'string' ? body.org_id : null;
  const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const action = body && body.action;
  if (!orgId) return json(400, { error: 'org_id_required' });
  if (!EMAIL_RE.test(email) || email.length > 200) return json(400, { error: 'email_invalid' });
  if (action !== 'reset' && action !== 'invite') return json(400, { error: 'action_invalid' });

  /* El org debe existir (el email puede ser de cualquier login del dealer). */
  const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=id,name&limit=1`);
  const dealer = (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
  if (!dealer) return json(404, { error: 'not_found' });

  const redirectTo = (env.PORTAL_URL || env.SITE_URL || '').replace(/\/$/, '') + '/portal/';
  try {
    if (action === 'reset') {
      await sendRecovery(env, email, redirectTo);
    } else {
      try {
        const r = await inviteUser(env, email, redirectTo);
        if (r && r.exists) await sendRecovery(env, email, redirectTo);   // ya tiene cuenta → recovery
      } catch (err) {
        /* invite duplicado en algunos GoTrue devuelve error genérico → recovery de cortesía */
        console.warn('[portal-dealer-login-action] invite fallback:', err.message);
        await sendRecovery(env, email, redirectTo);
      }
    }
  } catch (err) {
    console.error('[portal-dealer-login-action] gotrue:', err.message);
    return json(502, { error: 'email_failed' });
  }

  await writeAudit(env, auditRow({
    actor_id: ctx.userId, actor_name: ctx.name, actor_role: ctx.scope.role,
    category: 'Access', action: action === 'reset' ? 'password_reset_sent' : 'invite_resent',
    target: email, details: `dealer ${dealer.name}`, org_id: orgId
  }));
  return json(200, { sent: true });
}
