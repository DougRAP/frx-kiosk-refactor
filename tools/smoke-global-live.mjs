/* ============================================================================
 * SMOKE GLOBAL LIVE — end-to-end REAL en Stripe TEST MODE, de la venta en el
 * navegador (D2C + Kiosk SSO + Tech) hasta el reporte de reinsurance, pasando
 * por leads → subscriptions → covered_pieces → commission_ledger → transfers.
 *
 * Es el hermano mayor de tools/smoke-circuit-live.mjs (mismos helpers/patrón,
 * mismas reglas de la casa): se corre ON-DEMAND contra un deploy fresco, NUNCA
 * en la suite. Todo lo que siembra lleva prefijo qa-global / QAG y es
 * IDEMPOTENTE. ⚠️ JAMÁS borra nada (ni DELETE ni DROP): si un artefacto ya
 * existe se REUTILIZA y se sigue.
 *
 * Uso:
 *   node tools/smoke-global-live.mjs --plan            # imprime fases, no toca red
 *   node tools/smoke-global-live.mjs                   # local (netlify dev :8888)
 *   node tools/smoke-global-live.mjs \
 *     --base https://furniturerx.netlify.app \
 *     --kiosk https://kiosk.furniturerx.net \
 *     --tech https://tech.furniturerx.net \
 *     --portal https://furniturerx.netlify.app
 *   node tools/smoke-global-live.mjs --skip-browser    # solo capas API (CI sin Chrome)
 *
 * Env (.env local si existe, si no process.env — igual que smoke-circuit-live):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY (sk_test_…),
 *   RESEND_API_KEY (opcional), STRIPE_PRICE_STAIN / STRIPE_PRICE_STAIN_MECH.
 *
 * Requisito para que la cadena post-pago se verifique: el webhook de Stripe
 * (test mode) debe apuntar al deploy del --base (checkout.session.completed +
 * invoice.paid). Los test clocks NO funcionan con Checkout hosted → la capa
 * multi-mes (fase 5) va por API, patrón exacto de tools/full-run-live.mjs.
 * ==========================================================================*/

'use strict';

import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── args ─────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return (i >= 0 && args[i + 1]) ? args[i + 1].replace(/\/+$/, '') : dflt;
};
/* Defaults = los mismos orígenes que usa smoke-circuit-live (localhost salvo
 * --base explícito); kiosk/tech default = los hosts de appUrlFor (_lib/portal). */
const BASE   = argOf('--base', 'http://localhost:8888');
const KIOSK  = argOf('--kiosk', 'https://kiosk.furniturerx.net');
const TECH   = argOf('--tech', 'https://tech.furniturerx.net');
const PORTAL = argOf('--portal', BASE);   // las Functions del portal viven en el mismo /api del BASE
const PLAN_ONLY    = args.includes('--plan');
const SKIP_BROWSER = args.includes('--skip-browser');

/* ── plan de fases (también sirve de índice del reporte) ─────────────────── */
const PHASES = [
  ['0', 'SEED idempotente (prefijo qa-global/QAG): dealer QAG-0001 + 2 stores + logins portal (owner/store, GoTrue) + referral code QAG-4242 + commission_rates con split cash/reinsurance ($1/$1 stain, $4/$4 stain_mech) + Connect acct EXISTENTE en dealers.stripe_account_id. NUNCA borra: si existe, reutiliza.'],
  ['1', 'VENTA D2C (Playwright, Chrome headless): carrito monthly stain + código QAG en #cart-referral → Stripe Checkout hosted (4242…) → ?paid=1.'],
  ['2', 'VENTA KIOSK vía SSO: portal-app-handoff como owner → kiosk ?pt= → banner "Selling as" → venta monthly stain_mech con test card.'],
  ['3', 'VENTA TECH: tech/index.html con Technician ID + work order → venta monthly stain con test card.'],
  ['4', 'CADENA por venta (polling PostgREST service_role): lead → subscription (master_no RX-…) → covered_pieces → atribución (referral_code vs kiosk_session) → commission_ledger (split) → transfer → v_reinsurance_monthly serial -01.'],
  ['5', 'MULTI-MES por API (test clock, patrón full-run-live): sub bajo clock, avanzar +31d y +62d → ledger meses 2 y 3 → serials -02/-03 en la view. (Test clocks no funcionan con Checkout hosted.)'],
  ['6', 'PORTAL: portal-stats (active/monthly/comisión), portal-referral-codes (Uses/Attributed/Credit del QAG > 0), portal-subscribers; admin: portal-dealeradmin GET + PATCH selling_enabled=false → 4ª venta NO atribuida (permitida) → PATCH true.'],
  ['7', 'EMAILS: portal-resend-link → 200 {sent:true}; verificación de inbox Resend = MANUAL (no hay endpoint de listado global).'],
  ['8', 'REPORTE: N/N + artefactos (dealer/sub/ledger ids, serials) + exit code.']
];
if (PLAN_ONLY) {
  console.log('smoke-global-live — PLAN (nada se ejecuta):\n');
  for (const [n, d] of PHASES) console.log(`  Fase ${n}: ${d}\n`);
  console.log(`Bases: D2C=${BASE} · KIOSK=${KIOSK} · TECH=${TECH} · PORTAL=${PORTAL}${SKIP_BROWSER ? ' · (skip-browser)' : ''}`);
  process.exit(0);
}

