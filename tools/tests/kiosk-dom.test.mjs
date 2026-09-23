/* Tests de COMPORTAMIENTO del kiosk (jsdom). Crece tarea a tarea (work order 04-jul).
 * Spec: misc/spec-work-order-04jul.md · helpers: loadKiosk() con /api stub + intervals capturados. */
import { loadKiosk, flush, makeT, sleep } from './helpers.mjs';

const t = makeT('kiosk-dom');
const ONE_LINE = JSON.stringify([{ cov: 'stain', term: 'monthly', type: 'furniture', count: 1 }]);

/* 4 · KIOSK-3 — checkbox de exactitud que habilita el pago (Doug 02-jul 20:16 a 20:58) */
{
  const { document, errors } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  t(errors.length === 0, 'KIOSK-3: boot sin jsdomErrors');
  const pay = document.getElementById('cart-pay');
  const cb = document.getElementById('cart-accuracy');
  t(!!cb, 'KIOSK-3: existe #cart-accuracy');
  t(!!pay && pay.disabled === true, 'KIOSK-3: con carrito y checkbox sin marcar → Pay deshabilitado');
  if (cb) {
    cb.click();
    await flush();
    t(pay.disabled === false, 'KIOSK-3: marcar el checkbox habilita Pay');
    document.getElementById('cart-newsale-success').click();
    await flush();
    t(cb.checked === false, 'KIOSK-3: "New sale" desmarca el checkbox');
    t(pay.disabled === true, 'KIOSK-3: tras "New sale" Pay vuelve a deshabilitado');
  }
}

/* Helper de flujo: bootea con 1 plan, confirma exactitud, llena el form y hace submit
   en modo handoff (EXPLÍCITO desde 09-jul: el default pasó a "Pay on this device")
   → arranca el poll de pago capturado en `intervals`. */
