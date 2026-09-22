/* ============================================================================
 * Subscription Portal (email Doug 11-jul) — fase 1. Spec: misc/spec-portal-fase1.md. TDD.
 * (Nombre 'subportal' para no colisionar con portal.test.mjs = DASH-1 Stripe Billing Portal.)
 *   (A) motor de scoping _lib/portal.mjs (PURO → la frontera de seguridad)
 *   (B) gates estáticos del front + migraciones
 *   (C) comportamiento del front en jsdom (loadPortal): landing/login/shell/roles/inquiry
 * ==========================================================================*/
import { src, makeT, loadPortal, sleep } from './helpers.mjs';
import {
  deriveScope, readOrgScope, omitAdminFields, contractNumber, validateInquiry,
  assertCanExport, assertCanStripe, assertAdmin, appUrlFor, shortLinkBase, PortalError,
  firstLast, programLabel, paymentsSince, mapSubscriberRow, mapCustomerRecord,
  toCSV, auditRow, validateServiceRequest, dealerCanSell
} from '../../netlify/functions/_lib/portal.mjs';
import { validateCheckout } from '../../netlify/functions/_lib/validate.mjs';
import { TERMS_VERSION } from '../../netlify/functions/_lib/terms.mjs';

const t = makeT('subportal');
const throwsStatus = (fn, status) => { try { fn(); return false; } catch (e) { return e instanceof PortalError && e.status === status; } };
const noThrow = (fn) => { try { fn(); return true; } catch (e) { return false; } };

/* ── (A) motor de scoping ─────────────────────────────────────────────────── */
{
  t(deriveScope(null) === null && deriveScope({}) === null, 'engine: sin portal_role → null (cliente normal, no entra)');

  const admin = deriveScope({ portal_role: 'admin' });
  t(admin.tier === 'admin' && admin.world === null && admin.isAdmin, 'engine: admin → tier admin, cross-world (world null)');
  t(admin.canExport && admin.canStripe && admin.canReferralCreate && admin.canAdmin, 'engine: admin tiene todas las capacidades');

  const org = deriveScope({ portal_role: 'dealer', org_id: 'o1', org_name: 'Summit' });
  t(org.tier === 'org' && org.world === 'retailer', 'engine: dealer → tier org, world retailer derivado');
  t(org.canExport && org.canStripe && !org.canReferralCreate && !org.canAdmin, 'engine: org exporta/stripe pero NO crea referral ni admin');

  const sub = deriveScope({ portal_role: 'store', org_id: 'o1' });
  t(sub.tier === 'sub' && !sub.canExport && !sub.canStripe && !sub.canApi, 'engine: store → tier sub, SIN export/stripe/api');

  const tech = deriveScope({ portal_role: 'technician', org_id: 'o2' });
  t(tech.tier === 'sub' && tech.world === 'technician', 'engine: technician → sub, world technician');

  t(throwsStatus(() => assertCanExport(sub), 403), 'guard: store pide export → 403 (negative test 1)');
  t(throwsStatus(() => assertAdmin(org), 403), 'guard: dealer pide admin → 403 (negative test 2)');
  t(throwsStatus(() => assertCanStripe(tech), 403), 'guard: technician pide stripe → 403 (negative test 6)');
  t(noThrow(() => assertCanExport(org)) && noThrow(() => assertAdmin(admin)), 'guard: org exporta, admin administra (sin lanzar)');

  t(readOrgScope(admin).all === true && readOrgScope(admin, 'shf').orgId === 'shf', 'scope: admin ve all o filtra por org');
  t(readOrgScope(org).orgId === 'o1' && readOrgScope(org, 'o1').orgId === 'o1', 'scope: org → su propio org_id');
  t(throwsStatus(() => readOrgScope(org, 'otro'), 404), 'scope: dealer A pide org B → 404 (negative test 3, cross-tenant)');
  t(readOrgScope(sub).orgId === 'o1', 'scope: sub lee org-wide (su org_id) — V4');

  const rec = { first_name: 'Jane', stripe_subscription_id: 'sub_x', internal_notes: 'n' };
  const forOrg = omitAdminFields(rec, org);
  t(forOrg.first_name === 'Jane' && !('stripe_subscription_id' in forOrg) && !('internal_notes' in forOrg), 'payload: org NO recibe campos admin-only (negative test 5)');
  t(omitAdminFields(rec, admin).stripe_subscription_id === 'sub_x', 'payload: admin conserva los campos admin-only');

  t(contractNumber('RX-10001', 3) === 'RX-10001-3', 'port-3 (DEC-2): master + sufijo de UN dígito sin pad (RX-10001-3)');
  t(contractNumber('RX-10001', 0) === 'RX-10001-1' && contractNumber(null, 3) === null, 'port-3 (DEC-2): min ciclo 1 → RX-10001-1; sin master → null');

  t(appUrlFor('technician') === 'https://tech.furniturerx.net/' && appUrlFor('retailer') === 'https://kiosk.furniturerx.net/', 'engine: app_url routeado por world');
  /* DEV-URLS: si el request viene de localhost → links de localhost (probar sin desplegar); prod = constantes */
  const devReq = { url: 'http://localhost:8888/api/x' };
  t(appUrlFor('retailer', devReq) === 'http://localhost:8888/kiosk/' && appUrlFor('technician', devReq) === 'http://localhost:8888/tech/', 'dev-urls: host localhost → app bajo /kiosk/ y /tech/');
  t(shortLinkBase('retailer', devReq) === 'http://localhost:8888/', 'dev-urls: short link /s/ desde la RAÍZ en dev');
  t(appUrlFor('retailer', { url: 'https://portal.furniturerx.net/api/x' }) === 'https://kiosk.furniturerx.net/' && shortLinkBase('retailer', { url: 'https://x/y' }) === 'https://kiosk.furniturerx.net/', 'dev-urls: host de prod → constantes (jamás localhost)');
  t(appUrlFor('retailer') === 'https://kiosk.furniturerx.net/', 'dev-urls: sin req → prod (backward-compatible)');

  t(validateInquiry({ name: 'A', email: 'a@b.co', world: 'retailer' }).ok, 'inquiry: válido pasa');
  t(validateInquiry({ name: 'A', email: 'a@b.co' }).error === 'invalid_world', 'inquiry: SIN world → error (§5.15, untagged se pierde)');
  t(validateInquiry({ name: 'A', email: 'a@b.co', world: 'x' }).error === 'invalid_world', 'inquiry: world inválido → error');
  t(validateInquiry({ name: 'A', email: 'nope', world: 'retailer' }).error === 'invalid_email', 'inquiry: email inválido → error');
  t(validateInquiry({ name: 'A', email: 'a@b.co', world: 'retailer', company_url: 'http://spam' }).error === 'spam', 'inquiry: honeypot relleno → spam');
}

