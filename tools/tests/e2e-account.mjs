/* ============================================================================
 * E2E del login del customer (AUTH-1) en CHROME REAL — Playwright.
 * account.html contra /api/auth-* stubbeados: password bueno/malo (uniforme),
 * persistencia de sesión, sign out, vía OTP, aterrizaje del invite (hash
 * limpiado de la URL) y la vía legacy ?t= intacta.
 * Uso: npm run test:e2e (corre kiosk + account)
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
  let file = join(process.cwd(), path.endsWith('/') ? path + 'index.html' : path);
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const SESSION = { access_token: 'tok_ok', refresh_token: 'rt_1', expires_at: Math.floor(Date.now() / 1000) + 3600 };
const ACCOUNT = {
  ok: true, email: 'test@example.com',
  profile: { full_name: 'Test Customer', email: 'test@example.com', phone: null, address: '1 Main St, Logan UT' },
  summary: { plans_active: 1, plans_total: 1, monthly_cents_total: 999, coverage_cents_total: 500000, member_since: '2026-07-01T00:00:00Z' },
  plans: [{ tier: 'stain', status: 'active', monthly_cents: 999, master_no: 'RX-10001', sales_order_number: '100482', started_at: '2026-07-01T00:00:00Z', coverage_cap_cents: 500000, receipt: true, receipt_url: ORIGIN + '/receipt-test.png', pieces: ['sofa'],
    stripe_subscription_id: 'sub_e2e_1',   /* DASH-1b: compartido con la membership → camino del modal */
    purchase: { plans: 1, membership: true },   /* DASH-1b fix: el resumen de la compra viene del SERVER */
    coverage: { summary: 'Sized for a $4,100 order.', sales_order_total: 4100, item_count: 3, recommended_plans: 1, covered_up_to: 5000 } }],
  membership: { status: 'active', monthly_cents: 999, started_at: '2026-07-01T00:00:00Z', current_period_end: '2026-08-01T00:00:00Z', stripe_subscription_id: 'sub_e2e_1' },
  kits: []
};
let portalReqBody = null;   /* DASH-1b: último body recibido por create-portal-session */
let giftReqBody = null;     /* gift-ctx: último body recibido por create-gift-checkout */

