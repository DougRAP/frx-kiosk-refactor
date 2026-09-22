/* ============================================================================
 * POST /.netlify/functions/stripe-webhook
 * ----------------------------------------------------------------------------
 * Al confirmarse el pago (checkout.session.completed), hace "deferred account
 * creation": crea/obtiene la cuenta por email (Supabase), el profile, la
 * subscription real y las covered_pieces desde el lead, enlaza el lead y dispara
 * el email de acceso (AUTH-2: welcome propio con contraseña temporal para nuevos,
 * recovery de GoTrue para recurrentes).
 *
 * SEGURIDAD: la firma se verifica ANTES de cualquier lógica (raw body intacto).
 * IDEMPOTENCIA: guarda por lead.user_id + INSERT plano de subscription (409 = ya
 * procesado). Errores recuperables → non-2xx → Stripe reintenta (~3 días).
 * ==========================================================================*/

'use strict';

import { getStripe } from './_lib/stripe.mjs';
import {
  getLead, linkLeadUser, getUserIdByEmail, upsertProfile,
  createUserWithPassword, sendRecovery, insertSubscription, insertCoveredPieces,
  insertOrder, insertOrderItems,
  getOrAssignMasterNo, getPlanBySubscription, countCertificates, insertCoverageCertificate,
  updateSubscriptionsByStripeId, pgrest
} from './_lib/supabase.mjs';
import { signAccountToken } from './_lib/token.mjs';
import { sendEmail } from './_lib/email.mjs';
import { generateTempPassword, welcomeEmail } from './_lib/onboarding.mjs';
import { GIFT_TIERS, GIFT_MONTHS, generateGiftCode, couponId, giftEmail } from './_lib/gift.mjs';
import { recordCommissions, recordKitCommission } from './_lib/commissions.mjs';
import { termsFor } from './_lib/referral.mjs';
import { kitCharges } from './_lib/checkout.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const env = process.env;
  const sig = req.headers.get('stripe-signature');
  if (!sig || !env.STRIPE_WEBHOOK_SECRET) return json(400, { error: 'missing_signature' });

  // 1) Raw body SIN parsear (parsearlo invalidaría la firma)
  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }

  // 2) Verificar firma (HMAC + anti-replay). Cualquier fallo → 400, nada se ejecuta.
  const stripe = getStripe(env);
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return json(400, { error: 'invalid_signature' });
  }

  // 3a) SERIALIZACIÓN (opción B) — listener del ciclo, APAGADO por default. Emite un certificado
  //     de cobertura serializado ({master_no}-NN) por cada invoice pagada. NO encender hasta que
  //     Doug confirme (a) el formato exacto del serial/claim# y (b) la regla del waiting-period de
  //     30 días. Doble apagado: este flag + el evento invoice.paid NO está suscrito en el endpoint
  //     de Stripe. Cuando se encienda, el backfill de ciclos pasados sale de las invoices de Stripe.
  if (event.type === 'invoice.paid') {
    // PORT-8: accrual de comisión por pago recibido ($2/$8 + split reinsurance, canon 15-jul).
    // Detrás de COMMISSIONS_ENABLED (default OFF → cero regresión); idempotente por
    // UNIQUE (invoice, sku). Requiere suscribir invoice.paid en el endpoint de Stripe.
    if (env.COMMISSIONS_ENABLED === 'true') {
      try { await recordCommissions(env, event.data.object); }
      catch (err) { console.error('[webhook] invoice.paid commission error:', err.message); return json(500, { error: 'commission_failed' }); }
    }
    if (env.SERIALIZATION_ENABLED === 'true') {
      try { await handleInvoicePaid(env, event.data.object); }
      catch (err) { console.error('[webhook] invoice.paid cert error:', err.message); return json(500, { error: 'cert_failed' }); }
    }
    return json(200, { received: true });
  }

  // 3b) SUB-2 — ciclo de vida: refleja pausa/cancelación/impago de Stripe en subscriptions.status
  //     (sin esto el dashboard muestra "active" para siempre). Requiere suscribir los eventos
  //     customer.subscription.updated/deleted en el endpoint de Stripe (config, Adrian).
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    try {
      const n = await handleSubscriptionLifecycle(env, event.data.object, event.type);
      if (!n) console.log('[webhook] lifecycle: no rows for', event.data.object.id);
    } catch (err) {
      console.error('[webhook] lifecycle error:', err.message);
      return json(500, { error: 'lifecycle_failed' });   // → Stripe reintenta
    }
    return json(200, { received: true });
  }

  // 3c) Solo nos interesa checkout.session.completed; el resto se ACKea (YAGNI)
  if (event.type !== 'checkout.session.completed') return json(200, { received: true });

  const session = event.data.object;

  // 3d) GIFT-1 — compra de un gift code (create-gift-checkout: mode:payment,
  //     metadata.intent='gift'). Va ANTES del manejo de leads porque esta compra NO trae
  //     client_reference_id (no crea cuenta ni cobertura: emite el promotion code y manda
  //     el email). Los pasos internos son idempotentes → non-2xx = reintento de Stripe.
  if (session.metadata && session.metadata.intent === 'gift') {
    console.log(`[webhook] ${event.id} gift pay=${session.payment_status}`);
    if (session.payment_status !== 'paid') return json(200, { ignored: 'not_paid' });
    try {
      await handleGiftPurchase(env, session);
      return json(200, { received: true });
    } catch (err) {
      console.error('[webhook] gift error:', err.message);
      return json(500, { error: 'gift_failed' });   // → Stripe reintenta
    }
  }

  const leadId = session.client_reference_id;
  console.log(`[webhook] ${event.id} ${event.type} lead=${leadId} pay=${session.payment_status}`);

  if (session.payment_status !== 'paid') return json(200, { ignored: 'not_paid' });
  if (!leadId) { console.error('[webhook] no client_reference_id'); return json(200, { ignored: 'no_lead' }); }

  try {
    const lead = await getLead(env, leadId);
    if (!lead) { console.error('[webhook] lead not found:', leadId); return json(200, { ignored: 'lead_missing' }); }

    // Idempotencia barata: si el lead ya fue enlazado, ya procesamos este pago.
    // Evita re-crear cuenta/subscription y re-enviar emails en reentregas secuenciales.
    if (lead.user_id) { console.log('[webhook] already processed lead', leadId); return json(200, { received: true }); }

    const p = lead.payload || {};
    const email = lead.email;
    const siteUrl = env.SITE_URL || new URL(req.url).origin;
    /* El email de Supabase (invite/recovery) redirige AQUÍ: al dashboard SIN login (account.html + token
       firmado de 90d). Fail-soft: sin DASHBOARD_LINK_SECRET cae al siteUrl (home), como antes. */
    const dashUrl = env.DASHBOARD_LINK_SECRET
      ? siteUrl + '/account.html?t=' + signAccountToken(email, env.DASHBOARD_LINK_SECRET)
      : siteUrl;
    const plans = Array.isArray(p.plans) ? p.plans : [];   // [{cov,term,type,count,tier,monthly_cents}]
    const kits = Array.isArray(p.kits) ? p.kits : [];      // [{sku,quantity,kit_id,unit_price_cents}] (resueltos)

    // 4) get-or-create user — SIEMPRE (independiente de plan/kit). Email = única verdad (lead).
    //    Una compra solo-kit también crea cuenta (decisión de producto, jun-2026).
    //    AUTH-2 (Adrian 07-jul): la cuenta nace confirmada y CON contraseña temporal (nada de
    //    invite de GoTrue); must_change_password fuerza el cambio en el primer login.
    let userId = await getUserIdByEmail(env, email);
    let isNew = false;
    let tempPassword = null;
    if (!userId) {
      tempPassword = generateTempPassword();
      /* SEC-3a: se sella CUÁNDO se emitió la temporal para que pueda caducar
       * (_lib/temppw.mjs, ventana TEMP_PASSWORD_TTL_DAYS). Sin este sello la
       * contraseña del welcome email valía para siempre. */
      const r = await createUserWithPassword(env, email, tempPassword, {
        must_change_password: true,
        temp_password_at: new Date().toISOString()
      });
      if (r.exists) {
        userId = await getUserIdByEmail(env, email);      // carrera: otro proceso lo creó
        if (!userId) throw new Error('user exists but no profile yet');  // → reintento Stripe
        tempPassword = null;   // esa cuenta ajena tiene OTRA password; no hay nada que mandar
      } else {
        userId = r.id;
        isNew = true;
      }
    }

    // 5) profile (idempotente) — name/phone van a profiles; address vive en lead.payload.
    await upsertProfile(env, userId, email, { full_name: p.full_name, phone: p.phone });

    // 6) Email de acceso. Nuevo (AUTH-2): welcome PROPIO (Resend) con UN solo link al login del
    //    dashboard + la contraseña temporal (MAIL-1: el botón ?t= "View my coverage" murió).
    //    Si el envío falla → lanzar → non-2xx → Stripe reintenta; en el reintento el usuario YA
    //    existe → cae a recovery (el cliente nunca queda sin acceso). dashUrl sigue vivo abajo:
    //    sendRecovery (cuentas existentes) aún redirige por ?t=.
    if (isNew) {
      const mail = welcomeEmail({ accountUrl: siteUrl + '/account.html', tempPassword, email });
      const sent = await sendEmail(env, { to: email, subject: mail.subject, html: mail.html, text: mail.text });
      if (!sent.ok) throw new Error(`welcome email failed: ${sent.error}`);
    } else {
      await sendRecovery(env, email, dashUrl);
    }

    // 7) SUSCRIPCIÓN — UNA fila por COBERTURA (item de Stripe) + membership. (En
    //    mode:'payment'/solo-kit session.subscription es null → NO retrieve.)
    if (session.mode === 'subscription' && session.subscription) {
      // Verdad financiera: leer lo que Stripe realmente cobró, ITEM por ITEM.
      const sub = await stripe.subscriptions.retrieve(session.subscription);

      /* GIFT-1 — marcado de canje, BEST-EFFORT: si la sub nació con un promotion code
       * (campo "Add promotion code" de Checkout), puede ser un gift nuestro. El SDK trae
       * sub.discount (o discounts[0]) con promotion_code normalmente como id STRING
       * ('promo_...'); si viene expandido, usamos .id. markGiftRedeemed decide por
       * metadata.gift y JAMÁS lanza — un fallo aquí no puede tumbar la creación de cuenta. */
      const disc = sub.discount
        || (Array.isArray(sub.discounts) ? sub.discounts.find((d) => d && typeof d === 'object') : null)
        || null;
      const promoRef = (disc && typeof disc === 'object')
        ? (typeof disc.promotion_code === 'string' ? disc.promotion_code : ((disc.promotion_code && disc.promotion_code.id) || null))
        : null;
      if (promoRef) await markGiftRedeemed(env, promoRef, email);

      const items = (sub.items && sub.items.data) || [];
      const cpeEpoch = sub.current_period_end || (items[0] && items[0].current_period_end);
      const currentPeriodEnd = cpeEpoch ? new Date(cpeEpoch * 1000).toISOString() : null;

      // SERIALIZACIÓN (opción B): master# ESTABLE del plan, asignado en la compra (identidad
      // irreversible). Se asigna solo si la suscripción trae protección (la membership no es un
      // plan asegurado serializado). Compartido por TODAS las filas de protección de esta compra.
      const hasProtection = items.some((it) => {
        const pid = it.price && it.price.id;
        return pid === env.STRIPE_PRICE_STAIN || pid === env.STRIPE_PRICE_STAIN_MECH;
      });
      const masterNo = hasProtection ? await getOrAssignMasterNo(env, sub.id) : null;

      /* PORT-4b: repositorio de T&Cs. La versión que corresponde a (dealer atribuido, SKU) se
       * resuelve AL PRIMER PAGO (aquí), no en el checkout; sin fila específica → genérica; un
       * hipo de BD → fail-soft al estampado del checkout (p.terms_version). */
      let termsRows = [];
      if (hasProtection) {
        try {
          const orgFilter = p.dealer_id
            ? `or=(org_id.eq.${encodeURIComponent(p.dealer_id)},org_id.is.null)`
            : 'org_id=is.null';
          const tq = await pgrest(env, `/plan_terms?${orgFilter}&active=eq.true&select=org_id,plan_sku,terms_version,doc_url,active`);
          if (tq.status < 300 && Array.isArray(tq.data)) termsRows = tq.data;
        } catch (err) { console.warn('[webhook] plan_terms fail-soft:', err.message); }
      }

      // Grano por cobertura: una fila por item. Clasificación AUTORITATIVA por price-id (env
      // server-side, NO por payload). Idempotencia por stripe_subscription_item_id (si_...).
      // MEM-7 (14-ago): la membership de pago vale siempre $19.99; los prices FREE y HALF ya no
      // se venden, pero el webhook los SIGUE reconociendo por las suscripciones legacy que los
      // llevan (renovaciones/updates). Esto cierra de paso el bug F1 del audit: una HALF de
      // $9.99 caía a la clasificación de tiers y se descartaba sin registrarse.
      for (const item of items) {
        const priceId = item.price && item.price.id;
        const unit = item.price ? item.price.unit_amount : null;
        const monthlyCents = Number.isInteger(unit) ? unit * (item.quantity || 1) : null;

        const isMembership = priceId === env.STRIPE_PRICE_MEMBERSHIP
          || priceId === env.STRIPE_PRICE_MEMBERSHIP_FREE
          || priceId === env.STRIPE_PRICE_MEMBERSHIP_HALF;
        if (isMembership) {
          await insertSubscription(env, {
            user_id: userId, kind: 'membership', tier: null, status: 'active',
            started_at: new Date().toISOString(),
            monthly_cents: monthlyCents != null ? monthlyCents
              : (priceId === env.STRIPE_PRICE_MEMBERSHIP ? 1999
                : (priceId === env.STRIPE_PRICE_MEMBERSHIP_HALF ? 999 : 0)),   // defensivo
            stripe_subscription_id: sub.id,
            stripe_subscription_item_id: item.id,
            stripe_price_id: priceId,
            current_period_end: currentPeriodEnd,
            coverage_cap_cents: null,
            /* COMM-3: la fila membership TAMBIÉN lleva la atribución. Sin esto, una membership
               standalone vendida por QR/kiosk jamás comisionaría: recordCommissions resuelve el
               dealer buscando subscriptions con dealer_id de este stripe_subscription_id. */
            dealer_id: p.dealer_id || null,
            attribution_source: p.attribution_source || null,
            referral_code: p.referral_code || null
          });
          continue;
        }

        let tier = null;
        if (priceId === env.STRIPE_PRICE_STAIN_MECH) tier = 'stain_mech';
        else if (priceId === env.STRIPE_PRICE_STAIN) tier = 'stain';
        if (!tier) { console.warn('[webhook] price desconocido en item', item.id, priceId); continue; }

        const fb = (plans.find((pl) => pl.tier === tier) || {}).monthly_cents;   // fallback desde el lead
        const tlk = termsFor(termsRows, p.dealer_id || null, tier);   // PORT-4b: versión por (dealer, SKU)
        const { created, row } = await insertSubscription(env, {
          user_id: userId, kind: 'protection', tier, status: 'active',
          started_at: new Date().toISOString(),
          monthly_cents: monthlyCents != null ? monthlyCents : (fb || 0),
          stripe_subscription_id: sub.id,
          stripe_subscription_item_id: item.id,
          stripe_price_id: priceId,
          current_period_end: currentPeriodEnd,
          coverage_cap_cents: null,
          master_no: masterNo,                     // serialización (opción B): nº de plan estable RX-#####
          /* BE-1: copiamos el recibo desde lead.payload a la subscription. */
          sales_order_number: p.sales_order_number || null,
          sales_associate: p.sales_associate || null,   // Paso 2: atribución del associate (kiosk) → conciliar comisión
          receipt_zip: p.receipt_zip || null,
          purchased_on: p.purchase_date || null,
          receipt_path: p.receipt_path || null,
          /* PORT-9: atribución A/B del checkout (método A kiosk_session / B referral_code).
             Reemplaza al viejo plan BE-1b (matching por order#+zip). NULL = venta directa RAP. */
          dealer_id: p.dealer_id || null,
          attribution_source: p.attribution_source || null,
          referral_code: p.referral_code || null,
          terms_version: (tlk && tlk.terms_version) || p.terms_version || null,   // PORT-4b: lookup > estampado del checkout
          maya_summary: p.maya_summary || null      // PORT-4: resumen del chat → ficha del portal
        });

        // covered_pieces SOLO en el insert real, y SOLO de los planes de ESTE tier (1 fila por
        // la categoría/type de cada línea; las piezas concretas se asignan en checkout/claim).
        if (created && row) {
          const counts = {};
          for (const pl of plans) if (pl.tier === tier) counts[pl.type] = (counts[pl.type] || 0) + 1;
          await insertCoveredPieces(env, row.id, counts, p.purchase_date || null);
        }
      }
    }

    // 8) KITS (pago único) — en cualquier mode. Idempotente por orders.stripe_payment_intent_id
    //    UNIQUE. En subscription el primer pago va por invoice (session.payment_intent puede
    //    ser null) → usamos session.id como referencia estable única.
    if (kits.length) {
      const totalCents = kits.reduce((s, k) => s + (k.unit_price_cents || 0) * (k.quantity || 0), 0);
      const payRef = session.payment_intent || session.id;
      /* KIT-3: snapshot del ship-to en la ORDEN. La dirección vive en el payload del lead, y el
         despacho (portal → Kit Orders) necesita imprimirla sin escarbar en otra tabla. Snapshot a
         propósito: si el cliente edita su perfil luego, la etiqueta ya impresa no cambia. */
      const { created, row } = await insertOrder(env, {
        user_id: userId,
        email,
        status: 'paid',
        total_cents: totalCents,
        stripe_payment_intent_id: payRef,
        ship_to_name: p.full_name || null,
        ship_to_phone: p.phone || null,
        ship_to_address: p.address || null,
        ship_to_zip: p.zip || p.receipt_zip || null
      });
      if (created && row) {
        /* BE-5: sh_cents POR ITEM con el mismo helper del checkout (DRY). Por kit: $11 × unidades
           del item; por orden (KIT_SH_PER_ORDER=true): el total en el PRIMER item, resto null.
           El tax no se persiste: vive en la línea de Stripe y en la reserva contable interna.
           orders.total_cents sigue siendo retail puro (divergencia con el cargo de Stripe
           DOCUMENTADA: S&H va en sh_cents y el tax solo en Stripe). */
        const { shCents } = kitCharges(kits, env);
        const perOrder = String(env.KIT_SH_PER_ORDER || '').toLowerCase() === 'true';
        const shUnit = perOrder ? 0 : Math.round(shCents / Math.max(1, kits.reduce((s, k) => s + (k.quantity || 0), 0)));
        await insertOrderItems(env, row.id, kits.map((k, i) => ({
          kit_id: k.kit_id, quantity: k.quantity, unit_price_cents: k.unit_price_cents,
          sh_cents: shCents > 0 ? (perOrder ? (i === 0 ? shCents : null) : shUnit * (k.quantity || 0)) : null
        })));
      }

      /* COMM-3: comisión one-time del kit ($10/unidad, override por dealer). FUERA del guard
         `created` a propósito: un retry tras crear la orden pero antes del ledger no puede
         perder la comisión (la reentrega da 409 y se salta). Detrás del MISMO flag que el
         accrual de planes. Sin dealer atribuido → venta directa RAP, sin comisión. */
      if (env.COMMISSIONS_ENABLED === 'true' && p.dealer_id) {
        await recordKitCommission(env, { sessionId: session.id, orgId: p.dealer_id, kits });
      }
    }

    // 9) enlazar el lead (marca de "ya procesado")
    await linkLeadUser(env, leadId, userId);

    return json(200, { received: true });
  } catch (err) {
    // Recuperable → non-2xx → Stripe reintenta; los pasos previos son idempotentes.
    console.error('[webhook] processing error:', err.message);
    return json(500, { error: 'processing_failed' });
  }
}

