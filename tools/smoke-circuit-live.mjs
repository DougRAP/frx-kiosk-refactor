/* ============================================================================
 * SMOKE LIVE del circuito Fase 3 — se corre ON-DEMAND (una vez por deploy),
 * NUNCA en la suite. Contra BD REAL (PostgREST service_role del .env) y las
 * Functions REALES del BASE indicado. Reemplaza la pasada manual de la guía
 * misc/test-guide-portal-fase3.html (bloques con Stripe/BD reales).
 *
 * Uso:
 *   node tools/smoke-circuit-live.mjs                       # local (netlify dev, :8888)
 *   node tools/smoke-circuit-live.mjs --base https://furniturerx.netlify.app
 *
 * REGLAS: siembra sus datos QA con prefijo reconocible (slug qa-smoke-dealer, nombre 'Lakeside Home Furnishings' /
 * QAS-MOKE1 / qa-smoke*@rapqa.com / *_qasmoke_*) de forma IDEMPOTENTE y NO
 * BORRA NADA — al final reporta lo que dejó creado. No dispara emails (solo
 * crea leads; el webhook real no se invoca) ni cobra nada (Checkout Sessions
 * de test quedan sin pagar y vencen solas en 24h).
 * ==========================================================================*/

'use strict';

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/* ---- args + env ---- */
const args = process.argv.slice(2);
const BASE = (args[args.indexOf('--base') + 1] && args.includes('--base'))
  ? args[args.indexOf('--base') + 1].replace(/\/+$/, '')
  : 'http://localhost:8888';

const env = {};
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('FALTA .env (SUPABASE_URL / SERVICE_ROLE_KEY)'); process.exit(2); }

