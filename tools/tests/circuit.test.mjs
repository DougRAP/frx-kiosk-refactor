/* ============================================================================
 * Portal Fase 3 (respuestas Doug 15-jul) — circuito de comisiones + atribución A/B
 * + T&Cs por SKU. Spec: misc/spec-portal-fase3.md. TDD.
 *   (A) helpers puros: _lib/commissions.mjs + _lib/referral.mjs
 *   (B) gates de las migraciones 20260715100000 / 20260715110000
 *   (C) gates de cableado: webhook, checkout, functions nuevas
 *   (D) gates de los fronts: campo de código en los 3 carts + portal
 * ==========================================================================*/
import { src, makeT } from './helpers.mjs';
import {
  skuForPriceId, pickRate, commissionRowsForInvoice
} from '../../netlify/functions/_lib/commissions.mjs';
import {
  normalizeReferralCode, generateReferralCode, referralAttribution,
  sessionAttribution, hashToken, termsFor
} from '../../netlify/functions/_lib/referral.mjs';

const t = makeT('circuit');
const ENV = {
  STRIPE_PRICE_STAIN: 'price_s', STRIPE_PRICE_STAIN_MECH: 'price_m',
  /* COMM-3 (14-ago): la membership DE PAGO comisiona ($6/pago); FREE/HALF legacy NO. */
  STRIPE_PRICE_MEMBERSHIP: 'price_membership',
  STRIPE_PRICE_MEMBERSHIP_FREE: 'price_mem_free',
  STRIPE_PRICE_MEMBERSHIP_HALF: 'price_mem_half'
};
const NOW = Date.parse('2026-07-15T12:00:00Z');

/* ── (A1) comisiones: SKU por price id ───────────────────────────────────── */
{
  t(skuForPriceId(ENV, 'price_s') === 'stain' && skuForPriceId(ENV, 'price_m') === 'stain_mech', 'sku: price id → SKU (llave universal, PORT-15)');
  t(skuForPriceId(ENV, 'price_x') === null && skuForPriceId(ENV, null) === null, 'sku: price desconocido/null → null (sin comisión)');
}

/* ── (A2) comisiones: tasa con override por dealer y split ───────────────── */
{
  const rates = [
    { org_id: null, plan_sku: 'stain', stripe_amount_cents: 200, reinsurance_amount_cents: 0 },
    { org_id: null, plan_sku: 'stain_mech', stripe_amount_cents: 800, reinsurance_amount_cents: 0 },
    { org_id: 'bailey', plan_sku: 'stain_mech', stripe_amount_cents: 400, reinsurance_amount_cents: 400 }
  ];
  const g = pickRate(rates, 'otro-org', 'stain_mech');
  t(g.stripe_amount_cents === 800 && g.reinsurance_amount_cents === 0, 'rate: sin override → global $8/0');
  const b = pickRate(rates, 'bailey', 'stain_mech');
  t(b.stripe_amount_cents === 400 && b.reinsurance_amount_cents === 400, 'rate: Bailey\'s → split 400/400 (llamada 15-jul)');
  const d = pickRate([], 'x', 'stain');
  t(d.stripe_amount_cents === 200 && d.reinsurance_amount_cents === 0, 'rate: sin filas → default duro $2/0 (fail-safe)');
  /* COMM-3: los 4 SKUs tienen default duro (kit $10 cash, membership $6 cash). */
  const k = pickRate([], 'x', 'kit');
  t(k.stripe_amount_cents === 1000 && k.reinsurance_amount_cents === 0, 'COMM-3: kit → $10 todo cash (sin reinsurance, inferencia documentada)');
  const m = pickRate([], 'x', 'membership');
  t(m.stripe_amount_cents === 600 && m.reinsurance_amount_cents === 0, 'COMM-3: membership de pago → $6 default (techo $8 por override)');
  t(pickRate(rates, null, 'stain').stripe_amount_cents === 200, 'rate: org null → global stain $2');
}

