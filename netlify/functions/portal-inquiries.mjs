/* ============================================================================
 * /.netlify/functions/portal-inquiries — "become a reseller" (PORT-13).
 * ----------------------------------------------------------------------------
 * POST  (PÚBLICO, sin auth): el ÚNICO write sin login del portal (§5.15). world
 *       OBLIGATORIO + rate-limit + honeypot. Respuesta uniforme {ok:true} (no revela).
 * GET   (admin): lista filtrada por world/status para la cola de Reseller Inquiries.
 * PATCH (admin): { id, status } — New → Contacted (la conversión completa es PORT-12).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, validateInquiry, PortalError } from './_lib/portal.mjs';
import { pgrest } from './_lib/supabase.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';

const MAX_BODY_BYTES = 2048;
const STATUSES = ['New', 'Contacted', 'Converted'];

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }
  });
}

async function readBody(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new PortalError(400, 'body_too_large');
  try { return JSON.parse(raw); } catch { throw new PortalError(400, 'invalid_json'); }
}

export default async function handler(req) {
  const env = process.env;

  /* ---- POST público: crear el lead ---- */
  if (req.method === 'POST') {
    const rl = await checkRate(env, { prefix: 'portal-inquiry', ip: clientIp(req), limit: 5, windowSec: 60 });
    if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

    let body;
    try { body = await readBody(req); } catch (e) { return json(e.status || 400, { error: e.code || 'bad_request' }); }

    const v = validateInquiry(body);
    if (!v.ok) {
      if (v.error === 'spam') return json(200, { ok: true });     // honeypot: 200 mudo, no alimenta al bot
      return json(400, { error: v.error });
    }

    try {
      const { status } = await pgrest(env, '/reseller_inquiries', {
        method: 'POST', prefer: 'return=minimal',
        body: { name: v.fields.name, email: v.fields.email, phone: v.fields.phone, world: v.fields.world }
      });
      if (status >= 300) throw new Error(`insert ${status}`);
    } catch (err) {
      console.error('[portal-inquiries] insert failed:', err.message);
      return json(502, { error: 'upstream' });
    }
    return json(200, { ok: true });
  }

  /* ---- GET / PATCH admin ---- */
  let ctx;
  try {
    ctx = await requirePortalUser(req, env);
    assertAdmin(ctx.scope);
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-inquiries] auth failed:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const world = url.searchParams.get('world');
    const st = url.searchParams.get('status');
    let q = '/reseller_inquiries?select=id,name,email,phone,world,status,created_at&order=created_at.desc';
    if (world === 'retailer' || world === 'technician') q += `&world=eq.${world}`;
    if (STATUSES.includes(st)) q += `&status=eq.${st}`;
    let result;
    try { result = await pgrest(env, q); } catch (err) { console.error('[portal-inquiries] list:', err.message); return json(502, { error: 'upstream' }); }
    if (result.status >= 300) return json(502, { error: 'upstream' });
    const rows = Array.isArray(result.data) ? result.data : [];
    return json(200, { rows, total: rows.length });
  }

  if (req.method === 'PATCH') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(e.status || 400, { error: e.code || 'bad_request' }); }
    const id = typeof body.id === 'string' ? body.id : '';
    const status = STATUSES.includes(body.status) ? body.status : '';
    if (!id || !status) return json(400, { error: 'invalid_patch' });
    try {
      const r = await pgrest(env, `/reseller_inquiries?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { status }
      });
      if (r.status >= 300) throw new Error(`patch ${r.status}`);
    } catch (err) { console.error('[portal-inquiries] patch:', err.message); return json(502, { error: 'upstream' }); }
    return json(200, { ok: true });
  }

  return json(405, { error: 'method_not_allowed' });
}
