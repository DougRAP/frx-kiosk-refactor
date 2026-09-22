/* ============================================================================
 * TECH-1 (10-jul) — transformación ONE-SHOT de tech/index.html (copia del kiosk
 * final) al front TECH: kits + repair membership, sin protection plans.
 * Cada operación tiene ANCLA EXACTA y lanza si no la encuentra (cero ediciones
 * silenciosas). Tras correr, tech/index.html queda como FUENTE editable (igual
 * que kiosk/): este script no se re-corre, queda como acta de la cirugía.
 * Uso: node tools/build-tech-transform.mjs
 * ==========================================================================*/
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'tech/index.html';
let src = readFileSync(FILE, 'utf8');
let ops = 0;
const apply = (name, from, to, { all = false } = {}) => {
  if (!src.includes(from)) throw new Error(`ANCLA NO ENCONTRADA [${name}]: ${from.slice(0, 80)}…`);
  src = all ? src.split(from).join(to) : src.replace(from, to);
  ops++;
  console.log('  ✓', name);
};

/* 1 · Identidad del site */
apply('title tech',
  '<title>FurnitureRx — Monthly Furniture Protection Plans from $9.99/mo | Powered by RAP</title>',
  '<title>FurnitureRx Tech — Care Kits &amp; Repair Membership, In Your Home | Powered by RAP</title>');
apply('meta description tech',
  '<meta name="description" content="If you passed on the store plan, you still have options. FurnitureRx is monthly, per-item protection. Cancel, restart, upgrade, or downgrade anytime. Powered by RAP.">',
  '<meta name="description" content="Your repair is done — keep it that way. Pro-grade care kits and the FurnitureRx Repair Membership, offered by your technician in your home. Powered by RAP.">');

/* 2 · CSS de la offer card del hero (cosecha de dougTechVersion 895-899) */
const HIW_FOOT = src.match(/\.hiw-foot\{[^}]*\}/);
if (!HIW_FOOT) throw new Error('ANCLA NO ENCONTRADA [css .hiw-foot]');
apply('css hero-offer', HIW_FOOT[0], HIW_FOOT[0] + `
/* TECH: offer card del hero (cosecha de dougTechVersion) */
.hero-offer-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--rule)}
.hero-offer-name{font-family:var(--display);font-weight:500;font-size:1.15rem;letter-spacing:-.015em;color:var(--ink)}
.hero-offer-desc{font-size:.85rem;color:var(--ink-65);margin-top:3px}
.hero-offer-price{font-family:var(--display);font-weight:500;font-size:1.5rem;letter-spacing:-.02em;color:var(--ink);white-space:nowrap;text-align:right;font-variation-settings:"opsz" 28}
.hero-offer-price small{display:block;font-family:var(--body);font-size:.62rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--orange);margin-top:2px}`);

/* 3 · HERO de Doug (dougTechVersion 945-994) ANTES del trust; el dash-login (DASH-5) se
 *     reubica aquí porque su casa (el compare header) muere en el paso 4. */