/* ── (A3) comisiones: filas del ledger desde una invoice ─────────────────── */
{
  const invoice = {
    id: 'in_1', subscription: 'sub_1',
    status_transitions: { paid_at: Math.floor(NOW / 1000) },
    lines: { data: [
      { price: { id: 'price_s' }, quantity: 2 },
      { price: { id: 'price_m' }, quantity: 1 },
      { price: { id: 'price_membership' }, quantity: 1 },       // COMM-3: la DE PAGO comisiona
      { price: { id: 'price_mem_free' }, quantity: 1 },         // legacy bundled $0 → NO
      { price: { id: 'price_mem_half' }, quantity: 1 }          // legacy 50% → NO (decisión anotada)
    ] }
  };
  const rates = [
    { org_id: null, plan_sku: 'stain', stripe_amount_cents: 200, reinsurance_amount_cents: 0 },
    { org_id: null, plan_sku: 'membership', stripe_amount_cents: 600, reinsurance_amount_cents: 0 },
    { org_id: 'org1', plan_sku: 'stain_mech', stripe_amount_cents: 400, reinsurance_amount_cents: 400 }
  ];
  const rows = commissionRowsForInvoice(ENV, invoice, 'org1', rates);
  t(rows.length === 3, 'ledger: 3 filas (stain + stain_mech + membership de pago); FREE/HALF no comisionan');
  const mb = rows.find((r) => r.plan_sku === 'membership');
  t(mb && mb.qty === 1 && mb.stripe_amount_cents === 600 && mb.reinsurance_amount_cents === 0,
    'COMM-3: membership de pago → $6/pago con el split heredado (seed 600/0)');
  const st = rows.find((r) => r.plan_sku === 'stain');
  t(st.qty === 2 && st.stripe_amount_cents === 400 && st.reinsurance_amount_cents === 0, 'ledger: qty 2 × $2 = $4 cash');
  const sm = rows.find((r) => r.plan_sku === 'stain_mech');
  t(sm.stripe_amount_cents === 400 && sm.reinsurance_amount_cents === 400, 'ledger: split del override aplicado');
  t(st.stripe_invoice_id === 'in_1' && st.stripe_subscription_id === 'sub_1' && st.org_id === 'org1' && st.status === 'recorded', 'ledger: llaves de idempotencia y org');
  t(typeof st.paid_at === 'string' && st.paid_at.startsWith('2026-07-15'), 'ledger: paid_at ISO desde la invoice');
  t(commissionRowsForInvoice(ENV, invoice, null, rates).length === 0, 'ledger: sin dealer atribuido → CERO filas (venta directa RAP)');
}

/* ── (A4) referral: normalización + generación ───────────────────────────── */
{
  t(normalizeReferralCode('  gal-7k2m ') === 'GAL-7K2M', 'code: normaliza (trim + upper)');
  t(normalizeReferralCode('ab') === null && normalizeReferralCode('x'.repeat(30)) === null, 'code: largo fuera de rango → null');
  t(normalizeReferralCode('BAD CODE!') === null && normalizeReferralCode(7) === null && normalizeReferralCode('') === null, 'code: charset inválido / no-string → null');
  const gen = generateReferralCode('Gallery Furniture');
  t(/^GAL-[A-Z0-9]{4}$/.test(gen), 'code: generado con prefijo del org + 4 random');
  t(/^RAP-[A-Z0-9]{4}$/.test(generateReferralCode('!!!')), 'code: org sin letras → prefijo RAP');
}

/* ── (A5) referral: atribución método B (dealer apagado = código inválido) ── */
{
  const dealerOk = { id: 'd1', selling_enabled: true };
  const dealerOff = { id: 'd1', selling_enabled: false };
  const code = { code: 'GAL-7K2M', org_id: 'd1', active: true };
  const a = referralAttribution(code, dealerOk, NOW);
  t(a && a.dealer_id === 'd1' && a.source === 'referral_code' && a.code === 'GAL-7K2M', 'attr B: código activo + dealer vendible → atribuye');
  t(referralAttribution(code, dealerOff, NOW) === null, 'attr B: dealer APAGADO → código inválido, la venta sigue (decisión 15-jul)');
  t(referralAttribution({ ...code, active: false }, dealerOk, NOW) === null, 'attr B: código inactivo → null');
  t(referralAttribution(null, dealerOk, NOW) === null && referralAttribution(code, null, NOW) === null, 'attr B: sin fila de código o dealer → null');
  const dealerWindow = { id: 'd1', selling_enabled: true, access_end: '2026-01-01' };
  t(referralAttribution(code, dealerWindow, NOW) === null, 'attr B: dealer fuera de ventana de acceso → null');
}

