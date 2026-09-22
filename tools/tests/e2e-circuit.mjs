/* ============================================================================
 * E2E del CIRCUITO Fase 3 en CHROME REAL — Playwright (PORT-8/9/9b/10/12a).
 * Guía manual: misc/test-guide-portal-fase3.html (bloques 1-4, versión stubs).
 * Sirve los fuentes reales (D2C, kiosk, portal) y stubbea /api/*:
 *   - referral code en el cart: campo + feedback en vivo (método B, los 3 fronts)
 *   - SSO portal→kiosk: ?pt= → badge "Selling as"; handoff inválido → kiosk público;
 *     la sesión persiste en sessionStorage
 *   - portal: Referral Codes real (Generate = admin con org elegido), Pricing
 *     display-only y Stripe Account (comisiones con split)
 * Uso: npm run test:e2e
 * ==========================================================================*/
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

let fails = 0, count = 0;
const t = (cond, msg) => { count++; if (cond) console.log(`  PASS  ${msg}`); else { console.error(`  FAIL  ${msg}`); fails++; } };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(process.cwd(), path.endsWith('/') ? path + 'index.html' : path);
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const ADMIN_ME = {
  user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com',
  role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null,
  sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/'
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  /* ── 1 · Método B: campo + feedback en el D2C (mismo cableado en kiosk/tech) ── */
  {
    const page = await browser.newPage();
    await page.route('**/api/**', (route) => {
      const u = route.request().url();
      if (u.includes('/api/referral-validate')) {
        const code = new URL(u).searchParams.get('code') || '';
        const valid = code.toUpperCase() === 'QAS-MOKE1';
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(valid ? { valid: true, org_name: 'QA Smoke Dealer' } : { valid: false }) });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(ORIGIN + '/', { waitUntil: 'load' });
    t(await page.$('#cart-referral') !== null, 'd2c: campo "Dealer referral code" presente en el drawer');

    /* blur directo sobre el input (el drawer puede estar oculto; probamos el cableado) */
    await page.$eval('#cart-referral', (el) => { el.value = 'qas-moke1'; el.dispatchEvent(new Event('blur')); });
    await page.waitForFunction(() => !document.getElementById('cart-referral-msg').hidden, null, { timeout: 5000 });
    t(/Code applied — supporting QA Smoke Dealer/.test(await page.textContent('#cart-referral-msg')), 'd2c: código válido → "Code applied — supporting …" (feedback en vivo)');

    await page.$eval('#cart-referral', (el) => { el.value = 'NOEXISTE1'; el.dispatchEvent(new Event('blur')); });
    await page.waitForFunction(() => /not recognized/.test(document.getElementById('cart-referral-msg').textContent), null, { timeout: 5000 });
    t(/you can still check out/.test(await page.textContent('#cart-referral-msg')), 'd2c: código inválido → "not recognized" y la venta NO se bloquea');

    /* link permanente por dealer: ?ref= pre-llena y valida SOLO, sin teclear nada */
    await page.goto(ORIGIN + '/?ref=qas-moke1', { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('cart-referral-msg').hidden, null, { timeout: 5000 });
    t(await page.$eval('#cart-referral', (el) => el.value) === 'qas-moke1'
      && /Code applied — supporting QA Smoke Dealer/.test(await page.textContent('#cart-referral-msg')),
      'd2c: link permanente ?ref= → código pre-llenado + "Code applied" sin teclear');
    await page.close();
  }

  /* campo presente también en kiosk y tech (mismo id → mismo cableado) */
  for (const front of ['/kiosk/', '/tech/']) {
    const page = await browser.newPage();
    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.goto(ORIGIN + front, { waitUntil: 'load' });
    t(await page.$('#cart-referral') !== null, `${front}: campo de referral code presente ("same method for kiosk, tech site, and DtC site")`);
    await page.close();
  }

  /* ── 2 · Método A: SSO portal→kiosk (?pt= → sesión + badge) ── */
  {
    let redeemBody = null;
    const page = await browser.newPage();
    await page.route('**/api/**', (route) => {
      const u = route.request().url();
      if (u.includes('/api/portal-app-redeem')) {
        redeemBody = JSON.parse(route.request().postData() || '{}');
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: 'sess.e2e.1', org_id: 'org-qa', org_name: 'QA Smoke Dealer', expires_at: new Date(Date.now() + 12 * 3600e3).toISOString() }) });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(ORIGIN + '/kiosk/?pt=handoff-tok-1', { waitUntil: 'load' });
    await page.waitForSelector('#kiosk-session-badge', { timeout: 8000 });
    t(redeemBody && redeemBody.token === 'handoff-tok-1', 'sso: el kiosk canjea el ?pt= en /api/portal-app-redeem');
    t(/Selling as QA Smoke Dealer/.test(await page.textContent('#kiosk-session-badge')), 'sso: badge "Selling as {org}" visible tras el canje');
    t(await page.$('#kiosk-session-badge a') !== null, 'sso: sesión de portal (no sales_mode) → el badge trae el link Dashboard');
    t(await page.$eval('#cart-referral-field', (el) => el.hidden), 'sso: con sesión, el campo de referral code se OCULTA (el token manda; teclearlo mentiría)');
    t(!/pt=/.test(page.url()), 'sso: el ?pt= se limpia de la URL (replaceState)');

    /* persistencia: recargar SIN ?pt= en la misma pestaña → la sesión vive en sessionStorage */
    await page.goto(ORIGIN + '/kiosk/', { waitUntil: 'load' });
    await page.waitForSelector('#kiosk-session-badge', { timeout: 8000 });
    t(/QA Smoke Dealer/.test(await page.textContent('#kiosk-session-badge')), 'sso: la sesión persiste al recargar (sessionStorage, 12h)');
    await page.close();

    /* handoff inválido/usado (401) → kiosk público, sin badge (pestaña nueva = sessionStorage limpio) */
    const page2 = await browser.newPage();
    await page2.route('**/api/**', (route) => {
      const u = route.request().url();
      if (u.includes('/api/portal-app-redeem')) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid_token"}' });
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page2.goto(ORIGIN + '/kiosk/?pt=handoff-usado', { waitUntil: 'load' });
    await page2.waitForTimeout(600);
    t(await page2.$('#kiosk-session-badge') === null, 'sso: handoff usado/vencido (401) → kiosk público SIN badge (single-use)');
    t(await page2.$eval('#cart-referral-field', (el) => !el.hidden), 'sso: sin sesión, el campo de código sigue visible (única vía de atribución)');
    await page2.close();
  }

  /* ── 2b · KIOSK-22: sesión sales_mode → badge SIN link Dashboard (Doug: "dashboard... not sales mode") ── */
  {
    const page = await browser.newPage();
    await page.route('**/api/**', (route) => {
      const u = route.request().url();
      if (u.includes('/api/portal-app-redeem')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: 'sess.sm.1', org_id: 'org-fd', org_name: 'Factory Direct', sales_mode: true, expires_at: new Date(Date.now() + 12 * 3600e3).toISOString() }) });
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(ORIGIN + '/kiosk/?pt=sales-tok', { waitUntil: 'load' });
    await page.waitForSelector('#kiosk-session-badge', { timeout: 8000 });
    t(/Selling as Factory Direct/.test(await page.textContent('#kiosk-session-badge')), 'k22: sales_mode → badge "Selling as {dealer}"');
    t(await page.$('#kiosk-session-badge a') === null, 'k22: sales_mode OCULTA el link Dashboard (dashboard protegido)');
    t(await page.$eval('#cart-referral-field', (el) => el.hidden), 'k22: sales_mode también oculta el referral field (atribución del token)');
    await page.close();
  }

  /* ── 3 · Portal: Referral Codes + Pricing display-only + Commissions ── */
  {
    let createReq = null, handoffReq = null, refGets = 0;
    const page = await browser.newPage();
    await page.route('**/api/**', (route) => {
      const u = route.request().url();
      const method = route.request().method();
      let out = {};
      if (u.includes('/api/auth-login')) out = { access_token: 'tok.e2e', expires_at: Math.floor(Date.now() / 1000) + 3600 };
      else if (u.includes('/api/portal-me')) out = ADMIN_ME;
      else if (u.includes('/api/portal-resellers')) out = { rows: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }], total: 1 };
      else if (u.includes('/api/portal-referral-codes')) {
        if (method === 'POST') { createReq = JSON.parse(route.request().postData() || '{}'); out = { code: 'SUM-A1B2', org_id: 'shf', org_name: 'Summit Home Furnishings' }; }
        else { refGets++; out = { rows: [{ code: 'SUM-7K2M', org_id: 'shf', org_name: 'Summit Home Furnishings', active: true, created_at: '2026-07-15T12:00:00Z' }], total: 1 }; }
      }
      else if (u.includes('/api/portal-plans')) out = { plans: [
        { sku: 'stain', label: 'Protection (Stain)', monthly_cents: 999, covers: 'Stains — all categories' },
        { sku: 'stain_mech', label: 'Protection+ (Stain + Structure)', monthly_cents: 1999, covers: 'Stains + structural — all categories' }
      ], editable: false };
      else if (u.includes('/api/portal-commissions')) out = {
        rows: [{ plan_sku: 'stain_mech', qty: 1, stripe_amount_cents: 400, reinsurance_amount_cents: 400, status: 'recorded', paid_at: '2026-07-15T12:00:00Z' }],
        totals: { cash_cents: 400, reinsurance_cents: 400 }, total: 1
      };
      else if (u.includes('/api/portal-reconciliation')) out = {
        rows: [{ subscription_id: 's1', start_date: '2026-05-14', program: 'Protection+', first_name: 'Jane', last_name: 'Doe', status: 'active', contract_number: 'RX-10001-03', stripe_payment_no: 'in_e2e123', payment_date: '2026-07-15' }],
        total: 1
      };
      else if (u.includes('/api/portal-app-handoff')) { handoffReq = JSON.parse(route.request().postData() || '{}'); out = { url: ORIGIN + '/kiosk/?pt=e2e-handoff', expires_at: new Date(Date.now() + 120e3).toISOString() }; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });

    await page.goto(ORIGIN + '/portal/', { waitUntil: 'load' });
    await page.click('button[onclick="showLogin()"]');
    await page.waitForSelector('#view-login.on', { timeout: 5000 });
    await page.fill('#login-email', 'admin@raptns.com');
    await page.fill('#login-pw', 'x'.repeat(8));
    await page.click('#login-btn');
    await page.waitForFunction(() => document.getElementById('app').style.display === 'block', null, { timeout: 8000 });

    /* Referral Codes: el stub "Coming soon" murió; pinta filas reales */
    await page.click('a[data-screen="referrals"]');
    await page.waitForSelector('#ref-body tr:not(.skel-row)', { timeout: 5000 });
    t(/SUM-7K2M/.test(await page.textContent('#ref-body')) && /Summit Home Furnishings/.test(await page.textContent('#ref-body')), 'portal: Referral Codes pinta código + reseller (GET real)');

    /* Generate con Viewing=All → NO postea (pide elegir reseller) */
    await page.click('#view-referrals button[onclick="createReferral()"]');
    await page.waitForTimeout(300);
    t(createReq === null, 'portal: Generate con Viewing=All NO crea (pide elegir reseller primero)');

    /* Generate con org elegido → POST {org_id} y recarga la lista */
    await page.selectOption('#dealerSelect', 'shf');
    const before = refGets;
    await page.click('#view-referrals button[onclick="createReferral()"]');
    await page.waitForTimeout(500);
    t(createReq && createReq.org_id === 'shf', 'portal: Generate postea /api/portal-referral-codes con el org del selector');
    t(refGets > before, 'portal: tras crear, la lista se recarga');

    /* Pricing & Plans: display-only desde el canónico */
    await page.click('a[data-screen="pricing"]');
    await page.waitForSelector('#plans-body tr:not(.skel-row)', { timeout: 5000 });
    const plansTxt = await page.textContent('#plans-body');
    t(/\$9\.99\/mo/.test(plansTxt) && /\$19\.99\/mo/.test(plansTxt), 'portal: Pricing pinta $9.99 y $19.99 desde /api/portal-plans');
    t((await page.$$('#view-pricing input, #view-pricing button')).length === 0, 'portal: Pricing SIN controles de edición (display-only, "just show it")');

    /* Stripe Account (PORT-24D): 3 cards del split + reconciliación (clon de Subscribers), jamás revenue */
    await page.click('a[data-screen="stripe"]');
    await page.waitForSelector('#recon-body tr:not(.skel-row)', { timeout: 5000 });
    t(await page.textContent('#comm-total') === '$8.00' && await page.textContent('#comm-cash') === '$4.00' && await page.textContent('#comm-rein') === '$4.00', 'portal: Stripe Account → 3 cards (Total $8.00 = commission $4.00 + reinsurance $4.00)');
    t(/in_e2e123/.test(await page.textContent('#recon-body')) && /RX-10001-03/.test(await page.textContent('#recon-body')), 'portal: reconciliación pinta Stripe payment # + contract del clon (Doug 17-jul)');

    /* Open Kiosk vía SSO: con org elegido → POST handoff y abre la URL con ?pt= */
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 8000 }),
      page.click('#kioskNav')
    ]);
    t(handoffReq !== null && handoffReq.org_id === 'shf', 'portal: click en Kiosk (admin + org) postea /api/portal-app-handoff con org_id');
    t(/\?pt=e2e-handoff/.test(popup.url()), 'portal: abre el kiosk con el token one-time (?pt=)');
    await popup.close();
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`e2e-circuit: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
