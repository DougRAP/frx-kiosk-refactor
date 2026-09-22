/* ============================================================================
 * POST /.netlify/functions/portal-resend-link — PORT-19B (mock línea 434):
 * el botón "Resend dashboard link" del Customer Record. Reenvía al CLIENTE el
 * link a SU dashboard (account.html con token firmado de 90d, mismo mecanismo
 * del webhook/MAIL-1). Scoped: un dealer solo puede reenviarlo para SUS
 * suscriptores (cross-tenant → 404). Deja fila de audit (sale un email con link
 * de acceso). Body: { contract } (contract# o master, con o sin -NN).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, auditRow, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';
import { signAccountToken } from './_lib/token.mjs';
import { sendEmail } from './_lib/email.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let ctx, scope, rs;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    if (!scope) return json(403, { error: 'not_portal_user' });
    rs = readOrgScope(scope, null);
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-resend-link] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  let body = null;
  try { body = await req.json(); } catch { /* → 400 */ }
  const raw = body && typeof body.contract === 'string' ? body.contract.trim() : '';
  const master = raw.replace(/-\d+$/, '');            // acepta RX-10017 o RX-10017-02
  if (!/^RX-\d+$/i.test(master)) return json(400, { error: 'invalid_contract' });
  /* PORT-24C: mismo botón-familia del mock; kind='terms' reenvía las T&C, default el dashboard. */
  const kind = body && body.kind === 'terms' ? 'terms' : 'dashboard';

  if (kind === 'dashboard' && !env.DASHBOARD_LINK_SECRET) return json(503, { error: 'not_configured' });

  try {
    const q = await pgrest(env, `/subscriptions?master_no=eq.${encodeURIComponent(master.toUpperCase())}`
      + '&kind=eq.protection&select=dealer_id,terms_version,profiles(email,full_name)&limit=1');
    const row = (q.status < 300 && Array.isArray(q.data) && q.data[0]) || null;
    if (!row || !(row.profiles && row.profiles.email)) return json(404, { error: 'not_found' });
    /* frontera: fuera de tu scope el registro NO existe (mismo criterio 404 de PORT-5) */
    if (!rs.all && row.dealer_id !== rs.orgId) return json(404, { error: 'not_found' });

    const email = row.profiles.email;
    const siteUrl = (env.SITE_URL || 'https://furniturerx.net').replace(/\/+$/, '');
    let subject, html, text, action;
    if (kind === 'terms') {
      /* PORT-24C: "resend T's and C's to customer" — link a los términos del plan (versión aceptada). */
      const termsUrl = siteUrl + '/terms/';
      const ver = row.terms_version ? ' (' + row.terms_version + ')' : '';
      subject = 'Your Furniture-Rx terms & conditions';
      html = '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0e1418">'
        + '<h2>Your plan terms &amp; conditions</h2>'
        + '<p>Here are the terms and conditions of your Furniture-Rx protection plan' + ver + ':</p>'
        + '<p><a href="' + termsUrl + '" style="display:inline-block;background:#e8590c;color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none;font-weight:600">Read the terms &rarr;</a></p>'
        + '</div>';
      text = 'Your Furniture-Rx terms & conditions' + ver + ': ' + termsUrl;
      action = 'terms_resent';
    } else {
      const url = siteUrl + '/account.html?t=' + signAccountToken(email, env.DASHBOARD_LINK_SECRET);
      subject = 'Your Furniture-Rx dashboard link';
      html = '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0e1418">'
        + '<h2>Your Furniture-Rx dashboard</h2>'
        + '<p>Here is the link to view your coverage, payments and receipts:</p>'
        + '<p><a href="' + url + '" style="display:inline-block;background:#e8590c;color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none;font-weight:600">View my coverage &rarr;</a></p>'
        + '</div>';
      text = 'View your Furniture-Rx coverage: ' + url;
      action = 'dashboard_link_resent';
    }
    const sent = await sendEmail(env, { to: email, subject, html, text });
    if (!sent.ok) { console.error('[portal-resend-link] email:', sent.error); return json(502, { error: 'email_failed' }); }

    await writeAudit(env, auditRow({
      actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
      category: 'Access', action, target: master.toUpperCase(),
      details: 'sent to customer email', org_id: rs.all ? row.dealer_id : rs.orgId
    }));
    return json(200, { sent: true });
  } catch (err) {
    console.error('[portal-resend-link]', err.message);
    return json(502, { error: 'upstream' });
  }
}
