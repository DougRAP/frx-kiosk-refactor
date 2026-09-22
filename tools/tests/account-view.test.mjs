/* MEM-vis (08-jul, spec-dash-block-08jul §A1) — buildAccountView con PostgREST mockeado.
 * El bug: la Repair Safety Net pagada era invisible (solo se formaban filas kind='protection')
 * y monthly_cents_total no la sumaba → el header mentía vs el cargo real de Stripe. */
import { makeT } from './helpers.mjs';
import { buildAccountView } from '../../netlify/functions/_lib/account.mjs';

const t = makeT('account-view');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

/* Fábrica de filas de subscriptions (la query las trae DESC por started_at). */
const prot = (over) => ({
  id: 1, kind: 'protection', tier: 'stain', status: 'active', monthly_cents: 999,
  coverage_cap_cents: null, started_at: '2026-07-01T00:00:00Z', current_period_end: '2026-08-01T00:00:00Z',
  master_no: 'RX-10001', sales_order_number: null, receipt_path: null, purchased_on: null,
  covered_pieces: [{ piece_type: 'sofa', purchased_at: null }], ...(over || {})
});
const mem = (over) => ({
  id: 2, kind: 'membership', tier: null, status: 'active', monthly_cents: 999,
  coverage_cap_cents: null, started_at: '2026-07-02T00:00:00Z', current_period_end: '2026-08-02T00:00:00Z',
  master_no: null, sales_order_number: null, receipt_path: null, purchased_on: null,
  covered_pieces: [], ...(over || {})
});

let SUBS = [];
let PROFILE = { id: 'u1', email: 'a@b.co', full_name: 'Test C', phone: null };
let LEADS = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  const reply = (data) => new Response(JSON.stringify(data), { status: 200 });
  if (u.includes('/rest/v1/profiles')) return reply([PROFILE]);
  if (u.includes('/rest/v1/subscriptions')) return reply(SUBS);
  if (u.includes('/rest/v1/leads')) return reply(LEADS);
  if (u.includes('/rest/v1/orders')) return reply([]);
  throw new Error('unexpected fetch ' + u);
};

/* ── membership activa de pago (standalone/50%) ── */
{
  SUBS = [mem(), prot()];   // DESC: mem (02-jul) primero, prot (01-jul) después
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.membership && d.membership.status === 'active' && d.membership.monthly_cents === 999,
    'membership: la fila kind=membership se EXPONE (ya no es invisible)');
  t(d.membership.current_period_end === '2026-08-02T00:00:00Z', 'membership: current_period_end viaja');
  t(d.summary.monthly_cents_total === 1998, 'summary: el total mensual SUMA la membership (999+999)');
  t(d.plans.length === 1 && d.plans[0].tier === 'stain', 'plans: la membership NO se cuela como plan');
  t(d.summary.plans_active === 1, 'summary: plans_active sigue contando solo protección');
  t(d.summary.member_since === '2026-07-01T00:00:00Z', 'summary: member_since = la sub más VIEJA (cualquier kind)');
}

/* ── membership bundled ($0, incluida con stain-mech) ── */
{
  SUBS = [mem({ monthly_cents: 0 }), prot({ tier: 'stain_mech', monthly_cents: 1999 })];
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.membership && d.membership.monthly_cents === 0, 'membership: bundled $0 se expone como included');
  t(d.summary.monthly_cents_total === 1999, 'summary: bundled no infla el total');
}

/* ── sin membership: MEM-7 → entitlement computado "included" con plan activo ── */
{
  SUBS = [prot()];
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.membership === null, 'membership: sin fila → null (sin cobro, sin fila sintética)');
  t(d.summary.monthly_cents_total === 999, 'summary: total = solo protección');
  t(d.repair_safety_net === 'included', 'MEM-7: plan activo sin membership → repair_safety_net=included (entitlement computado)');
}

/* ── MEM-7: los tres estados del entitlement ── */
{
  SUBS = [mem(), prot()];
  let d = await buildAccountView(process.env, 'a@b.co');
  t(d.repair_safety_net === 'membership', 'MEM-7: con membership real activa → membership (esa manda)');
  SUBS = [];
  d = await buildAccountView(process.env, 'a@b.co');
  t(d.repair_safety_net === null, 'MEM-7: sin nada activo → null (no se inventa el beneficio)');
}

