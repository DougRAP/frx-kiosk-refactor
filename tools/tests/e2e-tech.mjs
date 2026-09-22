/* ============================================================================
 * E2E del front TECH en CHROME REAL — Playwright (TECH-1, call Doug 10-jul).
 * El técnico en casa del cliente: kits + Repair Membership, SIN protection
 * plans. Verifica: hero de Doug, cero compare, sticky tech, drawer con
 * Technician ID + Work order SIEMPRE visibles, 3 vías de pago (sin handoff),
 * Maya en modo tech (context:'tech' al server) y checkout con source:'tech'.
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

let chatReq = null;       // último body recibido por /api/chat
let checkoutReq = null;   // último body recibido por /api/create-checkout-session
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    const method = route.request().method();
    const body = method === 'POST' ? JSON.parse(route.request().postData() || '{}') : {};
    let out = {};
    if (u.includes('/api/chat')) { chatReq = body; out = { reply: 'The kits start at $49.99 and the membership covers everything in your house.' }; }
    else if (u.includes('/api/create-checkout-session')) { checkoutReq = body; out = { url: ORIGIN + '/tech/?paid=1', id: 'cs_1', short_url: null }; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  /* 1 · Identidad: hero de Doug, CERO protection plans */
  await page.goto(ORIGIN + '/tech/', { waitUntil: 'load' });
  t(/FurnitureRx Tech/.test(await page.title()), 'tech: title propio');
  t(await page.isVisible('.hero-headline'), 'tech: el hero de Doug se pinta');
  t(/Keep it that way/.test(await page.textContent('.hero-headline')), 'tech: headline "Your repair\'s done. Keep it that way."');
  t(/First 3 months/i.test(await page.textContent('#hero-offer')), 'tech: la offer card enuncia la promo (3 meses free)');
  t((await page.$$('#compare')).length === 0, 'tech: la sección de protection plans NO existe');
  t((await page.$$('.cov-assist-trigger')).length === 0, 'tech: cero triggers del sales assistant de planes');
  t(/Log in to your dashboard/.test(await page.textContent('#hero-offer')), 'tech: el dash-login (DASH-5) sobrevive reubicado en el hero');

  /* 2 · Sticky tech: carrito vacío → Add membership (nada de "Add plan") */
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForSelector('#sticky-mobile.show', { timeout: 5000 }).catch(() => {});
  t(/Add membership/.test(await page.textContent('#sticky-cta')), 'tech-sticky: carrito vacío → "Add membership"');

  /* 3 · Carrito: kit + membership; drawer con los campos TECH siempre visibles */
  const kitBtn = page.locator('.kit-add-btn').first();
  await kitBtn.scrollIntoViewIfNeeded();
  await kitBtn.click();
  await page.click('#mem-add-btn');   /* agrega la membership Y abre el drawer solo */
  await page.waitForSelector('#cart-panel.open', { timeout: 5000 });
  t(await page.isVisible('#cart-associate'), 'tech-drawer: Technician ID VISIBLE (aún sin planes)');
  t(/Technician ID/.test(await page.textContent('#cart-panel')), 'tech-drawer: label "Technician ID"');
  t(/Work order number/.test(await page.textContent('#cart-panel')), 'tech-drawer: label "Work order number"');
  t(!(await page.isVisible('#cart-receipt-field')), 'tech-drawer: el bloque del RECIBO no aparece (no hay planes)');
  const deliverValues = await page.$$eval('input[name="deliver"]', (ns) => ns.map((n) => n.value));
  t(deliverValues.length === 3 && !deliverValues.includes('handoff'),
    'tech-drawer: 3 vías de pago (device/QR/email) — sin el handoff de recibo');
  t(await page.isChecked('input[name="deliver"][value="redirect"]'), 'tech-drawer: "Pay on this device" default');

  /* 4 · Checkout: source:"tech" viaja (habilita el trial 90d server-side) */
  await page.fill('#cart-name', 'Tech Customer');
  await page.fill('#cart-email', 'techtest@example.com');
  await page.fill('#cart-phone', '0005551234');
  await page.fill('#cart-address', '1 Repair Rd, Logan, UT 84321');
  await page.fill('#cart-associate', 'T-4471');
  await page.fill('#cart-order', 'WO-88012');
  await page.check('#cart-accuracy');
  t(/Pay/.test(await page.textContent('#cart-pay')), 'tech-pay: botón habilitado con el total');
  await page.click('#cart-pay');
  await page.waitForURL('**paid=1**', { timeout: 10000 });
  t(checkoutReq && checkoutReq.source === 'tech', 'tech-checkout: el POST lleva source:"tech" (trial 90d)');
  t(checkoutReq && checkoutReq.kiosk === true, 'tech-checkout: kiosk:true → el server EXIGE Technician ID + Work order');
  t(checkoutReq && checkoutReq.associate === 'T-4471' && checkoutReq.order === 'WO-88012',
    'tech-checkout: Technician ID y Work order viajan en los campos de siempre (cero cambios de contrato)');
  t(checkoutReq && Array.isArray(checkoutReq.plans) && checkoutReq.plans.length === 0 && checkoutReq.membership === true,
    'tech-checkout: membership + kits, CERO planes de protección');

  /* 5 · Maya en modo TECH (cerrando antes el drawer del éxito, que tapa el botón del chat) */
  await page.waitForSelector('#cart-view-success:not([hidden])', { timeout: 5000 }).catch(() => {});
  await page.click('#cart-close');
  await page.waitForSelector('#cart-panel', { state: 'hidden', timeout: 5000 });
  await page.click('#chat-btn');
  await page.waitForSelector('#chat-panel.open', { timeout: 5000 });
  t(/care kits or your Repair Membership/.test(await page.textContent('#chat-body')), 'tech-maya: saludo tech (kits + membership)');
  await page.fill('#chat-input', 'What furniture does the membership cover?');
  await page.click('#chat-form button[type="submit"]');
  await page.waitForFunction(() => /everything in your house/.test((document.getElementById('chat-body') || {}).textContent || ''), null, { timeout: 10000 });
  t(chatReq && chatReq.context === 'tech', 'tech-maya: el POST al chat lleva context:"tech" (Q&A sin captura)');
  t(chatReq && !chatReq.conversation_id, 'tech-maya: sin conversation_id (no hay lead de cobertura que upsertear)');
} finally {
  await browser.close();
  server.close();
}

console.log(`e2e-tech: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
