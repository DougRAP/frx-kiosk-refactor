/* ============================================================================
 * FULL RUN test-mode — el ciclo COMPLETO de comisiones con dinero real de test:
 * venta atribuida por referral code → webhook real → ledger con split → TRANSFER
 * real a la connected account del dealer QA → mes 2 vía test clock → reporte.
 * (Corrido en verde el 15-jul: $8.00 en el balance del dealer tras 2 meses.)
 *
 * ── CÓMO CORRERLO (3 terminales o 2 background + 1) ─────────────────────────
 *   0. Prerrequisitos one-time: `stripe login` hecho; Connect habilitado en la
 *      cuenta (test); seed del smoke corrido al menos una vez (dealer + código):
 *      `npm run smoke:live` los crea si faltan.
 *   1. .env: STRIPE_WEBHOOK_SECRET = el del CLI → `stripe listen --print-secret`
 *      (guarda el original para restaurarlo). Flags: COMMISSIONS_ENABLED=true y
 *      STRIPE_CONNECT_TRANSFERS=1.
 *   2. `netlify dev`                                  (terminal A)
 *   3. `stripe listen --forward-to localhost:8888/.netlify/functions/stripe-webhook
 *        --events checkout.session.completed,invoice.paid`   (terminal B)
 *   4. `npm run fullrun:live`                         (terminal C)
 *   5. Al terminar: restaurar el STRIPE_WEBHOOK_SECRET original en .env.
 *
 * Autosuficiente: si el dealer QA no tiene connected account la CREA (custom de
 * test con transfers activa); si el balance available no alcanza, se FONDEA con
 * tok_bypassPending. Cada corrida usa un email/clock nuevos. NO borra nada.
 * ==========================================================================*/

'use strict';

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Stripe = require('stripe');

const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const i = l.indexOf('=');
  if (i > 0 && !l.startsWith('#')) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const K = env.STRIPE_SECRET_KEY, WH = env.STRIPE_WEBHOOK_SECRET;
if (!K || !K.startsWith('sk_test')) { console.error('ABORT: STRIPE_SECRET_KEY no es de TEST.'); process.exit(2); }
if (!/^whsec_/.test(WH || '')) { console.error('ABORT: STRIPE_WEBHOOK_SECRET vacío.'); process.exit(2); }
if (env.COMMISSIONS_ENABLED !== 'true' || env.STRIPE_CONNECT_TRANSFERS !== '1') {
  console.error('ABORT: pon COMMISSIONS_ENABLED=true y STRIPE_CONNECT_TRANSFERS=1 en .env (y reinicia netlify dev).'); process.exit(2);
}
const SV = '2024-06-20';   // la cuenta tiene una API version vieja → fijar versión moderna en llamadas raw
const BASE = 'http://localhost:8888';
const ts = Date.now();
const EMAIL = `qa-full+${ts}@rapqa.com`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, count = 0;
const t = (c, m) => { count++; console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };

async function api(path, body, extraH = {}) {
  const res = await fetch('https://api.stripe.com' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + K, 'Stripe-Version': SV, 'Content-Type': 'application/x-www-form-urlencoded', ...extraH },
    body: body === undefined ? undefined : new URLSearchParams(body).toString()
  });
  const d = await res.json();
  if (d.error) throw new Error(path + ' → ' + (d.error.code || '') + ': ' + d.error.message.slice(0, 180));
  return d;
}
async function db(path, opts = {}) {
  const res = await fetch(env.SUPABASE_URL + '/rest/v1' + path, {
    method: opts.method || 'GET',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
async function pollLedger(invoiceId, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await db(`/commission_ledger?stripe_invoice_id=eq.${invoiceId}&select=stripe_amount_cents,reinsurance_amount_cents,status,transfer_id`);
    if (r.data && r.data[0] && r.data[0].status === 'transferred') return r.data[0];
    await sleep(2000);
  }
  const r = await db(`/commission_ledger?stripe_invoice_id=eq.${invoiceId}&select=stripe_amount_cents,reinsurance_amount_cents,status,transfer_id`);
  return (r.data && r.data[0]) || null;
}

/* ── 0 · preflight: server local + dealer QA (con connected account) + fondos ── */
try { const p = await fetch(BASE + '/'); if (p.status !== 200) throw new Error(String(p.status)); }
catch { console.error('ABORT: netlify dev no responde en ' + BASE); process.exit(2); }

const dq = await db('/dealers?slug=eq.qa-smoke-dealer&select=id,name,stripe_account_id,selling_enabled&limit=1');
const dealer = dq.data && dq.data[0];
if (!dealer) { console.error('ABORT: falta el dealer QA — corre `npm run smoke:live` primero (lo siembra).'); process.exit(2); }
if (dealer.selling_enabled === false) await db(`/dealers?id=eq.${dealer.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { selling_enabled: true } });

let ACCT = dealer.stripe_account_id;
if (!ACCT) {
  console.log('  ····  el dealer QA no tiene connected account → creándola (custom de test)…');
  const acc = await api('/v1/accounts', {
    'type': 'custom', 'country': 'US', 'email': 'qa-smoke-dealer@rapqa.com',
    'capabilities[transfers][requested]': 'true', 'business_type': 'individual',
    'business_profile[mcc]': '5712', 'business_profile[product_description]': 'Lakeside Home Furnishings (test)',
    'individual[first_name]': 'QA', 'individual[last_name]': 'Dealer',
    'individual[email]': 'qa-smoke-dealer@rapqa.com', 'individual[phone]': '2015550123',
    'individual[dob][day]': '1', 'individual[dob][month]': '1', 'individual[dob][year]': '1990',
    'individual[address][line1]': 'address_full_match', 'individual[address][city]': 'Salt Lake City',
    'individual[address][state]': 'UT', 'individual[address][postal_code]': '84321',
    'individual[ssn_last_4]': '0000',
    'tos_acceptance[date]': String(Math.floor(ts / 1000)), 'tos_acceptance[ip]': '127.0.0.1',
    'external_account[object]': 'bank_account', 'external_account[country]': 'US', 'external_account[currency]': 'usd',
    'external_account[routing_number]': '110000000', 'external_account[account_number]': '000123456789'
  });
  ACCT = acc.id;
  await db(`/dealers?id=eq.${dealer.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { stripe_account_id: ACCT } });
}
/* fondos: los transfers salen del balance AVAILABLE (los cobros entran pending) → fondear si falta */
let bal = await api('/v1/balance');
if (bal.available[0].amount < 1000) {
  const pm = await api('/v1/payment_methods', { type: 'card', 'card[token]': 'tok_bypassPending' });
  await api('/v1/payment_intents', { amount: '10000', currency: 'usd', payment_method: pm.id, confirm: 'true', 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never', description: 'QA fund available balance (test)' });
  for (let i = 0; i < 10 && bal.available[0].amount < 1000; i++) { await sleep(3000); bal = await api('/v1/balance'); }
}
console.log(`FULL RUN · ${EMAIL} · dealer ${ACCT} · available $${bal.available[0].amount / 100}\n`);

/* ── 1 · venta REAL atribuida por referral code ── */
const co = await fetch(BASE + '/api/create-checkout-session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: EMAIL, plans: [{ cov: 'stain-mech', term: 'monthly', type: 'furniture', count: 1 }],
    kits: [], membership: false, full_name: 'QA FullRun', phone: '(555) 111-2222',
    address: '1 QA St, Test City UT 84321', receipt_path: `receipts/2026/07/${randomUUID()}.jpg`,
    referral_code: 'QAS-MOKE1'
  })
});
t(co.status === 200, `1. checkout real con código → ${co.status}`);
const leadQ = await db(`/leads?email=eq.${encodeURIComponent(EMAIL)}&select=id,payload&limit=1`);
const lead = leadQ.data && leadQ.data[0];
t(!!lead && lead.payload.dealer_id === dealer.id && lead.payload.attribution_source === 'referral_code', '1b. lead atribuido vía referral_code');

