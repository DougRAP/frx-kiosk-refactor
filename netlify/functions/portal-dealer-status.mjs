/* ============================================================================
 * GET /.netlify/functions/portal-dealer-status?org_id=… — PORT-11.
 * Estado de venta de un dealer para el aviso en UI (el enforcement REAL vive en
 * create-checkout-session). Solo flags, sin PII → no requiere auth de usuario.
 * ==========================================================================*/

'use strict';

import { pgrest } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;
  const orgId = (new URL(req.url).searchParams.get('org_id') || '').trim();
  if (!orgId) return json(400, { error: 'missing_org_id' });

  let result;
  try { result = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=selling_enabled,access_start,access_end&limit=1`); }
  catch (err) { console.error('[portal-dealer-status] pgrest:', err.message); return json(502, { error: 'upstream' }); }
  if (result.status >= 300) return json(502, { error: 'upstream' });
  const d = Array.isArray(result.data) && result.data[0] ? result.data[0] : null;
  if (!d) return json(404, { error: 'not_found' });

  return json(200, { selling_enabled: d.selling_enabled !== false, access_start: d.access_start, access_end: d.access_end });
}