/* ----------------------------------------------------------------------------
 * SERIALIZACIÓN (opción B) — mecanismo por-ciclo. APAGADO (ver 3a). Emite el certificado
 * de cobertura serializado de un ciclo a partir de una invoice pagada.
 * Idempotente: stripe_invoice_id + serial UNIQUE evitan duplicar en reentregas.
 * ⚠ PENDIENTE de Doug antes de encender:
 *   (a) formato exacto del serial/claim# — hoy `{master_no}-NN`.
 *   (b) regla del waiting-period de 30 días — hoy coverage_start = fecha de pago (placeholder),
 *       coverage_end = +30d. Si la cobertura arranca 30 días DESPUÉS del pago, sumar el offset.
 * -------------------------------------------------------------------------- */
async function handleInvoicePaid(env, invoice) {
  const stripeSubId = invoice.subscription;
  if (!stripeSubId) return;                              // invoice no ligada a una suscripción
  const plan = await getPlanBySubscription(env, stripeSubId);
  if (!plan || !plan.master_no) return;                 // sin plan serializado (p.ej. membership standalone)

  const seq = (await countCertificates(env, stripeSubId)) + 1;
  const serial = `${plan.master_no}-${String(seq).padStart(2, '0')}`;

  const paidEpoch = (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created;
  const start = paidEpoch ? new Date(paidEpoch * 1000) : new Date();
  const end = new Date(start.getTime() + 30 * 24 * 3600 * 1000);
  const isoDate = (d) => d.toISOString().slice(0, 10);

  await insertCoverageCertificate(env, {
    user_id: plan.user_id,
    stripe_subscription_id: stripeSubId,
    master_no: plan.master_no,
    sequence_no: seq,
    serial,
    coverage_start: isoDate(start),                     // ⚠ waiting-period 30d pendiente
    coverage_end: isoDate(end),
    stripe_invoice_id: invoice.id,
    status: 'active'
  });
}

/* ----------------------------------------------------------------------------
 * SUB-2 — ciclo de vida de la suscripción (customer.subscription.updated/deleted).
 * Exportadas para test directo (patrón sessionPayload de auth-login).
 * -------------------------------------------------------------------------- */

/* SUB-2: mapea el estado de la suscripción de Stripe al enum subscription_status.
 * null = estado desconocido → NO tocar status (solo se refresca current_period_end). */
export function mapStripeSubStatus(sub, eventType) {
  if (eventType === 'customer.subscription.deleted') return 'canceled';
  if (sub.pause_collection) return 'paused';                       // pausa de cobro (status sigue 'active' en Stripe)
  const s = sub.status;
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'paused') return 'paused';
  if (s === 'canceled' || s === 'incomplete_expired') return 'canceled';
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete') return 'past_due';
  return null;
}