async function bootAndSubmitHandoff(extraStorage, api) {
  const ctx = await loadKiosk({ storage: Object.assign({ furnfx_cart: ONE_LINE }, extraStorage || {}), api: api || {} });
  const { document, window } = ctx;
  const hRadio = document.querySelector('input[name="deliver"][value="handoff"]');
  if (hRadio && !hRadio.checked) { hRadio.checked = true; hRadio.dispatchEvent(new window.Event('change', { bubbles: true })); }
  const val = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  val('cart-name', 'Test Customer'); val('cart-email', 'test@example.com');
  val('cart-phone', '5551234567'); val('cart-address', '1 Main St, Logan UT 84321');
  val('cart-associate', '4471'); val('cart-order', '100482'); val('cart-zip', '84321'); val('cart-date', '2026-07-01');
  const acc = document.getElementById('cart-accuracy'); if (acc && !acc.checked) acc.click();
  await flush();
  document.getElementById('cart-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(); await flush();
  return ctx;
}

/* ISS-14 — vaciar el carrito abre el modal con estilo (no window.confirm); confirmar limpia */
{
  const { document, window } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const bd = document.getElementById('confirm-backdrop');
  t(!!bd && bd.hidden === true, 'ISS-14: el modal de confirmación nace hidden');
  document.getElementById('cart-clear').click();
  await flush();
  t(bd.hidden === false, 'ISS-14: "Empty cart" abre el modal (no un confirm nativo)');
  document.getElementById('confirm-no').click();
  await flush();
  t(bd.hidden === true, 'ISS-14: cancelar cierra el modal');
  /* cancelar NO vació: el botón solo abre el modal cuando el carrito tiene contenido (guard) → reabre */
  document.getElementById('cart-clear').click(); await flush();
  t(bd.hidden === false, 'ISS-14: cancelar NO vació (el carrito sigue con contenido → el modal reabre)');
  document.getElementById('confirm-yes').click(); await flush();
  t(bd.hidden === true, 'ISS-14: confirmar cierra el modal y vacía (clearCart)');
  /* con el carrito vacío el guard impide abrir el modal */
  document.getElementById('cart-clear').click(); await flush();
  t(bd.hidden === true, 'ISS-14: con el carrito vacío el botón no abre el modal (guard)');
}

/* DEC-1 — "Take a photo" conmuta capture=environment; "Choose a file" lo quita (mismo input) */
{
  const { document } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const inp = document.getElementById('cart-receipt-photo');
  const cam = document.getElementById('cart-receipt-cam-btn');
  const fileBtn = document.getElementById('cart-receipt-file-btn');
  t(!!inp && !!cam && !!fileBtn, 'DEC-1: existen el input y los dos botones');
  t(!inp.hasAttribute('capture'), 'DEC-1: por defecto sin capture (el box = galería/archivos)');
  cam.click();
  t(inp.getAttribute('capture') === 'environment', 'DEC-1: "Take a photo" pone capture=environment (cámara)');
  fileBtn.click();
  t(!inp.hasAttribute('capture'), 'DEC-1: "Choose a file" quita capture (galería/archivos)');
}

/* Ago-10 (Doug) — "My dashboard" se parte en Customer login + Dealer login; cada uno abre el QR
   modal a su destino, con la URL bajo el QR como link clicable (escanear con el teléfono O tocar). */
{
  const { document } = await loadKiosk({});
  const bd = document.getElementById('dashqr-backdrop');
  const urlLink = document.getElementById('dashqr-url');
  const cust = document.getElementById('drawer-cust-login');
  const dealer = document.getElementById('drawer-dealer-login');
  t(!!cust && !!dealer, 'login-split: el drawer tiene Customer login + Dealer login');
  t(!!bd && bd.hidden === true, 'login-split: el QR modal nace hidden');
  t(!!urlLink && urlLink.tagName === 'A', 'login-split: la URL bajo el QR es un <a> clicable');
  cust.click(); await flush();
  t(bd.hidden === false, 'login-split: Customer login abre el QR modal');
  t(urlLink.getAttribute('href') === 'https://www.furniturerx.net/dashboard', 'login-split: Customer login → href del dashboard del cliente');
  t(/furniturerx\.net\/dashboard/.test(urlLink.textContent), 'login-split: el texto del link muestra el dashboard');
  document.getElementById('dashqr-close').click(); await flush();
  t(bd.hidden === true, 'login-split: el × cierra el modal');
  dealer.click(); await flush();
  t(bd.hidden === false, 'login-split: Dealer login abre el QR modal');
  t(urlLink.getAttribute('href') === 'https://portal.furniturerx.net/', 'login-split: Dealer login → href del portal');
  t(/portal\.furniturerx\.net/.test(urlLink.textContent), 'login-split: el texto del link muestra el portal');
}

/* ISS-06 — el timeout del recibo-desde-teléfono sale JUNTO al campo del recibo, no en el pie */
{
  const ctx = await loadKiosk({
    storage: { furnfx_cart: ONE_LINE },
    api: {
      'kiosk-handoff': (u, o) => ((o && o.method) === 'POST')
        ? { token: 'rcpt.tok', summary: { first_name: 'T' }, expires_at: '2099-01-01T00:00:00.000Z' }
        : { status: 'pending' }   /* nunca llega el recibo → se agota el poll */
    }
  });
  const { document, tick } = ctx;
  document.getElementById('cart-receipt-phone-btn').click();
  await flush(); await flush();
  await tick(46);   /* agota el tope de 45 ticks del poll del recibo */
  const msg = document.getElementById('cart-receipt-msg');
  const foot = document.getElementById('cart-stripe-note');
  t(!!msg && msg.hidden === false && /Still no receipt/.test(msg.textContent), 'ISS-06: el timeout del recibo sale junto al campo (no en el pie)');
  t(!/Still no receipt/.test(foot.textContent || ''), 'ISS-06: el pie NO lleva el mensaje del recibo');
}

/* ISS-13 — al agotar/expirar el poll se ocultan el QR, el link y el aviso "valid 24h" (obsoletos).
   NOTA: la parte "la ✕ vuelve al form" que pidió el tester NO se implementa: choca con B.4/KIOSK-17
   (cerrar preserva la espera y reabrir la reanuda). Queda para decisión de Doug. */
{
  const ctx = await bootAndSubmitHandoff();
  const { document, tick } = ctx;
  const qr = document.getElementById('cart-qr');
  const valid = document.querySelector('#cart-view-handoff .handoff-valid');
  t(valid.hidden === false, 'ISS-13: antes del timeout, el aviso "valid 24h" es visible');
  await tick(46);   /* agota el poll → showPollTimeout */
  t(qr.hidden === true, 'ISS-13: al agotar el poll, el QR se oculta');
  t(valid.hidden === true, 'ISS-13: al agotar, el aviso "valid 24h" se oculta');
}

/* DEC-3 — el formulario del cliente sobrevive reload (borrador en sessionStorage) */
{
  const { document, window } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const val = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  val('cart-name', 'Ana Flores'); val('cart-email', 'ana@x.co'); val('cart-order', 'SO-99');
  await sleep(350);   /* deja correr el debounce del guardado */
  const raw = window.sessionStorage.getItem('furnfx_checkout_draft');
  t(!!raw && /Ana Flores/.test(raw) && /ana@x\.co/.test(raw), 'DEC-3: los campos del cliente se guardan en el borrador (sessionStorage)');
}
{
  const draft = JSON.stringify({ v: 1, f: { 'cart-name': 'Bob Lee', 'cart-email': 'bob@x.co', 'cart-order': 'SO-77' } });
  const { document } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE }, session: { furnfx_checkout_draft: draft } });
  await flush();
  t(document.getElementById('cart-name').value === 'Bob Lee' && document.getElementById('cart-email').value === 'bob@x.co', 'DEC-3: el borrador se restaura al cargar (sobrevive reload)');
  t(document.getElementById('cart-accuracy').checked === false, 'DEC-3: la casilla de exactitud NO se rehidrata (se re-atesta)');
  t(document.getElementById('cart-panel').hidden === false, 'DEC-3: con borrador, el drawer reabre en el form');
}
{
  const draft = JSON.stringify({ v: 1, f: { 'cart-name': 'X Person' } });
  const { document, window } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE }, session: { furnfx_checkout_draft: draft } });
  await flush();
  document.getElementById('cart-newsale-success').click();
  await flush();
  t(window.sessionStorage.getItem('furnfx_checkout_draft') === null, 'DEC-3: "Start a new purchase" limpia el borrador');
}

