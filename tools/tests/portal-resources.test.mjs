/* portal-resources — upload admin + asignación por dealer (Resources del portal).
 * Spec: misc/spec-portal-resources.md · fuente: revisiones/ChangesBLS.srt 02:10–04:11.
 * Stub por substring vía globalThis.fetch: GoTrue /user, PostgREST /resources + /resource_dealers
 * (+ audit), y Storage (upload + sign). */
import { makeT } from './helpers.mjs';

const t = makeT('portal-resources');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

let ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
const ALL = { id: 'r-all', title: 'Global sheet', resource_type: 'sell_sheet', all_dealers: true, storage_path: 'resources/all.pdf', link_url: null };
const ASSIGNED = { id: 'r-bls', title: 'BLS POS', resource_type: 'selling_pos', all_dealers: false, storage_path: 'resources/bls.pdf', link_url: null };
const OTHER = { id: 'r-oth', title: 'Other', resource_type: 'customer_info', all_dealers: false, storage_path: null, link_url: 'https://youtu.be/x' };
let calls = [];   // { method, kind }
let OBJ = { size: 1000, mimetype: 'application/pdf' };   // metadata que devuelve el list de Storage

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(ME), { status: 200 });

  if (u.includes('/storage/v1/object/upload/sign/')) { calls.push({ method: 'POST', kind: 'sign-upload' }); return new Response(JSON.stringify({ url: '/object/upload/sign/resources/KEY?token=t' }), { status: 200 }); }
  if (u.includes('/storage/v1/object/list/')) {
    let q = {}; try { q = JSON.parse(opts.body || '{}'); } catch { /* */ }
    return new Response(JSON.stringify([{ name: q.search || 'KEY', metadata: { size: OBJ.size, mimetype: OBJ.mimetype } }]), { status: 200 });
  }
  if (u.includes('/storage/v1/object/sign/')) return new Response(JSON.stringify({ signedURL: '/object/sign/resources/x?token=t' }), { status: 200 });
  if (u.includes('/storage/v1/object/')) {
    if (method === 'DELETE') { calls.push({ method: 'DELETE', kind: 'storage' }); return new Response('{}', { status: 200 }); }
    calls.push({ method: 'POST', kind: 'storage-upload' });
    return new Response('{}', { status: 200 });   // upload directo (no lo usa la función; por si acaso)
  }

  if (u.includes('/rest/v1/resource_dealers')) {
    if (method === 'POST') { calls.push({ method: 'POST', kind: 'assign' }); return new Response('[]', { status: 201 }); }
    return new Response(JSON.stringify([{ resource: ASSIGNED }]), { status: 200 });   // GET embdebido
  }
  if (u.includes('/rest/v1/resources')) {
    if (method === 'POST') { calls.push({ method: 'POST', kind: 'insert', body: opts.body ? JSON.parse(opts.body) : null }); const b = JSON.parse(opts.body); return new Response(JSON.stringify([{ id: 'r-new', ...b }]), { status: 201 }); }
    if (method === 'DELETE') { calls.push({ method: 'DELETE', kind: 'del-resource' }); return new Response(null, { status: 204 }); }
    if (u.includes('all_dealers=is.true')) return new Response(JSON.stringify([ALL]), { status: 200 });
    return new Response(JSON.stringify([ALL, ASSIGNED, OTHER]), { status: 200 });   // admin All
  }
  if (u.includes('/rest/v1/audit_events')) return new Response('[]', { status: 201 });
  throw new Error('unexpected fetch ' + u);
};

const handler = (await import('../../netlify/functions/portal-resources.mjs')).default;
const call = (method, { qs = '', body } = {}) =>
  handler(new Request('https://site.test/api/portal-resources' + qs, {
    method, headers: { Authorization: 'Bearer at_1' }, body: body === undefined ? undefined : JSON.stringify(body)
  }));

/* ── GET como DEALER → solo all_dealers + asignados (no ve OTHER) ── */
{
  ME = { id: 'd1', email: 'd@x.co', app_metadata: { portal_role: 'dealer', org_id: 'org1' } };
  const res = await call('GET', { qs: '?org_id=org1' });
  const d = await res.json();
  const ids = (d.resources || []).map((r) => r.id).sort();
  t(res.status === 200 && ids.join(',') === 'r-all,r-bls', 'GET dealer → all_dealers + asignados (sin ajenos)');
  t((d.resources || []).every((r) => typeof r.url === 'string' && r.url.length > 0), 'GET dealer → cada recurso trae url (firmada o link)');
  ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
}

/* ── GET como ADMIN viendo All → todos ── */
{
  const res = await call('GET', { qs: '' });
  const d = await res.json();
  t(res.status === 200 && (d.resources || []).length === 3, 'GET admin All → todos los recursos');
}

/* ── POST no-admin → 403 ── */
{
  ME = { id: 'd1', email: 'd@x.co', app_metadata: { portal_role: 'dealer', org_id: 'org1' } };
  const res = await call('POST', { body: { action: 'create', title: 'x', resource_type: 'sell_sheet', all_dealers: true, link_url: 'https://a.co' } });
  t(res.status === 403, 'POST no-admin → 403');
  ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
}

