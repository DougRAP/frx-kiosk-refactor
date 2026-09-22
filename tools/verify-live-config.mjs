/* ============================================================================
 * verify-live-config.mjs — ¿el backend DESPLEGADO está en live y con qué claves?
 * ----------------------------------------------------------------------------
 * Responde la pregunta que no se puede contestar mirando el panel de Netlify:
 * cambiar una env var NO redespliega, así que el panel puede decir `sk_live_`
 * mientras las Functions siguen corriendo con la clave vieja. Esto interroga al
 * deploy, no a la configuración.
 *
 * CÓMO LO AVERIGUA, sin cobrar un centavo: pide una Checkout Session de solo
 * membership (el único carrito que no exige recibo ni planes) y mira el id que
 * devuelve Stripe. `cs_live_…` = clave live activa; `cs_test_…` = sigue en test.
 * La sesión se abandona: una Checkout Session sin pagar no cobra ni deja cargo.
 *
 * Uso:
 *   node tools/verify-live-config.mjs                                   # local (netlify dev :8888)
 *   node tools/verify-live-config.mjs --base https://furniturerx.netlify.app
 *   node tools/verify-live-config.mjs --base … --origin https://furniturerx.net
 *   node tools/verify-live-config.mjs --prices                          # + los 3 price IDs del .env LOCAL
 *
 * DEJA RASTRO: un lead con email `qa-verify@rapqa.com`. Es una fila inofensiva y
 * reconocible, del mismo estilo que los prefijos qa- de los otros smokes. Nunca
 * borra nada.
 * ==========================================================================*/

'use strict';

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (args.includes('--' + name) ? true : dflt);
};

const BASE = String(flag('base', 'http://localhost:8888')).replace(/\/+$/, '');
const ORIGIN = flag('origin', null);
const CHECK_PRICES = args.includes('--prices');

const QA_EMAIL = 'qa-verify@rapqa.com';

/* ── salida ─────────────────────────────────────────────────────────────── */
const ok = (s) => console.log('  \x1b[32mOK\x1b[0m    ' + s);
const bad = (s) => console.log('  \x1b[31mFALLA\x1b[0m ' + s);
const warn = (s) => console.log('  \x1b[33mOJO\x1b[0m   ' + s);
const info = (s) => console.log('        ' + s);

let failures = 0;
const fail = (s) => { failures++; bad(s); };