/* ISS-04 — "Start a new purchase" resetea "Ways to pay" al default (Pay on this device) */
{
  const { document, window } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const qr = document.querySelector('input[name="deliver"][value="qr"]');
  qr.checked = true; qr.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  document.getElementById('cart-newsale-success').click();
  await flush();
  const redirect = document.querySelector('input[name="deliver"][value="redirect"]');
  t(redirect.checked === true && qr.checked === false, 'ISS-04: nueva venta vuelve a "Pay on this device" (default)');
}

/* DEC-4 — "Start a new purchase" en la ESPERA confirma antes de descartar (el modal va en el botón,
   no en newSale, para que el auto-reset de 120s no dispare modal). El botón de la vista de ÉXITO no confirma. */
{
  const ctx = await bootAndSubmitHandoff();
  const { document } = ctx;
  const bd = document.getElementById('confirm-backdrop');
  document.getElementById('cart-newsale').click();
  await flush();
  t(bd.hidden === false, 'DEC-4: "Start a new purchase" (espera) abre el modal');
  document.getElementById('confirm-no').click(); await flush();
  t(bd.hidden === true && document.getElementById('cart-view-handoff').hidden === false, 'DEC-4: cancelar cierra el modal y sigue en la espera');
  document.getElementById('cart-newsale').click(); await flush();
  document.getElementById('confirm-yes').click(); await flush();
  t(document.getElementById('cart-view-form').hidden === false && document.getElementById('cart-view-handoff').hidden === true, 'DEC-4: confirmar ejecuta newSale (vuelve al form)');
}

/* ISS-01 — quitar el plan (queda solo un kit) oculta y des-obliga los campos de tienda */
{
  const { document } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE, furnfx_kits: JSON.stringify({ 'Wood Care Kit': 1 }) } });
  document.getElementById('nav-cart').click();   /* abre el drawer → cartFillSummary + renderPlanLines */
  await flush();
  const fields = document.getElementById('cart-receipt-fields');
  const rp = document.getElementById('cart-receipt-photo');
  t(!!fields && fields.hidden === false && rp.required === true, 'ISS-01: con plan → campos de tienda visibles y required');
  document.querySelector('#cart-plans-list .cart-line-remove').click();   /* quita la línea de plan */
  await flush();
  t(fields.hidden === true && rp.required === false, 'ISS-01: al quitar el plan (solo kit) → campos ocultos y NO required');
}