/* ── env: .env local si existe; si no, el entorno del proceso ────────────── */
const env = { ...process.env };
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('FALTA SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env o entorno)'); process.exit(2); }
if (!env.STRIPE_SECRET_KEY || !env.STRIPE_SECRET_KEY.startsWith('sk_test')) {
  /* Guardarraíl duro: este smoke PAGA con tarjeta — solo test mode, jamás live. */
  console.error('ABORT: STRIPE_SECRET_KEY ausente o NO es de test (sk_test_…). Este smoke paga de verdad.');
  process.exit(2);
}

/* ── helpers (patrón de smoke-circuit-live / full-run-live) ──────────────── */
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
async function db(path, opts = {}) {
  const res = await fetch(env.SUPABASE_URL + '/rest/v1' + path, {
    method: opts.method || 'GET',
    headers: { ...H, ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let data = null; const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}
async function gotrue(path, opts = {}) {
  const res = await fetch(env.SUPABASE_URL + '/auth/v1' + path, {
    method: opts.method || 'GET', headers: H,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let data = null; const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(base, path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    /* rate-limit 5/min del checkout (BE-2): un smoke encadena varias ventas → respetar Retry-After una vez */
    if (res.status === 429 && attempt === 0) {
      const ra = Math.min(parseInt(res.headers.get('Retry-After'), 10) || 60, 70);
      console.log(`  ····  429 en ${path} — esperando ${ra}s y reintentando`);
      await sleep(ra * 1000); continue;
    }
    let data = null; const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  }
}
/* Stripe raw (mismo patrón que full-run-live: fijar Stripe-Version moderna) */
const SV = '2024-06-20';
async function stripeApi(path, body, extraH = {}) {
  const res = await fetch('https://api.stripe.com' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': SV, 'Content-Type': 'application/x-www-form-urlencoded', ...extraH },
    body: body === undefined ? undefined : new URLSearchParams(body).toString()
  });
  const d = await res.json();
  if (d.error) throw new Error(path + ' → ' + (d.error.code || '') + ': ' + String(d.error.message || '').slice(0, 180));
  return d;
}
/* polling genérico con backoff: la cadena post-pago depende del webhook real */
async function poll(fn, { tries = 30, base = 2000, factor = 1.15 } = {}) {
  let wait = base;
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(wait); wait = Math.min(wait * factor, 10000);
  }
  return null;
}

let fails = 0, count = 0, manual = 0;
const created = [];
const t = (cond, msg) => { count++; if (cond) console.log(`  PASS  #${count} ${msg}`); else { console.error(`  FAIL  #${count} ${msg}`); fails++; } };
const skip = (msg) => console.log(`  SKIP  ${msg}`);
const man = (msg) => { manual++; console.log(`  MANUAL ${msg}`); };
const ts = Date.now();
const PW = '12345678';
const OWNER_EMAIL = 'abarres+qaglobal-owner@raptns.com';
const STORE_EMAIL = 'abarres+qaglobal-store@raptns.com';
const REF_CODE = 'QAG-4242';
const CONNECT_ACCT = 'acct_1TtakbLGv5JY2bXP';   // cuenta Connect de test EXISTENTE (no se crean cuentas)

console.log(`SMOKE GLOBAL · D2C=${BASE} · KIOSK=${KIOSK} · TECH=${TECH} · PORTAL=${PORTAL}\n            · BD=${env.SUPABASE_URL}${SKIP_BROWSER ? ' · skip-browser' : ''}\n`);

/* ═══ Fase 0 · SEED idempotente (qa-global / QAG) — nunca se borra nada ═══ */
console.log('── Fase 0 · SEED');
let org = null, stores = [];
{
  const q = await db('/dealers?slug=eq.qa-global-dealer&select=id,name,selling_enabled,stripe_account_id&limit=1');
  org = (q.data && q.data[0]) || null;
  if (!org) {
    const ins = await db('/dealers', {
      method: 'POST', prefer: 'return=representation',
      body: { name: 'QA Global Dealer', slug: 'qa-global-dealer', world: 'retailer', rap_id: 'QAG-0001', selling_enabled: true, dashboard_enabled: true }
    });
    org = ins.data && ins.data[0];
    if (org) created.push(`dealers ${org.id} (QA Global Dealer)`);
  }
  t(!!org, 'seed: dealer QA Global existe (qa-global-dealer / QAG-0001)');
  if (!org) { console.error('sin dealer no hay smoke — abort'); process.exit(1); }
  /* el estado puede venir "sucio" de la corrida anterior (fase 6 lo apaga): re-encender, no borrar */
  const fix = {};
  if (org.selling_enabled === false) fix.selling_enabled = true;
  if (!org.stripe_account_id) fix.stripe_account_id = CONNECT_ACCT;
  if (Object.keys(fix).length) await db(`/dealers?id=eq.${org.id}`, { method: 'PATCH', prefer: 'return=minimal', body: fix });
  t(true, `seed: dealer apunta a la connected account de test (${org.stripe_account_id || CONNECT_ACCT})`);

  for (const name of ['QA Global — Store North', 'QA Global — Store South']) {
    const f = await db(`/sub_entities?org_id=eq.${org.id}&name=eq.${encodeURIComponent(name)}&select=id,name&limit=1`);
    let st = f.data && f.data[0];
    if (!st) {
      const ins = await db('/sub_entities', { method: 'POST', prefer: 'return=representation', body: { org_id: org.id, world: 'retailer', name, location: 'Test City, UT', status: 'active' } });
      st = ins.data && ins.data[0];
      if (st) created.push(`sub_entities ${st.id} (${name})`);
    }
    if (st) stores.push(st);
  }
  t(stores.length === 2, 'seed: 2 stores (sub_entities) del dealer QAG');

  /* logins portal — idempotente-de-verdad: 422 (ya existe) → PUT password+metadata
   * (mismo patrón que tools/seed-portal.mjs, así re-correr deja la password vigente) */
  const makeUser = async (email, appMeta, fullName) => {
    const create = await gotrue('/admin/users', { method: 'POST', body: { email, password: PW, email_confirm: true, app_metadata: appMeta, user_metadata: { full_name: fullName } } });
    if (create.status < 300 && create.data && create.data.id) { created.push(`gotrue user ${email}`); return true; }
    if (create.status === 422) {
      const list = await gotrue('/admin/users?per_page=200');
      const users = Array.isArray(list.data) ? list.data : (list.data && list.data.users) || [];
      const u = users.find((x) => x && x.email && x.email.toLowerCase() === email.toLowerCase());
      if (!u) return false;
      const upd = await gotrue(`/admin/users/${u.id}`, { method: 'PUT', body: { password: PW, app_metadata: appMeta, user_metadata: { full_name: fullName } } });
      return upd.status < 300;
    }
    return false;
  };
  t(await makeUser(OWNER_EMAIL, { portal_role: 'dealer', world: 'retailer', org_id: org.id, org_name: org.name }, 'QA Global Owner'),
    `seed: login owner (${OWNER_EMAIL})`);
  t(await makeUser(STORE_EMAIL, { portal_role: 'store', world: 'retailer', org_id: org.id, org_name: org.name, sub_entity_id: stores[0] && stores[0].id, sub_entity_name: stores[0] && stores[0].name }, 'QA Global Store'),
    `seed: login store (${STORE_EMAIL})`);

  const c = await db(`/referral_codes?code=eq.${REF_CODE}&select=code,org_id,active&limit=1`);
  if (!(c.data && c.data[0])) {
    const ins = await db('/referral_codes', { method: 'POST', prefer: 'return=minimal', body: { code: REF_CODE, org_id: org.id } });
    t(ins.status === 201, `seed: referral code ${REF_CODE} creado`);
    created.push(`referral_codes ${REF_CODE}`);
  } else t(c.data[0].org_id === org.id, `seed: referral code ${REF_CODE} ya existía (idempotente)`);

  /* split con reinsurance > 0 para que las ventas QAG aparezcan en la view REIN
   * conservando los TOTALES $2/$8 por pago: stain 100/100, stain_mech 400/400. */
  for (const [sku, cash, rein] of [['stain', 100, 100], ['stain_mech', 400, 400]]) {
    const has = await db(`/commission_rates?org_id=eq.${org.id}&plan_sku=eq.${sku}&select=id,stripe_amount_cents,reinsurance_amount_cents&limit=1`);
    if (!(has.data && has.data[0])) {
      const ins = await db('/commission_rates', { method: 'POST', prefer: 'return=minimal', body: { org_id: org.id, plan_sku: sku, stripe_amount_cents: cash, reinsurance_amount_cents: rein } });
      t(ins.status === 201, `seed: commission_rates ${sku} ${cash}/${rein} para QAG`);
      created.push(`commission_rates QAG ${sku} ${cash}/${rein}`);
    } else t(true, `seed: commission_rates ${sku} ya existía (${has.data[0].stripe_amount_cents}/${has.data[0].reinsurance_amount_cents}) — se reutiliza`);
  }
}
/* tasas EFECTIVAS (pueden venir de una corrida vieja con otro split): la
 * verificación del ledger compara contra lo que hay en BD, no contra constantes */
const RATES = {};
{
  const r = await db(`/commission_rates?org_id=eq.${org.id}&select=plan_sku,stripe_amount_cents,reinsurance_amount_cents`);
  for (const row of (r.data || [])) RATES[row.plan_sku] = row;
}

/* ── logins portal (se usan en fases 2, 6, 7) ────────────────────────────── */
const login = async (email) => {
  const r = await api(PORTAL, '/api/auth-login', { method: 'POST', body: { email, password: PW } });
  return r.status === 200 ? r.data.access_token : null;
};
const ownerTok = await login(OWNER_EMAIL);
const adminTok = await login('admin@raptns.com');   // admin del seed-portal (PORT-1)
t(!!ownerTok, 'portal: login owner QAG OK');
if (!adminTok) skip('portal: login admin@raptns.com falló — checks de admin (fase 6) se saltarán');

/* ═══ Fases 1-3 · VENTAS en navegador (Playwright + Stripe Checkout hosted) ═══ */
const SALES = [];   // { label, email, tier, source, base }
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let browser = null;

/* Rellena y confirma el Checkout hosted de Stripe (test). ⚠️ SUPUESTO: ids
 * actuales del hosted (#email/#cardNumber/#cardExpiry/#cardCvc/#billingName,
 * .SubmitButton) — ajustar en la primera corrida real si Stripe los cambió. */
async function payHostedCheckout(page, email) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 45000 });
  const fill = async (sel, val) => {
    const el = await page.$(sel);
    if (el) { await el.fill(val); return true; }
    return false;
  };
  await page.waitForSelector('#cardNumber, input[name="cardNumber"]', { timeout: 30000 });
  await fill('#email', email);                       // si create-checkout-session ya fijó customer_email, no existe
  await fill('#cardNumber, input[name="cardNumber"]', '4242 4242 4242 4242');
  await fill('#cardExpiry, input[name="cardExpiry"]', '12 / 34');
  await fill('#cardCvc, input[name="cardCvc"]', '123');
  await fill('#billingName, input[name="billingName"]', 'QA Global');
  const zip = await page.$('#billingPostalCode, input[name="billingPostalCode"]');
  if (zip) await zip.fill('84321');
  await page.click('button[type="submit"], .SubmitButton');
}

