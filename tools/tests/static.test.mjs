/* Aserciones ESTÁTICAS sobre la fuente (work order 04-jul). Crece tarea a tarea:
 * cada sección referencia su id de backlog. Spec: misc/spec-work-order-04jul.md */
import { src, makeT } from './helpers.mjs';

const t = makeT('static');
const kiosk = src('kiosk/index.html');

/* 1 · KIOSK-5 → C.6 — el email-cart es REAL (POST /api/email-cart) y el botón está DESTAPADO */
t(!/<button[^>]*id="cart-email-self"[^>]*\bhidden\b/.test(kiosk), 'C.6: #cart-email-self visible en kiosk (envío real verificado)');
t(kiosk.includes("fetch('/api/email-cart'"), 'C.6: el click del kiosk POSTea al endpoint real');
t(!kiosk.includes('Email your cart to yourself'), 'KIOSK-5: el popup how-it-works no promete envíos que no existen');

/* 2 · TNC-7 — frase obligatoria de términos del plan antes del pago (Doug 02-jul 36:04).
   El default ya era correcto: los 3 .js-plan-terms apuntan a /terms/ (el T&C del plan). */
{
  const m = kiosk.match(/Read the <a [^>]*href="\/terms\/"[^>]*>terms and conditions<\/a> of this plan before you purchase\./);
  t(!!m, 'TNC-7: la frase "Read the terms and conditions of this plan before you purchase" existe con link a /terms/');
  t(!!m && kiosk.indexOf(m[0]) < kiosk.indexOf('id="cart-deliver"'), 'TNC-7: la frase está ANTES de las opciones de pago');
  const planTermsHrefs = [...kiosk.matchAll(/class="js-plan-terms"/g)].length;
  const planTermsToTerms = [...kiosk.matchAll(/href="\/terms\/"[^>]*class="js-plan-terms"/g)].length;
  t(planTermsHrefs === planTermsToTerms && planTermsHrefs >= 3, `TNC-7: todos los .js-plan-terms (${planTermsHrefs}) apuntan a /terms/`);
}

/* 3 · FOOT-1a — footer sin links muertos (audit fase 3): los 7 href="#" se neutralizan
   quitando el href (un <a> sin href no es interactivo); el cableo real espera URLs de Doug. */
{
  const foot = kiosk.slice(kiosk.indexOf('<footer'), kiosk.indexOf('</footer>'));
  t(foot.length > 0 && !foot.includes('href="#"'), 'FOOT-1a: 0 href="#" dentro del footer');
  /* 06-jul: "Log in" salió de esta lista — ya está cableado al login real (FOOT-1b parcial) */
  for (const label of ['File a claim', 'Manage coverage', 'Contact concierge', 'Terms of service', 'Privacy policy', 'Accessibility'])
    t(new RegExp('<a>' + label + '</a>').test(foot), `FOOT-1a: "${label}" queda como texto no interactivo`);
  t(/href="\/terms\/"[^>]*class="js-plan-terms">Coverage terms/.test(foot), 'FOOT-1a: "Coverage terms" sigue cableado a /terms/');
  t(kiosk.includes('.footer-col a:not([href])'), 'FOOT-1a: regla CSS de cursor para los links neutralizados');
}

/* 4 · KIOSK-3 — warning de exactitud visible en "tell us about yourself" (Doug 02-jul 20:16) */
t(kiosk.includes('Inaccurate information may inactivate your subscription.'), 'KIOSK-3: warning de exactitud presente');
t(/I read the information above and it is accurate/.test(kiosk), 'KIOSK-3: label del checkbox con el wording de Doug');