const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
async function db(path, opts = {}) {
  const res = await fetch(env.SUPABASE_URL + '/rest/v1' + path, {
    method: opts.method || 'GET',
    headers: { ...H, ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let data = null; const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
        ...(opts.origin ? { Origin: opts.origin } : {})   // QA-4: simular el front que llama
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    /* El checkout tiene rate-limit 5/min por IP (BE-2) y el smoke hace varios: ante un 429
     * esperamos el Retry-After y reintentamos UNA vez (corridas back-to-back no deben dar rojo). */
    if (res.status === 429 && attempt === 0) {
      const ra = Math.min(parseInt(res.headers.get('Retry-After'), 10) || 60, 70);
      console.log(`  ····  429 en ${path} — esperando ${ra}s (rate-limit) y reintentando`);
      await sleep(ra * 1000);
      continue;
    }
    let data = null; const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  }
}

let fails = 0, count = 0;
const created = [];
const t = (cond, msg) => { count++; if (cond) console.log(`  PASS  ${msg}`); else { console.error(`  FAIL  ${msg}`); fails++; } };
const skip = (msg) => console.log(`  SKIP  ${msg}`);
const ts = Date.now();

console.log(`SMOKE LIVE · BASE=${BASE} · BD=${env.SUPABASE_URL}\n`);

/* ── 1 · Preflight: migraciones y seeds ─────────────────────────────────── */
{
  const r = await db('/commission_rates?org_id=is.null&select=plan_sku,stripe_amount_cents,reinsurance_amount_cents&order=plan_sku');
  t(r.status === 200 && r.data.length === 2 && r.data[0].stripe_amount_cents === 200 && r.data[1].stripe_amount_cents === 800,
    'preflight: commission_rates globales $2/$8 sembradas');
  const pt = await db('/plan_terms?org_id=is.null&select=plan_sku,terms_version');
  t(pt.status === 200 && pt.data.length === 2 && pt.data.every((x) => x.terms_version === 'v2026-05'),
    'preflight: plan_terms genéricas v2026-05');
}

/* ── 2 · Datos QA idempotentes: dealer + referral code ──────────────────── */
let qaOrg = null;
{
  const q = await db('/dealers?slug=eq.qa-smoke-dealer&select=id,name,selling_enabled&limit=1');
  qaOrg = (q.data && q.data[0]) || null;
  if (!qaOrg) {
    const ins = await db('/dealers', { method: 'POST', prefer: 'return=representation', body: { name: 'Lakeside Home Furnishings', slug: 'qa-smoke-dealer', world: 'retailer' } });
    qaOrg = ins.data && ins.data[0];
    if (qaOrg) created.push(`dealers ${qaOrg.id} (Lakeside Home Furnishings)`);
  }
  t(!!qaOrg, 'seed: dealer QA existe (qa-smoke-dealer)');
  if (qaOrg && qaOrg.selling_enabled === false) await db(`/dealers?id=eq.${qaOrg.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { selling_enabled: true } });

  const c = await db('/referral_codes?code=eq.QAS-MOKE1&select=code,org_id&limit=1');
  if (!(c.data && c.data[0])) {
    const ins = await db('/referral_codes', { method: 'POST', prefer: 'return=minimal', body: { code: 'QAS-MOKE1', org_id: qaOrg.id } });
    t(ins.status === 201, 'seed: referral code QAS-MOKE1 creado');
    created.push('referral_codes QAS-MOKE1');
  } else t(true, 'seed: referral code QAS-MOKE1 ya existía (idempotente)');
}

/* ── 3 · referral-validate (Function real) ──────────────────────────────── */
{
  const ok = await api('/api/referral-validate?code=qas-moke1');
  t(ok.status === 200 && ok.data.valid === true && ok.data.org_name === 'Lakeside Home Furnishings',
    'validate: código válido (minúsculas) → {valid:true, org_name}');
  const bad = await api('/api/referral-validate?code=NOEXISTE1');
  t(bad.status === 200 && bad.data.valid === false, 'validate: código inexistente → {valid:false}');
}

/* ---- payload de checkout reutilizable (plan monthly + recibo sintético válido) ---- */
const checkoutBody = (email, extra) => ({
  email,
  plans: [{ cov: 'stain', term: 'monthly', type: 'furniture', count: 1 }],
  kits: [], membership: false,
  full_name: 'QA Smoke', phone: '(555) 111-2222', address: '1 QA St, Test City UT 84321',
  receipt_path: `receipts/2026/07/${randomUUID()}.jpg`,
  ...extra
});
async function lastLead(email) {
  const r = await db(`/leads?email=eq.${encodeURIComponent(email)}&select=id,payload,created_at&order=created_at.desc&limit=1`);
  return (r.data && r.data[0]) || null;
}

/* ── 4 · Método B live: checkout con código → lead atribuido ────────────── */
{
  const email = `qa-smoke+${ts}@rapqa.com`;
  const r = await api('/api/create-checkout-session', { method: 'POST', body: checkoutBody(email, { referral_code: ' qas-moke1 ' }) });
  t(r.status === 200 && !!r.data.url, 'método B: checkout con código → 200 + url de Stripe (test, sin pagar)');
  const lead = await lastLead(email);
  if (lead) created.push(`leads ${lead.id} (${email})`);
  t(!!lead && lead.payload.dealer_id === qaOrg.id && lead.payload.attribution_source === 'referral_code' && lead.payload.referral_code === 'QAS-MOKE1',
    'método B: lead con dealer_id + attribution_source=referral_code + código normalizado');
}

/* ── 5 · Dealer APAGADO: código inválido, la venta SIGUE (decisión 15-jul) ─ */
{
  await db(`/dealers?id=eq.${qaOrg.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { selling_enabled: false } });
  const v = await api('/api/referral-validate?code=QAS-MOKE1');
  t(v.data.valid === false, 'apagado: validate → false con el dealer off');
  const email = `qa-smoke+${ts}b@rapqa.com`;
  const r = await api('/api/create-checkout-session', { method: 'POST', body: checkoutBody(email, { referral_code: 'QAS-MOKE1' }) });
  const lead = await lastLead(email);
  if (lead) created.push(`leads ${lead.id} (${email})`);
  t(r.status === 200 && !!r.data.url, 'apagado: la venta SIGUE (200 + url)');
  t(!!lead && !lead.payload.dealer_id && !lead.payload.attribution_source, 'apagado: lead SIN atribución (código ignorado)');
  await db(`/dealers?id=eq.${qaOrg.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { selling_enabled: true } });
}

/* ── 6 · Portal live: guards + pantallas nuevas (usuarios QA de Fase 1/2) ── */
let ownerTok = null, storeTok = null, adminTok = null, ownerOrg = null;
{
  const login = async (email) => {
    const r = await api('/api/auth-login', { method: 'POST', body: { email, password: '12345678' } });
    return r.status === 200 ? r.data.access_token : null;
  };
  ownerTok = await login('owner@rapqa.com');
  storeTok = await login('store@rapqa.com');
  adminTok = await login('admin@raptns.com');
  if (!ownerTok || !storeTok || !adminTok) {
    skip('portal: login QA falló (¿seed de Fase 1 corrido? ¿BASE correcto?) — bloque 6-7 saltado');
  } else {
    const me = await api('/api/portal-me', { bearer: ownerTok });
    ownerOrg = me.data && me.data.org_id;
    const plans = await api('/api/portal-plans', { bearer: ownerTok });
    t(plans.status === 200 && plans.data.plans.length === 2 && plans.data.editable === false,
      'portal: portal-plans → 2 sabores, display-only');
    const noauth = await api('/api/portal-plans');
    t(noauth.status === 401, 'portal: portal-plans sin Bearer → 401');

    const refsOwner = await api('/api/portal-referral-codes', { bearer: ownerTok });
    t(refsOwner.status === 200, 'portal: owner lista SUS códigos (200)');
    const refsStore = await api('/api/portal-referral-codes', { bearer: storeTok });
    t(refsStore.status === 403, 'portal: store pide referral-codes → 403 (frontera server-side)');
    const createOwner = await api('/api/portal-referral-codes', { method: 'POST', bearer: ownerTok, body: { org_id: ownerOrg } });
    t(createOwner.status === 403, 'portal: owner intenta CREAR código → 403 (crear = admin)');
    const createAdmin = await api('/api/portal-referral-codes', { method: 'POST', bearer: adminTok, body: { org_id: qaOrg.id } });
    t(createAdmin.status === 200 && !!createAdmin.data.code, `portal: admin crea código para el org QA (${createAdmin.data && createAdmin.data.code})`);
    if (createAdmin.data && createAdmin.data.code) created.push(`referral_codes ${createAdmin.data.code}`);

    const commOwner = await api('/api/portal-commissions', { bearer: ownerTok });
    t(commOwner.status === 200 && 'cash_cents' in (commOwner.data.totals || {}), 'portal: owner ve SUS comisiones (200, totales del split)');
    t(!JSON.stringify(commOwner.data).match(/revenue|gross/i), 'portal: el payload de comisiones no lleva revenue de RAP (§5.9)');
    const commStore = await api('/api/portal-commissions', { bearer: storeTok });
    t(commStore.status === 403, 'portal: store pide comisiones → 403');
  }
}

/* ── 7 · SSO live: handoff → redeem (single-use) → método A en el checkout ─ */
{
  if (!ownerTok) { skip('sso: sin token de owner — saltado'); }
  else {
    const h = await api('/api/portal-app-handoff', { method: 'POST', bearer: ownerTok, body: {} });
    t(h.status === 200 && /\?pt=/.test(h.data.url || ''), 'sso: handoff emitido (url con ?pt=)');
    const token = h.status === 200 ? new URL(h.data.url).searchParams.get('pt') : null;

    const red = await api('/api/portal-app-redeem', { method: 'POST', body: { token } });
    t(red.status === 200 && !!red.data.session && red.data.org_id === ownerOrg, 'sso: redeem → sesión 12h del org del owner');
    created.push('kiosk_sessions (handoff+session del smoke)');

    const again = await api('/api/portal-app-redeem', { method: 'POST', body: { token } });
    t(again.status === 401, 'sso: segundo redeem del MISMO handoff → 401 (single-use)');

    const email = `qa-smoke+${ts}c@rapqa.com`;
    const r = await api('/api/create-checkout-session', { method: 'POST', body: checkoutBody(email, { kiosk_session: red.data.session }) });
    const lead = await lastLead(email);
    if (lead) created.push(`leads ${lead.id} (${email})`);
    t(r.status === 200 && !!lead && lead.payload.dealer_id === ownerOrg && lead.payload.attribution_source === 'kiosk_session',
      'método A: checkout con kiosk_session → lead atribuido al org del TOKEN');

    const forged = await api('/api/create-checkout-session', { method: 'POST', body: checkoutBody(`qa-smoke+${ts}d@rapqa.com`, { kiosk_session: 'token-forjado-123' }) });
    const fl = await lastLead(`qa-smoke+${ts}d@rapqa.com`);
    if (fl) created.push(`leads ${fl.id}`);
    t(forged.status === 200 && !!fl && !fl.payload.dealer_id, 'método A: token forjado se IGNORA (venta sigue, sin atribución)');
  }
}

/* ── 8 · Motor de comisiones contra BD REAL (recordCommissions directo) ──── */
{
  const prof = await db('/profiles?select=id&limit=1');
  const userId = prof.data && prof.data[0] && prof.data[0].id;
  if (!userId) { skip('comisiones: sin profiles en la BD — saltado'); }
  else {
    const subId = `qasmoke_${ts}`;
    const ins = await db('/subscriptions', {
      method: 'POST', prefer: 'return=representation',
      body: {
        user_id: userId, kind: 'protection', tier: 'stain_mech', status: 'active',
        started_at: new Date().toISOString(), monthly_cents: 1999,
        stripe_subscription_id: subId, stripe_subscription_item_id: `si_${subId}`,
        dealer_id: qaOrg.id, attribution_source: 'referral_code', referral_code: 'QAS-MOKE1',
        sales_order_number: 'QA-SMOKE'
      }
    });
    t(ins.status === 201, 'comisiones: subscription QA sintética insertada (dealer atribuido)');
    if (ins.status === 201) created.push(`subscriptions ${subId} (QA-SMOKE)`);

    const { recordCommissions } = await import(pathToFileURL('netlify/functions/_lib/commissions.mjs').href);
    const invoice = (id) => ({
      id, subscription: subId,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      lines: { data: [{ price: { id: env.STRIPE_PRICE_STAIN_MECH }, quantity: 1 }] }
    });

    const r1 = await recordCommissions(env, invoice(`in_${subId}_1`));
    t(r1.recorded === 1, 'comisiones: invoice.paid → 1 fila en el ledger');
    const r2 = await recordCommissions(env, invoice(`in_${subId}_1`));
    t(r2.recorded === 0, 'comisiones: MISMA invoice re-procesada → 0 filas (idempotente)');
    /* La tasa esperada depende del estado real: si una corrida anterior ya dejó el override
     * QA 400/400, la fila sale con ese split; sin override, con la global 800/0. */
    const ovQ = await db(`/commission_rates?org_id=eq.${qaOrg.id}&plan_sku=eq.stain_mech&select=stripe_amount_cents,reinsurance_amount_cents&limit=1`);
    const ov = (ovQ.data && ovQ.data[0]) || null;
    const exp = ov || { stripe_amount_cents: 800, reinsurance_amount_cents: 0 };
    /* El status esperado depende de los FLAGS del .env: con transfers encendidos la fila
     * sale 'transferred' (transfer real de test); apagados, queda 'recorded'. */
    const xferOn = String(env.COMMISSIONS_ENABLED) === 'true' && ['1', 'true'].includes(String(env.STRIPE_CONNECT_TRANSFERS));
    const row1 = await db(`/commission_ledger?stripe_invoice_id=eq.in_${subId}_1&select=plan_sku,stripe_amount_cents,reinsurance_amount_cents,status`);
    /* La TASA se afirma siempre (es la lógica nuestra). El status 'transferred' depende de
     * Stripe test (Connect del dealer QA + balance de plataforma): un transfer 400 ambiental
     * deja la fila 'recorded' por diseño (fail-soft) → SKIP informativo, no FAIL (decisión
     * Adrian 27-jul, opción c). Un fallo REAL de tasa/split sigue poniendo el smoke en rojo. */
    t(row1.data[0] && row1.data[0].stripe_amount_cents === exp.stripe_amount_cents && row1.data[0].reinsurance_amount_cents === exp.reinsurance_amount_cents,
      `comisiones: tasa efectiva ${ov ? 'OVERRIDE QA ' + exp.stripe_amount_cents + '/' + exp.reinsurance_amount_cents : 'GLOBAL $8/0'} aplicada`);
    if (xferOn && row1.data[0] && row1.data[0].status === 'recorded') {
      skip('comisiones: flags ON pero el transfer de test devolvió 400 (Connect/balance del entorno) → fila queda \'recorded\' (fail-soft). Ver el error exacto en Stripe → Developers → Logs.');
    } else {
      t(row1.data[0] && row1.data[0].status === (xferOn ? 'transferred' : 'recorded'),
        `comisiones: status ${xferOn ? 'transferred' : 'recorded'} (flags ${xferOn ? 'ON' : 'OFF'})`);
    }
    created.push(`commission_ledger in_${subId}_1`);

    /* override con split (el caso Bailey's de la llamada) */
    const hasOv = await db(`/commission_rates?org_id=eq.${qaOrg.id}&plan_sku=eq.stain_mech&select=id&limit=1`);
    if (!(hasOv.data && hasOv.data[0])) {
      await db('/commission_rates', { method: 'POST', prefer: 'return=minimal', body: { org_id: qaOrg.id, plan_sku: 'stain_mech', stripe_amount_cents: 400, reinsurance_amount_cents: 400 } });
      created.push('commission_rates override QA 400/400');
    }
    await recordCommissions(env, invoice(`in_${subId}_2`));
    const row2 = await db(`/commission_ledger?stripe_invoice_id=eq.in_${subId}_2&select=stripe_amount_cents,reinsurance_amount_cents`);
    t(row2.data[0] && row2.data[0].stripe_amount_cents === 400 && row2.data[0].reinsurance_amount_cents === 400,
      'comisiones: override por dealer → split $4/$4 (gana a la global)');
    created.push(`commission_ledger in_${subId}_2`);

    const rein = await db(`/v_reinsurance_monthly?org_id=eq.${qaOrg.id}&select=dealer_name,reinsurance_amount_cents`);
    t(rein.status === 200 && rein.data.some((x) => x.reinsurance_amount_cents === 400),
      'REIN-1: la fila con reinsurance aparece en v_reinsurance_monthly (reporte de Daniel)');
  }
}

/* ── QA-4 · Franja ciega de la ronda QA de Jakob (BUG-01 + BUG-04) ─────────
 * Ninguna suite (todas stubbeadas) podía ver estos dos: son config/entorno REAL.
 * A) return-URLs: el checkout creado con Origin del kiosk debe volver AL kiosk.
 *    Si falla → ese origin NO está en ALLOWED_ORIGINS del backend (BUG-01).
 * B) payment link por email: emailed:true con el env real (BUG-04; en local sin
 *    RESEND_API_KEY fallará — esperado, el smoke es on-demand contra prod). */
{
  const ORIGIN = (args.includes('--origin') && args[args.indexOf('--origin') + 1])
    ? args[args.indexOf('--origin') + 1].replace(/\/+$/, '')
    : 'https://kiosk.furniturerx.net';

  /* A) detector de BUG-01 */
  if (!env.STRIPE_SECRET_KEY) {
    skip(`QA-4A: sin STRIPE_SECRET_KEY en .env — no puedo recuperar la Session para assertar las return-URLs`);
  } else {
    const email = `qa-smoke+${ts}u@rapqa.com`;
    const r = await api('/api/create-checkout-session', { method: 'POST', origin: ORIGIN, body: checkoutBody(email, { kiosk: true, associate: 'QA-01', order: `SO-QA-${ts}`, zip: '84321', date: new Date().toISOString().slice(0, 10) }) });
    t(r.status === 200 && r.data && r.data.id, 'QA-4A: checkout con Origin del kiosk → 200 + session id');
    if (r.status === 200 && r.data && r.data.id) {
      const s = await fetch(`https://api.stripe.com/v1/checkout/sessions/${r.data.id}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
      });
      const sess = s.status < 300 ? await s.json().catch(() => null) : null;
      t(!!sess && typeof sess.success_url === 'string', 'QA-4A: session recuperada de Stripe');
      const okSucc = !!sess && String(sess.success_url).startsWith(ORIGIN);
      const okCanc = !!sess && String(sess.cancel_url).startsWith(ORIGIN);
      t(okSucc, `QA-4A: success_url vuelve a ${ORIGIN} — si FALLA: añade ese origin a ALLOWED_ORIGINS del backend y redeploy (BUG-01)`);
      t(okCanc, `QA-4A: cancel_url también vuelve a ${ORIGIN}`);
    }
  }

  /* B) detector de BUG-04 (manda un email REAL a la inbox rapqa) */
  {
    const email = `qa-smoke+${ts}e@rapqa.com`;
    const r = await api('/api/create-checkout-session', { method: 'POST', origin: ORIGIN, body: checkoutBody(email, { kiosk: true, associate: 'QA-01', order: `SO-QA-${ts}E`, zip: '84321', date: new Date().toISOString().slice(0, 10), deliver: 'email' }) });
    t(r.status === 200 && r.data && r.data.emailed === true,
      'QA-4B: deliver:email → emailed:true con el env real — si FALLA: revisa el warn [checkout] email failed en los logs de la Function (BUG-04)');
  }
}

/* ── Reporte final (NO se borra nada — regla de la casa) ─────────────────── */
console.log('\n── Datos QA creados/tocados en esta corrida (limpieza manual si algún día hace falta):');
created.forEach((c) => console.log('   ·', c));
console.log(`\nsmoke-circuit-live: ${count - fails}/${count} aserciones${fails ? ' — RED' : ' — GREEN'}`);
process.exit(fails ? 1 : 0);