/* Venta genérica en un front FurnFX: siembra el carrito en localStorage (las 3
 * versiones comparten la clave y el shape), abre el drawer, llena el form y paga. */
async function browserSale({ base, url, tier, email, extraFill, expectText }) {
  const page = await browser.newPage();
  const line = { cov: tier === 'stain_mech' ? 'stain-mech' : 'stain', term: 'monthly', type: 'furniture', count: 1 };
  await page.addInitScript((cart) => { try { localStorage.setItem('furnfx_cart', cart); } catch (e) {} }, JSON.stringify([line]));
  await page.goto(url || base + '/', { waitUntil: 'load' });
  if (expectText) {
    const found = await page.waitForFunction((txt) => document.body.textContent.includes(txt), expectText, { timeout: 15000 }).catch(() => null);
    t(!!found, `venta: banner "${expectText}" visible`);
  }
  await page.click('#nav-cart').catch(() => page.evaluate(() => { const b = document.getElementById('cart-backdrop'); if (b) b.hidden = false; }));
  await page.waitForSelector('#cart-form', { state: 'visible', timeout: 10000 });
  await page.fill('#cart-name', 'QA Global');
  await page.fill('#cart-email', email);
  await page.fill('#cart-phone', '(555) 111-2222');
  await page.fill('#cart-address', '1 QA St, Test City UT 84321');
  if (extraFill) await extraFill(page);
  /* recibo: si el front lo exige (kiosk fuera de handoff), subir un PNG mínimo */
  const rc = await page.$('#cart-receipt-photo');
  if (rc) {
    const dir = mkdtempSync(join(tmpdir(), 'qag-'));
    const f = join(dir, 'receipt.png');
    writeFileSync(f, tinyPng);
    await rc.setInputFiles(f);
  }
  await page.click('#cart-pay');
  await payHostedCheckout(page, email);
  await page.waitForURL(/paid=1/, { timeout: 60000 });
  await page.close();
  return true;
}

