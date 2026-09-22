/* ============================================================================
 * _lib/commissions.mjs — PORT-8/8a + REIN-1 + COMM-3: comisión fija por SKU.
 * Canon 15-jul (Doug): stain $2 / stain_mech $8 por pago mensual recibido, con
 * override por dealer (Dev-controlled) y SPLIT stripe/reinsurance. La porción
 * reinsurance SOLO se registra ("it's just a reporting function"); el transfer
 * real es la porción cash y va a la Connect (Express) del dealer.
 * COMM-3 (reunión 14-ago): kit $10 one-time ("$49… give them 20%… ten bucks",
 * seed 1000/0, sin reinsurance: inferencia documentada, reversible por UPDATE)
 * y membership DE PAGO $6/pago ("say six and go up to eight", seed 600/0, techo
 * negociable por override; hereda el split, decisión N4 de Adrian).
 *
 * Los helpers de arriba son PUROS (testeables sin BD, ver circuit.test.mjs);
 * recordCommissions (invoice.paid) y recordKitCommission (checkout.session
 * .completed: los kits no tienen invoice propia) tocan BD y corren detrás de
 * COMMISSIONS_ENABLED (default OFF → cero regresión).
 * ==========================================================================*/

'use strict';

import { pgrest } from './supabase.mjs';

/* Defaults duros (fail-safe si la tabla no responde): canon 15-jul + COMM-3 14-ago. */
const HARD_DEFAULT = {
  stain: { stripe_amount_cents: 200, reinsurance_amount_cents: 0 },
  stain_mech: { stripe_amount_cents: 800, reinsurance_amount_cents: 0 },
  kit: { stripe_amount_cents: 1000, reinsurance_amount_cents: 0 },
  membership: { stripe_amount_cents: 600, reinsurance_amount_cents: 0 }
};

/* price id de Stripe → SKU. La llave universal (PORT-15). COMM-3: SOLO la membership DE PAGO
 * (price full) comisiona — la incluida es un entitlement sin pagos, y los prices legacy
 * FREE ($0) y HALF ($9.99) NO comisionan (decisión anotada como inferencia: el modelo del
 * 14-ago comisiona "la pagada", y pagar $6 sobre un item de $0 sería absurdo; la HALF legacy
 * queda fuera a propósito hasta que Doug diga otra cosa). */
export function skuForPriceId(env, priceId) {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_STAIN) return 'stain';
  if (priceId === env.STRIPE_PRICE_STAIN_MECH) return 'stain_mech';
  if (priceId === env.STRIPE_PRICE_MEMBERSHIP) return 'membership';
  return null;
}

/* Tasa efectiva para (org, sku): override del dealer > global (org_id null) > default duro. */
export function pickRate(rates, orgId, sku) {
  const list = Array.isArray(rates) ? rates : [];
  const own = orgId ? list.find((r) => r.org_id === orgId && r.plan_sku === sku) : null;
  const glob = list.find((r) => r.org_id == null && r.plan_sku === sku);
  const r = own || glob || HARD_DEFAULT[sku];
  return {
    stripe_amount_cents: (r && r.stripe_amount_cents) | 0,
    reinsurance_amount_cents: (r && r.reinsurance_amount_cents) | 0
  };
}

/* Filas del ledger para una invoice pagada. PURO. Sin org atribuido → [] (venta directa RAP,
 * sin comisión). Un line item sin SKU conocido no comisiona: eso incluye los kits (van por
 * recordKitCommission con session.id, no por invoice) y los prices legacy FREE/HALF de la
 * membership; la membership DE PAGO sí entra aquí vía skuForPriceId (COMM-3). */
