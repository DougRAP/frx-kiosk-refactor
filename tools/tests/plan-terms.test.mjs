/* ============================================================================
 * PORT-25 — T&C SKU por dealer. Unit de portal-plan-terms.mjs (mock globalThis.fetch,
 * patrón sales-mode.test.mjs). requirePortalUser → GoTrue /user; pgrest → /rest/v1/*.
 * ==========================================================================*/
import { makeT } from './helpers.mjs';

const t = makeT('plan-terms');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.SITE_URL = 'https://site.test';

let meUser = { id: 'u1', email: 'admin@raptns.com', app_metadata: { portal_role: 'admin', world: null }, user_metadata: { full_name: 'Alex' } };
let dealerRow = { id: 'shf', name: 'BLS', world: 'retailer' };
let ptRows = [];               // filas que devuelve el GET a plan_terms (override + genéricas)
let ptPatchResult = [];        // lo que devuelve el PATCH (representación); [] = no existía → INSERT
let ptPatched = null, ptInserted = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { /* form/otro */ }
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(meUser), { status: 200 });
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });
  if (u.includes('/rest/v1/dealers')) return new Response(JSON.stringify(dealerRow ? [dealerRow] : []), { status: 200 });
  if (u.includes('/rest/v1/plan_terms')) {
    if (method === 'GET') return new Response(JSON.stringify(ptRows), { status: 200 });
    if (method === 'PATCH') { ptPatched = { url: u, body }; return new Response(JSON.stringify(ptPatchResult), { status: 200 }); }
    if (method === 'POST') { ptInserted = body; return new Response(JSON.stringify([{ ...body }]), { status: 201 }); }
  }
  if (u.includes('/rest/v1/')) return new Response('[]', { status: method === 'POST' ? 201 : 200 });   // writeAudit etc.
  throw new Error('unexpected fetch ' + u);
};

const planTerms = (await import('../../netlify/functions/portal-plan-terms.mjs')).default;
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const req = (url, method = 'GET', body) => new Request(url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

/* ── GET: arma override + generic + effective/source por SKU ─────────────────── */
{
  meUser.app_metadata.portal_role = 'admin';
  ptRows = [
    { org_id: null,  plan_sku: 'stain',      terms_version: 'v2026-05', doc_url: '/terms/', active: true },
    { org_id: null,  plan_sku: 'stain_mech', terms_version: 'v2026-05', doc_url: '/terms/', active: true },
    { org_id: 'shf', plan_sku: 'stain',      terms_version: 'BLS-STAIN-01', doc_url: 'https://d/tc.pdf', active: true }
  ];
  let r = await planTerms(req('https://site.test/api/portal-plan-terms?org_id=shf', 'GET'));
  let d = await r.json();
  t(r.status === 200 && Array.isArray(d.skus) && d.skus.length === 2, 'pt: GET → 2 SKUs');
  const stain = d.skus.find((s) => s.plan_sku === 'stain');
  const mech = d.skus.find((s) => s.plan_sku === 'stain_mech');
  t(stain && stain.override && stain.override.terms_version === 'BLS-STAIN-01', 'pt: stain tiene override del dealer');
  t(stain && stain.generic && stain.generic.terms_version === 'v2026-05', 'pt: stain conserva la genérica como fallback');
  t(stain && stain.effective && stain.effective.terms_version === 'BLS-STAIN-01' && stain.effective.source === 'dealer', 'pt: stain effective = override (source dealer)');
  t(mech && !mech.override && mech.effective && mech.effective.terms_version === 'v2026-05' && mech.effective.source === 'generic', 'pt: stain_mech sin override → effective genérica (source generic)');
}

/* ── POST save: update (fila existe) vs insert (no existe) = upsert ──────────── */
{
  ptPatched = null; ptInserted = null; ptPatchResult = [{ org_id: 'shf', plan_sku: 'stain', terms_version: 'BLS-STAIN-02', active: true }];
  let r = await planTerms(req('https://site.test/api/portal-plan-terms', 'POST', { org_id: 'shf', plan_sku: 'stain', terms_version: 'BLS-STAIN-02', doc_url: 'https://d/2.pdf' }));
  let d = await r.json();
  t(r.status === 200 && d.saved === true && d.plan_sku === 'stain', 'pt: save (update) → saved');
  t(ptPatched && /org_id=eq\.shf/.test(ptPatched.url) && /plan_sku=eq\.stain/.test(ptPatched.url), 'pt: save PATCHea por (org_id, plan_sku)');
  t(ptPatched && ptPatched.body.terms_version === 'BLS-STAIN-02' && ptPatched.body.active === true, 'pt: save escribe terms_version + active=true');
  t(ptInserted === null, 'pt: update NO inserta (la fila ya existía)');

  ptPatched = null; ptInserted = null; ptPatchResult = [];   // no existía → cae a INSERT
  r = await planTerms(req('https://site.test/api/portal-plan-terms', 'POST', { org_id: 'shf', plan_sku: 'stain_mech', terms_version: 'BLS-MECH-01' }));
  d = await r.json();
  t(r.status === 200 && d.saved === true, 'pt: save (insert) → saved');
  t(ptInserted && ptInserted.org_id === 'shf' && ptInserted.plan_sku === 'stain_mech' && ptInserted.terms_version === 'BLS-MECH-01', 'pt: insert lleva org+sku+version');
  t(ptInserted && ptInserted.active === true, 'pt: insert nace active=true');
}

/* ── POST clear: desactiva la fila del dealer (cae a genérica) ───────────────── */
{
  ptPatched = null; ptInserted = null;
  let r = await planTerms(req('https://site.test/api/portal-plan-terms', 'POST', { org_id: 'shf', plan_sku: 'stain', action: 'clear' }));
  let d = await r.json();
  t(r.status === 200 && d.cleared === true, 'pt: clear → cleared');
  t(ptPatched && ptPatched.body.active === false && /org_id=eq\.shf/.test(ptPatched.url) && /plan_sku=eq\.stain/.test(ptPatched.url), 'pt: clear PATCHea active=false en la fila del dealer');
  t(ptInserted === null, 'pt: clear no inserta nada');
}

/* ── Validación + auth ──────────────────────────────────────────────────────── */
{
  let r = await planTerms(req('https://site.test/api/portal-plan-terms', 'POST', { org_id: 'shf', plan_sku: 'bogus', terms_version: 'x' }));
  t(r.status === 400, 'pt: plan_sku inválido → 400');
  r = await planTerms(req('https://site.test/api/portal-plan-terms', 'POST', { org_id: 'shf', plan_sku: 'stain', terms_version: '   ' }));
  t(r.status === 400, 'pt: terms_version vacío → 400');
  r = await planTerms(req('https://site.test/api/portal-plan-terms', 'POST', { plan_sku: 'stain', terms_version: 'x' }));
  t(r.status === 400, 'pt: sin org_id → 400');
  r = await planTerms(req('https://site.test/api/portal-plan-terms?org_id=shf', 'GET'));   // vuelve a admin OK
  t(r.status === 200, 'pt: admin GET sigue 200');

  meUser.app_metadata.portal_role = 'dealer';   // org, no admin
  r = await planTerms(req('https://site.test/api/portal-plan-terms?org_id=shf', 'GET'));
  t(r.status === 403, 'pt: no-admin GET → 403');
  r = await planTerms(req('https://site.test/api/portal-plan-terms', 'POST', { org_id: 'shf', plan_sku: 'stain', terms_version: 'x' }));
  t(r.status === 403, 'pt: no-admin POST → 403');
  meUser.app_metadata.portal_role = 'admin';
}

t.done();