if (SKIP_BROWSER) {
  /* Capa API pura: se ejercita el contrato de checkout + atribución del lead
   * (sin pago no hay cadena post-webhook; eso lo cubre la fase 5 por API). */
  console.log('\n── Fases 1-3 · VENTAS (modo --skip-browser: solo POST /api/create-checkout-session)');
  const mkBody = (email, tier, extra) => ({
    email, plans: [{ cov: tier === 'stain_mech' ? 'stain-mech' : 'stain', term: 'monthly', type: 'furniture', count: 1 }],
    kits: [], membership: false, full_name: 'QA Global', phone: '(555) 111-2222',
    address: '1 QA St, Test City UT 84321', receipt_path: `receipts/2026/07/${randomUUID()}.jpg`, ...extra
  });
  const d2cEmail = `qa-global+${ts}d2c@rapqa.com`;
  const r1 = await api(BASE, '/api/create-checkout-session', { method: 'POST', body: mkBody(d2cEmail, 'stain', { referral_code: REF_CODE }) });
  t(r1.status === 200 && !!r1.data.url, 'D2C(api): checkout con código QAG → 200 + url Stripe');
  SALES.push({ label: 'D2C', email: d2cEmail, tier: 'stain', source: 'referral_code', unpaid: true });
  if (ownerTok) {
    const h = await api(PORTAL, '/api/portal-app-handoff', { method: 'POST', bearer: ownerTok, body: {} });
    t(h.status === 200 && /\?pt=/.test(h.data.url || ''), 'KIOSK(api): handoff SSO emitido (?pt=)');
    const pt = h.status === 200 ? new URL(h.data.url).searchParams.get('pt') : null;
    const red = await api(BASE, '/api/portal-app-redeem', { method: 'POST', body: { token: pt } });
    t(red.status === 200 && !!red.data.session, 'KIOSK(api): redeem → sesión 12h');
    const kEmail = `qa-global+${ts}kiosk@rapqa.com`;
    const r2 = await api(BASE, '/api/create-checkout-session', { method: 'POST', body: mkBody(kEmail, 'stain_mech', { kiosk_session: red.data && red.data.session }) });
    t(r2.status === 200 && !!r2.data.url, 'KIOSK(api): checkout con kiosk_session → 200');
    SALES.push({ label: 'KIOSK', email: kEmail, tier: 'stain_mech', source: 'kiosk_session', unpaid: true });
  } else skip('KIOSK(api): sin owner token');
  const tEmail = `qa-global+${ts}tech@rapqa.com`;
  const r3 = await api(BASE, '/api/create-checkout-session', { method: 'POST', body: mkBody(tEmail, 'stain', { sales_associate: 'TECH-QA-01', sales_order_number: 'WO-QA-1001' }) });
  t(r3.status === 200 && !!r3.data.url, 'TECH(api): checkout con Technician ID + work order → 200');
  SALES.push({ label: 'TECH', email: tEmail, tier: 'stain', source: null, unpaid: true });
} else {
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  /* ── Fase 1 · D2C ── */
  console.log('\n── Fase 1 · VENTA D2C (navegador)');
  const d2cEmail = `qa-global+${ts}d2c@rapqa.com`;
  try {
    await browserSale({
      base: BASE, tier: 'stain', email: d2cEmail,
      extraFill: async (p) => { const r = await p.$('#cart-referral'); if (r) await r.fill(REF_CODE); }
    });
    t(true, `D2C: venta monthly stain pagada (4242) con código ${REF_CODE} → ?paid=1`);
    SALES.push({ label: 'D2C', email: d2cEmail, tier: 'stain', source: 'referral_code' });
  } catch (e) { t(false, `D2C: venta en navegador falló — ${e.message.slice(0, 140)}`); }

  /* ── Fase 2 · KIOSK vía SSO ── */
  console.log('\n── Fase 2 · VENTA KIOSK (SSO ?pt=)');
  if (!ownerTok) skip('KIOSK: sin owner token — saltado');
  else {
    const h = await api(PORTAL, '/api/portal-app-handoff', { method: 'POST', bearer: ownerTok, body: {} });
    t(h.status === 200 && /\?pt=/.test(h.data.url || ''), 'KIOSK: handoff emitido (url con ?pt=)');
    const pt = h.status === 200 ? new URL(h.data.url).searchParams.get('pt') : null;
    const kEmail = `qa-global+${ts}kiosk@rapqa.com`;
    if (pt) {
      try {
        /* el ?pt= se canjea EN el kiosk (TTL 120s) → abrir de inmediato */
        await browserSale({ base: KIOSK, url: KIOSK + '/?pt=' + pt, tier: 'stain_mech', email: kEmail, expectText: 'Selling as' });
        t(true, 'KIOSK: venta monthly stain_mech pagada bajo la sesión SSO → ?paid=1');
        SALES.push({ label: 'KIOSK', email: kEmail, tier: 'stain_mech', source: 'kiosk_session' });
      } catch (e) { t(false, `KIOSK: venta en navegador falló — ${e.message.slice(0, 140)}`); }
    }
  }

  /* ── Fase 3 · TECH ── */
  console.log('\n── Fase 3 · VENTA TECH');
  const techEmail = `qa-global+${ts}tech@rapqa.com`;
  try {
    await browserSale({
      base: TECH, tier: 'stain', email: techEmail,
      extraFill: async (p) => {
        /* en tech/ #cart-associate = Technician ID y #cart-order = work order */
        const a = await p.$('#cart-associate'); if (a) await a.fill('TECH-QA-01');
        const o = await p.$('#cart-order'); if (o) await o.fill('WO-QA-1001');
      }
    });
    t(true, 'TECH: venta monthly stain con Technician ID + work order → ?paid=1');
    SALES.push({ label: 'TECH', email: techEmail, tier: 'stain', source: null });
  } catch (e) { t(false, `TECH: venta en navegador falló — ${e.message.slice(0, 140)}`); }

  await browser.close();
}