/* ── (A6) sesión de kiosk: atribución método A ───────────────────────────── */
{
  const live = { kind: 'session', org_id: 'd9', org_name: 'Summit', expires_at: new Date(NOW + 3600e3).toISOString() };
  const a = sessionAttribution(live, NOW);
  t(a && a.dealer_id === 'd9' && a.source === 'kiosk_session', 'attr A: sesión viva → dealer del TOKEN');
  t(sessionAttribution({ ...live, expires_at: new Date(NOW - 1000).toISOString() }, NOW) === null, 'attr A: sesión vencida → null');
  t(sessionAttribution({ ...live, kind: 'handoff' }, NOW) === null, 'attr A: un handoff NO es sesión (single-use, no atribuye)');
  t(sessionAttribution(null, NOW) === null, 'attr A: sin fila → null');
  const h = hashToken('abc');
  t(/^[a-f0-9]{64}$/.test(h) && h === hashToken('abc') && h !== hashToken('abd'), 'token: sha256 hex determinístico (solo el hash toca la BD)');
}

/* ── (A7) plan_terms: dealer-specific gana, genérica de fallback ─────────── */
{
  const rows = [
    { org_id: null, plan_sku: 'stain', terms_version: 'v2026-05', doc_url: '/terms/', active: true },
    { org_id: null, plan_sku: 'stain_mech', terms_version: 'v2026-05', doc_url: '/terms/', active: true },
    { org_id: 'gal', plan_sku: 'stain_mech', terms_version: 'gal-v1', doc_url: 'https://plans/x', active: true },
    { org_id: 'gal', plan_sku: 'stain', terms_version: 'gal-old', doc_url: null, active: false }
  ];
  t(termsFor(rows, 'gal', 'stain_mech').terms_version === 'gal-v1', 'terms: fila del dealer GANA a la genérica');
  t(termsFor(rows, 'gal', 'stain').terms_version === 'v2026-05', 'terms: fila del dealer inactiva → cae a la genérica');
  t(termsFor(rows, null, 'stain').terms_version === 'v2026-05', 'terms: sin atribución → genérica ("Otherwise send the generic versions")');
  t(termsFor([], 'gal', 'stain') === null, 'terms: sin filas → null (el caller cae a TERMS_VERSION)');
}