/* ── (B) gates estáticos ──────────────────────────────────────────────────── */
{
  const html = src('portal/index.html');
  t(/id="login-email"/.test(html) && /id="login-pw"/.test(html), 'front: login REAL (email + password)');
  t(!/login\('admin'\)/.test(html) && !/Demo accounts/.test(html), 'front: sin el login stub de 5 personas de la maqueta');
  t(/id="worldSelect"/.test(html) && /id="dealerSelect"/.test(html), 'front: selector cross-world del admin (World + Viewing)');
  t(/id="rs-world"/.test(html) && /name="company_url"/.test(html), 'front: become-a-reseller con world + honeypot');
  t(/assets\/css\/portal\.css/.test(html), 'front: usa el CSS de Doug (portal.css)');
  /* PORT-31 (Emmy 14-ago): el portal muestra la hotline de RESELLERS, no la línea de clientes. */
  t(/1-888-850-0057/.test(html) && !/\(800\) 555-0100/.test(html), 'front: hotline de resellers 1-888-850-0057 (no el placeholder del mock)');

  const js = src('portal/assets/js/portal.js');
  t(/\/api\/auth-login/.test(js) && /\/api\/portal-me/.test(js) && /\/api\/portal-inquiries/.test(js), 'js: cablea /api/auth-login, /api/portal-me, /api/portal-inquiries');
  t(!/\.innerHTML\s*=/.test(js), 'js: cero asignación a innerHTML (PII → textContent/createTextNode)');
  t(/textContent/.test(js), 'js: usa textContent para datos');

  const toml = src('portal/netlify.toml');
  t(/from = "\/api\/\*"/.test(toml) && /furniturerx\.netlify\.app\/\.netlify\/functions/.test(toml), 'netlify: proxy /api/* al backend central');
  t(/Content-Security-Policy/.test(toml) && /connect-src 'self'/.test(toml), 'netlify: CSP propia (connect-src self)');

  const m1 = src('supabase/migrations/20260713000000_portal_orgs_subentities.sql');
  t(/CREATE TABLE IF NOT EXISTS public\.sub_entities/.test(m1) && /ADD COLUMN IF NOT EXISTS world/.test(m1), 'mig PORT-2: sub_entities + dealers.world');
  t(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.sub_entities TO service_role/.test(m1) && /REVOKE ALL ON public\.sub_entities FROM anon/.test(m1), 'mig PORT-2: grants explícitos (service_role) + revoke anon');
  t(/ADD COLUMN IF NOT EXISTS sub_entity_id/.test(m1), 'mig PORT-2: subscriptions.sub_entity_id');

  const m2 = src('supabase/migrations/20260713010000_reseller_inquiries.sql');
  t(/CREATE TABLE IF NOT EXISTS public\.reseller_inquiries/.test(m2) && /reseller_inquiries_world_chk/.test(m2), 'mig PORT-13: reseller_inquiries + world CHECK');
  t(/REVOKE ALL ON public\.reseller_inquiries FROM anon/.test(m2), 'mig PORT-13: anon sin acceso (todo por Function)');
}

