/* ============================================================================
 * GET /.netlify/functions/portal-audit — audit log (PORT-6). Admin only.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, PortalError } from './_lib/portal.mjs';
import { pgrest } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}
const CATS = ['Change', 'Export', 'Access'];

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  try {
    const ctx = await requirePortalUser(req, env);
    assertAdmin(ctx.scope);                                   // no-admin → 403 (negative test 2)
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-audit] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  const cat = new URL(req.url).searchParams.get('category');
  let q = '/audit_events?select=at,actor_name,actor_role,category,action,target,details&order=at.desc&limit=200';
  if (CATS.includes(cat)) q += `&category=eq.${cat}`;

  let result;
  try { result = await pgrest(env, q); } catch (err) { console.error('[portal-audit] pgrest:', err.message); return json(502, { error: 'upstream' }); }
  if (result.status >= 300) return json(502, { error: 'upstream' });

  const rows = Array.isArray(result.data) ? result.data : [];
  return json(200, { rows, total: rows.length });
}