/* SUB-2: aplica el evento a TODAS las filas con ese stripe_subscription_id (una compra =
 * varias filas: coberturas + membership). current_period_end viene en epoch segundos (a
 * nivel sub o, en API versions nuevas, a nivel item) → ISO. Si no hay NADA que tocar
 * (estado desconocido y sin period_end) devuelve 0 sin llamar a la BD. */
export async function handleSubscriptionLifecycle(env, sub, eventType) {
  const mapped = mapStripeSubStatus(sub, eventType);
  const items = (sub.items && sub.items.data) || [];
  const cpeEpoch = sub.current_period_end || (items[0] && items[0].current_period_end);
  const patch = {};
  if (mapped) patch.status = mapped;
  if (cpeEpoch) patch.current_period_end = new Date(cpeEpoch * 1000).toISOString();
  if (!Object.keys(patch).length) return 0;
  return updateSubscriptionsByStripeId(env, sub.id, patch);
}

/* ----------------------------------------------------------------------------
 * GIFT-1 — compra de un gift code (spec 08-jul §F4). Exportadas para test
 * directo (patrón sessionPayload). TODO fetch directo a api.stripe.com — el SDK
 * queda reservado para la firma del webhook + el retrieve ya existente.
 * -------------------------------------------------------------------------- */