/* ── (C) comportamiento del front (jsdom) ─────────────────────────────────── */
const SESSION = { access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 };
const ADMIN_ME = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
const ORG_ME = { user_id: 'u2', name: 'Dana Reed', email: 'owner@summithf.com', role: 'dealer', tier: 'org', world: 'retailer', org_id: 'org-1', org_name: 'Summit Home Furnishings', sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
const SUB_ME = { user_id: 'u3', name: 'Sam Lee', email: 'nashville@summithf.com', role: 'store', tier: 'sub', world: 'retailer', org_id: 'org-1', org_name: 'Summit Home Furnishings', sub_entity_id: 'st-1', sub_entity_name: 'Summit — Nashville', app_url: 'https://kiosk.furniturerx.net/' };

/* sin session → landing */
{
  const { document, errors } = await loadPortal({});
  t(errors.length === 0, 'boot: sin errores de jsdom (sin session)');
  t(document.getElementById('view-landing').classList.contains('on'), 'boot: sin session → landing visible');
  t(document.getElementById('app').style.display === 'none', 'boot: sin session → app oculta');
}

/* admin con session → shell + selector poblado */
{
  const { document, errors } = await loadPortal({ session: SESSION, me: ADMIN_ME, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }, { org_id: 'r2g', org_name: 'Rooms2Go #3' }] });
  await sleep(60);
  t(errors.length === 0, 'admin: sin errores de jsdom');
  t(document.getElementById('app').style.display === 'block', 'admin: /api/me válido → app visible');
  t(document.getElementById('userName').textContent === 'Alex Rivera', 'admin: nombre pintado (textContent)');
  t(document.getElementById('hdr-admin').style.display === 'flex' && document.getElementById('hdr-user').style.display === 'none', 'admin: header del selector cross-world visible');
  t(document.getElementById('dealerSelect').options.length === 3, 'admin: dropdown Viewing poblado (All + 2 orgs)');
  t(/Admin/.test(document.getElementById('scope-line').textContent), 'admin: scopebar de admin');
  t(document.getElementById('dash-role').textContent === 'admin', 'admin: dashboard pinta la identidad real');
}

/* org → header de identidad, ve Referral + Stripe, NO ve Admin */
{
  const { document } = await loadPortal({ session: SESSION, me: ORG_ME });
  await sleep(40);
  t(document.getElementById('hdr-user').style.display === 'flex' && document.getElementById('hdr-admin').style.display === 'none', 'org: header de identidad (sin selector)');
  t(document.getElementById('orgName').textContent === 'Summit Home Furnishings', 'org: org_name pintado');
  const referral = document.querySelector('a[data-screen="referrals"]');
  const adminNav = document.querySelector('a[data-screen="dealeradmin"]');
  t(!referral.classList.contains('role-hidden'), 'org: ve Referral Codes (data-roles admin org)');
  t(adminNav.classList.contains('role-hidden'), 'org: NO ve el nav de Admin');
  t(document.querySelector('a[data-screen="kitorders"]').classList.contains('role-hidden'), 'org: NO ve Kit Orders (KIT-1, admin-only)');
}

