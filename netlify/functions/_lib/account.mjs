/* ============================================================================
 * _lib/account.mjs — builder COMPARTIDO de la vista de cuenta del customer.
 * ----------------------------------------------------------------------------
 * Extraído VERBATIM de account-view.mjs (AUTH-1) para que las DOS puertas
 * pinten la misma forma con el mismo render() de account.html:
 *   - account-view.mjs  → autoriza por token HMAC (?t=, legacy/demo)
 *   - account-me.mjs    → autoriza por Bearer de GoTrue (login real)
 * 🔒 service_role BYPASSA RLS: cada query filtra por email/user_id. El caller
 * es responsable de AUTORIZAR antes de llamar; aquí solo se lee y se forma.
 * ==========================================================================*/

'use strict';

import { pgrest, signStorageUrl } from './supabase.mjs';

const PER_PLAN_COVERAGE_CENTS = 500000;   // $5,000 por plan (espeja coverage-policy.perPlanLimitCents)
const enc = encodeURIComponent;

export async function buildAccountView(env, email) {
  // 1) Perfil (ancla por email; profiles.email UNIQUE, profiles.id = user_id)
  //    address: columna nueva (migración 20260708120000, editable vía update-profile)
  const pr = await pgrest(env, `/profiles?email=eq.${enc(email)}&select=id,email,full_name,phone,address&limit=1`);
  const profile = (pr.status < 300 && Array.isArray(pr.data) && pr.data[0]) ? pr.data[0] : null;
  const uid = profile ? profile.id : null;

  // 2) Suscripciones (protección) + piezas cubiertas (embed declarativo)
  let subs = [];
  if (uid) {
    const sel = 'id,kind,tier,status,monthly_cents,coverage_cap_cents,started_at,current_period_end,'
      + 'stripe_subscription_id,'   // DASH-1b: el front lo manda de vuelta para el flow de cancelación del portal
      + 'master_no,sales_order_number,receipt_path,purchased_on,covered_pieces(piece_type,purchased_at)';
    const sr = await pgrest(env, `/subscriptions?user_id=eq.${enc(uid)}&select=${enc(sel)}&order=started_at.desc`);
    if (sr.status < 300 && Array.isArray(sr.data)) subs = sr.data;
  }

  // 2b) Firmar URL temporal de cada recibo (bucket PRIVADO). Fail-soft: sin firma → badge estático.
  const receiptPaths = [...new Set(subs.map((s) => s.receipt_path).filter(Boolean))];
  const receiptUrlByPath = {};
  await Promise.all(receiptPaths.map(async (rp) => {
    const i = rp.indexOf('/');                    // receipt_path = "bucket/objectPath"
    if (i < 0) return;
    const signed = await signStorageUrl(env, rp.slice(0, i), rp.slice(i + 1), 3600);
    if (signed) receiptUrlByPath[rp] = signed;
  }));

  // 3) Coverage summary por order# (1 lead más reciente por orden) — SOLO el resumen, sin transcript
  const orderNos = [...new Set(subs.map((s) => s.sales_order_number).filter(Boolean))];
  const covByOrder = {};
  await Promise.all(orderNos.map(async (ord) => {
    const lr = await pgrest(
      env,
      `/leads?select=payload&payload->>intent=eq.coverage&payload->>sales_order_number=eq.${enc(ord)}&order=created_at.desc&limit=1`
    );
    if (lr.status < 300 && Array.isArray(lr.data) && lr.data[0]) {
      const p = lr.data[0].payload || {};
      covByOrder[ord] = {
        summary: p.summary ?? null,                       // narrativa legible (B)
        sales_order_total: p.sales_order_total ?? null,
        item_count: p.item_count ?? null,
        recommended_plans: p.recommended_plans ?? null,
        covered_up_to: p.covered_up_to ?? null
      };
    }
  }));

  // 4) Dirección postal: profiles.address (editable, item 6) GANA; fallback al lead más
  //    reciente para cuentas anteriores a la migración 20260708120000.
  let address = (profile && profile.address) || null;
  if (!address) {
    const adr = await pgrest(env, `/leads?email=eq.${enc(email)}&select=payload&order=created_at.desc&limit=1`);
    if (adr.status < 300 && Array.isArray(adr.data) && adr.data[0]) address = (adr.data[0].payload || {}).address || null;
  }

  // 5) Care kits (orders por user_id o email) + sus líneas + nombres de kit
  const orFilter = uid ? `or=(user_id.eq.${enc(uid)},email.eq.${enc(email)})` : `email=eq.${enc(email)}`;
  const ordr = await pgrest(env, `/orders?${orFilter}&select=id,status,total_cents,created_at&order=created_at.desc`);
  let kits = [];
  if (ordr.status < 300 && Array.isArray(ordr.data) && ordr.data.length) {
    const orders = ordr.data;
    const ids = orders.map((o) => o.id);
    const itr = await pgrest(env, `/order_items?order_id=in.(${ids.map(enc).join(',')})&select=order_id,quantity,unit_price_cents,kit_id`);
    const items = (itr.status < 300 && Array.isArray(itr.data)) ? itr.data : [];
    const kitIds = [...new Set(items.map((it) => it.kit_id).filter(Boolean))];
    const nameByKit = {};
    if (kitIds.length) {
      const ck = await pgrest(env, `/care_kits?id=in.(${kitIds.map(enc).join(',')})&select=id,name,sku`);
      if (ck.status < 300 && Array.isArray(ck.data)) for (const k of ck.data) nameByKit[k.id] = { name: k.name, sku: k.sku };
    }
    kits = orders.map((o) => ({
      status: o.status, total_cents: o.total_cents, created_at: o.created_at,
      items: items.filter((it) => it.order_id === o.id).map((it) => ({
        name: (nameByKit[it.kit_id] || {}).name || 'Care kit',
        sku: (nameByKit[it.kit_id] || {}).sku || null,
        quantity: it.quantity, unit_price_cents: it.unit_price_cents
      }))
    }));
  }

  // 6) Forma los planes + el summary de cabecera
  // DASH-1b fix (09-jul): resumen de la COMPRA por plan, calculado AQUÍ donde están TODAS las
  // filas. El front comparaba contra la única membership expuesta (la activa más reciente) y
  // perdía el vínculo cuando había varias de compras distintas → el aviso de "cancela la compra
  // completa" no salía. Sin sub id (filas viejas) NO se inventan vínculos.
  const purchaseOf = (subId) => {
    if (!subId) return { plans: 1, membership: false };
    const shared = subs.filter((x) => x.stripe_subscription_id === subId && x.status !== 'canceled');
    return {
      plans: Math.max(1, shared.filter((x) => x.kind === 'protection').length),
      membership: shared.some((x) => x.kind === 'membership')
    };
  };
  const plans = subs
    .filter((s) => s.kind === 'protection')
    .map((s) => ({
      tier: s.tier, status: s.status, monthly_cents: s.monthly_cents,
      stripe_subscription_id: s.stripe_subscription_id || null,   // DASH-1b (id opaco; el server re-verifica propiedad)
      purchase: purchaseOf(s.stripe_subscription_id),             // DASH-1b fix: qué agrupa SU checkout
      master_no: s.master_no || null,
      sales_order_number: s.sales_order_number, started_at: s.started_at,
      coverage_cap_cents: s.coverage_cap_cents,
      receipt: !!s.receipt_path,
      receipt_url: s.receipt_path ? (receiptUrlByPath[s.receipt_path] || null) : null,
      pieces: Array.isArray(s.covered_pieces) ? s.covered_pieces.map((p) => p.piece_type) : [],
      coverage: s.sales_order_number ? (covByOrder[s.sales_order_number] || null) : null
    }));

  /* 6b) Membership (Repair Safety Net) — antes se filtraba junto con todo lo no-protection y
     quien la pagaba NO la veía (y el total mensual del header mentía vs el cargo de Stripe).
     Se expone la más reciente ACTIVA (fallback: la más reciente) y TODAS las activas suman
     al total (si existe el doble cobro cross-purchase, el total refleja la verdad de Stripe
     hasta que Doug decida SUB-2b). */
  const memberships = subs.filter((s) => s.kind === 'membership');
  const memPick = memberships.find((m) => m.status === 'active') || memberships[0] || null;   // subs vienen DESC
  const membership = memPick ? {
    status: memPick.status,
    monthly_cents: memPick.monthly_cents,
    started_at: memPick.started_at,
    current_period_end: memPick.current_period_end || null,
    stripe_subscription_id: memPick.stripe_subscription_id || null   // DASH-1b: para el aviso "cancela la compra completa"
  } : null;
  const membershipCentsActive = memberships
    .filter((m) => m.status === 'active')
    .reduce((sum, m) => sum + (m.monthly_cents || 0), 0);

  const activePlans = plans.filter((p) => p.status === 'active');
  const summary = {
    plans_active: activePlans.length,
    plans_total: plans.length,
    monthly_cents_total: activePlans.reduce((sum, p) => sum + (p.monthly_cents || 0), 0) + membershipCentsActive,
    coverage_cents_total: activePlans.length * PER_PLAN_COVERAGE_CENTS,
    member_since: subs.length ? subs[subs.length - 1].started_at : null   // subs vienen DESC → el último es el más viejo (cualquier kind)
  };

  /* MEM-7 (14-ago, "we're going to activate a repair membership for every subscription… at no
     additional charge"): entitlement COMPUTADO, sin filas nuevas ni items $0. Con al menos un
     plan de protección activo, la Repair Safety Net está activa para el ítem comprado; si además
     hay una membership REAL (pagada o legacy bundled), esa manda. Solo sale a relucir en el
     dashboard y en la conversación de claim ("good news, you automatically get the repair
     membership with your subscription"). */
  const repair_safety_net = membership && memPick.status === 'active' ? 'membership'
    : (activePlans.length ? 'included' : null);

  return {
    ok: true,
    email,
    profile: profile ? { full_name: profile.full_name || null, email: profile.email, phone: profile.phone || null, address } : { email, address },
    summary, plans, membership, kits, repair_safety_net
  };
}
