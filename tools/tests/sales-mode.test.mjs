/* ============================================================================
 * KIOSK-22 — Sales-mode URL + QR. Unit de las dos Functions (mock globalThis.fetch,
 * patrón portal.test.mjs). requirePortalUser → GoTrue /user; pgrest → /rest/v1/*.
 * ==========================================================================*/
import { makeT } from './helpers.mjs';

const t = makeT('sales-mode');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.SITE_URL = 'https://site.test';

let meUser = { id: 'u1', email: 'admin@raptns.com', app_metadata: { portal_role: 'admin', world: null }, user_metadata: { full_name: 'Alex' } };
let smLinks = [];                 // lo que devuelve el GET a sales_mode_links
let dealerRow = { id: 'shf', name: 'BLS', world: 'retailer' };
let smInserted = null, smPatched = null, ksInserted = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { /* form/otro */ }
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(meUser), { status: 200 });
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });           // limiter sano → pasa
  if (u.includes('/rest/v1/dealers')) return new Response(JSON.stringify(dealerRow ? [dealerRow] : []), { status: 200 });
  if (u.includes('/rest/v1/sales_mode_links')) {
    if (method === 'GET') return new Response(JSON.stringify(smLinks), { status: 200 });
    if (method === 'PATCH') { smPatched = { url: u, body }; return new Response('[]', { status: 200 }); }
    if (method === 'POST') { smInserted = body; return new Response(JSON.stringify([{ ...body }]), { status: 201 }); }
  }
  if (u.includes('/rest/v1/kiosk_sessions')) {
    if (method === 'POST') { ksInserted = body; return new Response('', { status: 201 }); }
    return new Response('[]', { status: 200 });
  }
  if (u.includes('/rest/v1/')) return new Response('[]', { status: method === 'POST' ? 201 : 200 });   // writeAudit etc.
  throw new Error('unexpected fetch ' + u);
};