/* sub → NO ve Referral/Stripe/Admin (capabilities), pero sí el shell */
{
  const { document } = await loadPortal({ session: SESSION, me: SUB_ME });
  await sleep(40);
  t(document.querySelector('a[data-screen="referrals"]').classList.contains('role-hidden'), 'sub: NO ve Referral');
  t(document.querySelector('a[data-screen="stripe"]').classList.contains('role-hidden'), 'sub: NO ve Stripe Account');
  t(document.querySelector('a[data-screen="dealeradmin"]').classList.contains('role-hidden'), 'sub: NO ve Admin');
  t(document.querySelector('a[data-screen="kitorders"]').classList.contains('role-hidden'), 'sub: NO ve Kit Orders (KIT-1, admin-only)');
  t(document.getElementById('app').style.display === 'block', 'sub: pero el shell carga (dashboard visible)');
}

/* become-a-reseller → POST con world */
{
  const { window, document, requests } = await loadPortal({});
  document.getElementById('rs-name').value = 'Nash Upholstery';
  document.getElementById('rs-email').value = 'shop@nash.co';
  document.getElementById('rs-world').value = 'technician';
  window.submitReseller();
  await sleep(40);
  const inq = requests.find((r) => r.url.includes('/api/portal-inquiries') && r.method === 'POST');
  t(!!inq, 'inquiry: submit hace POST a /api/portal-inquiries');
  t(inq && inq.body.world === 'technician', 'inquiry: el world viaja en el body (§5.15)');
}

/* login success flow (sin session): doLogin → /api/auth-login → /api/me → shell */
{
  const { window, document } = await loadPortal({ me: ADMIN_ME });
  window.showLogin();
  document.getElementById('login-email').value = 'admin@raptns.com';
  document.getElementById('login-pw').value = 'PortalTest!2026';
  window.doLogin();
  await sleep(150);
  t(document.getElementById('app').style.display === 'block', 'login: doLogin → token → /api/me → app visible');
  t(document.getElementById('userName').textContent === 'Alex Rivera', 'login: identidad hidratada tras el login');
}

/* ── (D) PORT-4: captura terms_version + maya_summary en el checkout ── */
{
  const BASE = { email: 'a@b.co', full_name: 'X Y', phone: '5551234567', address: '1 St', plans: [], kits: [{ sku: 'CARE-WOOD-001', quantity: 1 }] };
  const r = validateCheckout(BASE);
  t(r.ok && r.fields.terms_version === TERMS_VERSION, 'port-4: terms_version estampado server-side (nunca del cliente)');
  t(r.ok && r.fields.maya_summary === null, 'port-4: maya_summary null si no viene');
  const r2 = validateCheckout({ ...BASE, maya_summary: 'Asked about kid stains; confirmed covered.' });
  t(r2.ok && r2.fields.maya_summary === 'Asked about kid stains; confirmed covered.', 'port-4: maya_summary pasa cuando viene');
  const r3 = validateCheckout({ ...BASE, maya_summary: 'x'.repeat(3000) });
  t(r3.ok && r3.fields.maya_summary.length === 2000, 'port-4: maya_summary con cap defensivo (2000)');
}