/* BE-5 (14-ago) — el drawer incluye S&H ($11/kit) + tax (6% kit-only) en el total one-time y
   lo explica con una nota; espeja lo que Stripe cobrará (kitCharges del server). */
{
  const { document } = await loadKiosk({ storage: { furnfx_kits: JSON.stringify({ 'Wood Care Kit': 1 }) } });
  document.getElementById('nav-cart').click();
  await flush();
  /* 49.99 + 11.00 + 3.00 (6% de 49.99 redondeado) = 63.99 */
  t(/\$63\.99/.test(document.getElementById('cart-pay').textContent), 'BE-5: solo-kit → Pay $63.99 once (retail + S&H + tax)');
  t(/\$63\.99 one-time/.test(document.getElementById('cart-total-val').textContent), 'BE-5: el total one-time incluye S&H + tax');
  const note = document.querySelector('#cart-kits .cart-kits-note');
  t(!!note && /\$11\.00 shipping & handling per kit and 6% sales tax/.test(note.textContent), 'BE-5: la nota del drawer explica los cargos');
}

/* 6 · KIOSK-6 — timeout visible del polling de pago + retry (audit C7) */
{
  const ctx = await bootAndSubmitHandoff();
  const { document, live, tick } = ctx;
  t(live().length > 0, 'KIOSK-6: el submit handoff arranca un poll (interval capturado)');
  await tick(46);   /* agota el tope de 45 ticks */
  const sub = document.getElementById('cart-handoff-sub');
  t(/Still no payment confirmation/.test(sub.textContent), 'KIOSK-6: al agotar ticks el estado lo dice en pantalla');
  const retry = document.getElementById('cart-poll-retry');
  t(!!retry && retry.hidden === false, 'KIOSK-6: aparece el botón de retry');
  const before = live().length;
  if (retry) { retry.click(); await flush(); }
  t(live().length > before, 'KIOSK-6: el retry relanza el poll (nuevo interval vivo)');
}

/* 7 · KIOSK-7 — associate # persistente entre ventas (audit C3) */
{
  const { document, window } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE, furnfx_kiosk_associate: '4471' } });
  const assoc = document.getElementById('cart-associate');
  t(assoc.value === '4471', 'KIOSK-7: el boot precarga el associate # guardado');
  assoc.value = '9999';
  assoc.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();
  t(window.localStorage.getItem('furnfx_kiosk_associate') === '9999', 'KIOSK-7: editar el campo persiste el nuevo valor');
  document.getElementById('cart-newsale-success').click();
  await flush();
  t(assoc.value === '9999', 'KIOSK-7: "New sale" conserva el associate #');
  t(document.getElementById('cart-order').value === '', 'KIOSK-7: el resto de campos sí se limpian');
}

/* 11 · KIOSK-10 — el drawer se comporta igual tras la poda de las ramas membership */
{
  const empty = await loadKiosk();
  t(empty.errors.length === 0, 'KIOSK-10: boot sin excepciones con carrito vacío');
  const payE = empty.document.getElementById('cart-pay');
  t(payE.disabled === true && /Your cart is empty/.test(payE.textContent), 'KIOSK-10: carrito vacío → "Your cart is empty" deshabilitado');

  const full = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const payF = full.document.getElementById('cart-pay');
  t(/\$19\.99/.test(payF.textContent), 'KIOSK-10: con 1 plan el Pay muestra $19.99/mo');
  /* C.6: el botón de email quedó destapado (envío real verificado); abrir el drawer no lo altera */
  full.document.getElementById('nav-cart').click();
  await flush();
  t(full.document.getElementById('cart-email-self').hidden === false, 'C.6: #cart-email-self visible al abrir el drawer');
}

