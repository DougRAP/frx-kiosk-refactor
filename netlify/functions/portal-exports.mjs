/* ============================================================================
 * POST /.netlify/functions/portal-exports — export de suscriptores (PORT-6).
 * assertCanExport: sub → 403. Scoped por org. Cada export ESCRIBE una fila de audit
 * (lleva PII). Devuelve el CSV inline (el front lo descarga).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, assertCanExport, mapSubscriberRow, toCSV, auditRow, excludedOrgIds, rollupExclusion, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}
const COLS = [
  { key: 'first_name', label: 'First' }, { key: 'last_name', label: 'Last' },
  { key: 'program', label: 'Program' }, { key: 'start_date', label: 'Start' }, { key: 'end_date', label: 'End' },
  { key: 'payments', label: 'Payments' }, { key: 'person_id', label: 'Associate' },
  { key: 'contract_number', label: 'Contract #' },
  /* PORT-30 (aprobado 14-ago): el sales order # amarra el CSV al POS del dealer
     ("ties the two systems together", Doug). Celda vacia si no se capturo. */
  { key: 'sales_order_number', label: 'Sales order #' },
  { key: 'status', label: 'Status' }
];

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let ctx, scope, rs;
  try {
    ctx = await requirePortalUser(req, env);
    if (!ctx.scope) return json(403, { error: 'not_portal_user' });
    scope = ctx.scope;
    assertCanExport(scope);                                   // sub → 403 (negative test 1)
    rs = readOrgScope(scope, new URL(req.url).searchParams.get('org_id'));
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-exports] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  /* PORT-24B: Doug "it should export the filtered list". El front manda los contract_number del
     set filtrado; aquí filtramos los mapeados a ese set (sin reimplementar los filtros). */
  let body = null;
  try { body = await req.json(); } catch { /* body opcional */ }
  const wanted = body && Array.isArray(body.contracts) ? new Set(body.contracts.map(String)) : null;

  /* PORT-24B: limit 1000→5000 (si no, un dealer grande exportaría de menos que lo que ve) +
     exclusión de rollups en admin-all para casar con la pantalla. */
  const excl = rs.all ? await excludedOrgIds(env) : [];
  let q = '/subscriptions?kind=eq.protection'
    + '&select=id,master_no,tier,kind,status,started_at,canceled_at,sub_entity_id,sales_associate,sales_order_number,profiles(full_name,email)'
    + '&order=started_at.desc&limit=5000';
  if (!rs.all) q += `&dealer_id=eq.${encodeURIComponent(rs.orgId)}`;
  else q += rollupExclusion('dealer_id', excl);

  let result;
  try { result = await pgrest(env, q); } catch (err) { console.error('[portal-exports] pgrest:', err.message); return json(502, { error: 'upstream' }); }
  if (result.status >= 300) return json(502, { error: 'upstream' });

  const now = Date.now();
  let rows = (Array.isArray(result.data) ? result.data : []).map((r) => mapSubscriberRow(r, now));
  if (wanted) rows = rows.filter((r) => wanted.has(r.contract_number));
  const csv = toCSV(rows, COLS);

  await writeAudit(env, auditRow({
    actor_id: ctx.userId, actor_name: ctx.name || ctx.email, actor_role: scope.role,
    category: 'Export', action: 'Exported subscribers',
    target: scope.org_name || (rs.all ? 'all resellers' : rs.orgId),
    details: `CSV · ${rows.length} rows${wanted ? ' (filtered)' : ''} · PII included`, org_id: rs.orgId
  }));

  return json(200, { ok: true, filename: 'subscribers.csv', rows: rows.length, csv });
}