/* ── (E) PORT-5: mappers de lectura (puros) ── */
{
  const NOW = Date.parse('2026-07-13T00:00:00Z');
  t(programLabel('protection', 'stain_mech') === 'Protection+' && programLabel('membership', null) === 'Membership', 'port-5: programLabel');
  const fl = firstLast('Jane Ann Doe'); t(fl.first === 'Jane' && fl.last === 'Ann Doe', 'port-5: firstLast separa nombre/apellidos');
  t(paymentsSince('2026-05-14T00:00:00Z', NOW) === 3 && paymentsSince(null, NOW) === 0, 'port-5: paymentsSince (meses desde inicio, 0 sin inicio)');
  /* PORT-29a (email Doug 13-ago + "we settled on no limit" 14-ago): el clamp de 36 MURIÓ.
     El mes 40 emite 40 (antes emitía 36 y colisionaba el contract# RX-XXXXX-36). */
  const START = '2023-01-01T00:00:00Z';
  t(paymentsSince(START, Date.parse(START) + 39.5 * 30 * 86400000) === 40, 'PORT-29a: mes 40 → 40 (sin tope)');
  t(paymentsSince(START, Date.parse(START) + 99.5 * 30 * 86400000) === 100, 'PORT-29a: mes 100 → 100 (renueva hasta cancelar)');
  const row = { id: 's1', master_no: 'RX-10001', tier: 'stain', kind: 'protection', status: 'active', started_at: '2026-05-14T00:00:00Z', canceled_at: null, sales_associate: 'A-07', sub_entity_id: 'st1', profiles: { full_name: 'Jane Doe', email: 'j@x.co' } };
  const m = mapSubscriberRow(row, NOW);
  t(m.first_name === 'Jane' && m.last_name === 'Doe' && m.program === 'Protection' && m.status === 'active', 'port-5: mapSubscriberRow campos');
  t(m.contract_number === 'RX-10001-3', 'port-5 (DEC-2): contract# = master + sufijo de un dígito');
  /* PORT-30 (aprobado 14-ago): el sales order # viaja en la fila (y de ahí al CSV del dealer). */
  t(m.sales_order_number === null, 'PORT-30: sin captura → null (celda vacía en el CSV)');
  t(mapSubscriberRow({ ...row, sales_order_number: 'SO-44192' }, NOW).sales_order_number === 'SO-44192', 'PORT-30: capturado → viaja tal cual');
  {
    const fx = src('netlify/functions/portal-exports.mjs');
    t(/sales_order_number,profiles/.test(fx), 'PORT-30: el SELECT del export trae sales_order_number');
    t(/\{ key: 'sales_order_number', label: 'Sales order #' \}/.test(fx), "PORT-30: columna 'Sales order #' en el CSV (tras Contract #)");
    t(fx.indexOf("label: 'Contract #'") < fx.indexOf("label: 'Sales order #'"), 'PORT-30: orden de columnas Contract # → Sales order #');
  }

  const org = deriveScope({ portal_role: 'dealer', org_id: 'o1' });
  const admin = deriveScope({ portal_role: 'admin' });
  const crow = { ...row, sales_order_number: 'SO-1', purchased_on: '2026-05-28', receipt_path: null, terms_version: 'v2026-05', maya_summary: 'note', stripe_subscription_id: 'sub_x', user_id: 'u1', profiles: { full_name: 'Jane Doe', email: 'j@x.co', phone: '555', address: '1 St' } };
  const recOrg = mapCustomerRecord(crow, [], NOW, org);
  t(!('stripe_subscription_id' in recOrg) && recOrg.terms_version === 'v2026-05' && recOrg.contract_number === 'RX-10001-3', 'port-5: ficha org SIN stripe id, con terms + contract#');
  t(mapCustomerRecord(crow, [], NOW, admin).stripe_subscription_id === 'sub_x', 'port-5: ficha admin conserva el stripe id');
}

/* ── (E2) PORT-5: comportamiento del front (jsdom) ── */
{
  const subs = [{ subscription_id: 's1', start_date: '2026-05-14', end_date: null, program: 'Protection', first_name: 'Jane', last_name: 'Doe', payments: 3, status: 'active', contract_number: 'RX-10001-03' }];
  const cust = { first_name: 'Jane', last_name: 'Doe', email: 'j@x.co', phone: '555', address: '1 St', status: 'active', payments: 3, program: 'Protection', order_ref: 'SO-1', contract_number: 'RX-10001-03', terms_version: 'v2026-05', maya_summary: 'Asked about stains.', related_purchases: [] };
  const { window, document } = await loadPortal({ session: SESSION, me: ORG_ME, subscribers: subs, customer: cust });
  await sleep(40);
  window.show('subscribers');
  await sleep(40);
  t(document.querySelectorAll('#subs-body tr').length === 1, 'port-5 front: Subscribers pinta las filas');
  t(/Jane Doe/.test(document.getElementById('subs-body').textContent) && /RX-10001-03/.test(document.getElementById('subs-body').textContent), 'port-5 front: fila con nombre + contract#');
  document.querySelector('#subs-body a.lk').click();
  await sleep(40);
  t(!document.getElementById('cust-card').hidden, 'port-5 front: click View abre la ficha');
  t(/Active RX-10001-03/.test(document.getElementById('cr-contract').textContent) && /Asked about stains/.test(document.getElementById('cr-maya').textContent), 'port-5 front: ficha pinta contract# activo + Maya summary (PORT-24C: header master+activo)');
}