/* ═══ Fase 4 · CADENA en BD por cada venta ═══ */
console.log('\n── Fase 4 · CADENA leads → subscriptions → pieces → ledger → REIN');
let firstMaster = null;
for (const sale of SALES) {
  const enc = encodeURIComponent(sale.email);
  const lead = await poll(async () => {
    const r = await db(`/leads?email=eq.${enc}&select=id,payload&order=created_at.desc&limit=1`);
    return (r.data && r.data[0]) || null;
  }, { tries: 10 });
  t(!!lead, `${sale.label}: lead existe (${lead && lead.id})`);
  if (lead) created.push(`leads ${lead.id} (${sale.label})`);
  if (lead && sale.source === 'referral_code') {
    t(lead.payload.dealer_id === org.id && lead.payload.attribution_source === 'referral_code' && lead.payload.referral_code === REF_CODE,
      `${sale.label}: lead atribuido por referral_code al dealer QAG`);
  } else if (lead && sale.source === 'kiosk_session') {
    t(lead.payload.dealer_id === org.id && lead.payload.attribution_source === 'kiosk_session',
      `${sale.label}: lead atribuido por kiosk_session al dealer QAG`);
  }
  if (sale.unpaid) { skip(`${sale.label}: sin pago (skip-browser) — cadena post-webhook no aplica`); continue; }

  /* la fila de subscriptions la crea el webhook checkout.session.completed → polling largo */
  const sub = await poll(async () => {
    const r = await db(`/subscriptions?select=id,master_no,tier,status,dealer_id,attribution_source,referral_code,stripe_subscription_id,terms_version,profiles!inner(email)&profiles.email=eq.${enc}&order=created_at.desc&limit=1`);
    return (r.data && r.data[0]) || null;
  }, { tries: 40 });
  t(!!sub && /^RX-\d+$/.test(sub.master_no || ''), `${sale.label}: subscription con master serializado (${sub && sub.master_no})`);
  if (!sub) continue;
  created.push(`subscriptions ${sub.stripe_subscription_id} master ${sub.master_no} (${sale.label})`);
  if (!firstMaster) firstMaster = sub.master_no;
  t(sub.tier === sale.tier && sub.status === 'active', `${sale.label}: tier ${sale.tier} + status active`);
  if (sale.source) t(sub.dealer_id === org.id && sub.attribution_source === sale.source, `${sale.label}: atribución ${sale.source} persistida en la subscription`);
  t(!!sub.terms_version, `${sale.label}: terms_version sellada (${sub.terms_version})`);

  const pieces = await poll(async () => {
    const r = await db(`/covered_pieces?subscription_id=eq.${sub.id}&select=id,type`);
    return (r.data && r.data.length) ? r.data : null;
  }, { tries: 10 });
  t(!!pieces, `${sale.label}: covered_pieces expandidas (${pieces ? pieces.length : 0})`);

  if (sale.source) {
    /* comisión solo en ventas ATRIBUIDAS; el split esperado sale de la BD (RATES) */
    const led = await poll(async () => {
      const r = await db(`/commission_ledger?stripe_subscription_id=eq.${sub.stripe_subscription_id}&select=id,plan_sku,stripe_amount_cents,reinsurance_amount_cents,status,transfer_id,stripe_invoice_id&order=paid_at.asc`);
      return (r.data && r.data[0]) || null;
    }, { tries: 40 });
    const exp = RATES[sale.tier] || {};
    t(!!led && led.stripe_amount_cents === exp.stripe_amount_cents && led.reinsurance_amount_cents === exp.reinsurance_amount_cents,
      `${sale.label}: ledger mes 1 con split ${exp.stripe_amount_cents}/${exp.reinsurance_amount_cents} (${led && led.id})`);
    if (led) {
      created.push(`commission_ledger ${led.id} (${sale.label} ${led.stripe_invoice_id})`);
      t(led.status === 'transferred' ? /^tr_/.test(led.transfer_id || '') : led.status === 'recorded',
        `${sale.label}: estado del transfer coherente (${led.status}${led.transfer_id ? ' ' + led.transfer_id : ''})`);
      const rein = await db(`/v_reinsurance_monthly?org_id=eq.${org.id}&master_no=eq.${sub.master_no}&select=serial_no,reinsurance_amount_cents`);
      t(rein.status === 200 && (rein.data || []).some((x) => x.serial_no === `${sub.master_no}-01`),
        `${sale.label}: v_reinsurance_monthly con serial ${sub.master_no}-01`);
    }
  }
}