/* ── membership cancelada (única): se muestra pero NO suma ── */
{
  SUBS = [mem({ status: 'canceled' }), prot()];
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.membership && d.membership.status === 'canceled', 'membership: cancelada se expone con su status');
  t(d.summary.monthly_cents_total === 999, 'summary: la cancelada NO suma al total');
}

/* ── membership más vieja que la protección → manda en member_since ── */
{
  SUBS = [prot(), mem({ started_at: '2026-05-01T00:00:00Z' })];   // DESC: prot primero
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.summary.member_since === '2026-05-01T00:00:00Z', 'summary: member_since considera también la membership');
}

/* ── item 6: dirección postal — profiles.address GANA; fallback al lead para cuentas viejas ── */
{
  SUBS = [prot()];
  PROFILE = { id: 'u1', email: 'a@b.co', full_name: 'Test C', phone: null, address: '9 Elm St, Logan UT' };
  LEADS = [{ payload: { address: '1 Old Rd (lead viejo)' } }];
  let d = await buildAccountView(process.env, 'a@b.co');
  t(d.profile.address === '9 Elm St, Logan UT', 'address: profiles.address (editable) gana sobre el lead');

  PROFILE = { id: 'u1', email: 'a@b.co', full_name: 'Test C', phone: null, address: null };
  d = await buildAccountView(process.env, 'a@b.co');
  t(d.profile.address === '1 Old Rd (lead viejo)', 'address: sin columna poblada → fallback al último lead (cuentas viejas)');

  LEADS = [];
  d = await buildAccountView(process.env, 'a@b.co');
  t(d.profile.address === null, 'address: sin dato en ningún lado → null');
}

/* ── DASH-1b fix (09-jul, bug de Adrian en el smoke): "compra compartida" SERVER-SIDE.
   El front comparaba contra la ÚNICA membership expuesta (la activa más reciente): con
   varias membership de compras distintas el vínculo real se perdía y el modal de aviso
   no salía (Cancel iba directo a Stripe). La vista ahora resume la COMPRA por plan. ── */
{
  /* plan + membership del MISMO checkout + una membership MÁS RECIENTE de otra compra
     (la que memPick expone) → el vínculo se detecta igual */
  SUBS = [
    mem({ id: 9, started_at: '2026-07-05T00:00:00Z', stripe_subscription_id: 'sub_other' }),
    mem({ id: 2, stripe_subscription_id: 'sub_A' }),
    prot({ stripe_subscription_id: 'sub_A' })
  ];
  const d = await buildAccountView(process.env, 'a@b.co');
  t(!!d.plans[0].purchase && d.plans[0].purchase.plans === 1 && d.plans[0].purchase.membership === true,
    'purchase: el plan sabe que SU compra incluye membership (aunque memPick sea OTRA)');
}
{
  /* 2 planes del mismo checkout, sin membership */
  SUBS = [
    prot({ id: 3, master_no: 'RX-10002', started_at: '2026-07-01T00:00:01Z', stripe_subscription_id: 'sub_B' }),
    prot({ stripe_subscription_id: 'sub_B' })
  ];
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.plans[0].purchase.plans === 2 && d.plans[0].purchase.membership === false,
    'purchase: cuenta los planes hermanos del mismo checkout');
}
{
  /* filas canceladas NO cuentan (cancelar ya no las afecta) */
  SUBS = [
    mem({ stripe_subscription_id: 'sub_C', status: 'canceled' }),
    prot({ stripe_subscription_id: 'sub_C' })
  ];
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.plans[0].purchase.plans === 1 && d.plans[0].purchase.membership === false,
    'purchase: filas canceladas fuera del conteo');
}
{
  /* fila vieja sin stripe_subscription_id → compra desconocida: reporte mínimo (sin falsos vínculos) */
  SUBS = [mem(), prot()];
  const d = await buildAccountView(process.env, 'a@b.co');
  t(d.plans[0].purchase.plans === 1 && d.plans[0].purchase.membership === false,
    'purchase: sin sub id no se inventan vínculos (undefined NO matchea undefined)');
}

t.done();