export function commissionRowsForInvoice(env, invoice, orgId, rates) {
  if (!orgId || !invoice) return [];
  const lines = (invoice.lines && invoice.lines.data) || [];
  const paidEpoch = (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created;
  const paidAt = new Date((paidEpoch || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const bySku = {};
  for (const ln of lines) {
    const sku = skuForPriceId(env, ln.price && ln.price.id);
    if (!sku) continue;
    bySku[sku] = (bySku[sku] || 0) + (ln.quantity || 1);
  }
  return Object.entries(bySku).map(([sku, qty]) => {
    const rate = pickRate(rates, orgId, sku);
    return {
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: invoice.subscription || null,
      org_id: orgId,
      plan_sku: sku,
      qty,
      stripe_amount_cents: rate.stripe_amount_cents * qty,
      reinsurance_amount_cents: rate.reinsurance_amount_cents * qty,
      status: 'recorded',
      paid_at: paidAt
    };
  });
}

/* Accrual completo de una invoice pagada (lo llama el webhook):
 *   1) dealer atribuido = subscriptions.dealer_id (A/B del checkout); sin dealer → no-op.
 *   2) tasas: override del org + globales.
 *   3) INSERT por fila (idempotente: UNIQUE (invoice, sku) → 409 = reentrega, skip).
 *   4) transfer Connect SOLO si STRIPE_CONNECT_TRANSFERS==='1' y el dealer tiene
 *      stripe_account_id — fail-soft: un transfer fallido deja la fila 'recorded'
 *      (reconciliación manual/retry), jamás tumba el webhook. */
export async function recordCommissions(env, invoice) {
  const stripeSubId = invoice && invoice.subscription;
  if (!stripeSubId) return { recorded: 0 };

  const subQ = await pgrest(env, `/subscriptions?stripe_subscription_id=eq.${encodeURIComponent(stripeSubId)}`
    + '&dealer_id=not.is.null&select=dealer_id&limit=1');
  const orgId = (subQ.status < 300 && Array.isArray(subQ.data) && subQ.data[0]) ? subQ.data[0].dealer_id : null;
  if (!orgId) return { recorded: 0 };                       // venta directa RAP → sin comisión

  const ratesQ = await pgrest(env, `/commission_rates?or=(org_id.eq.${encodeURIComponent(orgId)},org_id.is.null)`
    + '&select=org_id,plan_sku,stripe_amount_cents,reinsurance_amount_cents');
  const rates = (ratesQ.status < 300 && Array.isArray(ratesQ.data)) ? ratesQ.data : [];

  const rows = commissionRowsForInvoice(env, invoice, orgId, rates);
  let recorded = 0;
  for (const row of rows) {
    const ins = await pgrest(env, '/commission_ledger', { method: 'POST', prefer: 'return=minimal', body: row });
    if (ins.status === 201) recorded++;
    else if (ins.status !== 409) throw new Error(`commission insert failed (${ins.status})`);   // → retry Stripe
  }

  if (env.STRIPE_CONNECT_TRANSFERS === '1') {
    try { await transferCommissions(env, invoice.id, orgId); }
    catch (err) { console.warn('[commissions] transfer fail-soft:', err.message); }
  }
  return { recorded };
}

/* COMM-3 — comisión ONE-TIME del kit ($10/unidad por defecto), registrada en
 * checkout.session.completed: una compra de kits no tiene invoice propia (en mode:payment no
 * existe; en mode:subscription los kits viajan como price_data inline que skuForPriceId ignora),
 * así que la referencia de idempotencia es session.id contra el UNIQUE (stripe_invoice_id,
 * plan_sku) del ledger — un retry de Stripe da 409 y se salta, patrón de recordCommissions.
 * Corre FUERA del guard `created` de la orden (un retry tras crear la orden pero antes del
 * ledger no puede perder la comisión). Las filas kit quedan 'recorded': el transfer Connect
 * de una comisión sin invoice se liquida por barrido aparte (futuro PORT-8c), documentado.
 * qty = unidades del lead (p.kits), no de la orden. Sin dealer → no-op (venta directa RAP). */
export async function recordKitCommission(env, { sessionId, orgId, kits }) {
  if (!orgId || !sessionId) return { recorded: 0 };
  const qty = (kits || []).reduce((s, k) => s + (k.quantity || 0), 0);
  if (!qty) return { recorded: 0 };

  const ratesQ = await pgrest(env, `/commission_rates?or=(org_id.eq.${encodeURIComponent(orgId)},org_id.is.null)`
    + '&select=org_id,plan_sku,stripe_amount_cents,reinsurance_amount_cents');
  const rates = (ratesQ.status < 300 && Array.isArray(ratesQ.data)) ? ratesQ.data : [];
  const rate = pickRate(rates, orgId, 'kit');

  const ins = await pgrest(env, '/commission_ledger', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      stripe_invoice_id: sessionId,           // cs_… nunca colisiona con in_… (mismo UNIQUE)
      stripe_subscription_id: null,           // one-time: sin subscription (migración 20260815)
      org_id: orgId, plan_sku: 'kit', qty,
      stripe_amount_cents: rate.stripe_amount_cents * qty,
      reinsurance_amount_cents: rate.reinsurance_amount_cents * qty,
      status: 'recorded', paid_at: new Date().toISOString()
    }
  });
  if (ins.status === 201) return { recorded: 1 };
  if (ins.status === 409) return { recorded: 0 };           // reentrega → ya registrada
  throw new Error(`kit commission insert failed (${ins.status})`);   // → retry Stripe (todo aguas arriba es idempotente)
}

/* Un reclamo 'transferring' más viejo que esto se considera HUÉRFANO (el proceso murió entre el
 * reclamo y el transfer) y vuelve a ser elegible. Constante y no env var a propósito: nadie va a
 * querer ajustar esto desde fuera, y una env var de más es una palanca de más que mantener. */
const CLAIM_TTL_MS = 15 * 60 * 1000;

/* Transfers de la porción cash de las filas pendientes de esta invoice.
 *
 * DOS DEFENSAS QUE SE REPARTEN EL TRABAJO:
 *
 * 1) RECLAMO ATÓMICO (SEC-2b, hallazgo 6 de la auditoría 28-jul, CWE-362) — cubre la CONCURRENCIA.
 *    Hasta hoy el de-dup era solo la búsqueda del punto 2, y entre buscar y crear no había nada:
 *    dos entregas concurrentes de invoice.paid (Stripe reintenta cuando una ejecución tarda) leían
 *    la misma lista vacía y ambas creaban su transfer → la misma comisión pagada DOS VECES. Ahora
 *    cada fila se reclama con un UPDATE condicional (`&status=eq.recorded` + return=representation),
 *    que Postgres evalúa bajo lock de fila: solo UNA ejecución recibe la fila de vuelta, la otra
 *    recibe [] y se salta. El guard del PATCH final ya existía, pero corre DESPUÉS del POST:
 *    protegía el registro, no el dinero.
 *
 * 2) BÚSQUEDA por transfer_group (ya existía) — cubre el CRASH entre el POST y el PATCH.
 *    Cada transfer sale con transfer_group=invoice + metadata.commission_ledger_id=row.id, y antes
 *    de crear uno nuevo se busca si ya existe: el siguiente intento lo ADOPTA en vez de duplicarlo.
 *    Es lo que hace segura la recuperación de un reclamo huérfano.
 *
 * La Idempotency-Key sigue siendo POR INTENTO y NO se toca: aprendido en la corrida test del
 * 15-jul, una key FIJA hace que Stripe REPITA el error original 24h (un balance_insufficient
 * inicial dejaba la fila irrecuperable aunque ya hubiera fondos).
 * Spec: misc/spec-sec2b-commission-race.md. */
async function transferCommissions(env, invoiceId, orgId) {
  const dq = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(orgId)}&select=stripe_account_id&limit=1`);
  const acct = (dq.status < 300 && Array.isArray(dq.data) && dq.data[0]) ? dq.data[0].stripe_account_id : null;
  if (!acct) return;                                        // dealer aún sin Connect → queda 'recorded'

  /* Pendientes = las 'recorded' + los reclamos HUÉRFANOS (transferring con el sello vencido).
   * Sin esta segunda mitad, el reclamo introduciría un problema nuevo: una fila reclamada por un
   * proceso que muere quedaría bloqueada para siempre. */
  const stale = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
  const lq = await pgrest(env, `/commission_ledger?stripe_invoice_id=eq.${encodeURIComponent(invoiceId)}`
    + `&or=(status.eq.recorded,and(status.eq.transferring,transfer_claimed_at.lt.${encodeURIComponent(stale)}))`
    + '&select=id,plan_sku,stripe_amount_cents,status');
  const rows = (lq.status < 300 && Array.isArray(lq.data)) ? lq.data : [];
  if (!rows.length) return;

  const sAuth = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };

  /* ¿Ya existe un transfer de alguna de estas filas? (reintento tras crash/fallo previo) */
  let existing = [];
  try {
    const q = await fetch(`https://api.stripe.com/v1/transfers?transfer_group=${encodeURIComponent(invoiceId)}&limit=100`, { headers: sAuth });
    const list = q.status < 300 ? await q.json().catch(() => null) : null;
    existing = (list && Array.isArray(list.data)) ? list.data : [];
  } catch (err) { console.warn('[commissions] transfer lookup fail-soft:', err.message); }

  for (const row of rows) {
    if (!(row.stripe_amount_cents > 0)) continue;

    const prev = existing.find((tr) => tr.metadata && tr.metadata.commission_ledger_id === row.id);
    if (prev) {                                             // ya se transfirió en un intento anterior → adoptar
      /* El guard es "aún no transferida" y no `=eq.recorded`: una fila que se recupera de un reclamo
       * huérfano llega aquí en 'transferring', y es justo el caso que hay que adoptar sin volver a pagar. */
      await pgrest(env, `/commission_ledger?id=eq.${encodeURIComponent(row.id)}&status=neq.transferred`, {
        method: 'PATCH', prefer: 'return=minimal', body: { transfer_id: prev.id, status: 'transferred' }
      });
      continue;
    }

    /* RECLAMO. El WHERE viaja en la query, así que Postgres lo evalúa bajo lock de fila: de N
     * ejecuciones concurrentes, exactamente una recibe la fila de vuelta. Para una fila huérfana el
     * guard es su propio estado + que el sello siga vencido, así que dos recuperaciones simultáneas
     * tampoco se pisan. */
    const guard = row.status === 'transferring'
      ? `&status=eq.transferring&transfer_claimed_at=lt.${encodeURIComponent(stale)}`
      : '&status=eq.recorded';
    const claim = await pgrest(env, `/commission_ledger?id=eq.${encodeURIComponent(row.id)}${guard}`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { status: 'transferring', transfer_claimed_at: new Date().toISOString() }
    });
    if (claim.status === 400) {
      /* Casi seguro el CHECK viejo: falta aplicar 20260728120000_commission_claim.sql. Se avisa
       * explícito para no perder una tarde diagnosticándolo. No se transfiere nada: lado seguro. */
      console.warn('[commissions] claim rechazado (400) — ¿falta la migración 20260728120000_commission_claim?');
      continue;
    }
    if (!(claim.status < 300 && Array.isArray(claim.data) && claim.data[0])) continue;   // la tiene otra ejecución

    const form = new URLSearchParams();
    form.append('amount', String(row.stripe_amount_cents));
    form.append('currency', 'usd');
    form.append('destination', acct);
    form.append('transfer_group', invoiceId);
    form.append('metadata[commission_ledger_id]', row.id);
    const res = await fetch('https://api.stripe.com/v1/transfers', {
      method: 'POST',
      headers: {
        ...sAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `commission_${row.id}_${Date.now()}`   // por-intento: los reintentos NO replayean errores viejos
      },
      body: form.toString()
    });
    const tr = res.status < 300 ? await res.json().catch(() => null) : null;
    if (!tr || !tr.id) {
      /* LIBERAR el reclamo: sin esto la fila quedaría bloqueada 15 minutos tras un fallo que ya
       * conocemos (balance_insufficient). Devolverla a 'recorded' preserva el fail-soft de siempre:
       * el siguiente intento la retoma y el webhook nunca se cae por esto. */
      console.warn('[commissions] transfer status', res.status, 'row', row.id);
      await pgrest(env, `/commission_ledger?id=eq.${encodeURIComponent(row.id)}&status=eq.transferring`, {
        method: 'PATCH', prefer: 'return=minimal', body: { status: 'recorded', transfer_claimed_at: null }
      });
      continue;
    }
    await pgrest(env, `/commission_ledger?id=eq.${encodeURIComponent(row.id)}&status=eq.transferring`, {
      method: 'PATCH', prefer: 'return=minimal', body: { transfer_id: tr.id, status: 'transferred' }
    });
  }
}
