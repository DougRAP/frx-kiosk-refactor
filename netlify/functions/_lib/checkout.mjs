/* ============================================================================
 * _lib/checkout.mjs — NÚCLEO del checkout, compartido (DRY).
 * ----------------------------------------------------------------------------
 * Lo usan create-checkout-session (D2C) y kiosk-handoff-complete (single-QR).
 * Toma los `fields` YA validados (validateCheckout) + el `body` (return_to /
 * deliver / kiosk) + `req` (para el header Origin). Resuelve kits contra el
 * catálogo (precio + kit_id SIEMPRE del server), persiste el lead (service_role),
 * crea la Stripe Checkout Session y —si deliver:'email'— envía el link.
 *
 * Devuelve { status, data } para que el CALLER haga json(status, data) con su
 * propio helper. El lead_id viaja como client_reference_id → el webhook reconcilia
 * (idéntico para ambos caminos → cero cambios en el webhook). Origin-allowlist +
 * return_to validados aquí (anti open-redirect); precios NUNCA del cliente.
 * ==========================================================================*/

'use strict';

import { insertLead, getCareKitsBySku, pgrest } from './supabase.mjs';
import { getStripe, priceForTier, pickMembershipPrice } from './stripe.mjs';
import { sendEmail } from './email.mjs';
import { newShortCode } from './shortcode.mjs';
import { dealerCanSell } from './portal.mjs';
import { resolveAttribution } from './referral.mjs';

/* TECH-2a (call 10-jul, decisión Adrian): la promo del hero tech de Doug ("first 3 months
 * FREE, then $19.99/mo") se CABLEA como trial de Stripe. Enum server-side: solo 'tech'
 * cuenta, y SOLO cuando el carrito es membership SIN planes — un source forjado desde otro
 * front jamás regala planes (lo máximo que "gana" es la promo pública del tech). */
export function trialDaysFor(source, fields) {
  return (source === 'tech' && fields && fields.membership && !fields.hasPlans) ? 90 : 0;
}

/* BE-5 (reunión 14-ago) — cargos one-time de los kits, ÚNICO punto de verdad:
 *   S&H: "on the kits we're going to charge a shipping and handling charge… average shipping
 *        daily is 10.97… so you would just add eleven dollars" → $11 POR KIT (N1, Adrian).
 *   Tax: "Yes. You're going to use a flat 6%" (Doug, dos veces) con base SOLO el kit (N2).
 *        Kits SÍ se cobra al cliente; suscripciones NO ("we eat the 6%", se acumula interno);
 *        membership sin tax ("but not membership plan sales").
 * Knobs por env con default en código (patrón ELIGIBILITY_WINDOW_DAYS) para que un cambio de
 * criterio de Doug sea un flip de env var sin código:
 *   KIT_SH_CENTS (1100) · KIT_SH_PER_ORDER (false = por kit) · KIT_TAX_BASE ('kit'|'kit_sh').
 * Front y webhook consumen este helper (o lo espejan como display); nadie más calcula. */
const KIT_TAX_RATE = 0.06;   // flat 6% mientras no exista registro fiscal por estados
export function kitCharges(kits, env = {}) {
  const units = (kits || []).reduce((s, k) => s + (k.quantity || 0), 0);
  if (!units) return { shCents: 0, taxCents: 0 };
  const shPer = Number.parseInt(env.KIT_SH_CENTS ?? '', 10);
  const shCentsUnit = Number.isFinite(shPer) && shPer >= 0 ? shPer : 1100;
  const perOrder = String(env.KIT_SH_PER_ORDER || '').toLowerCase() === 'true';
  const shCents = perOrder ? shCentsUnit : shCentsUnit * units;
  const retailCents = (kits || []).reduce((s, k) => s + (k.unit_price_cents || 0) * (k.quantity || 0), 0);
  const base = (env.KIT_TAX_BASE === 'kit_sh') ? retailCents + shCents : retailCents;
  return { shCents, taxCents: Math.round(base * KIT_TAX_RATE) };
}

/* QA-2 (BUG-01 de Jakob): base de retorno post-Stripe, compartida por TODO checkout que
 * arme success/cancel_url (principal, handoff y gift). Si el ORIGEN real está en la
 * allowlist (ALLOWED_ORIGINS, CSV) volvemos a ÉL; si no, al SITE_URL canónico. Match
 * EXACTO → sin open-redirect. */
export function resolveReturnBase(req, env) {
  const stripSlash = (s) => s.replace(/\/+$/, '');
  const allowed = (env.ALLOWED_ORIGINS || env.SITE_URL || new URL(req.url).origin)
    .split(',').map((s) => stripSlash(s.trim())).filter(Boolean);
  const reqOrigin = stripSlash((req.headers.get('origin') || '').trim());
  return (reqOrigin && allowed.includes(reqOrigin))
    ? reqOrigin
    : stripSlash(env.SITE_URL || allowed[0] || new URL(req.url).origin);
}