/* ── 2 · subscription real bajo TEST CLOCK ── */
const clock = await api('/v1/test_helpers/test_clocks', { frozen_time: String(Math.floor(ts / 1000)) });
const customer = await api('/v1/customers', { email: EMAIL, name: 'QA FullRun', test_clock: clock.id });
const pm = await api('/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' });
await api(`/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
await api(`/v1/customers/${customer.id}`, { 'invoice_settings[default_payment_method]': pm.id });
const sub = await api('/v1/subscriptions', {
  customer: customer.id, 'items[0][price]': env.STRIPE_PRICE_STAIN_MECH,
  'metadata[lead_id]': lead.id, payment_behavior: 'default_incomplete', 'expand[]': 'latest_invoice'
});
t(!!sub.id, `2. subscription bajo test clock (${sub.id})`);

/* ── 3 · checkout.session.completed FIRMADO (crea cuenta + rows atribuidas) ── */
const payload = JSON.stringify({
  id: `evt_qafull_${ts}`, object: 'event', type: 'checkout.session.completed',
  data: { object: { id: `cs_test_qafull_${ts}`, object: 'checkout.session', mode: 'subscription', payment_status: 'paid', client_reference_id: lead.id, subscription: sub.id, customer: customer.id, customer_email: EMAIL, metadata: { lead_id: lead.id } } }
});
const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WH });
const wh = await fetch(BASE + '/.netlify/functions/stripe-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body: payload });
t(wh.status === 200, `3. webhook session.completed → ${wh.status} (si es 400: el secret de .env no es el del CLI)`);
const srQ = await db(`/subscriptions?stripe_subscription_id=eq.${sub.id}&select=dealer_id,attribution_source,terms_version,master_no&limit=1`);
const sr = srQ.data && srQ.data[0];
t(!!sr && sr.dealer_id === dealer.id && sr.attribution_source === 'referral_code', '3b. subscription row atribuida');
t(!!sr && !!sr.terms_version && /^RX-/.test(sr.master_no || ''), `3c. terms ${sr && sr.terms_version} + master ${sr && sr.master_no}`);

/* ── 4 · mes 1: pagar la invoice → invoice.paid REAL → ledger + transfer ── */
const inv1 = typeof sub.latest_invoice === 'object' ? sub.latest_invoice.id : sub.latest_invoice;
await api(`/v1/invoices/${inv1}/pay`, { payment_method: pm.id });
console.log('  ····  mes 1 pagado; esperando webhook + transfer…');
const row1 = await pollLedger(inv1);
t(!!row1 && row1.status === 'transferred' && /^tr_/.test(row1.transfer_id || ''),
  `4. mes 1 → ledger ${row1 && row1.stripe_amount_cents}/${row1 && row1.reinsurance_amount_cents} + transfer ${row1 && row1.transfer_id}`);

/* ── 5 · mes 2: test clock +31d (+2h para que la invoice salga de draft) ── */
await api(`/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: String(Math.floor(ts / 1000) + 31 * 86400 + 2 * 3600) });
console.log('  ····  test clock avanzando 31 días…');
for (let i = 0; i < 60; i++) { const c = await api(`/v1/test_helpers/test_clocks/${clock.id}`); if (c.status === 'ready') break; await sleep(2000); }
const invList = await api(`/v1/invoices?subscription=${sub.id}&limit=5`);
let inv2 = invList.data.find((i) => i.id !== inv1);
t(!!inv2, `5. invoice del mes 2 (${inv2 && inv2.id}, ${inv2 && inv2.status})`);
if (inv2 && inv2.status === 'draft') { await api(`/v1/invoices/${inv2.id}/finalize`, {}); inv2 = await api(`/v1/invoices/${inv2.id}`); }
if (inv2 && inv2.status === 'open') { try { await api(`/v1/invoices/${inv2.id}/pay`, { payment_method: pm.id }); } catch (e) { console.log('  ····  pay inv2:', e.message); } }
const row2 = inv2 ? await pollLedger(inv2.id) : null;
t(!!row2 && row2.status === 'transferred', `5b. mes 2 → segunda fila + transfer ${row2 && row2.transfer_id}`);

/* ── 6 · el dinero y el reporte ── */
const trs = await api(`/v1/transfers?destination=${ACCT}&limit=20`);
const mine = trs.data.filter((tr) => tr.transfer_group === inv1 || (inv2 && tr.transfer_group === inv2.id));
t(mine.length >= 2, `6. ${mine.length} transfers de esta corrida en la connected account`);
const dbal = await api('/v1/balance', undefined, { 'Stripe-Account': ACCT });
console.log(`  ····  balance del dealer: $${dbal.available[0].amount / 100} available`);
const rein = await db(`/v_reinsurance_monthly?org_id=eq.${dealer.id}&select=master_no,reinsurance_amount_cents&order=paid_at.desc&limit=4`);
t(rein.status === 200 && rein.data.length >= 2, '6b. v_reinsurance_monthly con las asignaciones (reporte de underwriting)');

console.log(`\n── Creado (test, nada se borra): lead ${lead && lead.id} · ${customer.id} · ${sub.id} · clock ${clock.id} · transfers ${mine.map((m) => m.id).join(', ')}`);
console.log(`\nfull-run-live: ${count - fails}/${count}${fails ? ' — RED' : ' — GREEN'}`);
process.exit(fails ? 1 : 0);