const salesMode = (await import('../../netlify/functions/portal-sales-mode.mjs')).default;
const redirect = (await import('../../netlify/functions/sales-mode-redirect.mjs')).default;
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const req = (url, method = 'GET', body) => new Request(url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

/* ── portal-sales-mode ─────────────────────────────────────────────────────── */
{
  meUser.app_metadata.portal_role = 'admin'; smLinks = [];
  let r = await salesMode(req('https://site.test/api/portal-sales-mode?org_id=shf', 'GET'));
  let d = await r.json();
  t(r.status === 200 && d.code === null, 'sm: admin GET sin link → {code:null}');

  smLinks = [{ code: 'ACDE2345', created_at: '2026-07-20T00:00:00Z' }];
  r = await salesMode(req('https://site.test/api/portal-sales-mode?org_id=shf', 'GET'));
  d = await r.json();
  t(r.status === 200 && d.code === 'ACDE2345' && /kiosk\.furniturerx\.net\/s\/ACDE2345$/.test(d.url), 'sm: GET → code + url /s/{code}');

  smInserted = null; smPatched = null;
  r = await salesMode(req('https://site.test/api/portal-sales-mode', 'POST', { org_id: 'shf' }));
  d = await r.json();
  t(r.status === 200 && d.code && /\/s\//.test(d.url), 'sm: POST generate → code + url');
  t(smInserted && smInserted.org_id === 'shf' && smInserted.code === d.code, 'sm: inserta la fila (org + code)');
  t(!!smPatched, 'sm: generate desactiva los activos previos (PATCH active=false)');

  smPatched = null;
  r = await salesMode(req('https://site.test/api/portal-sales-mode', 'POST', { org_id: 'shf', action: 'disable' }));
  d = await r.json();
  t(r.status === 200 && d.disabled === true && !!smPatched, 'sm: disable desactiva');

  /* PORT-28: el dealer VE su propio link/QR (lo necesita para vender); generarlo, rotarlo o
     apagarlo sigue siendo admin-only. readOrgScope acota: pedir OTRO org = 404, no 403. */
  meUser.app_metadata.portal_role = 'dealer';   // org, no admin
  meUser.app_metadata.org_id = 'shf';
  smLinks = [{ code: 'ACDE2345', created_at: '2026-07-20T00:00:00Z' }];

  r = await salesMode(req('https://site.test/api/portal-sales-mode?org_id=shf', 'GET'));
  d = await r.json();
  t(r.status === 200 && d.code === 'ACDE2345', 'PORT-28: el dealer LEE su propio link');

  r = await salesMode(req('https://site.test/api/portal-sales-mode', 'GET'));   // sin org_id: el suyo
  d = await r.json();
  t(r.status === 200 && d.code === 'ACDE2345' && /\/s\/ACDE2345$/.test(d.url), 'PORT-28: sin org_id el server usa el org del token');

  r = await salesMode(req('https://site.test/api/portal-sales-mode?org_id=otro-dealer', 'GET'));
  t(r.status === 404, 'PORT-28: el dealer pidiendo OTRO org → 404 (cross-tenant probe, no 403)');

  smLinks = [];
  r = await salesMode(req('https://site.test/api/portal-sales-mode', 'GET'));
  d = await r.json();
  t(r.status === 200 && d.code === null, 'PORT-28: dealer sin link generado → {code:null} (el modal muestra el aviso)');

  r = await salesMode(req('https://site.test/api/portal-sales-mode', 'POST', { org_id: 'shf' }));
  t(r.status === 403, 'sm: no-admin POST → 403 (generar/rotar sigue siendo de RAP)');
  r = await salesMode(req('https://site.test/api/portal-sales-mode', 'POST', { org_id: 'shf', action: 'disable' }));
  t(r.status === 403, 'sm: no-admin disable → 403');

  meUser.app_metadata.portal_role = 'admin';
  delete meUser.app_metadata.org_id;
  smLinks = [{ code: 'ACDE2345', created_at: '2026-07-20T00:00:00Z' }];
  r = await salesMode(req('https://site.test/api/portal-sales-mode', 'GET'));
  t(r.status === 400, 'sm: admin SIN org_id → 400 (debe nombrar el dealer; su QR vive en Dealer Admin)');
}

/* ── sales-mode-redirect ───────────────────────────────────────────────────── */
{
  smLinks = [{ org_id: 'shf', org_name: 'BLS', dealers: { world: 'retailer' } }];
  ksInserted = null;
  let r = await redirect(new Request('https://site.test/s/ACDE2345?code=ACDE2345', { method: 'GET' }));
  t(r.status === 302, 'redir: code válido → 302');
  t(/kiosk\.furniturerx\.net\/\?pt=/.test(r.headers.get('Location') || ''), 'redir: Location al kiosk con ?pt=');
  t(ksInserted && ksInserted.kind === 'handoff' && ksInserted.sales_mode === true && ksInserted.org_id === 'shf', 'redir: acuña handoff sales_mode del dealer');
  t((r.headers.get('Cache-Control') || '').includes('no-store'), 'redir: no-store');

  smLinks = [];
  r = await redirect(new Request('https://site.test/s/ACDE2345?code=ACDE2345', { method: 'GET' }));
  t(r.status === 404, 'redir: code desconocido/inactivo → 404');

  r = await redirect(new Request('https://site.test/s/xx?code=xx', { method: 'GET' }));
  t(r.status === 404, 'redir: code malformado → 404');

  r = await redirect(new Request('https://site.test/s/ACDE2345?code=ACDE2345', { method: 'POST' }));
  t(r.status === 405, 'redir: POST → 405');
}

/* ── dev-aware: request desde localhost → links de localhost (probar sin desplegar) ── */
{
  smLinks = [{ org_id: 'shf', org_name: 'BLS', dealers: { world: 'retailer' } }];
  let r = await redirect(new Request('http://localhost:8888/s/ACDE2345?code=ACDE2345', { method: 'GET' }));
  t(r.status === 302 && /^http:\/\/localhost:8888\/kiosk\/\?pt=/.test(r.headers.get('Location') || ''), 'dev: /s/ desde localhost → 302 a localhost/kiosk/?pt=');

  meUser.app_metadata.portal_role = 'admin';
  smLinks = [{ code: 'ACDE2345', created_at: '2026-07-20T00:00:00Z' }];
  r = await salesMode(new Request('http://localhost:8888/api/portal-sales-mode?org_id=shf', { method: 'GET', headers: H }));
  let d = await r.json();
  t(d.url === 'http://localhost:8888/s/ACDE2345', 'dev: sales-mode GET desde localhost → url localhost/s/{code} (RAÍZ, no /kiosk/s/)');
}

t.done();