/* B.4 (KIOSK-17) — reabrir con un pago EN CURSO reanuda la espera; tras newSale, reset limpio al
   form (el bugfix anti-apilado 2c1b72f se conserva para el caso sin espera activa). */
{
  const ctx = await bootAndSubmitHandoff();
  const { document, live } = ctx;
  const handoff = document.getElementById('cart-view-handoff');
  const form = document.getElementById('cart-view-form');
  t(handoff.hidden === false && form.hidden === true, 'B.4: tras el submit solo se ve la vista de espera');
  document.getElementById('cart-close').click();
  await flush();
  const before = live().length;   /* closeCart paró el poll */
  document.getElementById('nav-cart').click();
  await flush();
  t(handoff.hidden === false && form.hidden === true, 'B.4: reabrir REANUDA la espera, no resetea al form');
  t(document.getElementById('cart-view-success').hidden === true, 'B.4: sin vistas apiladas');
  t(live().length > before, 'B.4: el poll se re-lanza al reabrir');
  document.getElementById('cart-newsale').click();
  await flush();
  document.getElementById('confirm-yes').click();   /* DEC-4: el botón de la espera ahora confirma antes de descartar */
  await flush();
  document.getElementById('nav-cart').click();
  await flush();
  t(form.hidden === false && handoff.hidden === true, 'B.4: tras New sale, reabrir vuelve al form limpio');
}

