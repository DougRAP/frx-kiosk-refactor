/* ============================================================================
 * _lib/validate.mjs — única fuente de verdad de validación + pricing del checkout.
 * La comparten create-lead, create-checkout-session (y, indirectamente, el webhook
 * que confía en el tier/precio ya validado del lead). NO duplicar estos valores.
 * ==========================================================================*/

'use strict';

import { TERMS_VERSION } from './terms.mjs';

/* Pricing canónico (centavos). El cliente espeja 9.99/19.99 SOLO para mostrar
 * (index.html → rate()); aquí está la fuente de verdad del servidor. */
export const PRICE_CENTS = { 'stain': 999, 'stain-mech': 1999 };

export const MAX_PIECES = 99;                                 // piezas ilimitadas (Doug 06-jul); cap defensivo anti-abuso, no límite de producto. El trigger trg_piece_limit se elimina en la migración 20260706200000.
export const MAX_PLANS = 99;                                  // Doug 18-jun: sin cap artificial (CART-1.2). Tope defensivo alto; antes 2. Stripe usa quantity=count.
/* Categorías canónicas: espejan TYPES de index.html. El front manda UNA categoría
 * (type) + count; el servidor sintetiza counts = { [type]: count }. */
export const PIECE_TYPES = ['furniture', 'outdoor', 'adjbed', 'mattress', 'rugs', 'lighting'];
/* SKUs canónicos de kits — espejan care_kits.sku (ya sembrados en la BD) y KIT_SKU del front.
 * El PRECIO del kit NO vive aquí: se recomputa desde care_kits.price_cents server-side. */
export const KIT_SKUS = ['CARE-WOOD-001', 'CARE-FABRIC-001', 'CARE-LEATHER-001'];
export const MAX_KIT_QTY = 20;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;          // espeja EMAIL_RE del cliente
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/* QA-7 (BUG-02 de Jakob): misma regex que Maya (chat.mjs) — muere la inconsistencia
   "el asistente valida más que el formulario". El ZIP sigue siendo opcional. */
const ZIP_OK_RE = /^\d{5}(-\d{4})?$/;
/* BE-1: el cliente sube la foto a /upload-receipt (que devuelve un PATH server-issued) y aquí
   solo llega ese path. Validamos su forma fail-closed (bucket/yyyy/mm/uuid.ext) → el cliente no
   puede inyectar una ruta arbitraria al lead. */
export const RECEIPT_PATH_RE = /^receipts\/\d{4}\/\d{2}\/[a-f0-9-]{36}\.(jpg|png|webp)$/;

/* trim + strip de caracteres de control (code < 32 o 127) + recorte.
 * Filtra por charCode para no incrustar bytes de control en el source. */
export function clean(v, max) {
  if (typeof v !== 'string') return null;
  let s = '';
  for (const ch of v.trim()) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) s += ch;
  }
  s = s.slice(0, max);
  return s.length ? s : null;
}

/* Email canónico único: lowercase + trim. Debe usarse en TODO el flujo
 * (lead, get-or-create user, profile) para evitar duplicados por casing. */
export function canonicalEmail(v) {
  const c = clean(v, 254);
  return c ? c.toLowerCase() : null;
}

/* Phone validation: permisivo (acepta dígitos + espacios + paréntesis + guiones
 * + signo +). El único criterio numérico es ≥7 dígitos tras strip — cubre el
 * piso mínimo (US 10 dígitos, internacional 7-15 según E.164) sin pretender ser
 * validador de E.164. Preserva el formato original para mostrarlo tal cual. */
export function cleanPhone(v) {
  const c = clean(v, 32);
  if (!c) return null;
  const digits = c.replace(/\D/g, '');
  return digits.length >= 7 ? c : null;
}