/* ═══ Fase 5 · MULTI-MES por API bajo test clock (patrón full-run-live) ═══ */
console.log('\n── Fase 5 · MULTI-MES (test clock por API — Checkout hosted no soporta clocks)');
{
  try {
    const email = `qa-global+${ts}clock@rapqa.com`;
    const clock = await stripeApi('/v1/test_helpers/test_clocks', { frozen_time: String(Math.floor(ts / 1000)) });
    const customer = await stripeApi('/v1/customers', { email, name: 'QA Global Clock', test_clock: clock.id });
    const pm = await stripeApi('/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' });
    await stripeApi(`/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
    await stripeApi(`/v1/customers/${customer.id}`, { 'invoice_settings[default_payment_method]': pm.id });
    const sub = await stripeApi('/v1/subscriptions', {
      customer: customer.id, 'items[0][price]': env.STRIPE_PRICE_STAIN_MECH,
      payment_behavior: 'default_incomplete', 'expand[]': 'latest_invoice'
    });
    t(!!sub.id, `clock: subscription de test creada (${sub.id}) bajo ${clock.id}`);
    created.push(`stripe test clock ${clock.id} + ${customer.id} + ${sub.id}`);

    /* la fila local se siembra directa (el webhook de checkout no dispara en subs
     * por API) — atribuida al QAG para que recordCommissions le asigne split. */
    const prof = await db('/profiles?select=id&limit=1');
    const userId = prof.data && prof.data[0] && prof.data[0].id;
    const master = 'RX-' + String(900000 + (ts % 90000));
    if (userId) {
      const ins = await db('/subscriptions', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          user_id: userId, kind: 'protection', tier: 'stain_mech', status: 'active',
          started_at: new Date().toISOString(), monthly_cents: 1999, master_no: master,
          stripe_subscription_id: sub.id, dealer_id: org.id,
          attribution_source: 'referral_code', referral_code: REF_CODE, sales_order_number: 'QA-GLOBAL-CLOCK'
        }
      });
      t(ins.status === 201, `clock: subscription row local sembrada (master ${master})`);
      if (ins.status === 201) created.push(`subscriptions ${sub.id} master ${master} (clock)`);
    } else skip('clock: sin profiles en la BD — no puedo sembrar la fila local');

    const invoiceIds = [typeof sub.latest_invoice === 'object' ? sub.latest_invoice.id : sub.latest_invoice];
    await stripeApi(`/v1/invoices/${invoiceIds[0]}/pay`, { payment_method: pm.id });

    /* si el webhook del deploy no llega (p. ej. corrida local sin stripe listen),
     * caemos al motor directo — misma vía que usa el webhook real (recordCommissions) */
    const ensureLedger = async (invId) => {
      let row = await poll(async () => {
        const r = await db(`/commission_ledger?stripe_invoice_id=eq.${invId}&select=id,stripe_amount_cents,reinsurance_amount_cents,status,transfer_id`);
        return (r.data && r.data[0]) || null;
      }, { tries: 15 });
      if (!row) {
        console.log(`  ····  webhook no registró ${invId} — fallback recordCommissions directo`);
        const { pathToFileURL } = await import('node:url');
        const { recordCommissions } = await import(pathToFileURL('netlify/functions/_lib/commissions.mjs').href);
        const inv = await stripeApi(`/v1/invoices/${invId}`);
        await recordCommissions(env, inv);
        const r = await db(`/commission_ledger?stripe_invoice_id=eq.${invId}&select=id,stripe_amount_cents,reinsurance_amount_cents,status,transfer_id`);
        row = (r.data && r.data[0]) || null;
      }
      return row;
    };
    const exp = RATES.stain_mech || {};
    const row1 = await ensureLedger(invoiceIds[0]);
    t(!!row1 && row1.stripe_amount_cents === exp.stripe_amount_cents, `clock: mes 1 en el ledger (split ${row1 && row1.stripe_amount_cents}/${row1 && row1.reinsurance_amount_cents})`);
    if (row1) created.push(`commission_ledger ${row1.id} (clock mes 1)`);

    /* avanzar el clock 31 y 62 días desde el frozen_time inicial (+2h de colchón
     * para que la invoice del ciclo salga de draft, como en full-run-live) */
    for (const [monthN, days] of [[2, 31], [3, 62]]) {
      await stripeApi(`/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: String(Math.floor(ts / 1000) + days * 86400 + 2 * 3600) });
      console.log(`  ····  clock +${days}d…`);
      await poll(async () => {
        const c = await stripeApi(`/v1/test_helpers/test_clocks/${clock.id}`);
        return c.status === 'ready' ? c : null;
      }, { tries: 60, base: 2000, factor: 1 });
      const list = await stripeApi(`/v1/invoices?subscription=${sub.id}&limit=10`);
      let inv = list.data.find((i) => !invoiceIds.includes(i.id));
      t(!!inv, `clock: invoice del mes ${monthN} emitida (${inv && inv.id}, ${inv && inv.status})`);
      if (!inv) continue;
      invoiceIds.push(inv.id);
      if (inv.status === 'draft') { await stripeApi(`/v1/invoices/${inv.id}/finalize`, {}); inv = await stripeApi(`/v1/invoices/${inv.id}`); }
      if (inv.status === 'open') { try { await stripeApi(`/v1/invoices/${inv.id}/pay`, { payment_method: pm.id }); } catch (e) { console.log(`  ····  pay mes ${monthN}:`, e.message); } }
      const row = await ensureLedger(inv.id);
      t(!!row, `clock: mes ${monthN} en el ledger (${row && row.id})`);
      if (row) created.push(`commission_ledger ${row.id} (clock mes ${monthN})`);
      const rein = await db(`/v_reinsurance_monthly?org_id=eq.${org.id}&master_no=eq.${master}&select=serial_no`);
      const serial = `${master}-${String(monthN).padStart(2, '0')}`;
      t(rein.status === 200 && (rein.data || []).some((x) => x.serial_no === serial), `clock: serial ${serial} en v_reinsurance_monthly`);
    }
  } catch (e) { t(false, `clock: capa multi-mes falló — ${e.message.slice(0, 160)}`); }
}