/* ── (B) gates de migraciones ────────────────────────────────────────────── */
{
  const m1 = src('supabase/migrations/20260715100000_commissions_reinsurance.sql');
  t(/CREATE TABLE IF NOT EXISTS public\.commission_rates/.test(m1) && /reinsurance_amount_cents/.test(m1), 'mig 8a: commission_rates con split');
  t(/SELECT NULL, 'stain', 200, 0/.test(m1) && /SELECT NULL, 'stain_mech', 800, 0/.test(m1), 'mig 8a: seed global $2/$8 (canon 15-jul)');
  t(/ADD COLUMN IF NOT EXISTS stripe_account_id/.test(m1), 'mig 8a: dealers.stripe_account_id');
  t(/commission_ledger_invoice_sku_uq UNIQUE \(stripe_invoice_id, plan_sku\)/.test(m1), 'mig 8a: idempotencia por (invoice, sku)');
  t(/CREATE OR REPLACE VIEW public\.v_reinsurance_monthly/.test(m1), 'mig REIN-1: view mensual para Daniel');
  t(/GRANT SELECT, INSERT, UPDATE ON public\.commission_ledger TO service_role/.test(m1) && !/GRANT[^;]*DELETE[^;]*commission_ledger/.test(m1), 'mig 8a: ledger append-only (sin DELETE)');
  t(/REVOKE ALL ON public\.commission_rates\s+FROM anon, authenticated/.test(m1), 'mig 8a: anon/authenticated fuera');

  const m2 = src('supabase/migrations/20260715110000_referral_terms_kiosk_sessions.sql');
  t(/CREATE TABLE IF NOT EXISTS public\.referral_codes/.test(m2) && /code\s+text NOT NULL UNIQUE/.test(m2), 'mig 9: referral_codes');
  t(/ADD COLUMN IF NOT EXISTS attribution_source/.test(m2) && /subscriptions_attribution_chk/.test(m2), 'mig 9: subscriptions.attribution_source con CHECK');
  t(/CREATE TABLE IF NOT EXISTS public\.plan_terms/.test(m2) && /'v2026-05', '\/terms\/'/.test(m2), 'mig 4b: plan_terms + seed genéricas');
  t(/CREATE TABLE IF NOT EXISTS public\.kiosk_sessions/.test(m2) && /kind IN \('handoff','session'\)/.test(m2) && /token_hash/.test(m2), 'mig 10: kiosk_sessions (hash, handoff/session)');
  t(/CREATE OR REPLACE VIEW public\.v_first_payment_terms/.test(m2), 'mig 4c: view para el sistema de Coms');
  t(/REVOKE ALL ON public\.referral_codes\s+FROM anon, authenticated/.test(m2), 'mig 9: anon/authenticated fuera');

  /* COMM-3 (14-ago): migración de kit + membership. */
  const m3 = src('supabase/migrations/20260815000000_commissions_kit_membership.sql');
  t(/CHECK \(plan_sku IN \('stain', 'stain_mech', 'kit', 'membership'\)\)/.test(m3), 'mig COMM-3: CHECKs ampliados a 4 SKUs');
  t(/ALTER COLUMN stripe_subscription_id DROP NOT NULL/.test(m3), 'mig COMM-3: el kit one-time no exige subscription');
  t(/SELECT NULL, 'kit', 1000, 0/.test(m3) && /SELECT NULL, 'membership', 600, 0/.test(m3), 'mig COMM-3: seeds kit \$10 y membership \$6, idempotentes');
  t(!/ADD CONSTRAINT commission_ledger_status_chk/.test(m3), 'mig COMM-3: NO recrea el status_chk de 3 estados (SEC-2b)');
  t(!/DROP\s+(TABLE|COLUMN)/i.test(m3) && !/^\s*REVOKE/im.test(m3), 'mig COMM-3: no destructiva, sin cambiar grants');

  /* El webhook registra la comisión del kit por session.id, FUERA del guard created, y la fila
     membership lleva la atribución (sin eso una standalone jamás comisionaría). */
  const wh = src('netlify/functions/stripe-webhook.mjs');
  t(/recordKitCommission\(env, \{ sessionId: session\.id/.test(wh), 'COMM-3: kit ledger por session.id en checkout.session.completed');
  const memBlock = wh.split('if (isMembership)')[1] || '';
  t(/dealer_id: p\.dealer_id \|\| null/.test(memBlock.slice(0, 3000)), 'COMM-3: la fila membership persiste dealer_id (la standalone comisiona)');
}

/* ── (C) gates de cableado backend ───────────────────────────────────────── */
{
  const wh = src('netlify/functions/stripe-webhook.mjs');
  t(/COMMISSIONS_ENABLED/.test(wh) && /recordCommissions/.test(wh), 'webhook: accrual de comisión detrás de flag (default OFF)');
  t(/dealer_id: p\.dealer_id \|\| null/.test(wh) && /attribution_source: p\.attribution_source \|\| null/.test(wh), 'webhook: la subscription hereda la atribución A/B del lead');
  t(/lookupTermsVersion|termsFor/.test(wh), 'webhook: lookup de plan_terms al crear (PORT-4b)');

  const co = src('netlify/functions/_lib/checkout.mjs');
  t(/resolveAttribution/.test(co), 'checkout: atribución resuelta server-side');
  t(/kiosk_session/.test(co) && /referral_code/.test(co), 'checkout: método A (sesión) + método B (código)');

  const sb = src('netlify/functions/_lib/supabase.mjs');
  t(/dealer_id: fields\.dealer_id \|\| null/.test(sb) && /attribution_source: fields\.attribution_source \|\| null/.test(sb), 'lead: payload persiste la atribución');

  t(/normalizeReferralCode/.test(src('netlify/functions/referral-validate.mjs')), 'function: referral-validate valida con el normalizador');
  t(/assertCanStripe/.test(src('netlify/functions/portal-commissions.mjs')), 'function: portal-commissions con guard canStripe (§5.9)');
  t(/PRICE_CENTS/.test(src('netlify/functions/portal-plans.mjs')), 'function: portal-plans lee el canónico del server (display-only)');
  t(/canReferralCreate|assertAdmin/.test(src('netlify/functions/portal-referral-codes.mjs')), 'function: portal-referral-codes (crear = admin)');
  t(/kind: 'handoff'/.test(src('netlify/functions/portal-app-handoff.mjs')), 'function: portal-app-handoff emite one-time token');
  t(/kind: 'session'/.test(src('netlify/functions/portal-app-redeem.mjs')), 'function: portal-app-redeem canjea a sesión');
}

/* ── (D) gates de los fronts ─────────────────────────────────────────────── */
{
  for (const f of ['index.html', 'kiosk/index.html', 'tech/index.html']) {
    const html = src(f);
    t(/id="cart-referral"/.test(html), `front ${f}: input de referral code en el cart (método B, "same method")`);
    t(/referral_code/.test(html), `front ${f}: el POST del checkout manda referral_code`);
  }
  t(/kiosk_session/.test(src('kiosk/index.html')), 'front kiosk: manda kiosk_session (método A) cuando hay sesión SSO');
  /* EMAIL-LINK BUG: startCheckout arma el body a mano; si NO forwardea deliver, el server nunca ve
     deliver:'email' → la rama de sendEmail no corre → nada llega a Resend (síntoma 31-jul). */
  for (const f of ['kiosk/index.html', 'tech/index.html']) {
    t(/deliver:\s*p\.deliver/.test(src(f)), `front ${f}: el POST de startCheckout FORWARDEA deliver (KIOSK-1 email link)`);
  }
  for (const f of ['index.html', 'kiosk/index.html', 'tech/index.html']) {
    t(/URLSearchParams\(location\.search\)\.get\('ref'\)/.test(src(f)), `front ${f}: link permanente ?ref= pre-llena el código (vía B automática)`);
  }
  t(/\?ref=/.test(src('portal/assets/js/portal.js')) && /Share link/.test(src('portal/index.html')), 'portal: columna Share link con copy del link permanente por dealer');

  const pjs = src('portal/assets/js/portal.js');
  t(/\/api\/portal-plans/.test(pjs) && /\/api\/portal-referral-codes/.test(pjs) && /\/api\/portal-commissions/.test(pjs), 'portal js: cablea plans + referral-codes + commissions');
  t(/\/api\/portal-app-handoff/.test(pjs), 'portal js: botón Open App usa el handoff SSO');
  t(!/\.innerHTML\s*=/.test(pjs), 'portal js: sigue sin innerHTML con datos');
  const phtml = src('portal/index.html');
  t(!/Referral codes \+ D2C attribution \(PORT-9\)/.test(phtml), 'portal: el stub "Coming soon" de Referral Codes murió');
}

/* ── QA-3 (BUG-04 de Jakob): el fallo del email del payment link era indiagnosticable
   (r.error se descartaba) y el timeout de 3s era demasiado corto tras Stripe+insert
   en la misma invocación (G1 pasó con el mismo driver → la causa apunta al timeout). ── */
{
  const core = src('netlify/functions/_lib/checkout.mjs');
  const emailPath = core.split("deliver === 'email'")[1].split('return { status: 200')[0];
  t(/timeoutMs:\s*8000/.test(emailPath), 'QA-3: el path del payment-link email usa timeoutMs 8000 (no el default 3s)');
  t(/console\.warn\('\[checkout\] email failed:', r\.error\)/.test(emailPath), 'QA-3: un envío fallido loguea r.error (antes se descartaba)');
  /* SHORT-LINK: el email debe llevar el /p/CODE corto (payLink = shortUrl || session.url), no la URL
     larga de Stripe. session.url solo puede aparecer 1 vez (la definición del fallback). */
  const payLinkUses = (emailPath.match(/payLink/g) || []).length;
  const rawUses = (emailPath.match(/session\.url/g) || []).length;
  t(/const payLink\s*=\s*shortUrl\s*\|\|\s*session\.url/.test(emailPath) && payLinkUses >= 3 && rawUses === 1,
    'email link: usa el short link /p/CODE (payLink con fallback), no la URL larga de Stripe');
}

/* ── QA-4: el smoke live carga los DOS detectores de la franja ciega (BUG-01/BUG-04) ── */
{
  const smoke = src('tools/smoke-circuit-live.mjs');
  t(/api\.stripe\.com\/v1\/checkout\/sessions\//.test(smoke) && /success_url/.test(smoke),
    'QA-4: el smoke recupera la Session de Stripe y asserta las return-URLs (detector BUG-01)');
  t(/deliver:\s*'email'/.test(smoke) && /emailed === true/.test(smoke),
    'QA-4: el smoke asserta emailed:true del payment link (detector BUG-04)');
}

t.done();
