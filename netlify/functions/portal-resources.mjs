/* ============================================================================
 * /.netlify/functions/portal-resources — Resources del portal (ChangesBLS.srt 02:10–04:11).
 *   GET  ?org_id  → recursos visibles para el scope (admin All=todos; dealer/admin-viendo-org =
 *                   all_dealers OR asignados), cada uno con `url` (signed download o link).
 *   POST (admin-only):
 *     action 'create' → sube archivo a Storage (o guarda link) + inserta resource (+ resource_dealers).
 *     action 'delete' → borra la fila (cascade quita resource_dealers) + best-effort el objeto.
 *   Spec: misc/spec-portal-resources.md.
 * ==========================================================================*/

'use strict';

import { randomUUID } from 'node:crypto';
import { requirePortalUser, assertAdmin, readOrgScope, auditRow, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit, createSignedUploadUrl, objectInfo, signStorageUrl, deleteFromStorage } from './_lib/supabase.mjs';

const BUCKET = 'resources';
const TYPES = ['sell_sheet', 'selling_pos', 'product_overview', 'customer_info'];
const MIME_EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
/* Límite por tipo (decisión Ago-11): PDF 20MB, imágenes 10MB. El bucket topa en 20MB (candado duro
   de Storage); el 10MB de imágenes se enforce aquí con el tamaño real leído de Storage. */
const CAP = { 'application/pdf': 20 * 1024 * 1024, 'image/png': 10 * 1024 * 1024, 'image/jpeg': 10 * 1024 * 1024 };
const KEY_RE = /^[a-f0-9-]+\.(pdf|png|jpg|jpeg)$/i;   // key = uuid.ext bajo el bucket resources/

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

/* recurso de la BD → forma para el front, con `url` firmada (archivo) o el link externo. */
async function present(env, r) {
  let url = r.link_url || null;
  if (r.storage_path) {
    const i = r.storage_path.indexOf('/');
    url = i > 0 ? await signStorageUrl(env, r.storage_path.slice(0, i), r.storage_path.slice(i + 1), 3600) : null;
  }
  return { id: r.id, title: r.title, description: r.description || null, resource_type: r.resource_type, all_dealers: !!r.all_dealers, is_link: !r.storage_path, url, created_at: r.created_at };
}

async function listForScope(env, orgId, all) {
  if (all) {
    const r = await pgrest(env, '/resources?select=*&order=created_at.desc');
    return (r.status < 300 && Array.isArray(r.data)) ? r.data : [];
  }
  const gq = await pgrest(env, '/resources?all_dealers=is.true&select=*&order=created_at.desc');
  const aq = await pgrest(env, `/resource_dealers?dealer_id=eq.${encodeURIComponent(orgId)}&select=resource:resources(*)`);
  const rows = [];
  const seen = new Set();
  const push = (row) => { if (row && row.id && !seen.has(row.id)) { seen.add(row.id); rows.push(row); } };
  if (gq.status < 300 && Array.isArray(gq.data)) gq.data.forEach(push);
  if (aq.status < 300 && Array.isArray(aq.data)) aq.data.forEach((x) => push(x && x.resource));
  return rows;
}