apply('hero tech + dash-login', '<main id="main">\n\n\n<!-- TRUST -->', `<main id="main">


<!-- HERO (cosecha de dougTechVersion — la historia del técnico en casa) -->
<section class="hero" aria-label="Introduction">
  <div class="container hero-grid">
    <div class="hero-copy">
      <span class="eyebrow eyebrow-orange">Your FurnitureRx technician</span>
      <h1 class="h-display hero-headline">Your repair&rsquo;s done. <em class="accent">Keep it that way.</em></h1>
      <p class="hero-lead">The same pro-grade care kits your technician carries on every service call &mdash; buy one today and protect the piece we just fixed, plus everything else in your home.</p>
      <div class="hero-proof">
        <span class="proof-line"><strong>4.5 Google Star Rating</strong>, Trusted by <strong>2M+</strong> households</span>
        <span class="proof-line">Repairs &amp; kits administered by <strong>RAP</strong></span>
      </div>
      <p class="hiw-title">Why buy a kit</p>
      <ol class="hiw-steps">
        <li><strong>It&rsquo;s what the pros use.</strong> The exact cleaner, conditioner, and tools your technician carries &mdash; not a drugstore substitute.</li>
        <li><strong>Stop the next problem.</strong> Regular care prevents the stains, cracks, and wear that cause the repairs in the first place.</li>
        <li><strong>Keeps your whole home looking new.</strong> Pick wood, fabric, or leather and care for every piece you own.</li>
      </ol>
      <p class="hiw-foot">Ask your technician to start a <strong>Repair Membership</strong> &mdash; your <strong>first 3 months are free</strong>, then $19.99/mo for member-rate repairs on every piece.</p>
    </div>

    <aside class="signed-card" id="hero-offer" aria-label="Today's offer">
      <div class="configurator">
        <div class="cfg-title">
          <h2>Today, with your tech</h2>
        </div>
        <div class="hero-offer-row">
          <div>
            <div class="hero-offer-name">Pro care kit</div>
            <div class="hero-offer-desc">Wood, fabric &amp; upholstery, or leather</div>
          </div>
          <div class="hero-offer-price">$49.99</div>
        </div>
        <div class="hero-offer-row">
          <div>
            <div class="hero-offer-name">Repair Membership</div>
            <div class="hero-offer-desc">Member-rate repairs on every piece</div>
          </div>
          <div class="hero-offer-price">$0<small>First 3 months</small></div>
        </div>
        <p class="cfg-covers" style="margin-top:14px">Membership then $19.99/mo &middot; cancel anytime</p>
        <div class="cfg-actions">
          <div class="cfg-cta-row">
            <a href="#kits" class="btn btn-accent">Shop kits <span class="arrow">&rarr;</span></a>
            <a href="#membership" class="btn btn-ghost">Add membership</a>
          </div>
          <p class="cfg-note">No charge until your technician rings it up &mdash; pay on this device, scan a QR, or get the link by email.</p>
          <!-- DASH-5 reubicado: el compare (su casa original) no existe en el tech -->
          <p class="dash-login"><a href="https://www.furniturerx.net/dashboard" target="_blank" rel="noopener">Already a member? Log in to your dashboard &rarr;</a></p>
        </div>
      </div>
    </aside>
  </div>
</section>

<!-- TRUST -->`);

/* 4 · FUERA la sección de protection plans (compare) completa */
{
  const start = src.indexOf('<section class="compare" id="compare" aria-label="Comparison">');
  const end = src.indexOf('<!-- MEMBERSHIP -->');
  if (start < 0 || end < 0 || end <= start) throw new Error('ANCLA NO ENCONTRADA [sección compare]');
  src = src.slice(0, start) + src.slice(end);
  ops++;
  console.log('  ✓ compare (protection plans) eliminado:', end - start, 'chars');
}

/* 5 · Drawer de navegación: fuera "Protection Plans" (su ancla #compare murió) */
apply('drawer sin Protection Plans', '    <li><a href="#compare">Protection Plans</a></li>\n', '');

/* 6 · Checkout: Technician ID + Work order SIEMPRE visibles (Doug: "you're gonna need both");
 *     salen del bloque del recibo (que en tech vive oculto: no hay planes) */
apply('tech fields visibles', '        <div id="cart-receipt-fields">', `        <!-- TECH (Doug 10-jul): el técnico SIEMPRE se identifica (pre-asignado, "so you get
             credit") y ata la venta a su work order — o a su referencia interna en ventas de
             solo-kit ("you're gonna need both"). El server los exige (kiosk:true). -->
        <p class="cart-hint">From the repair visit &mdash; so your technician gets credit.</p>
        <div class="cart-field kiosk-only">
          <label for="cart-associate">Technician ID</label>
          <input id="cart-associate" name="associate" type="text" autocomplete="off" placeholder="Pre-assigned &mdash; e.g. T-4471" required>
        </div>
        <div class="cart-field">
          <label for="cart-order">Work order number</label>
          <input id="cart-order" name="order" type="text" autocomplete="off" placeholder="From the work order &mdash; or your internal reference" required>
        </div>
        <div id="cart-receipt-fields">`);
apply('fuera associate del bloque recibo', `          <div class="cart-field kiosk-only">
            <label for="cart-associate">Sales associate #</label>
            <input id="cart-associate" name="associate" type="text" autocomplete="off" placeholder="e.g. 4471">
          </div>
`, '');
apply('fuera order del bloque recibo', `          <div class="cart-field">
            <label for="cart-order">Sale order number</label>
            <input id="cart-order" name="order" type="text" autocomplete="off" inputmode="numeric" placeholder="e.g. 100482" required>
          </div>
`, '');

/* 7 · Ways to pay: fuera el handoff de recibo+pago (el tech no captura recibos);
 *     quedan las 3 vías EXACTAS del cfg-note de Doug: device / QR / email */
apply('fuera handoff radio', '          <label><input type="radio" name="deliver" value="handoff"> Show QR to add receipt and pay</label>\n', '');