/* PNG 1×1 para el modal del recibo (la URL firmada real es de Supabase Storage) */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/receipt-test.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }));
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    const method = route.request().method();
    const body = method === 'POST' ? JSON.parse(route.request().postData() || '{}') : {};
    let status = 200, out = {};
    if (u.includes('/api/auth-login')) {
      if (body.password === 'goodpass123') out = SESSION;
      else if (body.password === 'Temp-1234-Xyz9') out = { ...SESSION, must_change_password: true };   // AUTH-2
      else { status = 401; out = { error: 'invalid_credentials' }; }
    } else if (u.includes('/api/auth-otp')) {
      if (body.code !== undefined) {
        if (body.code === '123456') out = SESSION;
        else { status = 401; out = { error: 'invalid_code' }; }
      } else out = { sent: true };
    } else if (u.includes('/api/auth-set-password')) {
      if (body.access_token && (body.password || '').length >= 8) out = { ok: true };
      else { status = 401; out = { error: 'set_password_failed' }; }
    } else if (u.includes('/api/account-me')) {
      if ((route.request().headers()['authorization'] || '') === 'Bearer tok_ok') out = ACCOUNT;
      else { status = 401; out = { error: 'invalid_token' }; }
    } else if (u.includes('/api/account-view')) {
      out = ACCOUNT;
    } else if (u.includes('/api/create-gift-checkout')) {
      giftReqBody = body;
      out = { url: ORIGIN + '/account.html?gift=sent' };
    } else if (u.includes('/api/create-portal-session')) {
      portalReqBody = body;
      if ((route.request().headers()['authorization'] || '') === 'Bearer tok_ok') out = { url: ORIGIN + '/account.html?portal=ok' };
      else { status = 401; out = { error: 'invalid_token' }; }
    } else if (u.includes('/api/get-billing')) {
      if ((route.request().headers()['authorization'] || '') === 'Bearer tok_ok') out = { ok: true, billing: {
        card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2027 },
        billing_address: '1 Main St, Logan, UT 84321',
        next_charge: { date: '2026-08-01T00:00:00Z', amount_cents: 1998 },
        invoices: [{ date: '2026-07-01T00:00:00Z', amount_cents: 1998, status: 'paid', description: '1 × Stain Protection (at $9.99 / month)' }]
      } };
      else { status = 401; out = { error: 'invalid_token' }; }
    } else if (u.includes('/api/update-profile')) {
      if ((route.request().headers()['authorization'] || '') === 'Bearer tok_ok' && (body.full_name || '').length) out = { ok: true };
      else { status = 400; out = { error: 'invalid_name' }; }
    }
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
  });

  /* 1 · Sin sesión → login */
  await page.goto(ORIGIN + '/account.html', { waitUntil: 'load' });
  await page.waitForSelector('#auth:not([hidden])', { timeout: 5000 });
  t(await page.isVisible('#auth-view-login'), 'account: sin sesión → vista de login');
  t(!(await page.isVisible('#dash')), 'account: el dashboard no se pinta sin sesión');
  t((await page.$$('#loading .sk-card')).length === 3 && (await page.$eval('#loading', (n) => n.hidden)),
    'account: el loading es un SKELETON del dashboard (y se ocultó al resolver)');

  /* 2 · Password mala → error uniforme en pantalla */
  await page.fill('#li-email', 'test@example.com');
  await page.fill('#li-pw', 'wrongpass');
  await page.click('#li-submit');
  await page.waitForFunction(() => /don’t match/.test((document.getElementById('auth-msg') || {}).textContent || ''), null, { timeout: 5000 });
  t(true, 'account: password mala → mensaje uniforme visible');

  /* 3 · Password buena → dashboard */
  await page.fill('#li-pw', 'goodpass123');
  await page.click('#li-submit');
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t((await page.textContent('#who-email')).trim() === 'test@example.com', 'account: login OK → dashboard con el email del usuario');
  t(/Test/.test(await page.textContent('#greet')), 'account: saludo con el nombre');
  t(await page.isVisible('#logout'), 'account: Sign out visible con sesión');
  t(await page.isVisible('#chpw'), 'account: Change password visible con sesión');

  /* 4 · Recarga → sigue dentro (sesión persistida) */
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(true, 'account: recargar mantiene la sesión (localStorage)');

  /* 5 · Sign out → login */
  await page.click('#logout');
  await page.waitForSelector('#auth:not([hidden])', { timeout: 5000 });
  t(/Signed out/.test(await page.textContent('#auth-msg')), 'account: Sign out → login con aviso');

  /* 6 · Vía OTP completa */
  await page.fill('#li-email', 'test@example.com');
  await page.click('#li-otp');
  await page.waitForSelector('#auth-view-code:not([hidden])', { timeout: 5000 });
  t(/We emailed a sign-in code/.test(await page.textContent('#auth-sub')), 'account: OTP pedido → vista del código (copy agnóstico de longitud)');
  await page.fill('#oc-code', '000000');
  await page.click('#oc-submit');
  await page.waitForFunction(() => /didn’t work/.test((document.getElementById('auth-msg') || {}).textContent || ''), null, { timeout: 5000 });
  t(true, 'account: código malo → mensaje claro');
  await page.fill('#oc-code', '123456');
  await page.click('#oc-submit');
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(true, 'account: código bueno → dashboard');
  await page.click('#logout');
  await page.waitForSelector('#auth:not([hidden])', { timeout: 5000 });

  /* 7 · Aterrizaje del INVITE (hash de GoTrue) → set-password → dashboard; hash fuera de la URL */
  /* query distinto → navegación REAL (goto con solo-hash sería same-document y el boot no corre) */
  await page.goto(ORIGIN + '/account.html?from=email#access_token=tok_ok&refresh_token=rt_1&expires_in=3600&type=invite', { waitUntil: 'load' });
  await page.waitForSelector('#auth-view-setpw:not([hidden])', { timeout: 5000 });
  t(true, 'account: invite → vista de set-password');
  t(!page.url().includes('access_token'), 'account: el token desapareció de la URL (replaceState)');
  await page.fill('#sp-pw', 'newpass123');
  await page.click('#sp-submit');
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(true, 'account: password fijada → dashboard');
  await page.click('#logout');
  await page.waitForSelector('#auth:not([hidden])', { timeout: 5000 });

  /* 8 · Vía legacy ?t= intacta (sin sesión, sin Sign out) */
  await page.goto(ORIGIN + '/account.html?t=demo-token', { waitUntil: 'load' });
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(!(await page.isVisible('#logout')), 'account: la vía ?t= pinta el dashboard SIN sesión (sin Sign out)');
  t((await page.$$('#subs-list >> text=Cancel plan')).length === 0, 'DASH-1b: sin sesión (?t=) NO hay chip Cancel plan');

  /* 9 · BUG prod 06-jul: link de GoTrue consumido (#error=otp_expired) PERO ?t= válido → el ?t= GANA */
  await page.goto(ORIGIN + '/account.html?t=demo-token&v=2#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { waitUntil: 'load' });
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(true, 'account: #error de GoTrue + ?t= válido → dashboard (el respaldo HMAC gana)');
  t(!page.url().includes('error_code'), 'account: el #error se limpia de la URL');
  t(!(await page.isVisible('#auth')), 'account: nada de mandar al login teniendo ?t= bueno');

  /* 10 · AUTH-2: contraseña TEMPORAL del welcome → cambio FORZADO (sin skip) antes del dashboard */
  await page.goto(ORIGIN + '/account.html', { waitUntil: 'load' });
  await page.waitForSelector('#auth:not([hidden])', { timeout: 5000 });
  await page.fill('#li-email', 'test@example.com');
  await page.fill('#li-pw', 'Temp-1234-Xyz9');
  await page.click('#li-submit');
  await page.waitForSelector('#auth-view-setpw:not([hidden])', { timeout: 5000 });
  t(/temporary password/.test(await page.textContent('#auth-sub')), 'account: temporal → set-password forzado con el porqué');
  t(!(await page.isVisible('#sp-skip')), 'account: el cambio forzado NO ofrece "Skip for now"');
  t(!(await page.isVisible('#dash')), 'account: sin dashboard hasta reemplazar la temporal');
  await page.fill('#sp-pw', 'brandnew123');
  await page.click('#sp-submit');
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(true, 'account: temporal reemplazada → dashboard');

  /* 10b · MAIL-1b (Adrian 09-jul): aterrizaje del botón del welcome (#welcome=<email>).
     Con una sesión AJENA guardada, el botón NO debe abrir ese dashboard: muestra el login
     con el email del comprador prefilled, foco en la password y la guía de la temporal. */
  await page.goto(ORIGIN + '/account.html?x=1#welcome=newbuyer%40example.com', { waitUntil: 'load' });
  await page.waitForSelector('#auth-view-login:not([hidden])', { timeout: 5000 });
  t(!(await page.isVisible('#dash')), 'welcome-link: NO entra a la sesión guardada de otro (muestra login)');
  t((await page.inputValue('#li-email')) === 'newbuyer@example.com', 'welcome-link: email del comprador prefilled');
  t(/temporary password/.test(await page.textContent('#auth-sub')), 'welcome-link: la guía pide la password temporal del email');
  t(await page.$eval('#li-pw', (n) => document.activeElement === n), 'welcome-link: el foco cae en la password (solo falta teclearla)');
  t(!page.url().includes('welcome='), 'welcome-link: el email desaparece de la URL (replaceState)');
  /* el viaje del niño de 10 años completo: teclear la temporal → cambio forzado → dashboard */
  await page.fill('#li-email', 'test@example.com');   /* el stub de login valida por password */
  await page.fill('#li-pw', 'Temp-1234-Xyz9');
  await page.click('#li-submit');
  await page.waitForSelector('#auth-view-setpw:not([hidden])', { timeout: 5000 });
  await page.fill('#sp-pw', 'chosen-by-me-123');
  await page.click('#sp-submit');
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(true, 'welcome-link: temporal → password propia → dashboard, sin callejones');

  /* 11 · Paquete dashboard (spec 08-jul): membership visible + File a claim + Manage billing */
  t(await page.isVisible('#mem-panel'), 'account: la Repair Safety Net pagada SE VE (panel membership)');
  t(/^active$/i.test((await page.textContent('#mem-pill')).trim()), 'account: pill de estado de la membership en el head (item 4)');
  t(/Billed at \$9\.99\/month/.test(await page.textContent('#mem-foot')), 'account: el foot de membership muestra el precio real');
  t(/Priority repair coordination/.test(await page.textContent('.mem-benefits')), 'account: beneficios de la Safety Net visibles');
  t((await page.getAttribute('#file-claim', 'href')) === 'https://5starservice.net/', 'account: File a claim apunta a Five Star (DASH-2)');
  await page.waitForSelector('#bill-panel:not([hidden])', { timeout: 5000 });
  t(await page.isVisible('#billing'), 'account: Manage billing visible en el panel Billing (item 7)');
  /* pedido 08-jul: el portal abre en PESTAÑA NUEVA y el botón no se queda en "Opening…" */
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    page.click('#billing')
  ]);
  await popup.waitForURL('**/account.html?portal=ok**', { timeout: 5000 });
  t(true, 'account: Manage billing abre el Customer Portal en pestaña NUEVA');
  await popup.close();
  await page.waitForFunction(() => (document.getElementById('billing') || {}).textContent === 'Manage billing', null, { timeout: 5000 });
  t(!(await page.$eval('#billing', (b) => b.disabled)), 'account: el botón vuelve a "Manage billing" habilitado (no más Opening… pegado)');
  t(await page.isVisible('#dash'), 'account: la página original sigue en el dashboard');

  /* 12 · Consolidación: dashboard.html redirige a account.html preservando search + hash */
  await page.goto(ORIGIN + '/dashboard.html?a=1#b=2', { waitUntil: 'load' });
  await page.waitForURL('**/account.html?a=1#b=2', { timeout: 5000 });
  t(true, 'dashboard.html: redirect a /account.html conservando query y hash');

  /* 13 · Paridad con dashboard-demo: la sesión guardada ya pintó el dashboard */
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t((await page.getAttribute('#new-plan', 'href')) === '/#compare', 'item 1: "+ New plan" → /#compare');
  t(/Protect another receipt/.test(await page.textContent('.cov-add')), 'item 1: tile de recompra al final de los planes');
  /* la width se anima 0 → 82% vía doble rAF → esperar el valor final */
  await page.waitForFunction(() => {
    const f = document.querySelector('.usebar > span');
    return f && f.style.width === '82%';
  }, null, { timeout: 5000 });
  t(true, 'item 8: usebar animada hasta 82% ($4,100 de $5,000)');
  t(/3 items · \$4,100 of \$5,000 covered/.test(await page.textContent('.cov-line')), 'item 13: línea de cobertura CONDENSADA');
  t(!/Plans sized/.test(await page.textContent('#subs-list')), 'item 13: fuera las filas sueltas del summary');
  t((await page.$$eval('.pi-ic svg', (n) => n.length)) > 0, 'item 2: icono SVG por pieza cubierta');
  t(/Read plan terms/.test(await page.textContent('.panel-foot')), 'item 4: panel-foot con el link a /terms/');
  t(/File a claim/.test(await page.textContent('.plan-actions')), 'item 3: chips de acciones en la card');
  t(/administered by Risk Assurance Partners/.test(await page.textContent('footer.site-foot')), 'item 6: footer del site presente');
  t(/1 active plan \+ membership/.test(await page.textContent('#stat-row .stat-card.lead')), 'item 11: Monthly total lidera con su meta');
  await page.waitForSelector('#bill-panel:not([hidden])', { timeout: 5000 });
  t(/Visa •••• 4242/.test(await page.textContent('#bill-body')), 'item 5: tarjeta en el panel Billing');
  /* la fecha exacta depende de la zona horaria local (medianoche UTC → día anterior en UTC-) */
  t(/Next charge \w{3} \d{1,2}, 2026 · \$19\.98/.test(await page.textContent('#bill-sub')), 'item 5: próximo cargo con fecha y monto');
  t(/1 × Stain Protection/.test(await page.textContent('#bill-body')), 'item 14: columna Description con la línea de la invoice');
  t(/1 Main St, Logan, UT 84321/.test(await page.textContent('#bill-body')), 'item 14: dirección de facturación en su fila');
  t(/Payment method/.test(await page.textContent('#bill-body')) && /Billing address/.test(await page.textContent('#bill-body')),
    'billing: labels explícitos en las filas (no solo el icono)');
  await page.waitForFunction(() => /\$19\.98 · Visa •••• 4242/.test((document.getElementById('stat-nextpay') || {}).textContent || ''), null, { timeout: 5000 });
  t(true, 'item 11: stat Next payment relleno async desde get-billing');

  /* DASH-11 (Doug 08-jul): Claims coming soon + franja referral/gift */
  t(await page.isVisible('#claims-panel'), 'DASH-11: panel Claims visible con sesión');
  t((await page.getAttribute('#file-claim', 'href')) === 'https://5starservice.net/', 'DASH-11: File a claim del panel Claims → Five Star');
  t((await page.$$eval('#claims-panel .step', (n) => n.length)) === 4, 'DASH-11: stepper de preview con 4 pasos');
  t(/coming soon/i.test(await page.textContent('#claims-panel')), 'DASH-11: badge "Live claim tracker · coming soon"');
  t(await page.isVisible('#refer-card'), 'DASH-11: tarjeta referral visible');
  t(/Give a month/.test(await page.textContent('#refer-card')) && /coming soon/i.test(await page.textContent('#refer-card')),
    'DASH-11: referral con el copy del demo, marcado coming soon');
  t(await page.isVisible('#gift-card'), 'DASH-11: tarjeta gift visible con encabezado propio');
  t(/Give 3 months/.test(await page.textContent('#gift-card')) && !/coming soon/i.test(await page.textContent('#gift-card')),
    'DASH-11: el gift tiene su heading y NO dice coming soon (es una compra viva)');
  t((await page.getAttribute('#gift-link', 'href')) === '/#gift', 'DASH-11: CTA de gift → /#gift (fallback sin JS)');

  /* gift EN CONTEXTO (09-jul): el CTA abre un MODAL en el dashboard (sin navegar al site);
     Stripe devuelve a /account.html?gift=sent → toast + URL limpia + sesión re-entra sola */
  await page.click('#gift-link');
  await page.waitForSelector('#modal-backdrop.open #gift-tier', { timeout: 5000 });
  t(page.url().includes('/account.html'), 'gift-ctx: NO navegó al site — el modal abre en el dashboard');
  t(/3 months · total \$29\.97/.test(await page.textContent('#gift-total')), 'gift-ctx: total inicial (Stain × 3)');
  await page.selectOption('#gift-tier', 'membership');
  t(/\$59\.97/.test(await page.textContent('#gift-total')), 'gift-ctx: cambiar de tier recalcula el total');
  t(/test@example\.com/.test(await page.textContent('#modal')), 'gift-ctx: el email del comprador es el de la sesión (sin teclearlo)');
  await page.click('#gift-continue');
  await page.waitForFunction(() => /Gift purchased/.test((document.getElementById('toast-wrap') || {}).textContent || ''), null, { timeout: 10000 });
  t(true, 'gift-ctx: al volver de Stripe (gift=sent) el dashboard lo confirma con un toast');
  t(giftReqBody && giftReqBody.source === 'account' && giftReqBody.email === 'test@example.com' && giftReqBody.tier === 'membership',
    'gift-ctx: el POST lleva email de sesión + tier + source account');
  t(!page.url().includes('gift='), 'gift-ctx: la URL queda limpia (replaceState)');
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  t(true, 'gift-ctx: la sesión persistida re-entra al dashboard sola');

  /* B3 (PAUSE-1): "Pause plan" como coming soon disimulado — tooltip nativo, SPAN no clickable */
  const pauseChip = page.locator('#subs-list .chip.soon');
  t((await pauseChip.count()) === 1 && /Pause plan/.test(await pauseChip.textContent()), 'B3: chip "Pause plan" presente y discreto');
  t((await pauseChip.getAttribute('title')) === 'Coming soon', 'B3: tooltip nativo "Coming soon"');
  t((await pauseChip.evaluate((n) => n.tagName)) === 'SPAN', 'B3: es un SPAN (no botón): clicarlo no hace nada');

  /* DASH-1b: Cancel plan → modal honesto (compra compartida con la membership) → portal flow */
  t(await page.isVisible('#subs-list >> text=Cancel plan'), 'DASH-1b: chip Cancel plan en la card activa (con sesión)');
  await page.click('#subs-list >> text=Cancel plan');
  await page.waitForSelector('#modal-backdrop.open', { timeout: 5000 });
  t(/Cancel this purchase\?/.test(await page.textContent('#modal')), 'DASH-1b: la compra tiene más líneas → modal de aviso');
  t(/whole purchase: 1 plan \+ membership/.test(await page.textContent('#modal')),
    'DASH-1b: el aviso dice QUÉ cancela (1 plan + membership)');
  await page.click('#modal >> text=Keep my coverage');
  await page.waitForFunction(() => !document.getElementById('modal-backdrop').classList.contains('open'), null, { timeout: 5000 });
  t(true, 'DASH-1b: "Keep my coverage" cierra sin salir');
  portalReqBody = null;
  await page.click('#subs-list >> text=Cancel plan');
  await page.waitForSelector('#cancel-continue', { timeout: 5000 });
  const [popupCancel] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    page.click('#cancel-continue')
  ]);
  await popupCancel.waitForURL('**/account.html?portal=ok**', { timeout: 5000 });
  t(true, 'DASH-1b: Continue to Stripe abre el portal en pestaña nueva');
  await popupCancel.close();
  t(portalReqBody && portalReqBody.subscription === 'sub_e2e_1', 'DASH-1b: el POST lleva la subscription dirigida del flow');

  /* DASH-1b (pedido Adrian 09-jul): la confirmación abre SIEMPRE — también en compras de UNA
     línea, con copy propio (sin el aviso multi-línea, que ahí no aplica). */
  ACCOUNT.plans[0].purchase = { plans: 1, membership: false };
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#dash:not([hidden])', { timeout: 5000 });
  await page.click('#subs-list >> text=Cancel plan');
  await page.waitForSelector('#modal-backdrop.open', { timeout: 5000 });
  t(/Cancel this plan\?/.test(await page.textContent('#modal')), 'DASH-1b: compra de UNA línea TAMBIÉN confirma en la página');
  t(!/whole purchase/.test(await page.textContent('#modal')), 'DASH-1b: sin el aviso multi-línea cuando no aplica');
  t(/end of your current billing period/.test(await page.textContent('#modal')), 'DASH-1b: el copy single explica el fin de período');
  await page.click('#modal >> text=Keep my coverage');
  await page.waitForFunction(() => !document.getElementById('modal-backdrop').classList.contains('open'), null, { timeout: 5000 });
  t(true, 'DASH-1b: Keep my coverage cierra también en el camino single');
  ACCOUNT.plans[0].purchase = { plans: 1, membership: true };   /* restaurar el fixture multi */

  /* View receipt → MODAL dentro de la página (pedido 08-jul) */
  await page.click('#subs-list >> text=View receipt');
  await page.waitForSelector('#modal-backdrop.open img.receipt-img', { timeout: 5000 });
  t(/Sales receipt/.test(await page.textContent('#modal')), 'receipt: el modal abre con el título');
  t(/Plan RX-10001 · Order #100482/.test(await page.textContent('#modal')), 'receipt: contexto del plan en el subtítulo');
  t((await page.getAttribute('#modal a.btn-accent', 'href')) === ORIGIN + '/receipt-test.png', 'receipt: "Open full size" apunta al archivo');
  await page.click('#modal >> text=Close');
  await page.waitForFunction(() => !document.getElementById('modal-backdrop').classList.contains('open'), null, { timeout: 5000 });
  t(true, 'receipt: Close cierra el modal');

  /* item 12: editar teléfono end-to-end en el MODAL */
  await page.click('#edit-acct');
  await page.waitForSelector('#modal-backdrop.open #d-phone-in', { timeout: 5000 });
  t(true, 'item 12: Edit details abre el MODAL con los campos');
  t(/Email can’t be changed/.test(await page.textContent('#modal')), 'item 12: el modal aclara que el email no se toca');
  await page.fill('#d-phone-in', '5551234567');
  await page.click('#acct-save');
  await page.waitForFunction(() => (document.getElementById('d-phone') || {}).textContent === '5551234567', null, { timeout: 5000 });
  t(true, 'item 12: guardar actualiza el dato en pantalla');
  t(!(await page.isVisible('#acct-save')), 'item 12: al guardar, el modal se cierra (contenido limpiado)');
  await page.waitForFunction(() => /Details saved/.test((document.getElementById('toast-wrap') || {}).textContent || ''), null, { timeout: 5000 });
  t(true, 'item 1: toast de éxito "Details saved."');

  /* item 12b: el modal también cierra con Escape sin guardar */
  await page.click('#edit-acct');
  await page.waitForSelector('#modal-backdrop.open #d-name-in', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('modal-backdrop').classList.contains('open'), null, { timeout: 5000 });
  t(true, 'item 12: Escape cierra el modal sin guardar');
} finally {
  await browser.close();
  server.close();
}

console.log(`e2e-account: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