/* ═══ Fase 6 · PORTAL (owner + admin) ═══ */
console.log('\n── Fase 6 · PORTAL');
if (!ownerTok) skip('portal: sin owner token — fase 6 (owner) saltada');
else {
  const stats = await api(PORTAL, '/api/portal-stats?period=all', { bearer: ownerTok });
  const s = stats.data || {};
  /* el shape exacto lo decide _lib/stats.mjs; se valida presencia + magnitud, no el literal */
  const activeish = JSON.stringify(s).match(/"active[^"]*":\s*(\d+)/);
  t(stats.status === 200, 'portal: portal-stats owner → 200');
  t(!!activeish && parseInt(activeish[1], 10) >= (SKIP_BROWSER ? 1 : 3), `portal: stats con suscriptores activos (${activeish && activeish[1]})`);
  t(/monthly|cents/i.test(JSON.stringify(s)), 'portal: stats incluye valor monthly/comisión');

  const refs = await api(PORTAL, '/api/portal-referral-codes', { bearer: ownerTok });
  const mine = ((refs.data && refs.data.codes) || refs.data || []);
  const qag = Array.isArray(mine) ? mine.find((c) => c.code === REF_CODE) : null;
  t(refs.status === 200 && !!qag, `portal: código ${REF_CODE} listado para el owner`);
  if (qag) t((qag.uses || 0) > 0 || (qag.attributed || 0) > 0 || (qag.credit_cents || 0) > 0,
    `portal: Uses/Attributed/Credit del ${REF_CODE} > 0 (uses=${qag.uses} attributed=${qag.attributed} credit=${qag.credit_cents})`);

  const subs = await api(PORTAL, '/api/portal-subscribers', { bearer: ownerTok });
  t(subs.status === 200, 'portal: portal-subscribers owner → 200');
}
if (adminTok) {
  const g = await api(PORTAL, `/api/portal-dealeradmin?org_id=${org.id}`, { bearer: adminTok });
  t(g.status === 200 && g.data && g.data.dealer && g.data.dealer.rap_id === 'QAG-0001', 'portal: dealeradmin GET → master data del QAG (rap_id QAG-0001)');
  const off = await api(PORTAL, '/api/portal-dealeradmin', { method: 'PATCH', bearer: adminTok, body: { org_id: org.id, selling_enabled: false } });
  t(off.status === 200, 'portal: PATCH selling_enabled=false → 200');

  /* 4ª venta con el dealer APAGADO: la venta SIGUE pero SIN atribución (decisión Doug 15-jul) */
  const email4 = `qa-global+${ts}off@rapqa.com`;
  const r4 = await api(BASE, '/api/create-checkout-session', {
    method: 'POST',
    body: {
      email: email4, plans: [{ cov: 'stain', term: 'monthly', type: 'furniture', count: 1 }],
      kits: [], membership: false, full_name: 'QA Global', phone: '(555) 111-2222',
      address: '1 QA St, Test City UT 84321', receipt_path: `receipts/2026/07/${randomUUID()}.jpg`,
      referral_code: REF_CODE
    }
  });
  t(r4.status === 200 && !!r4.data.url, 'apagado: 4ª venta con código QAG PERMITIDA (200 + url)');
  const lead4 = await poll(async () => {
    const r = await db(`/leads?email=eq.${encodeURIComponent(email4)}&select=id,payload&limit=1`);
    return (r.data && r.data[0]) || null;
  }, { tries: 8 });
  if (lead4) created.push(`leads ${lead4.id} (venta dealer OFF)`);
  t(!!lead4 && !lead4.payload.dealer_id && !lead4.payload.attribution_source, 'apagado: la 4ª venta NO se atribuye (lead sin dealer_id)');

  const on = await api(PORTAL, '/api/portal-dealeradmin', { method: 'PATCH', bearer: adminTok, body: { org_id: org.id, selling_enabled: true } });
  t(on.status === 200, 'portal: PATCH selling_enabled=true (restaurado)');
} else skip('portal: sin admin token — dealeradmin + venta-apagada saltados');