/* Valida el cuerpo del checkout MIXTO (fail-closed) y recalcula el pricing en
 * servidor. NUNCA confía en montos del cliente. Contrato nuevo (rework jun-2026):
 *   { email, full_name, phone, address, order?, zip?, date?,
 *     plans: [{ cov, term, type, count }],   // 0+ líneas de plan (suscripción)
 *     kits:  [{ sku, quantity }] }            // 0+ líneas de kit (pago único)
 * → { ok:false, error:'<code>' } | { ok:true, fields:{...} }
 * El precio de los kits NO se calcula aquí — se resuelve desde care_kits.price_cents
 * (getCareKitsBySku) en create-checkout-session/webhook. */
export function validateCheckout(body, { requireReceipt = true } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };

  const email = canonicalEmail(body.email);
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };

  /* --- Planes (suscripción). Solo monthly está wired; yearly se rechaza explícito. --- */
  const rawPlans = Array.isArray(body.plans) ? body.plans : [];
  const plans = [];
  for (const p of rawPlans) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'invalid_plan' };
    const cov = p.cov;
    if (cov !== 'stain' && cov !== 'stain-mech') return { ok: false, error: 'invalid_cov' };
    const term = p.term == null ? 'monthly' : p.term;
    if (term !== 'monthly') return { ok: false, error: 'term_not_supported' };
    const type = p.type;
    if (typeof type !== 'string' || !PIECE_TYPES.includes(type)) return { ok: false, error: 'invalid_piece_type' };
    const count = p.count;
    if (!Number.isInteger(count) || count < 1 || count > MAX_PLANS) return { ok: false, error: 'plan_count_out_of_range' };
    plans.push({
      cov, term, type, count,
      tier: cov === 'stain-mech' ? 'stain_mech' : 'stain',
      monthly_cents: PRICE_CENTS[cov]            // recomputado server-side
    });
  }

  /* --- Kits (pago único). El precio se resuelve luego desde care_kits. --- */
  const rawKits = Array.isArray(body.kits) ? body.kits : [];
  const kits = [];
  for (const k of rawKits) {
    if (!k || typeof k !== 'object') return { ok: false, error: 'invalid_kit' };
    const sku = typeof k.sku === 'string' ? k.sku : null;
    if (!sku || !KIT_SKUS.includes(sku)) return { ok: false, error: 'invalid_kit_sku' };
    const quantity = k.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_KIT_QTY) return { ok: false, error: 'kit_qty_out_of_range' };
    kits.push({ sku, quantity });
  }

  /* --- Membership (suscripción recurrente, producto aparte). El cliente solo manda un bool;
   * el precio se resuelve server-side (STRIPE_PRICE_MEMBERSHIP) y bundled (con plan) va gratis. --- */
  const membership = body.membership === true;

  const hasPlans = plans.length > 0;
  const hasKits = kits.length > 0;
  if (!hasPlans && !hasKits && !membership) return { ok: false, error: 'empty_cart' };

  /* Contact info (Doug 01-jun): name + phone + address son la base mínima para
   * soporte / file-a-claim / envío del kit. Required siempre (también en solo-kit);
   * address vive en lead.payload porque no hay columna en profiles. */
  const fullName = clean(body.full_name, 128);
  if (!fullName) return { ok: false, error: 'invalid_name' };
  /* QA-7 (BUG-06): SOLO dígitos y longitud 1 bloquean (typo con confianza). Jamás blocklist
     de caracteres ni exigir dos palabras: O'Brien, José, mononyms son clientes reales y en
     un kiosk atendido un falso rechazo cuesta una venta cerrada. */
  if (/\d/.test(fullName) || fullName.length < 2) return { ok: false, error: 'invalid_name' };

  const phone = cleanPhone(body.phone);
  if (!phone) return { ok: false, error: 'invalid_phone' };

  const address = clean(body.address, 256);
  if (!address) return { ok: false, error: 'invalid_address' };

  const order = clean(body.order, 64);
  const zip = clean(body.zip, 64);
  if (zip && !ZIP_OK_RE.test(zip)) return { ok: false, error: 'invalid_zip' };   // QA-7 (BUG-02)
  const date = clean(body.date, 10);
  if (date && !DATE_RE.test(date)) return { ok: false, error: 'invalid_date' };
  /* QA-6 (BUG-03 de Jakob; decisión Doug 27-jul: "Use 60 days"): ventana de elegibilidad
     PARAMETRIZADA. min = hoy - ELIGIBILITY_WINDOW_DAYS (no se asegura un mueble viejo);
     max = hoy + DELIVERY_HORIZON_DAYS (venta en mostrador con entrega programada a futuro).
     El campo es la delivery/coverage-start date (KIOSK-1); cambiar la ventana = 1 env var. */
  if (date) {
    const eligDays = parseInt(process.env.ELIGIBILITY_WINDOW_DAYS, 10) || 60;
    const horizonDays = parseInt(process.env.DELIVERY_HORIZON_DAYS, 10) || 90;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const diffDays = Math.round((new Date(date + 'T00:00:00Z') - today) / 86400000);
    if (diffDays < -eligDays || diffDays > horizonDays) return { ok: false, error: 'date_out_of_range' };
  }

  /* KIOSK-1 (semántica corregida 10-jul, hallazgo del smoke TECH): associate + order + fecha
   * (= delivery/coverage-start) son requisitos DE LOS PLANES en el kiosk (dealer match +
   * inicio de cobertura). Un carrito de solo-kit/membership en el kiosk OCULTA esos campos
   * → exigirlos era un 400 garantizado (bug latente: el kiosk no podía vender un kit suelto).
   * TECH (source:'tech'): Technician ID + work order se exigen SIEMPRE, con o sin planes —
   * Doug 10-jul: "make sure you enter this id so you get credit… you're gonna need both". */
  const associate = clean(body.associate, 64);
  const kiosk = body.kiosk === true;
  const kioskStrict = kiosk && hasPlans;
  if (kioskStrict && !associate) return { ok: false, error: 'invalid_associate' };
  if (kioskStrict && !order) return { ok: false, error: 'order_required' };  // ASC sales order # (Doug: el associate lo ingresa)
  if (kioskStrict && !date) return { ok: false, error: 'date_required' };
  const techSource = body.source === 'tech';
  if (techSource && !associate) return { ok: false, error: 'invalid_associate' };  // Technician ID
  if (techSource && !order) return { ok: false, error: 'order_required' };         // work order / referencia interna

  /* BE-1: foto del recibo. Llega ya subida (path server-issued de /upload-receipt). OBLIGATORIA
     cuando hay plan de protección (Doug 24-jun + legal "required to activate"); en solo-kit o
     solo-membership no aplica. */
  const receipt_path = clean(body.receipt_path, 80);
  if (receipt_path && !RECEIPT_PATH_RE.test(receipt_path)) return { ok: false, error: 'invalid_receipt_path' };
  if (hasPlans && requireReceipt && !receipt_path) return { ok: false, error: 'receipt_required' };

  /* PORT-4: terms_version se estampa SERVER-SIDE (nunca del cliente); maya_summary es opcional
   * (resumen del chat, cap defensivo). El webhook los copia a la subscription; el portal los muestra. */
  const maya_summary = clean(body.maya_summary, 2000);

  return {
    ok: true,
    fields: {
      email,
      plans,                                     // [{cov,term,type,count,tier,monthly_cents}]
      kits,                                      // [{sku,quantity}] (precio se resuelve en care_kits)
      membership,                                // bool; standalone cobra, bundled (con plan) gratis
      hasPlans,
      kitsOnly: !hasPlans && hasKits,
      full_name: fullName,
      phone,
      address,
      order,
      zip,
      date: date || null,
      associate,                                 // KIOSK-1: nº de sales associate (null fuera de kiosk)
      receipt_path,                              // BE-1: ruta del recibo en Storage (null si solo-kit/membership)
      terms_version: TERMS_VERSION,              // PORT-4: versión de T&C aceptada (server-stamped)
      maya_summary                               // PORT-4: resumen del chat de Maya (opcional)
    }
  };
}