/* 5 · KIOSK-4a — renames de checkout con wording cerrado (Doug 02-jul 17:02, 21:08, 21:19) */
t(!kiosk.includes('How will the customer pay?'), 'KIOSK-4a: fuera "How will the customer pay?"');
t(kiosk.includes('<legend>Ways to pay</legend>'), 'KIOSK-4a: legend "Ways to pay"');
/* ISS-14 — modal de confirmación con estilo (reemplaza el window.confirm nativo; lo reusa DEC-4) */
t(/id="confirm-backdrop"[^>]*hidden/.test(kiosk), 'ISS-14: #confirm-backdrop existe y nace hidden');
t(kiosk.includes('id="confirm-yes"') && kiosk.includes('id="confirm-no"'), 'ISS-14: el modal tiene botones confirmar/cancelar');
t(!/window\.confirm\(/.test(kiosk), 'ISS-14: sin window.confirm nativo en el kiosk');
/* DEC-1 — dos botones de recibo (cámara + archivo) que conmutan capture sobre UN input */
t(kiosk.includes('id="cart-receipt-cam-btn"') && kiosk.includes('id="cart-receipt-file-btn"'), 'DEC-1: dos botones de recibo (cámara + archivo)');
t(kiosk.includes('id="phone-cam-btn"') && !/id="phone-receipt"[^>]*capture=/.test(kiosk), 'DEC-1 (teléfono): botón "Take a photo" (capture por JS) sin romper SELF-1 (input sin capture, KSK-062)');
/* ISS-05 — la miniatura del recibo se arma del JPEG comprimido (no del archivo crudo) */
t(!/thumbImg\.src = URL\.createObjectURL\(f\)/.test(kiosk), 'ISS-05 (teléfono): la miniatura NO se arma del archivo crudo');
t(kiosk.includes('thumbImg.src = URL.createObjectURL(blob)') && /compressReceipt\(f\)\.then\(function\(blob\)\{ thumb\.src = URL\.createObjectURL\(blob\)/.test(kiosk), 'ISS-05: miniatura (tablet + teléfono) desde el blob comprimido');
t(!kiosk.includes('Pay on this tablet'), 'KIOSK-4a: fuera "Pay on this tablet"');
t(kiosk.includes('Pay on this device'), 'KIOSK-4a: radio "Pay on this device"');
t(!/<label for="cart-name">Full name<\/label>/.test(kiosk), 'KIOSK-4a: fuera el label "Full name"');
t(/<label for="cart-name">First name and last name<\/label>/.test(kiosk), 'KIOSK-4a: label "First name and last name"');

/* 8 · KIOSK-9 — cero lenguaje "builder" en copy visible (audit F2: el builder no existe en el kiosk) */
{
  t(!kiosk.includes('in the builder'), 'KIOSK-9: fuera "in the builder"');
  for (const dead of ['Build my coverage', 'Build coverage', 'Build your plan', 'Build plan', 'Build it now'])
    t(!kiosk.includes('>' + dead) && !kiosk.includes(dead + '.') && !kiosk.includes(dead + ' <'), `KIOSK-9: fuera "${dead}" del copy visible`);
  /* DOUG-2: el drawer perdió el CTA (fuera) y ganó File a Claim + Questions?; sticky = cart-aware */
  t(!kiosk.includes('class="btn btn-accent btn-block drawer-cta"'), 'DOUG-2: el CTA del drawer se fue (la regla CSS huérfana queda, como en el archivo de Doug)');
  t(kiosk.includes('https://5starservice.net/'), 'DOUG-2: File a Claim → 5starservice.net');
  t(kiosk.includes('id="drawer-chat-cta"'), 'DOUG-2: Questions? abre el chat');
  t(kiosk.includes('id="sticky-cta"') && kiosk.includes('renderStickyMobile'), 'DOUG-2: sticky cart-aware (Add plan/Checkout)');
}

/* 9 · MEM-5 → DOUG-2 (call 06-jul) — naming FINAL: 'FurnitureRx Repair Safety Net'
   (Repair·Net quedó MUERTO; el middot solo vive en el logo... tampoco: FurnitureRx va sin punto).
   El bloque legal memterms conserva su texto original (Doug lo maneja aparte). */
{
  t(!kiosk.includes('Repair&middot;Net') && !kiosk.includes('Repair·Net'), 'NAMING: 0 Repair·Net en el kiosk');
  t(!src('index.html').includes('Repair&middot;Net'), 'NAMING: 0 Repair·Net en el D2C');
  t(kiosk.includes('<span class="kicker">FurnitureRx Repair Safety Net</span>'), 'NAMING: kicker de Doug en el kiosk');
  t(kiosk.includes('Repair Membership Terms &amp; Conditions'), 'NAMING: el bloque LEGAL memterms quedó intacto');
  t(kiosk.includes('>Uncovered Repairs</a>'), 'DOUG-2: item de menú "Uncovered Repairs"');
  t(src('index.html').includes('Repair Safety Net.</em>'), 'NAMING: heading del D2C en Safety Net');
  t(kiosk.includes('Repair Concierge'), 'DOUG-2: framing Repair Concierge presente');
  t(kiosk.includes('js-gift-coupon'), 'DOUG-2: gift coupon links presentes (placeholders, GIFT-1)');
  t(!kiosk.includes('Second Chance — You'), 'DOUG-2: título AI-search (fuera Second Chance del title)');
}

/* 10 · COPY-1a — fix gramatical del Trust (audit: la frase no tenía sujeto). 06-jul: también en el D2C. */
for (const [name, source] of [['kiosk', kiosk], ['d2c', src('index.html')]]) {
  t(!source.includes('US-based service and handles every step'), `COPY-1a: fuera la frase sin sujeto (${name})`);
  t(source.includes('US-based service that handles every step'), `COPY-1a: "service that handles" presente (${name})`);
}

/* 11 · KIOSK-10 — ramas muertas cartMode='membership' podadas (audit C8) */
for (const dead of ['cartMode', 'applyCartMode', 'fillMembershipSummary', 'membershipPayLabel'])
  t(!new RegExp('\\b' + dead + '\\b').test(kiosk), `KIOSK-10: 0 referencias a ${dead}`);

/* ── Bloque B · chat ── */
const chat = src('netlify/functions/chat.mjs');

/* 12 · MAYA-1 — guardrail: Maya no interpreta cobertura (Doug 02-jul 36:48 a 37:10) */
t(chat.includes("I can't comment on the specifics of what's covered"), 'MAYA-1: respuesta guiada presente en el SYSTEM');
t(/GUARDRAILS:[\s\S]*never interpret coverage/i.test(chat) || /GUARDRAILS:[\s\S]*do NOT interpret what is or isn/.test(chat), 'MAYA-1: la regla vive en la sección GUARDRAILS');

/* 13 · MAYA-3 — tres ajustes del chat (Doug 02-jul) */
const d2c = src('index.html');
const coreCss = src('packages/core/styles/core.css');
t(!d2c.includes('chat-panel--left') && !kiosk.includes('chat-panel--left') && !coreCss.includes('chat-panel--left'),
  'MAYA-3.1: posición única — 0 refs al flip chat-panel--left (D2C, kiosk, core.css)');
t(/limit:\s*10,\s*windowSec:\s*60/.test(chat), 'MAYA-3.2: tope anti-bot de ráfaga en 10 (Doug: "increase it to 10")');
t(!/Usually replies/i.test(d2c) && !/Usually replies/i.test(kiosk), 'MAYA-3.3: fuera "Usually replies in a few minutes" en ambos fronts');

/* 14 · MAYA-5a — la doc coincide con el modelo real del chat (cotejo call 02-jul vs CLAUDE.md) */
{
  const claudeMd = src('CLAUDE.md');
  t(/MODEL = 'claude-haiku-4-5/.test(chat), 'MAYA-5a: chat.mjs corre claude-haiku-4-5 (verificado)');
  t(claudeMd.includes('claude-haiku-4-5'), 'MAYA-5a: CLAUDE.md documenta haiku');
  t(!/claude-opus-4-8[^\n]*chat/.test(claudeMd) && !claudeMd.includes('model **`claude-opus-4-8`**'), 'MAYA-5a: CLAUDE.md ya no atribuye opus al chat');
}

/* 15 · TNC-6 — metadata oculto del T&C combinado sin el SKU de la fuente F3 */
{
  const terms = src('terms/Furniture-Rx-Protection-Plan-Terms.html');
  t(!terms.includes('F3-30-Day-Subscription'), 'TNC-6: 0 referencias al SKU F3-30-Day-Subscription');
  t(!terms.includes('data-plan-sku="'), 'TNC-6: el atributo data-plan-sku se retiró (el doc cubre todos los tipos)');
}

/* KIOSK-5b → C.6 (06-jul) — Resend verificado: el pack de email quedó DESTAPADO en ambos fronts */
{
  const d2cSrc = src('index.html');
  t(!/<button[^>]*id="cart-email-self"[^>]*\bhidden\b/.test(d2cSrc), 'C.6: #cart-email-self visible también en el D2C');
  t(d2cSrc.includes("fetch('/api/email-cart'"), 'C.6: el click del D2C POSTea al endpoint real');
  t(!d2cSrc.includes('emailSelfBtnEl.hidden = mem'), 'KIOSK-5b: applyCartMode del D2C sigue sin tocar el botón');
  t(/<label><input type="radio" name="deliver" value="email">/.test(kiosk), 'C.6: radio "Email the link" del kiosk visible');
}

/* BUGFIX 06-jul — [hidden] gana SIEMPRE: las reglas display (.btn, .cart-deliver label) re-mostraban
   elementos hidden; jsdom no computa layout, así que esto se vigila en la FUENTE del CSS. */
t(kiosk.includes('[hidden]{display:none!important}'), 'hidden-fix: regla global [hidden] en el CSS del kiosk');
t(coreCss.includes('[hidden]{display:none!important}'), 'hidden-fix: regla global [hidden] en core.css (D2C)');

/* BUGFIX 04-jul — openCart oculta la vista handoff en AMBOS fronts (vistas excluyentes) */
for (const [name, source] of [['kiosk', kiosk], ['d2c', src('index.html')]]) {
  const fn = source.slice(source.indexOf('function openCart()'), source.indexOf('function closeCart()'));
  t(fn.includes('cartViewHandoff.hidden = true'), `reopen-fix: openCart del ${name} resetea la vista handoff`);
}

/* 16 · KIOSK-16 — cableado de la URL corta /p/CODIGO */
{
  const toml = src('netlify.toml');
  const kioskToml = src('kiosk/netlify.toml');
  t(toml.includes('from = "/p/*"') && toml.includes('pay-redirect?code=:splat'), 'KIOSK-16: regla /p/* en netlify.toml');
  t(kioskToml.includes('from = "/p/*"') && kioskToml.includes('pay-redirect?code=:splat'), 'KIOSK-16: regla /p/* en kiosk/netlify.toml (proxy al backend central)');
  t(kiosk.includes('linkEl.textContent = shortUrl || url'), 'KIOSK-16: el drawer muestra la URL corta con fallback a la de Stripe');
  t(src('netlify/functions/_lib/checkout.mjs').includes("'/pay_links'"), 'KIOSK-16: checkout.mjs inserta el pay_link (fail-soft)');
  t(src('supabase/migrations/20260704120000_pay_links.sql').includes('GRANT SELECT, INSERT, UPDATE, DELETE ON public.pay_links TO service_role'), 'KIOSK-16: migración con GRANTs explícitos');
}

/* KIOSK-18 — errores específicos + máscara de teléfono replicados en el D2C (espejo del kiosk) */
{
  const d2cSrc = src('index.html');
  for (const needle of ['function formatPhone', 'function setFieldError', 'Add a photo of the sales receipt', "'Missing: ' + lastMissing"])
    t(d2cSrc.includes(needle), `KIOSK-18: D2C contiene ${needle.slice(0, 30)}…`);
  t(src('packages/core/styles/core.css').includes('.cart-field.field-error input'), 'KIOSK-18: CSS de errores en core.css');
}

/* FOOT-1b parcial (06-jul) — el Log in del footer apunta al login real; /login como atajo */
{
  const d2cSrc = src('index.html');
  t(/<li><a href="\/account\.html">Log in<\/a><\/li>/.test(d2cSrc), 'login-link: footer del D2C → /account.html');
  t(/<li><a href="https:\/\/www\.furniturerx\.net\/account\.html">Customer login<\/a><\/li>/.test(kiosk), 'login-link: footer del kiosk → Customer login → account del site principal');
  t(/<li><a href="https:\/\/portal\.furniturerx\.net\/">Dealer login<\/a><\/li>/.test(kiosk), 'login-link: footer del kiosk → Dealer login → portal');
  t(src('netlify.toml').includes('from = "/login"'), 'login-link: atajo /login en netlify.toml');
}

/* SELF-1 (call 06-jul) — self-checkout: tap-or-scan + galería + copy de actor genérico */
{
  t(!kiosk.includes('capture="environment"'), 'SELF-1: input del recibo SIN capture (la galería del móvil vuelve a funcionar)');
  t(kiosk.includes('Tap the code to add it from this device'), 'SELF-1: hint del QR de recibo tap-or-scan');
  t(kiosk.includes('or tap it to pay on this device') || kiosk.includes('or tap it to continue on this device'), 'SELF-1: la espera ofrece tap para el mismo dispositivo');
  t(!kiosk.includes('Have the customer scan'), 'SELF-1: 0 copy actor-específico en los pasos de QR');
  t(kiosk.includes('qrBox.dataset.url = url'), 'SELF-1: los QR de pago llevan su URL para el tap');
  t(kiosk.includes('>Add the receipt from a phone<'), 'SELF-1: botón del recibo genérico (renombrado en KIOSK-19: la lista aporta el "or")');
}

/* DASH-5 (Doug 24-jun: "at the top of that plan… login to your dashboard… [dominio]/dashboard")
   — link de recaptura ARRIBA de la sección de planes en AMBOS fronts + la ruta /dashboard */
{
  /* el slice arranca en el markup (id="compare") y el fin se busca DESDE ahí — en el kiosk
     el CSS inline también contiene "compare-grid" y aparece mucho antes que la sección */
  const d2cSrc = src('index.html');
  const d2cAt = d2cSrc.indexOf('id="compare"');
  const d2cHead = d2cSrc.slice(d2cAt, d2cSrc.indexOf('compare-grid', d2cAt));
  t(/<p class="dash-login"><a href="\/dashboard">/.test(d2cHead), 'DASH-5: D2C — link /dashboard al TOPE del compare-header');
  const kioskAt = kiosk.indexOf('id="compare"');
  const kioskHead = kiosk.slice(kioskAt, kiosk.indexOf('compare-grid', kioskAt));
  t(/<a href="https:\/\/www\.furniturerx\.net\/dashboard" target="_blank" rel="noopener">/.test(kioskHead),
    'DASH-5: kiosk — link ABSOLUTO al site principal, pestaña nueva (la tablet no pierde el kiosk)');
  t(/Log in to your dashboard/.test(d2cHead) && /Log in to your dashboard/.test(kioskHead),
    'DASH-5: copy "Log in to your dashboard" en ambos fronts');
  const toml = src('netlify.toml');
  t(/from = "\/dashboard"\s+to = "\/account\.html"\s+status = 301/.test(toml), 'DASH-5: redirect /dashboard → /account.html en netlify.toml');
  t(src('packages/core/styles/core.css').includes('.dash-login') && kiosk.includes('.dash-login'),
    'DASH-5: CSS .dash-login en core.css (D2C) y en el kiosk (inline)');
}

/* PREFILL-1 (08-jul) — checkout prellenado por sesión + menú Dashboard condicional (D2C) */
{
  const d2cSrc = src('index.html');
  t(/id="nav-dash-li" hidden/.test(d2cSrc) && /id="drawer-dash-li" hidden/.test(d2cSrc),
    'PREFILL-1: items de menú Dashboard OCULTOS por default (nav + drawer)');
  t(/id="prefill-note" hidden/.test(d2cSrc), 'PREFILL-1: la nota "Buying as" nace oculta');
  t(d2cSrc.includes("fetch('/api/account-me'"), 'PREFILL-1: valida la sesión contra account-me (no confía en el storage)');
  t(d2cSrc.includes('emailIn.readOnly = true'), 'PREFILL-1: email BLOQUEADO con sesión');
  t(d2cSrc.includes("localStorage.removeItem('furnfx_session')"), 'PREFILL-1: "Not you? Sign out" borra la sesión');
  t(src('packages/core/styles/core.css').includes('.prefill-note'), 'PREFILL-1: CSS de la nota en core.css');
}

/* Ago-10 (Doug) — el drawer parte "My dashboard" en Customer login + Dealer login; cada uno abre
   el mismo QR modal a su destino (cliente→dashboard, dealer→portal). La tablet es compartida y la
   sesión no existe en el dominio del kiosk, por eso el destino se abre en el TELÉFONO (o se toca). */
{
  const k = src('kiosk/index.html');
  t(/id="drawer-cust-login">Customer login</.test(k) && /id="drawer-dealer-login">Dealer login</.test(k), 'kiosk-B: el drawer tiene Customer login + Dealer login');
  t(/id="dashqr-backdrop" hidden/.test(k), 'kiosk-B: overlay del QR nace oculto');
  t(/DASHBOARD_URL = 'https:\/\/www\.furniturerx\.net\/dashboard'/.test(k) && /PORTAL_URL = 'https:\/\/portal\.furniturerx\.net\/'/.test(k),
    'kiosk-B: el QR conoce ambos destinos (dashboard cliente + portal dealer)');
  t(k.includes('qrSvg(opts.url'), 'kiosk-B: el QR se genera para el destino elegido');
  t(/<a id="dashqr-url"/.test(k), 'kiosk-B: la URL bajo el QR es un link clicable');
  t(/furniturerx\.net\/dashboard<\/a>/.test(k), 'kiosk-B: la URL tecleable (clicable) acompaña al QR');
  t(src('dist/kiosk/index.html') === k, 'kiosk-B: dist/kiosk espejo del fuente (cp hecho)');
}

/* GIFT-1 (08-jul) — gift coupons: links cableados + overlay en AMBOS fronts */
{
  const k = src('kiosk/index.html');
  const d = src('index.html');
  t(!/GIFT-1 pendiente/.test(k), 'GIFT-1: el kiosk ya NO tiene el preventDefault inerte');
  t(/id="gift-backdrop" hidden/.test(k) && /id="gift-backdrop" hidden/.test(d), 'GIFT-1: overlay oculto por default en ambos fronts');
  t(/js-gift-coupon/.test(d), 'GIFT-1: el D2C ganó el link espejo de gift');
  t(k.includes("fetch('/api/create-gift-checkout'") || k.includes('fetch("/api/create-gift-checkout"'),
    'GIFT-1: el kiosk postea al endpoint real');
  t(d.includes("fetch('/api/create-gift-checkout'"), 'GIFT-1: el D2C postea al endpoint real');
  t(src('dist/kiosk/index.html') === k, 'GIFT-1: dist/kiosk espejo del fuente');
  t(src('netlify/functions/_lib/checkout.mjs').includes('allow_promotion_codes'),
    'GIFT-1: el checkout de suscripción acepta promotion codes (la vía de canje)');
}

/* DASH-11 (Doug 08-jul) — coming soon en el dashboard: panel Claims con stepper de preview
   + franja referral (coming soon) con CTA al gift REAL (/#gift abre el overlay del D2C) */
{
  const a = src('account.html');
  const d = src('index.html');
  t(/id="claims-panel"/.test(a), 'DASH-11: panel Claims presente en account.html');
  t(/id="file-claim"[^>]*href="https:\/\/5starservice\.net\/"/.test(a.replace(/\n/g, ' ')),
    'DASH-11: File a claim (Five Star) vive en el panel Claims');
  t((a.match(/class="step\b/g) || []).length === 4, 'DASH-11: stepper de preview con los 4 pasos');
  t(/Live claim tracker &middot; coming soon/.test(a), 'DASH-11: badge del claim tracker coming soon');
  t(/Give a month, <em>get a month<\/em>/.test(a), 'DASH-11: tarjeta referral con el copy del demo de Doug');
  t(/Give 3 months, <em>make their day<\/em>/.test(a), 'DASH-11: la tarjeta gift tiene encabezado propio (paralelo al referral)');
  t(/id="gift-link" href="\/#gift"/.test(a), 'DASH-11: CTA de gift → /#gift (flujo real GIFT-1)');
  t(d.includes("location.hash === '#gift'"), 'DASH-11: el D2C abre el overlay de gift al aterrizar con /#gift');
  t(src('dist/account.html') === a, 'DASH-11: dist/account.html espejo del fuente (build hecho)');
}

/* DASH-1b (09-jul) — chip "Cancel plan" por card vía flow dirigido del Customer Portal.
   El portal NO ofrece pause: eso queda para una fase 2 con endpoint propio (decisión Doug). */
{
  const a = src('account.html');
  const f = src('netlify/functions/create-portal-session.mjs');
  const v = src('netlify/functions/_lib/account.mjs');
  t(/Cancel plan/.test(a) && /startCancelPlan/.test(a), 'DASH-1b: chip Cancel plan cableado en el dashboard');
  t(a.includes("if(session && p.status !== 'canceled' && p.stripe_subscription_id)"),
    'DASH-1b: el chip solo existe con sesión y en planes no cancelados');
  t(/whole purchase/.test(a), 'DASH-1b: el modal avisa que Stripe cancela la compra completa');
  t(f.includes("params.append('flow_data[type]', 'subscription_cancel')"),
    'DASH-1b: el endpoint arma el flow subscription_cancel');
  t(f.includes('stripe_subscription_id=eq.') && f.includes('user_id=eq.'),
    'DASH-1b: ownership check server-side antes de tocar Stripe');
  t(f.includes("/^sub_[A-Za-z0-9]+$/"), 'DASH-1b: formato del sub id validado (400 si no)');
  t(v.includes('stripe_subscription_id: s.stripe_subscription_id'), 'DASH-1b: la vista expone el sub id por plan');
  t(v.includes('stripe_subscription_id: memPick.stripe_subscription_id'), 'DASH-1b: y en la membership (aviso de compra compartida)');
  t(v.includes('purchaseOf'), 'DASH-1b-fix: la compra compartida se calcula SERVER-SIDE (todas las filas, no la membership única)');
  t(a.includes('p.purchase'), 'DASH-1b-fix: el front usa el resumen del server para decidir modal vs directo');
}

/* Bloque 09-jul (spec: misc/spec-block-09jul.md) — P2 recibo en 3 vías, P3 un solo link T&C,
   B1 success "plan holder" + 833 GRANDE, B2 Secure pay bajo el precio, B3 Pause coming soon */
{
  const k = src('kiosk/index.html');
  const d = src('index.html');
  const core = src('packages/core/styles/core.css');
  const a = src('account.html');

  /* P2 · KIOSK-19 (solo kiosk: el D2C no tiene la vía QR) */
  t(k.includes('Now, please add your sales receipt to ensure coverage'), 'KIOSK-19: heading dictado por Doug');
  t(k.includes('There are three ways to do it'), 'KIOSK-19: intro de las tres vías');
  const ways = k.match(/<ul class="receipt-ways">([\s\S]*?)<\/ul>/);
  t(!!ways && (ways[1].match(/<li>/g) || []).length === 3, 'KIOSK-19: lista bullet con exactamente 3 vías');
  t(!k.includes('>Photo of your sales receipt<'), 'KIOSK-19: fuera el label viejo');

  /* P3 · LEG-4 (solo kiosk: el D2C ya tenía un solo link) */
  t(!k.includes('cart-terms-note'), 'LEG-4: el elemento duplicado del T&C murió (markup y CSS)');
  t(/not available in all states\. Read the <a [^>]*class="js-plan-terms">terms and conditions<\/a> of this plan before you purchase\./.test(k),
    'LEG-4: párrafo fusionado con UN solo link (la frase TNC-7 vive al final del párrafo)');

  /* B1 · KIOSK-21 (ambos fronts comparten la vista de éxito) */
  for (const [name, s] of [['kiosk', k], ['d2c', d]]) {
    t(s.includes('We sent the plan holder the sign-in information'), `KIOSK-21: mensaje "plan holder" (${name})`);
    t(s.includes('Check your spam folder'), `KIOSK-21: recordatorio de spam (${name})`);
    t(s.includes('href="tel:18333957824">1-833-395-7824</a>'), `KIOSK-21: el 833 clickeable (${name})`);
  }
  t(k.includes('.cart-success .success-big') && core.includes('.cart-success .success-big'),
    'KIOSK-21: estilos GRANDES del éxito en kiosk inline y core.css');

  /* B2 · KIOSK-20 (CSS puro: cubre los 5 caminos que reescriben el innerHTML del botón) */
  t(k.includes('content:"Secure pay through Stripe"') && core.includes('content:"Secure pay through Stripe"'),
    'KIOSK-20: la mención vive bajo el precio en ambos fronts (::after)');
  t(k.includes('#cart-pay:not(:disabled)::after') && core.includes('#cart-pay:not(:disabled)::after'),
    'KIOSK-20: el carrito vacío (Pay disabled) NO muestra la mención');

  /* Default del kiosk (09-jul, Adrian): "Pay on this device" manda y va PRIMERO; el bloque del
     recibo (que solo se oculta en handoff) abre visible desde el arranque */
  t(/<label><input type="radio" name="deliver" value="redirect" checked> Pay on this device<\/label>/.test(k),
    'kiosk-default: "Pay on this device" es el radio marcado por defecto');
  t(k.indexOf('value="redirect" checked') < k.indexOf('value="handoff"'),
    'kiosk-default: y es la PRIMERA opción de la lista');
  t(k.includes('Email the payment link') && k.includes('Show the QR code'),
    'kiosk-guide: el CTA dice la ACCIÓN real en las vías QR/email (no "Pay")');
  t(!/>New sale</.test(k) && !/>New sale</.test(d) && !/new sale/.test(k),
    'SELF-1b: "New sale" murió — el reset es neutro de actor ("Start a new purchase") en ambos fronts');
  t(k.includes('>Start a new purchase<'), 'SELF-1b: el botón neutro presente en el kiosk');

  /* B3 · PAUSE-1 placeholder */
  t(a.includes("'Pause plan'") && a.includes("title = 'Coming soon'"), 'PAUSE-1: chip Pause plan con tooltip Coming soon');
  t(a.includes('.chip.soon'), 'PAUSE-1: estilo disimulado del chip (dashed, sin acción)');

  /* Gift EN CONTEXTO (09-jul, feedback Adrian): desde el dashboard el gift se compra en un
     MODAL de account.html y Stripe devuelve a /account.html?gift=… (el href /#gift queda de
     fallback sin JS). El source es un ENUM server-side: sin open redirect. */
  const gc = src('netlify/functions/create-gift-checkout.mjs');
  t(a.includes('openGiftModal'), 'gift-ctx: el CTA abre el modal EN el dashboard (sin navegar)');
  t(a.includes("fetch('/api/create-gift-checkout'"), 'gift-ctx: account POSTea al endpoint real');
  t(a.includes("source: 'account'"), 'gift-ctx: el POST declara la fuente para el retorno');
  t(/giftBack/.test(a), 'gift-ctx: el retorno ?gift= pinta toast y limpia la URL');
  t(gc.includes('/account.html') && gc.includes("=== 'account'"), 'gift-ctx: retorno al dashboard como ENUM en el server');

  /* MAIL-1b (09-jul): el botón del welcome aterriza guiado (prefill + password temporal),
     sin secuestrar la sesión ajena guardada; el email viaja en el FRAGMENTO, no en query */
  t(src('netlify/functions/_lib/onboarding.mjs').includes("#welcome="), 'MAIL-1b: el botón del welcome lleva #welcome=<email>');
  t(a.includes("hp.get('welcome')"), 'MAIL-1b: account.html maneja el aterrizaje del welcome');
  t(a.includes('temporary password from your email'), 'MAIL-1b: la guía pide la password temporal (10-year-old rule)');

  /* favicon inline (09-jul): sin él, cada visita loguea un 404 de /favicon.ico */
  for (const f of ['index.html', 'kiosk/index.html', 'account.html', 'dashboard.html'])
    t(src(f).includes('rel="icon"'), `favicon: ${f} declara su icono inline (adiós 404)`);

  /* espejos publicados */
  const dd = src('dist/index.html');
  t(dd.includes('We sent the plan holder') && dd.includes('content:"Secure pay through Stripe"'),
    'Bloque 09-jul: dist/index.html refleja B1+B2 (build hecho)');
  t(src('dist/kiosk/index.html') === k, 'Bloque 09-jul: dist/kiosk espejo del fuente (cp hecho)');
  t(src('dist/account.html') === a, 'Bloque 09-jul: dist/account.html espejo del fuente');
}

/* Bloque MAYA 09-jul (spec: misc/spec-maya-09jul.md) — MAYA-7 identidad, MAYA-8 guion +
   volcado total, MAYA-9 road signs. Gates vivos G13b / MAYA-1 / CA-4 re-verificados. */
{
  const k = src('kiosk/index.html');
  const d = src('index.html');
  const c = src('netlify/functions/chat.mjs');
  for (const [name, s] of [['kiosk', k], ['d2c', d]]) {
    t((s.match(/>Maya · your sales assistant</g) || []).length >= 2, `MAYA-7: triggers renombrados a "Maya · your sales assistant" (${name})`);
    t(!/>Coverage Assistant</.test(s), `MAYA-7: cero "Coverage Assistant" VISIBLE (${name})`);
    t((s.match(/Tell me about your purchase/g) || []).length >= 2, `MAYA-7: subheading de Doug "Tell me about your purchase" (${name})`);
    t(!s.includes("Let's size your "), `MAYA-7: el opener robótico murió (${name})`);
    t(s.includes("Hi, I'm Maya, your sales assistant"), `MAYA-7: Maya se presenta por nombre (${name})`);
    t(s.includes('cv.customer_name') && s.includes('cv.delivery_address') && s.includes('cv.delivery_zip') && s.includes('cv.delivery_date'),
      `MAYA-8: applyCoverage vuelca nombre/dirección/ZIP/fecha a la card (${name})`);
    t(s.includes('cv.customer_email') && s.includes('cv.customer_phone'), `MAYA-8b: y también email + teléfono (${name})`);
    t(s.includes('covDoneFor'), `MAYA-8c: el mensaje "Done…" sale UNA vez por conversación (el 2º tool-call llena en silencio) (${name})`);
    t(s.includes('placeholder="First and Last Name"'), `MAYA-8b: placeholder del nombre alineado al label (${name})`);
    t(s.includes('f.readOnly') || s.includes('readOnly'), `MAYA-8b: el volcado respeta campos bloqueados por sesión (${name})`);
    t(s.includes('add a photo of your sales receipt to ensure coverage'),
      `MAYA-9: road signs DETERMINISTAS en el mensaje de éxito (${name})`);
  }
  /* el guion pregunta en el ORDEN dictado por Doug, AGRUPADO, y el CONTACTO va al FINAL con su
     porqué (MAYA-8c, evidencia NN/g "sensitive fields last" + chatbots "value before data") */
  const orden = ['first and last name', 'sales order number', 'total amount on your sales order',
    'how many items', 'delivered, including state and ZIP', 'expected delivery date', 'best email and phone'];
  let pos = -1, monotono = true;
  for (const paso of orden) { const i = c.indexOf(paso); if (i < 0 || i < pos) { monotono = false; break; } pos = i; }
  t(monotono, 'MAYA-8: orden del guion (nombre → orden/total/items → dirección/fecha → contacto al FINAL)');
  t(c.includes('so your plan and receipts reach you'), 'MAYA-8c: el contacto se pide CON su porqué (mitigación NN/g)');
  t(c.includes('value first, then data'), 'MAYA-8c: contacto solo después de entregar el sizing');
  t(c.includes('ONCE more with ALL fields'), 'MAYA-8c: segundo size_coverage para que email/tel lleguen a la card');
  t(c.includes('grouped') && !c.includes('ONE question at a time'), 'MAYA-8b: guion AGRUPADO (fuera el interrogatorio una-por-una)');
  t(c.includes('never re-ask'), 'MAYA-8b: no re-pregunta lo que el cliente ya dio');
  t(/PERSON'S NAME/.test(c) && c.includes('never a number'), 'MAYA-8b: customer_name es nombre de persona, jamás un número (el SO no se disfraza)');
  t(c.includes("'customer_name'") || c.includes('customer_name:'), 'MAYA-8: la tool size_coverage captura customer_name');
  t(c.includes('customer_email') && c.includes('customer_phone'), 'MAYA-8b: la tool captura email y teléfono');
  t(c.includes('delivery_address') && c.includes('delivery_zip') && c.includes('delivery_date'),
    'MAYA-8: la tool captura dirección + ZIP + fecha de entrega');
  t(c.includes('or the date on the sales order'), 'MAYA-8: fallback de la fecha (la del sales order si no la sabe)');
  t(c.includes('ROAD SIGNS'), 'MAYA-9: road signs enunciados en el SYSTEM');
  /* gates que NO pueden morir con el rewrite */
  t(c.includes('do NOT quote yearly prices'), 'G13b: chat.mjs sigue SIN precios yearly');
  t(c.includes('REQUIRED-DATA GUARD'), 'CA-4: el guard sigue enunciado en el SYSTEM');
  t(c.includes("I can't comment on the specifics of what's covered"), 'MAYA-1: el guardrail de terms sigue verbatim');
  /* MAYA-9 (14-ago): Doug probó "Explain the repair membership to me" en vivo y Maya no pudo
     ("we overly restricted Maya so she wouldn't promise stuff… Adrian, you need to update that
     Maya code… Maya should be reading the FAQs"). El SYSTEM compartido kiosk+D2C aprende la
     membership SIN soltar los guard rails. */
  t(c.includes('REPAIR SAFETY NET — the membership'), 'MAYA-9: el SYSTEM tiene el bloque de la membership');
  t(c.includes('managed repair service, NOT insurance'), 'MAYA-9: la describe como servicio gestionado, no seguro');
  t(c.includes('the subscription protects the new item') && c.includes('repair help for everything else'),
    'MAYA-9: la diferencia suscripción vs membership (la pregunta del FAQ) está enunciada');
  t(c.includes('Never promise a repair outcome'), 'MAYA-9: el guard rail anti-promesa sigue en pie');
  t(c.includes('Facebook Marketplace'), 'MAYA-9: apunta al público real del producto (used furniture)');
  t(src('dist/kiosk/index.html') === k, 'MAYA: dist/kiosk espejo del fuente');
}

/* TECH-1 (call Doug 10-jul) — front tech/: kits + Repair Membership, SIN protection plans.
   Base = kiosk final; hero cosechado de dougTechVersion; trial 90d (TECH-2a) server-side. */
{
  const th = src('tech/index.html');
  const toml = src('tech/netlify.toml');
  const ck = src('netlify/functions/_lib/checkout.mjs');
  t(/FurnitureRx Tech/.test(th), 'TECH: title propio del front tech');
  t(th.includes('Your repair&rsquo;s done.'), 'TECH: hero de Doug cosechado ("Keep it that way")');
  t(th.includes('first 3 months are free'), 'TECH: la promo del hero enunciada (y cableada, no prometida en el aire)');
  t(!th.includes('<section class="compare"'), 'TECH: la sección de protection plans NO existe');
  t(!th.includes('class="cov-assist-trigger"'), 'TECH: cero triggers de captura de planes');
  t(!th.includes('href="#compare"'), 'TECH: cero anclas huérfanas al compare');
  t(!th.includes('value="handoff"'), 'TECH: sin el handoff de recibo — 3 vías (device/QR/email), como el cfg-note de Doug');
  t(th.includes('>Technician ID<') && th.includes('>Work order number<'),
    'TECH: labels del técnico ("you\'re gonna need both", Doug 10-jul)');
  t(th.includes("source: 'tech'"), 'TECH: el checkout declara source:tech (trial 90d)');
  t(th.includes("context: 'tech'"), 'TECH: Maya corre en modo tech (Q&A sin captura)');
  t(th.includes('dash-login'), 'TECH: el login al dashboard (DASH-5) sobrevive reubicado');
  /* TECH parity: los fixes alcanzables del lote replicados en tech (fork del kiosk) */
  t(/id="confirm-backdrop"[^>]*hidden/.test(th) && !/window\.confirm\(/.test(th), 'TECH/ISS-14: modal de confirmación + sin window.confirm nativo');
  t(th.includes('input[name="deliver"][value="redirect"]') && th.includes('rd.checked = true'), 'TECH/ISS-04: la venta nueva resetea Ways-to-pay al default');
  t(th.includes('function hideStaleHandoff()') && /showExpired[\s\S]{0,240}hideStaleHandoff\(\)/.test(th), 'TECH/ISS-13: oculta el QR/link obsoletos en timeout/expirado');
  t(th.includes("var DRAFT_KEY = 'furnfx_checkout_draft'") && th.includes('function restoreDraft()') && th.includes("addEventListener('pageshow'"), 'TECH/DEC-3: borrador del form en sessionStorage + restore/pageshow');
  t(/newsaleBtn\)[\s\S]{0,260}openConfirm\(\{ title: 'Start a new purchase\?'/.test(th), 'TECH/DEC-4: "Start a new purchase" (espera) confirma antes de descartar');
  t(th.includes("if(name.length < 2){ setFieldError('cart-name', 'Enter the full name.')"), 'TECH/ISS-07: check de nombre <2 en cliente');
  t(toml.includes('furniturerx.netlify.app/.netlify/functions/:splat'), 'TECH: /api proxeado al backend central');
  /* standalone de verdad (Adrian 10-jul): la carpeta lleva TODO lo que sirve */
  t(src('tech/kit_assets/wood.jpg').length > 1000 && src('tech/kit_assets/fabric.jpg').length > 1000
    && src('tech/kit_assets/leather.jpg').length > 1000, 'TECH: kit_assets standalone (las kit cards pintan)');
  t(src('tech/terms/index.html').length > 1000, 'TECH: terms standalone (los href="/terms/" resuelven en el propio site)');
  t(src('dist/tech/index.html') === th, 'TECH: dist/tech espejo del fuente (cp hecho)');
  /* backend TECH-2a + Maya tech */
  t(ck.includes('trial_period_days') && ck.includes('trialDaysFor'), 'TECH-2a: trial 90d cableado en el checkout compartido');
  t(src('netlify/functions/kiosk-handoff-complete.mjs').includes("config.source === 'tech'"),
    'TECH-2a: el source sobrevive el camino handoff');
  t(src('netlify/functions/chat.mjs').includes('TECH_SYSTEM'), 'TECH: Maya tiene su SYSTEM tech (enum por context)');
}

t.done();
