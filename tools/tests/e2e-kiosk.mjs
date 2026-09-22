/* ============================================================================
 * E2E del checkout del kiosk en CHROME REAL (headless) — Playwright.
 * Motivo: jsdom no computa layout (el bug de [hidden] pasó invisible al harness);
 * aquí las aserciones de visibilidad son las que ve un humano.
 *
 * Sin descarga de browsers: playwright-core + channel:'chrome' (Chrome instalado).
 * /api/* va stubbeado con page.route (mismos stubs que el harness jsdom).
 * Uso:  npm run test:e2e   (fuera de `npm test`: requiere Chrome local)
 * ==========================================================================*/
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

let fails = 0, count = 0;
const t = (cond, msg) => { count++; if (cond) console.log(`  PASS  ${msg}`); else { console.error(`  FAIL  ${msg}`); fails++; } };

/* Servidor estático mínimo sirviendo la raíz del repo (kiosk/ vive ahí). */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(process.cwd(), path.endsWith('/') ? path + 'index.html' : path);
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();

  /* Stubs de /api/* (espejo de tools/tests/helpers.mjs). `pay` es el estado que el poll consulta. */
  const SUMMARY = { first_name: 'Test', lines: [{ cov: 'stain', count: 1, monthly_cents: 999 }], membership: false, total_cents: 999, mode: 'plan' };
  const pay = { opened: false, done: false };
  const CHAT_NEXT = [];   /* MAYA: respuestas encoladas para /api/chat (stub del LLM) */
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    const method = route.request().method();
    let body = {};
    if (u.includes('/api/chat')) body = CHAT_NEXT.shift() || { reply: 'ok' };
    else if (u.includes('/api/kiosk-handoff')) {
      body = method === 'GET' ? { status: 'pending', summary: SUMMARY }
        : { token: 'aaa.bbb', summary: SUMMARY, expires_at: '2099-01-01T00:00:00.000Z' };
    } else if (u.includes('/api/checkout-status')) body = { done: pay.done, expired: false, opened: pay.opened };
    else if (u.includes('/api/upload-receipt')) body = { path: 'receipts/2026/07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg' };
    else if (u.includes('/api/create-checkout-session')) body = { url: 'https://checkout.stripe.com/x', id: 'cs_test_1', short_url: ORIGIN + '/p/ACDE2345' };
    else if (u.includes('/api/create-gift-checkout')) body = { url: ORIGIN + '/kiosk/index.html?gift=stub' };   /* F6: navegable dentro del harness */
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  /* Carrito sembrado ANTES de cargar (mismo formato que el harness). */
  await page.addInitScript(() => {
    localStorage.setItem('furnfx_cart', JSON.stringify([{ cov: 'stain', term: 'monthly', type: 'furniture', count: 1 }]));
  });
  await page.goto(ORIGIN + '/kiosk/', { waitUntil: 'load' });
  await page.click('#nav-cart');
  await page.waitForSelector('#cart-panel.open');

  /* 1 · C.6: el pack de email quedó destapado (envío real verificado el 06-jul) — visibilidad COMPUTADA. */
  t(await page.isVisible('#cart-email-self'), 'e2e: el botón "Email my cart to myself" se pinta (destapado)');
  t(await page.isVisible('input[name="deliver"][value="email"]'), 'e2e: el radio "Email the link to the customer" se pinta (destapado)');
  t(await page.isVisible('#cart-pay'), 'e2e: el botón Pay sí se pinta (sanity del selector)');
  /* la regla global [hidden]{display:none!important} sigue vigilada con la vista de éxito (hidden en markup) */
  t(!(await page.isVisible('#cart-view-success')), 'e2e: regresión [hidden] — la vista de éxito NO se pinta');
  /* Default 09-jul (Adrian): "Pay on this device" manda y el bloque del recibo abre VISIBLE */
  t(await page.isChecked('input[name="deliver"][value="redirect"]'), 'e2e-default: "Pay on this device" es el default');
  t(await page.isVisible('#cart-receipt-field'), 'e2e-default: el bloque "Now, please add your sales receipt…" abre visible sin tocar nada');

  /* 2 · Máscara de teléfono con teclado REAL. */
  await page.click('#cart-phone');
  await page.keyboard.type('5551234567');
  t((await page.inputValue('#cart-phone')) === '(555) 123-4567', 'e2e: teclear 10 dígitos pinta (555) 123-4567');
  /* 7 backspaces: el 4º borra solo el guion (los dígitos se conservan) y el reformat colapsa
     la puntuación al llegar a 3 dígitos — nunca se atasca. */
  for (let i = 0; i < 7; i++) await page.keyboard.press('Backspace');
  t((await page.inputValue('#cart-phone')) === '555', 'e2e: borrar colapsa la máscara sin atascarse');

  /* 3 · El checkbox de exactitud gatea el Pay (computado). */
  t(await page.isDisabled('#cart-pay'), 'e2e: Pay deshabilitado sin confirmar exactitud');
  /* B2 (KIOSK-20): deshabilitado NO muestra la mención de Stripe */
  const payAfterOff = await page.evaluate(() => getComputedStyle(document.getElementById('cart-pay'), '::after').content);
  t(payAfterOff === 'none', 'e2e-B2: Pay deshabilitado sin la segunda línea');
  await page.check('#cart-accuracy');
  t(!(await page.isDisabled('#cart-pay')), 'e2e: marcar el checkbox habilita Pay');
  /* B2 (KIOSK-20): la mención "Secure pay through Stripe" es la segunda línea DEL botón */
  const payAfterOn = await page.evaluate(() => getComputedStyle(document.getElementById('cart-pay'), '::after').content);
  t(payAfterOn.includes('Secure pay through Stripe'), 'e2e-B2: Pay habilitado muestra "Secure pay through Stripe" bajo el precio');

  /* El botón GUÍA según la vía elegida (09-jul): en QR/email el clic no cobra aquí */
  await page.check('input[name="deliver"][value="qr"]');
  t(/Show the QR code/.test(await page.textContent('#cart-pay')), 'e2e-guide: vía QR → "Show the QR code"');
  await page.check('input[name="deliver"][value="email"]');
  t(/Email the payment link/.test(await page.textContent('#cart-pay')), 'e2e-guide: vía email → "Email the payment link"');
  await page.check('input[name="deliver"][value="redirect"]');
  t(/Pay \$9\.99\/mo/.test((await page.textContent('#cart-pay')).replace(/\s+/g, ' ')), 'e2e-guide: volver a "Pay on this device" restaura el precio');

  /* 4 · Errores específicos: submit con nombre vacío (resto lleno, en modo handoff EXPLÍCITO:
     sin foto requerida, para aislar los mensajes de los demás campos). */
  await page.check('input[name="deliver"][value="handoff"]');
  await page.fill('#cart-email', 'test@example.com');
  await page.fill('#cart-phone', '5551234567');
  await page.fill('#cart-address', '1 Main St, Logan UT 84321');
  await page.fill('#cart-associate', '4471');
  await page.fill('#cart-order', '100482');
  await page.fill('#cart-zip', '84321');
  await page.fill('#cart-date', '2026-07-06');
  await page.click('#cart-pay');
  t(await page.isVisible('.cart-field.field-error .field-msg'), 'e2e: el mensaje inline del campo faltante SE VE');
  t((await page.textContent('.cart-field.field-error .field-msg')).trim() === 'Add the name', 'e2e: y dice "Add the name"');
  t(/Missing: name\./.test(await page.textContent('#cart-stripe-note')), 'e2e: la nota general nombra lo que falta');
  await page.fill('#cart-name', 'Test Customer');
  t(!(await page.isVisible('.cart-field.field-error .field-msg')), 'e2e: teclear limpia el error en pantalla');

  /* 5 · Email inválido → mensaje específico visible. */
  await page.fill('#cart-email', 'nope');
  await page.click('#cart-pay');
  t(/doesn't look right/.test(await page.textContent('.cart-field.field-error .field-msg')), 'e2e: email inválido → su mensaje visible');

  /* 6 · BLOQUE B: flujo QR-pay completo — opened → cerrar/reabrir reanuda → done. El poll corre
     cada 4s REALES, así que los waits son generosos. */
  await page.fill('#cart-email', 'test@example.com');
  await page.check('input[name="deliver"][value="qr"]');   /* fuera del modo handoff, el campo del recibo se muestra */
  /* SELF-1 (Doug: "tap the QR code or scan the QR code"): tocar el QR del recibo abre el
     file picker del PROPIO dispositivo — verificado con el filechooser real de Chrome. */
  await page.click('#cart-receipt-phone-btn');
  await page.waitForSelector('#cart-receipt-qr:not([hidden])', { timeout: 10000 });
  const chooserP = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#cart-receipt-qr-box');
  const chooser = await chooserP;
  t(!!chooser, 'e2e-S1: tocar el QR del recibo abre el picker (tap or scan)');
  await chooser.setFiles([]);   /* el change vacío devuelve la UI al dropzone por sí sola */
  await page.waitForSelector('#cart-dropzone:not([hidden])', { timeout: 5000 });
  const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#cart-receipt-photo', { name: 'receipt.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await page.click('#cart-pay');
  await page.waitForSelector('#cart-view-handoff:not([hidden])', { timeout: 15000 });
  t(true, 'e2e-B: el submit QR llega a la vista de espera');
  t((await page.textContent('#cart-handoff-link')).includes('/p/ACDE2345'), 'e2e-B: la URL corta se pinta bajo el QR');
  /* hallazgo smoke 06-jul: abandonar la espera vuelve al form con carrito y campos intactos */
  await page.click('#cart-handoff-back');
  await page.waitForSelector('#cart-view-form:not([hidden])', { timeout: 5000 });
  t(await page.isVisible('#cart-pay'), 'e2e-B: "Choose another way to pay" vuelve a las opciones sin perder nada');
  await page.click('#cart-pay');
  await page.waitForSelector('#cart-view-handoff:not([hidden])', { timeout: 15000 });
  t(true, 'e2e-B: re-submit tras el back funciona');
  pay.opened = true;
  await page.waitForFunction(() => (document.getElementById('cart-handoff-sub') || {}).textContent === 'Customer is on the payment page…', null, { timeout: 15000 });
  t(true, 'e2e-B: opened:true → "Customer is on the payment page…" en pantalla');
  /* cerrar en plena espera y reabrir → REANUDA (KIOSK-17) */
  await page.click('#cart-close');
  await page.waitForSelector('#cart-panel', { state: 'hidden', timeout: 5000 });
  await page.click('#nav-cart');
  await page.waitForSelector('#cart-panel.open', { timeout: 5000 });
  t(await page.isVisible('#cart-view-handoff'), 'e2e-B: reabrir REANUDA la espera (no vuelve al form)');
  t(!(await page.isVisible('#cart-form')), 'e2e-B: el form no se apila debajo');
  pay.done = true;
  await page.waitForSelector('#cart-view-success:not([hidden])', { timeout: 15000 });
  t(/Payment received/.test(await page.textContent('#cart-success-title')), 'e2e-B: done:true → "Payment received"');
  /* B1 (KIOSK-21, Doug: "you stranded me… it has to be large"): el éxito habla del PLAN HOLDER,
     recuerda el spam, da el 833 clickeable y sigue ofreciendo New sale al associate. */
  const successTxt = await page.textContent('#cart-view-success');
  t(/We sent the plan holder the sign-in information/.test(successTxt), 'e2e-B1: el éxito habla del plan holder (no sabes quién mira)');
  t(/Check your spam folder/.test(successTxt), 'e2e-B1: recordatorio de spam visible');
  t((await page.getAttribute('#cart-view-success a[href^="tel:"]', 'href')) === 'tel:18333957824', 'e2e-B1: el 833 es un tel: clickeable');
  t(await page.isVisible('#cart-newsale-success'), 'e2e-B1: el botón de reset sigue ahí');
  t(/Start a new purchase/.test(await page.textContent('#cart-newsale-success')),
    'e2e-B1: y es neutro de actor ("Start a new purchase", no "New sale")');
  const bigPx = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#cart-view-success .success-big')).fontSize));
  t(bigPx >= 16.5, 'e2e-B1: el mensaje es GRANDE (fuente computada >= 1.05rem)');

  /* 7 · E3 (Ago-10 Doug): "Customer login" del drawer → overlay con QR al dashboard del cliente
     (la tablet no navega: el cliente lo abre en SU teléfono o toca el QR/URL). */
  await page.click('#cart-close');
  await page.waitForSelector('#cart-panel', { state: 'hidden', timeout: 5000 });
  await page.click('#nav-toggle');
  await page.waitForSelector('#nav-drawer.open', { timeout: 5000 });
  await page.click('#drawer-cust-login');
  await page.waitForSelector('#dashqr-backdrop:not([hidden])', { timeout: 5000 });
  t(true, 'e2e-E3: "My dashboard" abre el overlay del QR');
  /* closeDrawer() tapa el drawer con un setTimeout de 280ms antes de poner hidden */
  await page.waitForSelector('#nav-drawer', { state: 'hidden', timeout: 5000 });
  t(true, 'e2e-E3: el nav drawer se cerró al abrir el overlay');
  t((await page.textContent('#dashqr-backdrop')).includes('furniturerx.net/dashboard'), 'e2e-E3: la URL tecleable se pinta bajo el QR');
  /* qrcode.min.js se sirve local; si en el harness no cargara, el fallback deja el box vacío
     (la URL de texto basta) — la aserción acepta AMBOS estados, nunca un box a medias. */
  await page.waitForFunction(() => !!document.querySelector('#dashqr-box svg'), null, { timeout: 5000 }).catch(() => {});
  const dashQr = await page.evaluate(() => {
    const box = document.getElementById('dashqr-box');
    return { hasSvg: !!box.querySelector('svg'), empty: !box.firstChild };
  });
  t(dashQr.hasSvg || dashQr.empty, 'e2e-E3: el box trae un <svg> de QR — o queda vacío (fallback sin lib, URL visible)');
  await page.click('#dashqr-close');
  await page.waitForSelector('#dashqr-backdrop', { state: 'hidden', timeout: 5000 });
  t(true, 'e2e-E3: el × cierra el overlay (hidden)');

  /* 7b · Ago-10 (Doug): "Dealer login" del drawer → mismo overlay, destino portal.furniturerx.net,
     con la URL bajo el QR clicable en la tablet. */
  await page.click('#nav-toggle');
  await page.waitForSelector('#nav-drawer.open', { timeout: 5000 });
  await page.click('#drawer-dealer-login');
  await page.waitForSelector('#dashqr-backdrop:not([hidden])', { timeout: 5000 });
  t((await page.getAttribute('#dashqr-url', 'href')) === 'https://portal.furniturerx.net/', 'e2e-E3b: Dealer login → href del portal');
  t((await page.textContent('#dashqr-url')).includes('portal.furniturerx.net'), 'e2e-E3b: la URL del portal se pinta y es clicable');
  await page.click('#dashqr-close');
  await page.waitForSelector('#dashqr-backdrop', { state: 'hidden', timeout: 5000 });

  /* 8 · F6 (GIFT-1): los .js-gift-coupon dejaron de ser placeholders inertes — abren el overlay
     de gift, el total recalcula con el tier y el submit navega a la URL del checkout stubbeado. */
  const giftLinks = page.locator('.js-gift-coupon');
  t((await giftLinks.count()) === 2, 'e2e-F6: hay 2 links .js-gift-coupon (membership copy + foot)');
  await giftLinks.first().scrollIntoViewIfNeeded();
  await giftLinks.first().click();
  await page.waitForSelector('#gift-backdrop:not([hidden])', { timeout: 5000 });
  t(true, 'e2e-F6: el primer link abre el overlay (ya no es inerte)');
  t((await page.textContent('#gift-total')).trim() === '3 months · total $29.97', 'e2e-F6: total inicial (stain default) = $29.97');
  await page.selectOption('#gift-tier', 'membership');
  t((await page.textContent('#gift-total')).includes('$59.97'), 'e2e-F6: cambiar a membership recalcula el total a $59.97');
  /* submit sin email → mensaje inline y NO navega (el botón queda usable) */
  await page.click('#gift-submit');
  t(/Add your email/.test(await page.textContent('#gift-msg')), 'e2e-F6: submit sin email pinta el aviso inline');
  t(!(await page.isDisabled('#gift-submit')), 'e2e-F6: y el botón sigue habilitado');
  await page.fill('#gift-email', 'giver@example.com');
  await page.click('#gift-submit');
  await page.waitForURL('**gift=stub**', { timeout: 10000 });
  t(true, 'e2e-F6: submit válido POSTea al stub y navega a su {url}');
  /* la URL del stub sirve el MISMO archivo → verificar el SEGUNDO link tras el "regreso" */
  await giftLinks.nth(1).scrollIntoViewIfNeeded();
  await giftLinks.nth(1).click();
  await page.waitForSelector('#gift-backdrop:not([hidden])', { timeout: 5000 });
  t(true, 'e2e-F6: el segundo link (mem-card-foot) también abre el overlay');
  await page.click('#gift-close');
  await page.waitForSelector('#gift-backdrop', { state: 'hidden', timeout: 5000 });
  t(true, 'e2e-F6: el × cierra el overlay del gift');

  /* 9 · MAYA (7/8/9): trigger de la card → Maya se presenta y pide el NOMBRE; la respuesta
     (stub del LLM con coverage completo) deja road signs y la card ENTERA llena. */
  const mayaTrigger = page.locator('.cov-assist-trigger[data-cov="stain"]').first();
  await mayaTrigger.scrollIntoViewIfNeeded();
  await mayaTrigger.click();
  await page.waitForSelector('#chat-panel.open', { timeout: 5000 });
  const chatOpenTxt = await page.textContent('#chat-body');
  t(/Hi, I'm Maya, your sales assistant/.test(chatOpenTxt), 'e2e-M7: Maya se presenta por nombre');
  t(/first and last name/.test(chatOpenTxt), 'e2e-M7: la primera pregunta es el nombre (orden de Doug)');
  CHAT_NEXT.push({
    reply: 'Great, you are all set. Do not forget to add a photo of your sales receipt at checkout.',
    coverage: {
      cov: 'stain', sales_order_number: '100777', sales_order_total: 4100, item_count: 3,
      recommended_plans: 1, covered_up_to: 5000,
      customer_name: 'Bob Miller', customer_email: 'bob@example.com', customer_phone: '5550100199',
      delivery_address: '9 Oak St, Logan, UT 84321',
      delivery_zip: '84321', delivery_date: '2026-07-20', note: ''
    }
  });
  await page.fill('#chat-input', 'Bob Miller, order 100777, $4,100, 3 items, a sofa, 9 Oak St Logan UT 84321, July 20');
  await page.click('#chat-form button[type="submit"]');
  await page.waitForFunction(() => /filled in your details/.test((document.getElementById('chat-body') || {}).textContent || ''), null, { timeout: 10000 });
  t(/add a photo of your sales receipt/.test(await page.textContent('#chat-body')), 'e2e-M9: road signs deterministas tras el sizing');
  await page.click('#nav-cart');
  await page.waitForSelector('#cart-panel.open', { timeout: 5000 });
  t((await page.inputValue('#cart-name')) === 'Bob Miller', 'e2e-M8: NOMBRE volcado al campo del nombre (no el SO)');
  t((await page.getAttribute('#cart-name', 'placeholder')) === 'First and Last Name', 'e2e-M8b: placeholder alineado al label');
  t((await page.inputValue('#cart-email')) === 'bob@example.com', 'e2e-M8b: email volcado');
  t((await page.inputValue('#cart-phone')) === '(555) 010-0199', 'e2e-M8b: teléfono volcado y FORMATEADO por la máscara del front');
  t((await page.inputValue('#cart-order')) === '100777', 'e2e-M8: sales order volcada a SU campo');
  t((await page.inputValue('#cart-zip')) === '84321', 'e2e-M8: ZIP volcado');
  t((await page.inputValue('#cart-address')) === '9 Oak St, Logan, UT 84321', 'e2e-M8: dirección de entrega volcada');
  t((await page.inputValue('#cart-date')) === '2026-07-20', 'e2e-M8: delivery date volcada ("including the delivery date")');
} finally {
  await browser.close();
  server.close();
}

console.log(`e2e-kiosk: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