/* ── sign_upload (admin) → devuelve upload_url + storage_path ── */
{
  calls = [];
  const res = await call('POST', { body: { action: 'sign_upload', mime: 'application/pdf' } });
  const d = await res.json();
  t(res.status === 200 && /upload\/sign/.test(d.upload_url || '') && /^resources\//.test(d.storage_path || ''), 'sign_upload → upload_url + storage_path');
  t(calls.some((c) => c.kind === 'sign-upload'), 'sign_upload → pide el signed URL a Storage');
}
{
  ME = { id: 'd1', email: 'd@x.co', app_metadata: { portal_role: 'dealer', org_id: 'org1' } };
  const res = await call('POST', { body: { action: 'sign_upload', mime: 'application/pdf' } });
  t(res.status === 403, 'sign_upload no-admin → 403');
  ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
}

/* ── create con storage_path (ya subido) → valida el objeto e inserta con size/mime REALES ── */
{
  OBJ = { size: 5 * 1024 * 1024, mimetype: 'application/pdf' };   // 5MB pdf válido
  calls = [];
  const res = await call('POST', { body: { action: 'create', title: 'Tear pad', resource_type: 'selling_pos', all_dealers: false, dealer_ids: ['org1'], storage_path: 'resources/abc.pdf' } });
  const d = await res.json();
  t(res.status === 200 && d.resource && d.resource.id === 'r-new', 'create storage_path → crea el recurso');
  t(calls.some((c) => c.kind === 'insert' && c.body.storage_path === 'resources/abc.pdf' && c.body.mime_type === 'application/pdf' && c.body.size_bytes === 5 * 1024 * 1024), 'create → inserta con storage_path + size/mime REALES de Storage');
  t(calls.some((c) => c.kind === 'assign'), 'create → asigna al dealer');
  t(!calls.some((c) => c.kind === 'storage-upload'), 'create → NO sube (el navegador ya subió directo)');
}

/* ── create con PDF de 25MB (> 20MB) → 400 + limpia el objeto huérfano ── */
{
  OBJ = { size: 25 * 1024 * 1024, mimetype: 'application/pdf' };
  calls = [];
  const res = await call('POST', { body: { action: 'create', title: 'Big', resource_type: 'sell_sheet', all_dealers: true, storage_path: 'resources/deadbeef.pdf' } });
  t(res.status === 400, 'create PDF > 20MB → 400');
  t(calls.some((c) => c.kind === 'storage' && c.method === 'DELETE'), 'create rechazado → limpia el objeto huérfano');
}

/* ── create con imagen de 12MB (> 10MB para imágenes) → 400 ── */
{
  OBJ = { size: 12 * 1024 * 1024, mimetype: 'image/png' };
  const res = await call('POST', { body: { action: 'create', title: 'Img', resource_type: 'sell_sheet', all_dealers: true, storage_path: 'resources/cafe0011.png' } });
  t(res.status === 400, 'create imagen > 10MB → 400');
  OBJ = { size: 1000, mimetype: 'application/pdf' };   // restaura
}

/* ── POST create con LINK + all_dealers → sin storage, sin assign ── */
{
  calls = [];
  const res = await call('POST', { body: { action: 'create', title: 'Demo video', resource_type: 'product_overview', all_dealers: true, link_url: 'https://youtu.be/demo' } });
  const d = await res.json();
  t(res.status === 200 && d.resource, 'POST link → crea el recurso');
  t(!calls.some((c) => c.kind === 'storage-upload'), 'POST link → NO sube nada a Storage');
  t(calls.some((c) => c.kind === 'insert' && c.body.link_url === 'https://youtu.be/demo' && c.body.all_dealers === true), 'POST link → inserta link_url + all_dealers');
  t(!calls.some((c) => c.kind === 'assign'), 'POST link all_dealers → sin resource_dealers');
}

/* ── validaciones ── */
{
  const bad = await call('POST', { body: { action: 'create', title: '', resource_type: 'sell_sheet', all_dealers: true, link_url: 'https://a.co' } });
  t(bad.status === 400, 'POST create sin título → 400');
  const badType = await call('POST', { body: { action: 'create', title: 'x', resource_type: 'nope', all_dealers: true, link_url: 'https://a.co' } });
  t(badType.status === 400, 'POST create tipo inválido → 400');
  const noTarget = await call('POST', { body: { action: 'create', title: 'x', resource_type: 'sell_sheet', all_dealers: false, dealer_ids: [], link_url: 'https://a.co' } });
  t(noTarget.status === 400, 'POST create sin dealers y sin all_dealers → 400');
}

/* ── POST delete → borra la fila (cascade quita resource_dealers) ── */
{
  calls = [];
  const res = await call('POST', { body: { action: 'delete', resource_id: 'r-bls' } });
  const d = await res.json();
  t(res.status === 200 && d.deleted === true, 'POST delete → deleted:true');
  t(calls.some((c) => c.kind === 'del-resource'), 'POST delete → DELETE de la fila');
}

/* ── método no soportado ── */
{
  const res = await call('PUT', { body: {} });
  t(res.status === 405, 'PUT → 405');
}

t.done();