/* 8 · Maya TECH: saludo, seed, fallbacks y el context al server */
apply('chat greeting', 'Hi there 👋 I&rsquo;m Maya on the FurnitureRx team. Anything I can help you sort out about the plans or membership?',
  'Hi there 👋 I&rsquo;m Maya on the FurnitureRx team. Anything I can help you sort out about the care kits or your Repair Membership?');
apply('chat seed', "Hi there! I’m Maya on the FurnitureRx team. Anything I can help you sort out about the plans or membership?",
  'Hi there! I’m Maya on the FurnitureRx team. Anything I can help you sort out about the care kits or your Repair Membership?');
apply('fallbacks tech', `  var FALLBACK_REPLIES = [
    "Great question — happy to walk you through it. What piece are you thinking about covering?",
    "Totally fair — you can cancel any month and your account stays open if you want to restart later.",
    "We offer monthly plans starting at $9.99/mo — coverage up to $5,000. Want the details?",
    "Got it — let me grab a teammate who can pull up your situation. What’s the best number to reach you?"
  ];`, `  var FALLBACK_REPLIES = [
    "Great question — happy to walk you through it. Are you looking at a care kit, or the Repair Membership?",
    "Totally fair — the membership is $19.99/mo after your first 3 free months, and you can cancel anytime.",
    "The kits are the same pro-grade products your technician carries — wood, fabric & upholstery, or leather, from $49.99.",
    "Got it — let me grab a teammate who can pull up your situation. What’s the best number to reach you?"
  ];`);
apply('chat context tech',
  'body: JSON.stringify(covConvId ? { messages: chatHistory, conversation_id: covConvId } : { messages: chatHistory }),',
  "body: JSON.stringify({ messages: chatHistory, context: 'tech' }),   /* TECH: Maya Q&A sin captura */");

/* 9 · Neutralizar el wiring de las compare cards (su markup murió; sin esto el boot lanza) */
apply('wiring compare muerto',
  "[{ cov:'stain', pre:'cmp-stain' }, { cov:'stain-mech', pre:'cmp-mech' }].forEach(",
  "[].forEach(   /* TECH: sin protection plans — las compare cards no existen */");

/* 10 · Sticky mobile: carrito por kits/membership (savedItems = líneas de PLAN, aquí siempre 0) */
apply('sticky tech', `  function renderStickyMobile(){
    if(!stickyCta) return;
    stickyCta.innerHTML = savedItems.length
      ? 'Checkout <span class="arrow">&rarr;</span>'
      : 'Add plan <span class="arrow">&rarr;</span>';
    stickyCta.dataset.mode = savedItems.length ? 'checkout' : 'add';
  }
  if(stickyCta){
    stickyCta.addEventListener('click', function(){
      if(stickyCta.dataset.mode === 'add'){
        cartAdd('stain-mech', 'monthly', 'furniture', 1);
        renderCompareCards(); updateCartBadge(); reflectToHero('stain-mech');
      }
      openCart();
    });`, `  function renderStickyMobile(){
    if(!stickyCta) return;
    var hasTech = kitCount() > 0 || savedMembership;   /* TECH: el carrito vive de kits + membership */
    stickyCta.innerHTML = hasTech
      ? 'Checkout <span class="arrow">&rarr;</span>'
      : 'Add membership <span class="arrow">&rarr;</span>';
    stickyCta.dataset.mode = hasTech ? 'checkout' : 'add';
  }
  if(stickyCta){
    stickyCta.addEventListener('click', function(){
      if(stickyCta.dataset.mode === 'add'){ openMembership(); return; }
      openCart();
    });`);

/* 11 · source:'tech' en el payload del checkout (habilita el trial 90d server-side) */
apply('payload source', 'kiosk: KIOSK,                                                                 /* KIOSK-1: server exige associate+date en kiosk */',
  `kiosk: KIOSK,                                                                 /* KIOSK-1: server exige associate+order en kiosk */
        source: 'tech',                                                              /* TECH-2a: habilita el trial 90d de la membership */`);
apply('startCheckout source', 'associate: p.associate, kiosk: !!p.kiosk,           /* KIOSK-1 */',
  `associate: p.associate, kiosk: !!p.kiosk,           /* KIOSK-1 */
        source: p.source || undefined,                       /* TECH-2a */`);

/* 12 · El sticky del pago dice la verdad del trial en el botón NO — el precio real lo pinta
 *      updateCartTotal desde los line items; el trial lo enuncia el hero + Maya. (nota) */

writeFileSync(FILE, src);
console.log(`\nOK — ${ops} operaciones aplicadas sobre ${FILE} (${src.length} bytes)`);
