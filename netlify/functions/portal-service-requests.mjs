/* ============================================================================
 * /.netlify/functions/portal-service-requests — reseller → RAP (PORT-7).
 * POST crea (stage 0 'Received'). GET lista scoped por org. NO es un claim.
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, validateServiceRequest, PortalError } from './_lib/portal.mjs';
import { pgrest } from './_lib/supabase.mjs';

const MAX_BODY_BYTES = 8192;
function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

export default async function handler(req) {
  const env = process.env;

  let ctx, scope;
  try {
    ctx = await requirePortalUser(req, env);
    if (!ctx.scope) return json(403, { error: 'not_portal_user' });
    scope = ctx.scope;
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-service-requests] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'POST') {
    let body;
    try { const raw = await req.text(); if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' }); body = JSON.parse(raw); }
    catch { return json(400, { error: 'invalid_json' }); }
    const v = validateServiceRequest(body);
    if (!v.ok) return json(400, { error: v.error });

    /* SEC-3b (auditoría 28-jul, hallazgo 4): el contrato debe EXISTIR y estar en el scope de quien
     * radica. Hasta hoy el POST insertaba el contract_number del cuerpo sin comprobar propiedad (el
     * GET y el PATCH sí filtraban), así que un dealer podía radicar sobre el cliente de otro —
     * incluida la categoría "Cancel plan" — y la víctima ni lo veía, porque el SR se guarda con el
     * org del emisor. Mismo patrón y mismo 404 que portal-customer.mjs: no se distingue "no existe"
     * de "es de otro", para no dar un oráculo con el que enumerar contratos ajenos.
     * Va ANTES de pedir el número: no se quema un SR-##### en un intento rechazado.
     * NO es fail-soft (a diferencia de next_sr_no, que es cosmético): si la consulta falla, 502 y no
     * se crea nada, o el fallo se convertiría en la forma de evadir la comprobación.
     * Spec: misc/spec-sec3b-sr-scope.md. */
    const master = v.fields.contract_number.replace(/-\d{1,2}$/, '');   // el sufijo -NN es display
    let owns = `/subscriptions?master_no=eq.${encodeURIComponent(master)}&kind=eq.protection&select=id&limit=1`;
    if (!scope.isAdmin) owns += `&dealer_id=eq.${encodeURIComponent(scope.org_id || '')}`;
    let own;
    try { own = await pgrest(env, owns); }
    catch (err) { console.error('[portal-service-requests] scope:', err.message); return json(502, { error: 'upstream' }); }
    if (own.status >= 300) return json(502, { error: 'upstream' });
    if (!Array.isArray(own.data) || !own.data[0]) return json(404, { error: 'not_found' });   // ajeno o inexistente

    /* PORT-24C: número serializado SR-##### ("you generate a number"). Fail-soft: si el RPC falla,
     * el SR se crea igual sin número (no bloquea la solicitud del dealer). */
    let srNumber = null;
    try { const n = await pgrest(env, '/rpc/next_sr_no', { method: 'POST', body: {} }); if (typeof n.data === 'string') srNumber = n.data; }
    catch (err) { console.warn('[portal-service-requests] next_sr_no:', err.message); }

    const name = [v.fields.first_name, v.fields.last_name].filter(Boolean).join(' ') || null;
    const row = {
      org_id: scope.org_id || null, contract_number: v.fields.contract_number,
      customer_name: name, contact: v.fields.contact, body: v.fields.body,
      sr_number: srNumber, category: v.fields.category,           // PORT-24C
      stage: 0, status: 'open',
      history: [{ at: new Date().toISOString(), text: "Request received by RAP's service center." }]
    };
    let result;
    try { result = await pgrest(env, '/service_requests', { method: 'POST', prefer: 'return=representation', body: row }); }
    catch (err) { console.error('[portal-service-requests] insert:', err.message); return json(502, { error: 'upstream' }); }
    if (result.status >= 300 || !Array.isArray(result.data) || !result.data[0]) return json(502, { error: 'upstream' });
    return json(200, { ok: true, id: result.data[0].id, sr_number: srNumber, status: 'open' });
  }

  /* PORT-24C: cerrar un SR ("the last check box is Resolved… status open or closed"). Scoped al org. */
  if (req.method === 'PATCH') {
    let body;
    try { body = JSON.parse(await req.text()); } catch { return json(400, { error: 'invalid_json' }); }
    const id = body && typeof body.id === 'string' ? body.id : null;
    if (!id) return json(400, { error: 'id_required' });
    let q = `/service_requests?id=eq.${encodeURIComponent(id)}`;
    if (!scope.isAdmin) q += `&org_id=eq.${encodeURIComponent(scope.org_id || '')}`;   // solo SRs de su org
    let result;
    try {
      result = await pgrest(env, q + '&select=id', {
        method: 'PATCH', prefer: 'return=representation',
        body: { status: 'closed', stage: 5, resolved_at: new Date().toISOString() }
      });
    } catch (err) { console.error('[portal-service-requests] resolve:', err.message); return json(502, { error: 'upstream' }); }
    if (result.status >= 300) return json(502, { error: 'upstream' });
    if (!Array.isArray(result.data) || !result.data[0]) return json(404, { error: 'not_found' });   // ajeno al org
    return json(200, { ok: true, status: 'closed' });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    let rs;
    try { rs = readOrgScope(scope, url.searchParams.get('org_id')); }
    catch (err) { if (err instanceof PortalError) return json(err.status, { error: err.code }); throw err; }
    /* PORT-24C: ?contract= filtra por master (últimos 5 para la ficha); sin él, la lista general. */
    const contract = (url.searchParams.get('contract') || '').trim();
    const master = contract.replace(/-\d{1,2}$/, '');
    let q = '/service_requests?select=id,sr_number,category,contract_number,customer_name,body,stage,status,history,created_at,resolved_at&order=created_at.desc&limit='
      + (contract ? '5' : '200');
    if (contract) q += `&contract_number=like.${encodeURIComponent(master + '*')}`;
    if (!rs.all) q += `&org_id=eq.${encodeURIComponent(rs.orgId)}`;
    let result;
    try { result = await pgrest(env, q); } catch (err) { console.error('[portal-service-requests] list:', err.message); return json(502, { error: 'upstream' }); }
    if (result.status >= 300) return json(502, { error: 'upstream' });
    return json(200, { rows: Array.isArray(result.data) ? result.data : [], total: (result.data || []).length });
  }

  return json(405, { error: 'method_not_allowed' });
}