/* ── .env local, solo para --prices ─────────────────────────────────────── */
function localEnv() {
  const env = {};
  if (!existsSync('.env')) return env;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

/* ── 1) ¿responde el backend y en qué modo está? ────────────────────────── */
async function checkDeploy() {
  console.log('\n\x1b[1mBackend desplegado\x1b[0m  ' + BASE);

  const body = {
    email: QA_EMAIL,
    full_name: 'QA Verify',
    phone: '5550000000',
    address: '1 Verification Way, Testville',
    membership: true            // carrito mínimo: sin planes no hace falta recibo (BE-1)
  };
  const headers = { 'Content-Type': 'application/json' };
  if (ORIGIN) headers.Origin = ORIGIN;

  let res, text;
  try {
    res = await fetch(BASE + '/api/create-checkout-session', { method: 'POST', headers, body: JSON.stringify(body) });
    text = await res.text();
  } catch (err) {
    fail('el backend no responde: ' + err.message);
    info('¿está desplegado? ¿el --base es correcto? En local hace falta `netlify dev`.');
    return null;
  }

  let data = null; try { data = JSON.parse(text); } catch { /* no-json */ }

  if (res.status === 404) { fail('404 en /api/create-checkout-session — el proxy /api/* no está o el base es otro sitio'); return null; }
  if (!data) { fail('respuesta no-JSON (' + res.status + '): ' + text.slice(0, 160)); return null; }

  if (data.error) {
    fail('el checkout devolvió error: ' + data.error);
    if (data.error === 'stripe_error' || data.error === 'price_not_configured') {
      info('Suele ser un price ID de OTRO modo: Stripe no acepta un price de test con una clave live.');
      info('Revisa STRIPE_PRICE_MEMBERSHIP en el site del backend, y que haya redeploy después de guardarlo.');
    }
    if (data.error === 'invalid_body' || data.error === 'empty_cart') {
      info('El contrato del checkout cambió; este script hay que actualizarlo.');
    }
    return null;
  }

  if (!data.url) { fail('el checkout no devolvió url: ' + JSON.stringify(data).slice(0, 160)); return null; }

  ok('el backend responde y crea Checkout Sessions');

  /* El id de la sesión viaja en la URL de Stripe: cs_live_… | cs_test_… */
  const m = /\/(cs_(live|test)_[A-Za-z0-9]+)/.exec(data.url);
  if (!m) {
    warn('no se pudo leer el id de la sesión en la URL, Stripe cambió el formato');
    info(data.url.slice(0, 120));
    return null;
  }
  const mode = m[2];
  if (mode === 'live') ok('\x1b[1mSTRIPE_SECRET_KEY = LIVE\x1b[0m  (' + m[1].slice(0, 20) + '…)');
  else {
    warn('\x1b[1mSTRIPE_SECRET_KEY = TEST\x1b[0m  (' + m[1].slice(0, 20) + '…)');
    info('Si esperabas live: guardar la variable NO redespliega. Deploys → Trigger deploy → Deploy site.');
  }
  ok('STRIPE_PRICE_MEMBERSHIP existe en modo ' + mode + ' (si no, Stripe habría rechazado la sesión)');

  /* Nada de CORS aquí: los fronts llegan por el proxy /api/*, que es same-origin, así que
     estas Functions no emiten allow-origin y su ausencia NO es un fallo. ALLOWED_ORIGINS
     gobierna otra cosa: a qué origen se vuelve después de pagar (resolveReturnBase). */

  info('lead de verificación creado con ' + QA_EMAIL + '. La sesión se abandona: no hay cobro.');
  return mode;
}

/* ── 2) los 3 price IDs, contra el .env LOCAL (no el de Netlify) ────────── */
async function checkPrices() {
  console.log('\n\x1b[1mPrice IDs del .env LOCAL\x1b[0m');
  warn('esto valida TU .env, no lo que tiene Netlify. Son dos configuraciones distintas.');

  const env = localEnv();
  const key = env.STRIPE_SECRET_KEY;
  if (!key) { fail('no hay STRIPE_SECRET_KEY en .env'); return; }
  const keyMode = /^(sk|rk)_live_/.test(key) ? 'live' : 'test';
  info('la clave local es de modo ' + keyMode);

  for (const name of ['STRIPE_PRICE_STAIN', 'STRIPE_PRICE_STAIN_MECH', 'STRIPE_PRICE_MEMBERSHIP']) {
    const id = env[name];
    if (!id) { fail(name + ' no está definida'); continue; }
    let r;
    try {
      r = await fetch('https://api.stripe.com/v1/prices/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + key } });
    } catch (err) { fail(name + ': error de red ' + err.message); continue; }
    const d = await r.json().catch(() => null);
    if (r.status === 200 && d && d.id) {
      const amount = typeof d.unit_amount === 'number' ? ('$' + (d.unit_amount / 100).toFixed(2)) : '(sin importe fijo)';
      ok(name + ' → ' + amount + ' ' + (d.recurring ? '/' + d.recurring.interval : 'una vez'));
    } else if (r.status === 404) {
      fail(name + ' no existe en modo ' + keyMode + ' (¿es un price del otro modo?)');
    } else {
      fail(name + ': Stripe respondió ' + r.status + ' ' + ((d && d.error && d.error.code) || ''));
    }
  }
}

/* ── main ───────────────────────────────────────────────────────────────── */
console.log('\nverify-live-config — interroga al DEPLOY, no al panel de Netlify');

const mode = await checkDeploy();
if (CHECK_PRICES) await checkPrices();

console.log('\n\x1b[1mLo que esto NO comprueba\x1b[0m');
info('STRIPE_WEBHOOK_SECRET → Stripe Dashboard → Webhooks → Send test webhook (va firmado: un 200 valida el secreto).');
info('ALLOWED_ORIGINS       → no es CORS: decide a qué origen se vuelve tras pagar. Se verifica volviendo de Stripe.');
info('COMMISSIONS_ENABLED   → solo actúa en invoice.paid. Se verifica con la compra real del smoke test,');
info('                        mirando que aparezca la fila en commission_ledger. Debe ser el literal `true`.');
if (mode === 'live') info('STRIPE_PRICE_STAIN y _STAIN_MECH → los valida el primer checkout con plan (este carrito es solo membership).');

console.log(failures ? '\n\x1b[31m' + failures + ' problema(s)\x1b[0m\n' : '\n\x1b[32mSin problemas detectados\x1b[0m\n');
process.exit(failures ? 1 : 0);