/* B.3 (C7 fase 2) — el poll de sesión anuncia cuándo el cliente está en la página de pago */
{
  const opened = { v: false }, done = { v: false };
  const ctx = await loadKiosk({
    storage: { furnfx_cart: ONE_LINE },
    api: {
      /* helper recibo-desde-teléfono: POST crea token; GET ya devuelve el recibo subido */
      'kiosk-handoff': (u, o) => ((o && o.method) === 'POST')
        ? { token: 'rcpt.tok', summary: { first_name: 'T' }, expires_at: '2099-01-01T00:00:00.000Z' }
        : { status: 'receipt_uploaded', receipt_path: 'receipts/2026/07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg', receipt_preview_url: 'blob:x' },
      'checkout-status': () => (done.v ? { done: true, expired: false } : { done: false, expired: false, opened: opened.v })
    }
  });
  const { document, window, tick } = ctx;
  const val = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  val('cart-name', 'Test Customer'); val('cart-email', 'test@example.com');
  val('cart-phone', '5551234567'); val('cart-address', '1 Main St, Logan UT 84321');
  val('cart-associate', '4471'); val('cart-order', '100482'); val('cart-zip', '84321'); val('cart-date', '2026-07-06');
  document.getElementById('cart-accuracy').click();
  /* recibo vía teléfono → handoffReceiptPath queda seteado y el modo qr pasa focusFirst */
  document.getElementById('cart-receipt-phone-btn').click();
  await flush();
  await tick(1);
  const radio = document.querySelector('input[name="deliver"][value="qr"]');
  radio.checked = true; radio.dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('cart-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(); await flush();
  const sub = document.getElementById('cart-handoff-sub');
  t(document.getElementById('cart-view-handoff').hidden === false, 'B.3: el submit qr llega a la vista de espera');
  await tick(1);
  t(!/payment page/.test(sub.textContent), 'B.3: sin opened, el subtítulo no cambia');
  opened.v = true;
  await tick(1);
  t(sub.textContent === 'Customer is on the payment page…', 'B.3: opened:true → "Customer is on the payment page…"');
  done.v = true;
  await tick(1);
  t(document.getElementById('cart-view-success').hidden === false, 'B.3: done:true → "Payment received"');
}

/* KIOSK-18.1 — errores de campos ESPECÍFICOS (spec: misc/spec-work-order-06jul.md) */
{
  const { document, window } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const val = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  /* handoff EXPLÍCITO (el default es redirect desde 09-jul): sin foto requerida para aislar
     los mensajes de los demás campos */
  const hRadio = document.querySelector('input[name="deliver"][value="handoff"]');
  hRadio.checked = true; hRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  /* todo lleno MENOS el nombre → la foto no es requerida en handoff */
  val('cart-email', 'test@example.com'); val('cart-phone', '5551234567');
  val('cart-address', '1 Main St, Logan UT 84321'); val('cart-associate', '4471');
  val('cart-order', '100482'); val('cart-zip', '84321'); val('cart-date', '2026-07-06');
  document.getElementById('cart-accuracy').click();
  await flush();
  const submit = () => { document.getElementById('cart-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  submit(); await flush();
  const nameBox = document.getElementById('cart-name').closest('.cart-field');
  t(nameBox.classList.contains('field-error'), 'KIOSK-18.1: el campo faltante queda marcado .field-error');
  t((nameBox.querySelector('.field-msg') || {}).textContent === 'Add the name', 'KIOSK-18.1: mensaje inline del campo faltante');
  t(/Missing: name\./.test(document.getElementById('cart-stripe-note').textContent), 'KIOSK-18.1: la nota general NOMBRA lo que falta');
  val('cart-name', 'Test Customer');
  await flush();
  t(!nameBox.classList.contains('field-error') && !nameBox.querySelector('.field-msg'), 'KIOSK-18.1: teclear en el campo limpia su error');
  /* email inválido → mensaje específico */
  val('cart-email', 'nope');
  submit(); await flush();
  const emailBox = document.getElementById('cart-email').closest('.cart-field');
  t(/doesn't look right/.test((emailBox.querySelector('.field-msg') || {}).textContent || ''), 'KIOSK-18.1: email inválido → mensaje específico');
  val('cart-email', 'test@example.com');
  /* teléfono corto → mensaje específico */
  val('cart-phone', '123');
  submit(); await flush();
  const phoneBox = document.getElementById('cart-phone').closest('.cart-field');
  t(/at least 7 digits/.test((phoneBox.querySelector('.field-msg') || {}).textContent || ''), 'KIOSK-18.1: teléfono corto → mensaje específico');
  val('cart-phone', '5551234567');
  /* deliver=redirect sin foto → mensaje del recibo */
  const radio = document.querySelector('input[name="deliver"][value="redirect"]');
  radio.checked = true; radio.dispatchEvent(new window.Event('change', { bubbles: true }));
  submit(); await flush();
  const receiptBox = document.getElementById('cart-receipt-field');
  t(/photo of the sales receipt/.test((receiptBox.querySelector('.field-msg') || {}).textContent || ''), 'KIOSK-18.1: falta la foto del recibo → mensaje específico');
}

/* Botón que GUÍA (09-jul, Adrian): la etiqueta del CTA sigue a la vía de pago elegida —
   en QR/email el clic no cobra aquí, así que el botón dice la ACCIÓN real */
{
  const { document, window } = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const pay = document.getElementById('cart-pay');
  const pick = (v) => { const r = document.querySelector('input[name="deliver"][value="' + v + '"]'); r.checked = true; r.dispatchEvent(new window.Event('change', { bubbles: true })); };
  t(/Pay/.test(pay.textContent) && /\$19\.99/.test(pay.textContent), 'pay-label: redirect (default) → Pay $19.99/mo');
  pick('handoff'); await flush();
  t(/Show the QR code/.test(pay.textContent), 'pay-label: handoff → "Show the QR code"');
  pick('email'); await flush();
  t(/Email the payment link/.test(pay.textContent), 'pay-label: email → "Email the payment link"');
  pick('qr'); await flush();
  t(/Show the QR code/.test(pay.textContent), 'pay-label: qr → "Show the QR code"');
  pick('redirect'); await flush();
  t(/Pay/.test(pay.textContent) && /\$19\.99/.test(pay.textContent), 'pay-label: volver a redirect restaura el precio');
}

/* KIOSK-18.2 — máscara de teléfono (000) 000-0000 */
{
  const { document, window } = await loadKiosk();
  const phone = document.getElementById('cart-phone');
  const type = (v) => { phone.value = v; phone.dispatchEvent(new window.Event('input', { bubbles: true })); };
  type('5551234567');
  t(phone.value === '(555) 123-4567', 'KIOSK-18.2: 10 dígitos → (555) 123-4567');
  type('555123');
  t(phone.value === '(555) 123', 'KIOSK-18.2: 6 dígitos → (555) 123');
  type('555');
  t(phone.value === '555', 'KIOSK-18.2: 3 dígitos → sin puntuación (borrar no se atasca)');
  type('55512345678999');
  t(phone.value === '(555) 123-4567', 'KIOSK-18.2: tope en 10 dígitos');
}

/* C.5 — el front de "Email my cart to myself" ya NO finge: confirma solo si el server envió */
{
  const ok = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const val = (id, v) => { const el = ok.document.getElementById(id); el.value = v; el.dispatchEvent(new ok.window.Event('input', { bubbles: true })); };
  val('cart-email', 'test@example.com');
  ok.document.getElementById('cart-email-self').click();
  t(/Sending/.test(ok.document.getElementById('cart-email-status').textContent), 'C.5: mientras envía dice "Sending…"');
  await flush();
  t(/Sent a copy of your cart to test@example\.com/.test(ok.document.getElementById('cart-email-status').textContent),
    'C.5: confirma SOLO tras {sent:true} del server');

  const bad = await loadKiosk({ storage: { furnfx_cart: ONE_LINE }, api: { 'email-cart': () => ({ error: 'email_failed' }) } });
  const el = bad.document.getElementById('cart-email'); el.value = 'test@example.com';
  el.dispatchEvent(new bad.window.Event('input', { bubbles: true }));
  bad.document.getElementById('cart-email-self').click();
  await flush();
  t(/couldn’t send it/.test(bad.document.getElementById('cart-email-status').textContent),
    'C.5: si el server falla, lo dice — nunca confirmación fingida');
}

/* Hallazgo smoke 06-jul — abandonar la espera SIN perder el carrito: "Choose another way to pay" */
{
  const ctx = await bootAndSubmitHandoff();
  const { document, live } = ctx;
  const handoff = document.getElementById('cart-view-handoff');
  const form = document.getElementById('cart-view-form');
  document.getElementById('cart-handoff-back').click();
  await flush();
  t(form.hidden === false && handoff.hidden === true, 'back: vuelve al form de opciones');
  /* el carrito sigue intacto: el TOTAL conserva el monto (el botón en handoff dice la acción, no el precio) */
  t(/\$19\.99/.test(document.getElementById('cart-total-val').textContent), 'back: el carrito sigue intacto ($19.99/mo en el total)');
  t(/Show the QR code/.test(document.getElementById('cart-pay').textContent), 'back: el botón conserva la guía del modo handoff');
  t(document.getElementById('cart-name').value === 'Test Customer', 'back: los campos no se borran');
  t(live().length === 0, 'back: el poll quedó parado');
  /* y como la espera se abandonó, cerrar/reabrir ya NO reanuda */
  document.getElementById('cart-close').click();
  await flush();
  document.getElementById('nav-cart').click();
  await flush();
  t(form.hidden === false && handoff.hidden === true, 'back: reabrir tras abandonar va al form (activeWait limpio)');
}

/* BUG push 06-jul (Adrian) — el carrito no se limpiaba tras el pago en dos rutas: */
{
  /* (a) pago confirmado por el POLL (showPaid): el carrito debe vaciarse YA, no esperar a New sale */
  const done = { v: false };
  const ctx = await bootAndSubmitHandoff({ }, { 'kiosk-handoff': (u, o) => ((o && o.method) === 'POST')
    ? { token: 'aaa.bbb', summary: { first_name: 'T' }, expires_at: '2099-01-01T00:00:00.000Z' }
    : (done.v ? { done: true } : { status: 'pending' }) });
  done.v = true;
  await ctx.tick(1);
  t(ctx.document.getElementById('cart-view-success').hidden === false, 'paid-clear: el poll confirma → Payment received');
  const stored = JSON.parse(ctx.window.localStorage.getItem('furnfx_cart') || '[]');
  t(stored.length === 0, 'paid-clear: showPaid VACÍA el carrito (no espera a New sale)');
}
{
  /* (b) retorno ?paid=1 con el marcador de teléfono puesto (mismo browser que simuló el phone):
     el boot entra en modo phone y se saltaba el handler del kiosk → carrito zombi */
  const ctx = await loadKiosk({
    url: 'https://kiosk.test/?paid=1',
    storage: { furnfx_cart: ONE_LINE },
    session: { furnfx_phone: '1' }
  });
  t(ctx.document.documentElement.classList.contains('phone'), 'paid-clear: con el marcador, ?paid=1 arranca en modo phone (esperado)');
  const stored = JSON.parse(ctx.window.localStorage.getItem('furnfx_cart') || '[]');
  t(stored.length === 0, 'paid-clear: el modo phone TAMBIÉN purga el carrito local en ?paid=1');
}

/* MEM-7 (14-ago) — la membership del carrito es SIEMPRE la de pago ($19.99): cubre el mueble
   usado; la incluida con el plan es un entitlement del server, no una línea. Murió MEM-6. */
{
  const open = async (ctx) => { ctx.document.getElementById('nav-cart').click(); await flush(); };
  const mech = await loadKiosk({ storage: { furnfx_cart: JSON.stringify([{ cov: 'stain-mech', term: 'monthly', type: 'furniture', count: 1 }]), furnfx_membership: '1' } });
  await open(mech);
  t(/\$44\.98/.test(mech.document.getElementById('cart-pay').textContent), 'MEM-7: stain-mech + membership → $44.98 (24.99 + 19.99, sin bundled $0)');
  const stain = await loadKiosk({ storage: { furnfx_cart: ONE_LINE, furnfx_membership: '1' } });
  await open(stain);
  t(/\$39\.98/.test(stain.document.getElementById('cart-pay').textContent), 'MEM-7: stain + membership → $39.98 (19.99 + 19.99, sin 50%)');
  const label = stain.document.getElementById('cart-membership-list').textContent;
  t(!/50% off/.test(label) && !/included with your plan/.test(label), 'MEM-7: la línea no promete descuentos ni bundled');
  t(/cancel anytime/.test(label), 'MEM-7: la línea dice $19.99/month · cancel anytime');
  /* KIOSK-27: la línea del carrito es la DE PAGO — el meta distingue el mueble usado de la
     incluida (que viene gratis con el plan sin agregar nada). */
  t(/For furniture you already own/.test(label), 'KIOSK-27: el meta dice que es para el mueble que YA tienes');
  const solo = await loadKiosk({ storage: { furnfx_membership: '1' } });
  t(/Repair Safety Net · \$19\.99/.test(solo.document.getElementById('cart-pay').textContent), 'MEM-7: standalone → Repair Safety Net · $19.99/mo');
}

/* KIOSK-24 (14-ago, acuerdo unánime): el add-on de las plan cards pasa a ser "Cover your used
   furniture" y NO agrega al carrito — salta a #membership ("it should just be a module that drops
   you down to the repair membership where you add it from there"). El botón de la SECCIÓN
   (#mem-add-btn) queda EXACTO y sigue agregando. */
{
  const ctx = await loadKiosk({});
  const addons = Array.from(ctx.document.querySelectorAll('.cmp-addons a[href="#membership"]'));
  t(addons.length === 2, 'KIOSK-24: los 2 add-ons de las plan cards son anclas a #membership');
  t(addons.every((a) => /Cover your used furniture/.test(a.textContent)), 'KIOSK-24: el texto es "Cover your used furniture"');
  t(!ctx.document.querySelector('.cmp-addons [data-addon="membership"]'), 'KIOSK-24: ya no hay botón add-to-cart en las cards');
  /* click en el ancla: el carrito NO cambia */
  const before = ctx.window.localStorage.getItem('furnfx_membership');
  addons[0].click(); await flush();
  t(ctx.window.localStorage.getItem('furnfx_membership') === before, 'KIOSK-24: el click NO agrega la membership al carrito');
  /* el botón de la sección sigue agregando */
  const mab = ctx.document.getElementById('mem-add-btn');
  t(!!mab && /Add Repair Safety Net/.test(mab.textContent), 'KIOSK-24: #mem-add-btn queda exacto (decisión de Adrian)');
  mab.click(); await flush();
  t(ctx.window.localStorage.getItem('furnfx_membership') === '1', 'KIOSK-24: la sección SÍ agrega la membership');
}

/* SELF-1 — tap-or-scan en jsdom */
{
  const ctx = await bootAndSubmitHandoff();
  const qr = ctx.document.getElementById('cart-qr');
  t((qr.dataset.url || '').includes('?h='), 'SELF-1: el QR de la espera lleva su URL (tap paga/continúa aquí)');
  const fresh = await loadKiosk({ storage: { furnfx_cart: ONE_LINE } });
  const inp = fresh.document.getElementById('cart-receipt-photo');
  let clicked = false;
  inp.addEventListener('click', function(){ clicked = true; });
  fresh.document.getElementById('cart-receipt-qr-box').click();
  t(clicked, 'SELF-1: tocar el QR del recibo abre el picker del propio dispositivo');
  t(!inp.hasAttribute('capture'), 'SELF-1: el input acepta cámara O galería');
}

t.done();