/* Emite el gift: fila en gift_codes + coupon (create-if-missing) + promotion
 * code (1 uso, 90 días, cliente-nuevo) + email al comprador. IDEMPOTENTE para
 * los reintentos de Stripe, con este orden EXACTO:
 *   1) INSERT primero (stripe_payment_intent UNIQUE). 409 → fetch de la fila:
 *      con stripe_promo_id ya guardado → return (ack silencioso: todo se hizo);
 *      sin promo_id → retomar desde el coupon con el CODE de la fila existente.
 *   2) ensureCoupon por id FIJO couponId(tier,months): GET; 404 → POST con
 *      percent_off 100 × duration_in_months y applies_to[products][] = product
 *      del price del tier (GET /v1/prices/{env} → .product; cacheado POR
 *      REQUEST — el price puede re-apuntarse a otro product en Stripe).
 *   3) POST promotion code; error "already exists" (reintento previo murió tras
 *      crearlo) → GET /v1/promotion_codes?code= y reusar su id.
 *   4) PATCH de la fila con stripe_promo_id.
 *   5) email AL FINAL: si falla → throw → 500 → Stripe re-entra y los pasos
 *      previos no duplican nada (por eso el email cierra la secuencia).
 */
export async function handleGiftPurchase(env, session) {
  const meta = session.metadata || {};
  if (!Object.prototype.hasOwnProperty.call(GIFT_TIERS, meta.tier)) {
    // metadata corrupta: reintentar no la arregla → warn + ack (nunca 500-loop)
    console.warn('[webhook] gift con tier desconocido:', meta.tier);
    return;
  }
  const gift = GIFT_TIERS[meta.tier];
  const months = parseInt(meta.months, 10) || GIFT_MONTHS;
  const buyerEmail = meta.buyer_email || session.customer_email
    || (session.customer_details && session.customer_details.email) || null;
  /* En mode:payment el payment_intent SIEMPRE viene; session.id queda de red
   * defensiva (misma técnica que orders en el paso 8). */
  const payRef = session.payment_intent || session.id;
  const sAuth = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  const sForm = { ...sAuth, 'Content-Type': 'application/x-www-form-urlencoded' };

  // 1) INSERT primero — el UNIQUE de stripe_payment_intent es el candado de idempotencia.
  let code = generateGiftCode();
  const ins = await pgrest(env, '/gift_codes', {
    method: 'POST', prefer: 'return=representation',
    body: {
      code, buyer_email: buyerEmail, tier: meta.tier, months,
      price_cents: gift.cents * months, stripe_payment_intent: payRef
    }
  });
  if (ins.status === 409) {
    const got = await pgrest(env,
      `/gift_codes?stripe_payment_intent=eq.${encodeURIComponent(payRef)}&select=code,stripe_promo_id`);
    const row = (got.status < 300 && Array.isArray(got.data) && got.data[0]) || null;
    if (!row) throw new Error('gift 409 sin fila recuperable');
    if (row.stripe_promo_id) return;   // reentrega COMPLETA (promo + email ya salieron) → ack
    code = row.code;                   // reintento a medias → retomar con el code ya emitido
  } else if (ins.status >= 300) {
    throw new Error(`gift insert failed (${ins.status})`);
  }

  // 2) ensureCoupon — id fijo por tier×meses; el 404 es el camino "primera vez".
  const productCache = {};   // cache POR REQUEST (no global: el price puede re-apuntarse)
  const cid = couponId(meta.tier, months);
  const cGet = await fetch(`https://api.stripe.com/v1/coupons/${encodeURIComponent(cid)}`, { headers: sAuth });
  if (cGet.status === 404) {
    const priceId = env[gift.priceEnv];
    let productId = productCache[priceId];
    if (!productId) {
      const pRes = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, { headers: sAuth });
      const price = pRes.status < 300 ? await pRes.json().catch(() => null) : null;
      productId = price && (typeof price.product === 'string' ? price.product : (price.product && price.product.id));
      if (!productId) throw new Error(`gift price lookup failed (${pRes.status})`);
      productCache[priceId] = productId;
    }
    const cf = new URLSearchParams();
    cf.append('id', cid);
    cf.append('percent_off', '100');
    cf.append('duration', 'repeating');
    cf.append('duration_in_months', String(months));
    cf.append('applies_to[products][]', productId);   // el descuento SOLO aplica al producto regalado
    const cPost = await fetch('https://api.stripe.com/v1/coupons', { method: 'POST', headers: sForm, body: cf.toString() });
    if (cPost.status >= 300) {
      // carrera entre reintentos concurrentes: si ya existe, seguimos con él
      const again = await fetch(`https://api.stripe.com/v1/coupons/${encodeURIComponent(cid)}`, { headers: sAuth });
      if (again.status >= 300) throw new Error(`gift coupon create failed (${cPost.status})`);
    }
  } else if (cGet.status >= 300) {
    throw new Error(`gift coupon lookup failed (${cGet.status})`);
  }

  // 3) promotion code — aquí viven los límites de industria: 1 canje, 90 días, cliente-nuevo.
  const expiresAt = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;   // epoch segundos
  const pf = new URLSearchParams();
  pf.append('coupon', cid);
  pf.append('code', code);
  pf.append('max_redemptions', '1');
  pf.append('expires_at', String(expiresAt));
  pf.append('restrictions[first_time_transaction]', 'true');
  pf.append('metadata[gift]', '1');                 // ancla del marcado de canje (markGiftRedeemed)
  pf.append('metadata[tier]', meta.tier);
  pf.append('metadata[months]', String(months));
  if (buyerEmail) pf.append('metadata[buyer_email]', buyerEmail);
  const promoRes = await fetch('https://api.stripe.com/v1/promotion_codes', { method: 'POST', headers: sForm, body: pf.toString() });
  const pText = await promoRes.text().catch(() => '');
  let pData = null;
  try { pData = JSON.parse(pText); } catch { /* cuerpo no-JSON → cae al throw de abajo */ }
  let promo = (promoRes.status < 300 && pData && pData.id) ? pData : null;
  if (!promo) {
    // "already exists" = un reintento previo lo creó pero murió antes del PATCH → reusarlo
    const msg = (pData && pData.error && pData.error.message) || '';
    if (/already exists/i.test(msg)) {
      const q = await fetch(`https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code)}&limit=1`, { headers: sAuth });
      const list = q.status < 300 ? await q.json().catch(() => null) : null;
      promo = (list && Array.isArray(list.data) && list.data[0]) || null;
    }
    if (!promo) throw new Error(`gift promo create failed (${promoRes.status})`);
  }

  // 4) enlazar la fila con el promo (marca de "emitido" para la idempotencia del paso 1)
  const up = await pgrest(env, `/gift_codes?stripe_payment_intent=eq.${encodeURIComponent(payRef)}`, {
    method: 'PATCH', prefer: 'return=minimal', body: { stripe_promo_id: promo.id }
  });
  if (up.status >= 300) throw new Error(`gift promo patch failed (${up.status})`);

  // 5) email AL FINAL — su fallo lanza (→ retry de Stripe; los pasos previos no duplican).
  const siteUrl = (env.SITE_URL || '').replace(/\/+$/, '');
  const mail = giftEmail({ code, label: gift.label, months, expiresAtEpoch: expiresAt, siteUrl });
  const sent = await sendEmail(env, { to: buyerEmail, subject: mail.subject, html: mail.html, text: mail.text });
  if (!sent.ok) throw new Error(`gift email failed: ${sent.error}`);
}

/* Marca el canje de un gift: el promotion code usado en un checkout de
 * suscripción PUEDE ser un gift nuestro (metadata.gift === '1') o un promo
 * ajeno de marketing → no-op. FAIL-SOFT TOTAL: cualquier fallo se queda en un
 * warn — el marcado es telemetría/atribución, jamás puede romper el webhook
 * que crea la cuenta del cliente. */
export async function markGiftRedeemed(env, promotionCodeId, redeemerEmail) {
  try {
    const res = await fetch(`https://api.stripe.com/v1/promotion_codes/${encodeURIComponent(promotionCodeId)}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    const promo = res.status < 300 ? await res.json().catch(() => null) : null;
    if (!promo || !promo.metadata || promo.metadata.gift !== '1') return;   // promo ajeno → no-op
    const up = await pgrest(env, `/gift_codes?stripe_promo_id=eq.${encodeURIComponent(promotionCodeId)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'redeemed', redeemed_by_email: redeemerEmail || null, redeemed_at: new Date().toISOString() }
    });
    if (up.status >= 300) console.warn('[webhook] gift redeem patch status', up.status);
  } catch (err) {
    console.warn('[webhook] gift redeem fail-soft:', err.message);
  }
}