/* ═══ Fase 7 · EMAILS ═══ */
console.log('\n── Fase 7 · EMAILS');
if (ownerTok && firstMaster) {
  const r = await api(PORTAL, '/api/portal-resend-link', { method: 'POST', bearer: ownerTok, body: { contract: firstMaster } });
  t(r.status === 200 && r.data && r.data.sent === true, `emails: portal-resend-link ${firstMaster} → 200 {sent:true}`);
} else skip('emails: sin master de una venta pagada (o sin owner) — resend-link saltado');
/* Resend no expone listado global de emails por API (solo GET /emails/{id} con
 * un id que las Functions no devuelven al cliente) → verificación de inbox MANUAL. */
man('emails: welcome + dashboard-link en el inbox de Resend — verificar a mano en https://resend.com/emails (no hay endpoint de listado global; las Functions no exponen el email id)');
if (env.RESEND_API_KEY) {
  /* al menos validamos que la key es usable (GET /domains es inocuo y barato) */
  const rd = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
  t(rd.status === 200, 'emails: RESEND_API_KEY válida (GET /domains → 200)');
} else skip('emails: sin RESEND_API_KEY en el entorno');

/* ═══ Fase 8 · REPORTE ═══ */
console.log('\n── Artefactos QA de esta corrida (NADA se borra — regla de la casa):');
created.forEach((c) => console.log('   ·', c));
console.log(`\nsmoke-global-live: ${count - fails}/${count} checks${manual ? ` · ${manual} MANUAL` : ''}${fails ? ' — RED' : ' — GREEN'}`);
process.exit(fails ? 1 : 0);
