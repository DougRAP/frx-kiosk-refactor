/* ============================================================================
 * E2E del D2C en CHROME REAL — PREFILL-1 + menú Dashboard (spec 08-jul §E1/E2).
 * index.html contra /api/account-me stubbeado: con sesión seedeada el checkout
 * se prellena (email BLOQUEADO + nota), el menú Dashboard aparece, y "Not you?
 * Sign out" devuelve todo al estado anónimo. Sin sesión: cero cambios.
 * Uso: npm run test:e2e (kiosk + account + d2c)
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
  let file = join(process.cwd(), path === '/' ? '/dist/index.html' : path);
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* El D2C real es dist/index.html (fuente + core.css inyectado por el build). */
const PAGE = ORIGIN + '/dist/index.html';

const SESSION = { access_token: 'tok_ok', refresh_token: 'rt_1', expires_at: Math.floor(Date.now() / 1000) + 3600 };
const ACCOUNT = {
  ok: true, email: 'test@example.com',
  profile: { full_name: 'Test Customer', email: 'test@example.com', phone: '(555) 010-0142', address: '1 Main St, Logan UT' },
  summary: { plans_active: 1, plans_total: 1, monthly_cents_total: 999, coverage_cents_total: 500000, member_since: '2026-07-01T00:00:00Z' },
  plans: [], membership: null, kits: []
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  /* ── A · CON sesión: prefill + email bloqueado + menú Dashboard ── */
  const page = await browser.newPage();
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    let status = 200, out = {};
    if (u.includes('/api/account-me')) {
      if ((route.request().headers()['authorization'] || '') === 'Bearer tok_ok') out = ACCOUNT;
      else { status = 401; out = { error: 'invalid_token' }; }
    }
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await page.addInitScript(([sess, cart]) => {
    localStorage.setItem('furnfx_session', sess);
    localStorage.setItem('furnfx_cart', cart);   /* una línea válida para que el drawer tenga checkout */
  }, [JSON.stringify(SESSION), JSON.stringify([{ cov: 'stain', term: 'monthly', type: 'furniture', count: 1 }])]);

  await page.goto(PAGE, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('nav-dash-li').hidden, null, { timeout: 5000 });
  t(true, 'd2c: menú "Dashboard" visible con sesión validada por account-me');
  t((await page.getAttribute('#nav-dash', 'href')) === '/account.html', 'd2c: el menú apunta a /account.html');
  t((await page.inputValue('#cart-email')) === 'test@example.com', 'd2c: email prellenado desde la cuenta');
  t(await page.$eval('#cart-email', (n) => n.readOnly), 'd2c: email BLOQUEADO (la compra suma a la cuenta actual)');
  t((await page.inputValue('#cart-name')) === 'Test Customer', 'd2c: nombre prellenado');
  t((await page.inputValue('#cart-phone')) === '(555) 010-0142', 'd2c: teléfono prellenado');
  t((await page.inputValue('#cart-address')) === '1 Main St, Logan UT', 'd2c: dirección prellenada');
  t(/Buying as test@example\.com/.test(await page.$eval('#prefill-note', (n) => n.textContent)), 'd2c: nota "Buying as <email>" presente');

  /* B2 (KIOSK-20): la mención de Stripe como segunda línea del botón Pay, también en el D2C */
  const payAfterD2c = await page.evaluate(() => getComputedStyle(document.getElementById('cart-pay'), '::after').content);
  t(payAfterD2c.includes('Secure pay through Stripe'), 'd2c-B2: "Secure pay through Stripe" bajo el precio del Pay');

  /* "Not you? Sign out" (dentro del drawer del carrito → abrirlo para clickear) */
  await page.click('#nav-cart');
  await page.waitForSelector('#prefill-signout', { state: 'visible', timeout: 5000 });
  await page.click('#prefill-signout');
  t((await page.inputValue('#cart-email')) === '', 'd2c: sign out vacía el email');
  t(!(await page.$eval('#cart-email', (n) => n.readOnly)), 'd2c: sign out desbloquea el email');
  t((await page.inputValue('#cart-name')) === '', 'd2c: sign out vacía lo que el prefill llenó');
  t(await page.$eval('#prefill-note', (n) => n.hidden), 'd2c: la nota desaparece');
  t(await page.$eval('#nav-dash-li', (n) => n.hidden), 'd2c: el menú Dashboard se apaga');
  t((await page.evaluate(() => localStorage.getItem('furnfx_session'))) === null, 'd2c: la sesión se borró del storage');

  /* ── B · SIN sesión: el checkout queda exactamente como siempre ── */
  const page2 = await browser.newPage();
  await page2.goto(PAGE, { waitUntil: 'load' });
  await page2.waitForSelector('#cart-email', { state: 'attached', timeout: 5000 });
  t(await page2.$eval('#nav-dash-li', (n) => n.hidden), 'd2c: sin sesión NO hay menú Dashboard');
  t((await page2.inputValue('#cart-email')) === '' && !(await page2.$eval('#cart-email', (n) => n.readOnly)),
    'd2c: sin sesión el email queda vacío y editable');
  t(await page2.$eval('#prefill-note', (n) => n.hidden), 'd2c: sin sesión no hay nota');

  /* ── C · GIFT-1: overlay de gift coupon (endpoint stubbeado) ── */
  await page2.route('**/api/create-gift-checkout', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ url: PAGE + '?gift=stub' })
  }));
  await page2.locator('.js-gift-coupon').scrollIntoViewIfNeeded();
  await page2.click('.js-gift-coupon');
  await page2.waitForSelector('#gift-backdrop:not([hidden])', { timeout: 5000 });
  t(/3 months · total \$29\.97/.test(await page2.textContent('#gift-total')), 'gift: total inicial (Stain, $9.99 × 3)');
  await page2.selectOption('#gift-tier', 'membership');
  t(/\$59\.97/.test(await page2.textContent('#gift-total')), 'gift: membership recalcula a $59.97');
  await page2.fill('#gift-email', 'buyer@example.com');
  await page2.click('#gift-submit');
  await page2.waitForURL('**gift=stub**', { timeout: 5000 });
  t(true, 'gift: submit navega al checkout de Stripe (stub)');

  /* ── D · DASH-11: aterrizar con /#gift (CTA del dashboard) abre el overlay solo ── */
  const page3 = await browser.newPage();
  await page3.goto(PAGE + '#gift', { waitUntil: 'load' });
  await page3.waitForSelector('#gift-backdrop:not([hidden])', { timeout: 5000 });
  t(true, 'DASH-11: /#gift aterriza con el overlay de gift abierto');
  t(/3 months/.test(await page3.textContent('#gift-total')), 'DASH-11: el total ya viene calculado al abrir por hash');

  /* ── E · MAYA-7 en el D2C (espejo): el trigger presenta a Maya y pide el nombre ── */
  await page3.click('#gift-close');
  await page3.waitForSelector('#gift-backdrop', { state: 'hidden', timeout: 5000 });
  const trig = page3.locator('.cov-assist-trigger[data-cov="stain"]').first();
  await trig.scrollIntoViewIfNeeded();
  await trig.click();
  await page3.waitForSelector('#chat-panel.open', { timeout: 5000 });
  const d2cChat = await page3.textContent('#chat-body');
  t(/Hi, I'm Maya, your sales assistant/.test(d2cChat) && /first and last name/.test(d2cChat),
    'd2c-M7: Maya se presenta y arranca por el nombre (espejo del kiosk)');
} finally {
  await browser.close();
  server.close();
}

console.log(`e2e-d2c: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