/* ── (F) PORT-6: CSV + audit (puros) ── */
{
  const csv = toCSV([{ a: 'Jane', b: 'x,y' }, { a: 'Bo "B"', b: '2' }], [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Val' }]);
  t(csv.split('\n')[0] === 'Name,Val', 'port-6: CSV header');
  t(/"x,y"/.test(csv) && /"Bo ""B"""/.test(csv), 'port-6: CSV escapa comas y comillas');
  const ar = auditRow({ actor_name: 'Dana', category: 'Export', action: 'Exported', details: 'CSV', org_id: 'o1' });
  t(ar.category === 'Export' && ar.org_id === 'o1' && ar.target === null, 'port-6: auditRow normaliza');
}

/* ── (G) PORT-7: validación de service request (pura) ── */
{
  t(validateServiceRequest({ contract_number: 'RX-1-01', body: 'seam split' }).ok, 'port-7: SR válido');
  t(validateServiceRequest({ body: 'x' }).error === 'invalid_contract', 'port-7: SR sin contract → error');
  t(validateServiceRequest({ contract_number: 'RX-1' }).error === 'invalid_body_text', 'port-7: SR sin texto → error');
}

/* ── (H) PORT-11: dealerCanSell (puro; regresión cero sin org) ── */
{
  const NOW = Date.parse('2026-07-13T00:00:00Z');
  t(dealerCanSell(null, NOW).ok === true, 'port-11: sin dealer → permite (regresión cero)');
  t(dealerCanSell({ selling_enabled: true }, NOW).ok === true, 'port-11: selling_enabled → permite');
  t(dealerCanSell({ selling_enabled: false }, NOW).ok === false, 'port-11: selling_disabled → bloquea');
  t(dealerCanSell({ selling_enabled: true, access_start: '2026-08-01' }, NOW).reason === 'before_window', 'port-11: antes de la ventana → bloquea');
  t(dealerCanSell({ selling_enabled: true, access_end: '2026-07-01' }, NOW).reason === 'after_window', 'port-11: después de la ventana → bloquea');
}

/* ── (I) PORT-6/7: comportamiento front (export gating, audit, service request) ── */
{
  const owner = await loadPortal({ session: SESSION, me: ORG_ME, subscribers: [{ subscription_id: 's1', start_date: '2026-06-01', program: 'Protection', first_name: 'A', last_name: 'B', payments: 1, person_id: 'A-01', store_name: 'X', status: 'active', contract_number: 'RX-10001-01' }] });
  await sleep(30);
  const exBtn = owner.document.querySelector('#view-subscribers button[onclick="exportSubs()"]');
  t(exBtn && !exBtn.classList.contains('role-hidden'), 'port-6 front: owner ve el botón Export');
  owner.window.show('subscribers');   // PORT-24B: el export manda los contracts filtrados → hay que cargar la lista
  await sleep(30);
  owner.window.exportSubs();
  await sleep(30);
  t(owner.requests.some((r) => r.url.includes('/api/portal-exports') && r.method === 'POST'), 'port-6 front: Export dispara POST');

  const store = await loadPortal({ session: SESSION, me: SUB_ME });
  await sleep(30);
  const exBtnS = store.document.querySelector('#view-subscribers button[onclick="exportSubs()"]');
  t(exBtnS && exBtnS.classList.contains('role-hidden'), 'port-6 front: store NO ve el botón Export (capability)');

  const admin = await loadPortal({ session: SESSION, me: ADMIN_ME, audit: [{ at: '2026-07-13T08:04:00Z', actor_name: 'Dana', actor_role: 'dealer', action: 'Exported subscribers', target: 'Summit', details: 'CSV · 3 rows · PII included' }] });
  await sleep(30);
  admin.window.show('audit');
  await sleep(30);
  t(admin.document.querySelectorAll('#audit-body tr').length === 1 && /Exported subscribers/.test(admin.document.getElementById('audit-body').textContent), 'port-6 front: admin Audit Log pinta filas');

  const sr = await loadPortal({ session: SESSION, me: ORG_ME });
  await sleep(30);
  sr.window.show('custrecord');   /* 16-jul: el SR vive DENTRO del Customer Record */
  sr.document.getElementById('sr-contract').value = 'RX-10001-03';
  sr.document.getElementById('sr-body').value = 'Seam split';
  sr.window.submitSR();
  await sleep(30);
  t(sr.requests.some((r) => r.url.includes('/api/portal-service-requests') && r.method === 'POST'), 'port-7 front: submit SR postea');
}

t.done();
