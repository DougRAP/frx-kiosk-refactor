/* ============================================================================
 * GET /.netlify/functions/portal-customer?contract=RX-#####-NN — ficha (PORT-5).
 * Ownership server-side: si el master no es del org del caller → 404 (§1: 404 no 403).
 * Campos admin-only OMITIDOS del payload para org/sub (mapCustomerRecord → omitAdminFields).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, mapCustomerRecord, PortalError } from './_lib/portal.mjs';
import { pgrest, signStorageUrl } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}
const SELECT = 'id,master_no,kind,tier,status,started_at,canceled_at,sales_order_number,purchased_on,'
  + 'sub_entity_id,sales_associate,receipt_path,terms_version,maya_summary,stripe_subscription_id,user_id,'
  + 'internal_notes,'                                   // PORT-19B: adminfield del mock (omitido para org/sub)
  + 'profiles(full_name,email,phone,address),dealers(name),sub_entities(name)';   // PORT-19B: campo "Dealer / Store"

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let scope, rs;
  const url = new URL(req.url);
  const contract = (url.searchParams.get('contract') || '').trim();
  if (!contract) return json(400, { error: 'missing_contract' });
  const master = contract.replace(/-\d{1,2}$/, '');   // el sufijo -NN es display; el master es la clave

  try {
    const ctx = await requirePortalUser(req, env);
    if (!ctx.scope) return json(403, { error: 'not_portal_user' });
    scope = ctx.scope;
    rs = readOrgScope(scope, url.searchParams.get('org_id'));
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-customer] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  let q = `/subscriptions?master_no=eq.${encodeURIComponent(master)}&kind=eq.protection&select=${encodeURIComponent(SELECT)}&limit=1`;
  if (!rs.all) q += `&dealer_id=eq.${encodeURIComponent(rs.orgId)}`;

  let result;
  try { result = await pgrest(env, q); } catch (err) { console.error('[portal-customer] pgrest:', err.message); return json(502, { error: 'upstream' }); }
  if (result.status >= 300) return json(502, { error: 'upstream' });
  const row = Array.isArray(result.data) && result.data[0] ? result.data[0] : null;
  if (!row) return json(404, { error: 'not_found' });   // no existe o es de otro org (sin oráculo)

  /* related purchases: otras compras del MISMO cliente (user_id, más preciso que apellido+dirección;
   * default nuestro, pregunta 9 a Doug). Dedupe por master_no. */
  let related = [];
  try {
    let rq = `/subscriptions?user_id=eq.${encodeURIComponent(row.user_id)}&kind=eq.protection&master_no=neq.${encodeURIComponent(master)}`
      + '&select=master_no,kind,tier,status,started_at,canceled_at&order=started_at.desc&limit=20';
    if (!rs.all) rq += `&dealer_id=eq.${encodeURIComponent(rs.orgId)}`;
    const rr = await pgrest(env, rq);
    if (rr.status < 300 && Array.isArray(rr.data)) {
      const seen = new Set();
      for (const r of rr.data) { if (r.master_no && !seen.has(r.master_no)) { seen.add(r.master_no); related.push(r); } }
    }
  } catch (err) { console.warn('[portal-customer] related:', err.message); }

  /* PORT-24C: últimos 5 service requests de este contrato (por master, cualquier -NN), scoped. */
  let srs = [];
  try {
    let sq = `/service_requests?contract_number=like.${encodeURIComponent(master + '*')}`
      + '&select=id,sr_number,category,body,status,created_at,resolved_at&order=created_at.desc&limit=5';
    if (!rs.all) sq += `&org_id=eq.${encodeURIComponent(rs.orgId)}`;
    const sr = await pgrest(env, sq);
    if (sr.status < 300 && Array.isArray(sr.data)) srs = sr.data;
  } catch (err) { console.warn('[portal-customer] srs:', err.message); }

  const record = mapCustomerRecord(row, related, Date.now(), scope, srs);

  /* recibo firmado (fail-soft): receipt_path = "<bucket>/<objectPath>". */
  if (row.receipt_path) {
    const i = row.receipt_path.indexOf('/');
    if (i > 0) record.receipt_url = await signStorageUrl(env, row.receipt_path.slice(0, i), row.receipt_path.slice(i + 1), 300);
  }

  return json(200, record);
}
