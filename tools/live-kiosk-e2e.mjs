/* ============================================================================
 * SMOKE LIVE del kiosk (https://kiosk.furniturerx.net/) en Chrome VISIBLE.
 * Recorrido completo: card → drawer → form (datos random, email @rapqa.com,
 * tel 000…) → recibo → Pay on this device → Stripe TEST (Mastercard 5555…4444,
 * 04/44, CVC 444) → retorno → éxito "We sent the plan holder…".
 * Uso:  node tools/live-kiosk-e2e.mjs   (deja screenshots en misc/live-e2e-09jul/)
 * ==========================================================================*/
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'misc/live-e2e-09jul';
mkdirSync(OUT, { recursive: true });

const rand = (n) => Math.random().toString().slice(2, 2 + n);
const RUN = {
  name: 'QA Random ' + rand(4),
  email: 'qa.' + Date.now().toString(36) + rand(3) + '@rapqa.com',
  phone: '000' + rand(7),
  address: '123 QA Street, Logan, UT 84321',
  associate: '4471',
  order: '9' + rand(5),
  zip: '84321',
  date: new Date().toISOString().slice(0, 10)
};
console.log('DATOS DEL RUN →', JSON.stringify(RUN, null, 2));

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let step = 0;
const browser = await chromium.launch({ channel: 'chrome', headless: false, slowMo: 120 });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const shot = async (label) => {
  const f = `${OUT}/${String(++step).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: f, fullPage: false }).catch(() => {});
  console.log('  📸', f);
};

try {
  console.log('1 · Abriendo el kiosk live…');
  await page.goto('https://kiosk.furniturerx.net/', { waitUntil: 'load', timeout: 45000 });
  await shot('kiosk-home');

  console.log('2 · Checkout de la card Stain…');
  const cta = page.locator('#cmp-stain-checkout');
  await cta.scrollIntoViewIfNeeded();
  await cta.click();
  await page.waitForSelector('#cart-panel.open', { timeout: 10000 });
  const defaultRedirect = await page.isChecked('input[name="deliver"][value="redirect"]');
  const receiptVisible = await page.isVisible('#cart-receipt-field');
  console.log('   default "Pay on this device":', defaultRedirect, '· recibo abierto:', receiptVisible);
  await shot('drawer-abierto');

  console.log('3 · Llenando el form con', RUN.email, '/', RUN.phone);
  await page.fill('#cart-name', RUN.name);
  await page.fill('#cart-email', RUN.email);
  await page.fill('#cart-phone', RUN.phone);
  await page.fill('#cart-address', RUN.address);
  await page.fill('#cart-associate', RUN.associate);
  await page.fill('#cart-order', RUN.order);
  await page.fill('#cart-zip', RUN.zip);
  await page.fill('#cart-date', RUN.date);
  await page.setInputFiles('#cart-receipt-photo', { name: 'qa-receipt.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await page.waitForSelector('#cart-receipt-preview:not([hidden])', { timeout: 15000 }).catch(() => {});
  await page.check('#cart-accuracy');
  const payTxt = (await page.textContent('#cart-pay')).replace(/\s+/g, ' ').trim();
  console.log('   botón Pay:', payTxt);
  await shot('form-lleno');

  console.log('4 · Pay on this device → Stripe…');
  await page.click('#cart-pay');
  await page.waitForURL('**checkout.stripe.com**', { timeout: 45000 });
  await page.waitForSelector('#cardNumber, input[name="cardNumber"]', { timeout: 30000 });
  await shot('stripe-checkout');

  console.log('5 · Pagando con la Mastercard de test 5555…4444 (04/44, CVC 444)…');
  const emailBox = page.locator('#email');
  if (await emailBox.count() && !(await emailBox.inputValue().catch(() => 'x'))) await emailBox.fill(RUN.email);
  await page.fill('#cardNumber', '5555555555554444');
  await page.fill('#cardExpiry', '0444');
  await page.fill('#cardCvc', '444');
  const bn = page.locator('#billingName');
  if (await bn.count()) await bn.fill(RUN.name);
  const bz = page.locator('#billingPostalCode');
  if (await bz.count()) await bz.fill(RUN.zip);
  /* Link ("Save my information") viene auto-marcado y exige un teléfono válido → fuera */
  const linkCb = page.locator('#enableStripePass');
  if (await linkCb.count() && await linkCb.isChecked().catch(() => false)) {
    await linkCb.uncheck().catch(async () => { await linkCb.click().catch(() => {}); });
    console.log('   Link (Save my information) desmarcado');
  }
  await shot('stripe-lleno');
  const submit = page.locator('[data-testid="hosted-payment-submit-button"], button[type="submit"].SubmitButton, form button[type="submit"]').first();
  await submit.click();

  console.log('6 · Esperando el retorno al kiosk…');
  await page.waitForURL('**kiosk.furniturerx.net**', { timeout: 90000 });
  await page.waitForSelector('#cart-view-success:not([hidden])', { timeout: 30000 });
  const successTxt = (await page.textContent('#cart-view-success')).replace(/\s+/g, ' ').trim();
  await shot('exito-plan-holder');

  console.log('\n════════ RESULTADO ════════');
  console.log('ÉXITO visible:', /We sent the plan holder/.test(successTxt) ? 'SÍ — habla del plan holder' : 'texto inesperado');
  console.log('833 clickeable:', (await page.getAttribute('#cart-view-success a[href^="tel:"]', 'href')) || 'NO ENCONTRADO');
  console.log('Botón reset:', (await page.textContent('#cart-newsale-success')).trim());
  console.log('\nEmail del comprador (revisa el welcome + dashboard):', RUN.email);
  console.log('Sales order:', RUN.order, '· Teléfono:', RUN.phone);
  writeFileSync(`${OUT}/run-data.json`, JSON.stringify({ ...RUN, success_text: successTxt, when: new Date().toISOString() }, null, 2));
  console.log('Screenshots y datos en', OUT + '/');
  await page.waitForTimeout(10000);   // deja la pantalla de éxito a la vista
} catch (err) {
  console.error('\n❌ FALLÓ en el paso', step + 1, '→', err.message);
  await shot('ERROR');
  process.exitCode = 1;
} finally {
  await browser.close();
}