export default async function handler(req) {
  const env = process.env;

  let ctx, scope;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-resources] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    let view;
    try { view = readOrgScope(scope, new URL(req.url).searchParams.get('org_id')); }
    catch (err) { return err instanceof PortalError ? json(err.status, { error: err.code }) : json(500, { error: 'scope_error' }); }
    const rows = await listForScope(env, view.orgId, view.all);
    const resources = [];
    for (const r of rows) resources.push(await present(env, r));
    return json(200, { resources });
  }

  if (req.method === 'POST') {
    try { assertAdmin(scope); } catch (err) { return err instanceof PortalError ? json(err.status, { error: err.code }) : json(500, { error: 'auth_error' }); }

    let body = null; try { body = await req.json(); } catch { /* → 400 */ }
    if (!body || typeof body !== 'object') return json(400, { error: 'invalid_body' });
    const action = typeof body.action === 'string' ? body.action : 'create';

    if (action === 'delete') {
      const id = typeof body.resource_id === 'string' ? body.resource_id : null;
      if (!id) return json(400, { error: 'resource_id_required' });
      const q = await pgrest(env, `/resources?id=eq.${encodeURIComponent(id)}&select=storage_path&limit=1`);
      const row = (q.status < 300 && Array.isArray(q.data) && q.data[0]) || null;
      const del = await pgrest(env, `/resources?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
      if (del.status >= 300) { console.error('[portal-resources] delete', del.status); return json(502, { error: 'delete_failed' }); }
      if (row && row.storage_path) { const i = row.storage_path.indexOf('/'); if (i > 0) await deleteFromStorage(env, row.storage_path.slice(0, i), row.storage_path.slice(i + 1)); }
      await writeAudit(env, auditRow({ actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role, category: 'Change', action: 'resource_deleted', target: id, details: 'resource removed', org_id: null }));
      return json(200, { deleted: true });
    }

    /* paso 1 del upload directo: firma un URL para que el navegador suba el archivo a Storage. */
    if (action === 'sign_upload') {
      const mime = body.mime;
      if (!MIME_EXT[mime]) return json(400, { error: 'invalid_mime' });
      const key = `${randomUUID()}.${MIME_EXT[mime]}`;
      try {
        const { upload_url } = await createSignedUploadUrl(env, BUCKET, key);
        return json(200, { storage_path: `${BUCKET}/${key}`, upload_url });
      } catch (err) { console.error('[portal-resources] sign_upload', err.message); return json(502, { error: 'sign_failed' }); }
    }

    if (action !== 'create') return json(400, { error: 'invalid_action' });

    /* validación */
    const title = String(body.title || '').trim().slice(0, 160);
    if (!title) return json(400, { error: 'invalid_title' });
    if (!TYPES.includes(body.resource_type)) return json(400, { error: 'invalid_type' });
    const description = String(body.description || '').trim().slice(0, 500) || null;
    const all_dealers = body.all_dealers === true;
    const dealer_ids = Array.isArray(body.dealer_ids) ? body.dealer_ids.filter((x) => typeof x === 'string' && x).slice(0, 500) : [];
    if (!all_dealers && dealer_ids.length === 0) return json(400, { error: 'no_targets' });

    /* contenido: archivo YA subido (storage_path, flujo signed-upload) O link. NUNCA base64. */
    let storage_path = null, link_url = null, mime_type = null, size_bytes = null;
    if (typeof body.storage_path === 'string' && body.storage_path) {
      const sp = body.storage_path, i = sp.indexOf('/');
      const bkt = i > 0 ? sp.slice(0, i) : '', key = i > 0 ? sp.slice(i + 1) : '';
      if (bkt !== BUCKET || !KEY_RE.test(key)) return json(400, { error: 'invalid_path' });
      const info = await objectInfo(env, BUCKET, key);   // tamaño/mime REALES (no confiamos en el cliente)
      if (!info) return json(400, { error: 'upload_not_found' });
      const mime = info.mimetype;
      if (!MIME_EXT[mime]) { await deleteFromStorage(env, BUCKET, key); return json(400, { error: 'invalid_mime' }); }
      if (info.size != null && info.size > (CAP[mime] || CAP['image/png'])) { await deleteFromStorage(env, BUCKET, key); return json(400, { error: 'file_too_large' }); }
      storage_path = sp; mime_type = mime; size_bytes = info.size;
    } else if (typeof body.link_url === 'string' && /^https?:\/\//i.test(body.link_url.trim())) {
      link_url = body.link_url.trim().slice(0, 2048);
    } else {
      return json(400, { error: 'no_content' });
    }

    const ins = await pgrest(env, '/resources', {
      method: 'POST', prefer: 'return=representation',
      body: { title, description, resource_type: body.resource_type, storage_path, link_url, mime_type, size_bytes, all_dealers, uploaded_by: ctx.userId }
    });
    if (ins.status !== 201 || !Array.isArray(ins.data) || !ins.data[0]) { console.error('[portal-resources] insert', ins.status); return json(502, { error: 'insert_failed' }); }
    const resource = ins.data[0];

    if (!all_dealers && dealer_ids.length) {
      const links = dealer_ids.map((dealer_id) => ({ resource_id: resource.id, dealer_id }));
      const ra = await pgrest(env, '/resource_dealers', { method: 'POST', prefer: 'return=minimal', body: links });
      if (ra.status >= 300) console.warn('[portal-resources] assign status', ra.status);   // fail-soft: el recurso ya existe
    }

    await writeAudit(env, auditRow({ actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role, category: 'Change', action: 'resource_uploaded', target: title, details: `${body.resource_type} · ${all_dealers ? 'all dealers' : dealer_ids.length + ' dealer(s)'}`, org_id: null }));

    return json(200, { resource: await present(env, resource) });
  }

  return json(405, { error: 'method_not_allowed' });
}