export async function createCheckoutSession(env, req, { fields, body }) {
  body = body || {};

  /* PORT-9/9b: atribución A/B (canon 15-jul), resuelta SERVER-SIDE y fail-soft:
   *   A) body.kiosk_session (token del SSO portal→kiosk) → dealer del TOKEN (jamás de un
   *      org_id del body: un org forjado robaría comisiones);
   *   B) body.referral_code tecleado en el cart → lookup + dealerCanSell; dealer apagado =
   *      código inválido y la venta SIGUE (decisión Adrian 15-jul).
   * El resultado viaja en el lead.payload → el webhook lo copia a la subscription. */
  const attr = await resolveAttribution(env, {
    kioskSessionToken: typeof body.kiosk_session === 'string' ? body.kiosk_session : null,
    referralCodeRaw: body.referral_code
  }, Date.now());
  if (attr) {
    fields.dealer_id = attr.dealer_id;
    fields.attribution_source = attr.source;
    fields.referral_code = attr.code || null;
  }

  /* PORT-11 (sell-time check, va para AGO-1): si el front DECLARA su org (org_id/dealer_id) o la
   * venta viene por SESIÓN de kiosk (método A = el dealer vendiendo), y ese org está apagado o
   * fuera de su ventana de acceso → 403. Una atribución por referral code NO gatea (es el cliente
   * comprando; el código de un dealer no-vendible ya se ignoró arriba). SIN org → no toca nada
   * (regresión CERO). Fail-open ante un hipo de BD (mismo criterio que el rate-limit). */
  const sellOrg = (attr && attr.source === 'kiosk_session' && attr.dealer_id)
    || (typeof body.org_id === 'string' ? body.org_id : (typeof body.dealer_id === 'string' ? body.dealer_id : null));
  if (sellOrg) {
    try {
      const dr = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(sellOrg)}&select=selling_enabled,access_start,access_end&limit=1`);
      const dealer = (dr.status < 300 && Array.isArray(dr.data)) ? dr.data[0] : null;
      const can = dealerCanSell(dealer, Date.now());
      if (!can.ok) return { status: 403, data: { error: 'dealer_disabled', reason: can.reason } };
    } catch (err) { console.warn('[checkout] dealer-status fail-open:', err.message); }
  }

  /* Base de retorno (multi-variante / multi-dominio): helper compartido resolveReturnBase.
   * La variante DECLARA su path (location.pathname); validado: un solo '/' inicial,
   * sin query/hash/esquema/backslash/espacios. Fallback al flag kiosk. */
  const returnBase = resolveReturnBase(req, env);
  const rt = typeof body.return_to === 'string' ? body.return_to : '';
  const returnPath = (rt && rt.length <= 256 && rt[0] === '/' && rt[1] !== '/'
    && !/[?#\\\s]/.test(rt) && !rt.includes('://'))
    ? rt
    : (body.kiosk ? '/kiosk.html' : '/');

  /* Resolver los kits contra el catálogo canónico (care_kits): precio + kit_id SIEMPRE del server. */
  try {
    if (fields.kits.length) {
      const catalog = await getCareKitsBySku(env, fields.kits.map((k) => k.sku));
      const resolved = [];
      for (const k of fields.kits) {
        const c = catalog[k.sku];
        if (!c) return { status: 400, data: { error: 'unknown_kit' } };   // sku ausente/inactivo
        resolved.push({ sku: k.sku, quantity: k.quantity, kit_id: c.id, name: c.name, unit_price_cents: c.price_cents });
      }
      fields.kits = resolved;
    }
  } catch (err) {
    console.error('[checkout] kit catalog:', err.message);
    return { status: 502, data: { error: 'catalog_failed' } };
  }

  let leadId;
  try {
    leadId = await insertLead(env, fields);
  } catch (err) {
    console.error('[checkout] lead insert:', err.message);
    return { status: 502, data: { error: 'lead_failed' } };
  }

  /* line_items: planes (recurrente por tier, sumando quantity) + kits (price_data one-time) +
   * membership de pago a precio completo (MEM-7, 14-ago: la incluida es entitlement, no item). */
  const lineItems = [];
  const planQtyByTier = {};
  for (const p of fields.plans) planQtyByTier[p.tier] = (planQtyByTier[p.tier] || 0) + p.count;
  for (const tier of Object.keys(planQtyByTier)) {
    lineItems.push({ price: priceForTier(env, tier), quantity: planQtyByTier[tier] });
  }
  for (const k of fields.kits) {
    lineItems.push({
      quantity: k.quantity,
      price_data: { currency: 'usd', unit_amount: k.unit_price_cents, product_data: { name: k.name || k.sku } }
    });
  }
  /* BE-5: con kits en el carrito, DOS líneas one-time visibles en Stripe (S&H + tax). Los
     planes y la membership jamás las llevan. */
  {
    const { shCents, taxCents } = kitCharges(fields.kits, env);
    if (shCents > 0) lineItems.push({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: shCents, product_data: { name: 'Shipping & handling' } }
    });
    if (taxCents > 0) lineItems.push({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: taxCents, product_data: { name: 'Sales tax (6%)' } }
    });
  }
  if (fields.membership) {
    /* MEM-7 (14-ago): la membership DE PAGO vale SIEMPRE $19.99 (la incluida con el plan es un
       entitlement computado, no un item; murió la Arquitectura B FREE/HALF del 06-jul). */
    lineItems.push({ price: pickMembershipPrice(env), quantity: 1 });
  }

  try {
    const stripe = getStripe(env);
    const isSub = fields.hasPlans || fields.membership;
    const params = {
      mode: isSub ? 'subscription' : 'payment',
      line_items: lineItems,
      client_reference_id: leadId,
      customer_email: fields.email,
      metadata: { lead_id: leadId },
      success_url: `${returnBase}${returnPath}?paid=1`,
      cancel_url: `${returnBase}${returnPath}?canceled=1`
    };
    /* metadata de la Session NO se propaga a la Subscription → lead_id EN la subscription. */
    if (isSub) {
      params.subscription_data = { metadata: { lead_id: leadId } };
      /* TECH-2a: 3 meses free de la membership comprada en el front tech. Con kits en el
       * carrito, Stripe cobra HOY solo los one-time ($0 recurrente hasta el día 90). */
      const trial = trialDaysFor(body.source, fields);
      if (trial) params.subscription_data.trial_period_days = trial;
      /* GIFT-1 (§F5): pinta el campo "Add promotion code" de Stripe Checkout — ahí se
       * canjea el gift code SIN UI propia. Validez/expiración/1-uso/cliente-nuevo los
       * enforza Stripe (restricciones del promotion code). SOLO en mode:subscription:
       * el gift regala meses recurrentes, no aplica a compras one-time (solo-kit). */
      params.allow_promotion_codes = true;
    }
    const session = await stripe.checkout.sessions.create(params);

    /* KIOSK-16: URL corta TECLEABLE /p/CODIGO → 302 a session.url (fallback manual del QR;
     * pay-redirect.mjs + tabla pay_links, migración 20260704120000). FAIL-SOFT: si el insert
     * falla, el checkout sigue con la URL larga de Stripe y short_url va null. La base es el
     * ORIGEN del front que pidió el checkout (ya validado contra la allowlist arriba) para que
     * el cliente teclee el mismo dominio del QR; expira junto con la Checkout Session (24 h). */
    let shortUrl = null;
    try {
      const code = newShortCode();
      const expiresAt = new Date(session.expires_at ? session.expires_at * 1000 : Date.now() + 24 * 3600 * 1000).toISOString();
      const ins = await pgrest(env, '/pay_links', {
        method: 'POST', prefer: 'return=minimal',
        body: { code, stripe_url: session.url, session_id: session.id, expires_at: expiresAt }
      });
      if (ins.status < 300) shortUrl = `${returnBase}/p/${code}`;
      else console.warn('[checkout] pay_link insert status', ins.status);
    } catch (err) {
      console.warn('[checkout] pay_link:', err.message);   // sin session.url en el log
    }

    /* KIOSK-1: si el associate eligió "Email to customer", entregamos el link server-side con la
     * session.url recién creada (nunca una URL del cliente → sin open-relay). Fail-soft. NUNCA logueamos session.url. */
    let emailed = false;
    if (body.deliver === 'email') {
      /* SHORT-LINK: mandamos el /p/CODIGO corto y tecleable (el mismo del QR), no la URL larga de
       * Stripe. Fail-soft: si el pay_link no se creó (shortUrl null), cae a la URL larga como antes. */
      const payLink = shortUrl || session.url;
      const html = '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0e1418">'
        + '<h2>Complete your Furniture-Rx purchase</h2>'
        + '<p>Your sales associate started your protection plan. Tap below to pay securely &mdash; this link is valid for 24 hours.</p>'
        + '<p><a href="' + payLink + '" style="display:inline-block;background:#e8590c;color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none;font-weight:600">Pay securely &rarr;</a></p>'
        + '<p style="color:#667;font-size:13px">If the button doesn\'t work, paste this link into your browser:<br>' + payLink + '</p>'
        + '</div>';
      /* QA-3 (BUG-04): timeout 8s — esta llamada ocurre TRAS Stripe + insert en la misma
       * invocación (posible cold start); el default de 3s la mataba en prod. */
      const r = await sendEmail(env, {
        to: fields.email,
        subject: 'Your Furniture-Rx payment link',
        html: html,
        text: 'Complete your Furniture-Rx purchase securely (link valid 24h): ' + payLink,
        timeoutMs: 8000
      });
      emailed = r.ok;
      if (!r.ok) console.warn('[checkout] email failed:', r.error);   // QA-3: sin esto el fallo era indiagnosticable (nunca la URL)
    }
    return { status: 200, data: { url: session.url, emailed: emailed, id: session.id, short_url: shortUrl } };
  } catch (err) {
    console.error('[checkout] stripe:', err.message);
    return { status: 502, data: { error: 'checkout_failed' } };
  }
}
