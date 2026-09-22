/* ============================================================================
 * Harness de regresión — Fase A (cero deps nuevas, Node nativo). Corre los gates y falla ruidoso
 * (exit 1). El oráculo central es G2: dist/index.html (d2c) debe coincidir —por hash NORMALIZADO—
 * con tools/gate/baseline.d2c.sha256 → prueba que un refactor no cambió comportamiento.
 *   Uso:  npm run gate            (corre todo)
 *         npm run gate:baseline   (recaptura el baseline — SOLO al cambiar comportamiento a propósito)
 * ==========================================================================*/
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashFile, norm } from './norm-hash.mjs';

let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.error(`  FAIL  ${m}`); fails++; };
const txt = (p) => existsSync(p) ? norm(readFileSync(p, 'utf8')) : '';
const has = (p, s) => txt(p).includes(s);
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe', shell: process.platform === 'win32' });

// G1 — build verde
try { sh('npm', ['run', 'build']); ok('G1 build exit 0'); }
catch (e) { bad('G1 build NON-ZERO: ' + e.message); }

// G2 — regresión d2c (ORÁCULO): dist/index.html === baseline (hash normalizado)
try {
  const baseline = readFileSync('tools/gate/baseline.d2c.sha256', 'utf8').trim();
  const got = hashFile('dist/index.html');
  got === baseline ? ok('G2 dist/index.html === baseline') : bad(`G2 HASH MISMATCH got=${got} want=${baseline}`);
} catch (e) { bad('G2 baseline ausente — corré `npm run gate:baseline`: ' + e.message); }

// G3 — kiosk AUTOCONTENIDO en /kiosk/ (carpeta propia editable por Doug: index.html + netlify.toml +
// qrcode.min.js, deploy independiente con /api proxeado). NO se emite a dist/ (el site principal solo
// sirve el d2c). Se verifica en la FUENTE: class="kiosk" horneada, CSS inline (#d4541e), sin marcador.
(existsSync('kiosk/index.html') && existsSync('kiosk/netlify.toml') && existsSync('kiosk/qrcode.min.js')
  && has('kiosk/index.html', 'class="kiosk"')
  && !has('kiosk/index.html', '__CORE_CSS_INJECT__') && has('kiosk/index.html', '#d4541e'))
  ? ok('G3 kiosk autocontenido (/kiosk, no en dist, CSS inline, class horneada)')
  : bad('G3 kiosk no autocontenido / falta index|netlify.toml|qrcode / class / CSS');

// G4 — inject ocurrió en d2c: marcador ausente + firma de core.css presente (#d4541e = --orange)
(!has('dist/index.html', '__CORE_CSS_INJECT__') && has('dist/index.html', '#d4541e'))
  ? ok('G4 CSS inyectado (sin marcador, firma presente)') : bad('G4 marcador filtrado o CSS no inyectado');

// G6 — node --check en TODAS las functions (recursivo, incluye _lib/)
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.mjs') ? [join(d, e.name)] : []);
let g6 = true;
for (const f of walk('netlify/functions')) {
  try { sh('node', ['--check', f]); } catch { bad(`G6 node --check ${f}`); g6 = false; }
}
if (g6) ok('G6 node --check en todas las functions');

// G7 — netlify.toml intacta (chequeos textuales mínimos del contrato de deploy)
for (const needle of [
  'command = "npm run build"', 'publish = "dist"', 'directory = "netlify/functions"',
  'from = "/api/*"', 'to = "/.netlify/functions/:splat"', 'status = 200'
]) has('netlify.toml', needle) ? ok(`G7 toml: ${needle}`) : bad(`G7 toml FALTA: ${needle}`);

// G8 — copy-set completo de dist
for (const p of ['dist/dashboard.html', 'dist/account.html', 'dist/terms/index.html', 'dist/kit_assets'])
  existsSync(p) ? ok(`G8 ${p}`) : bad(`G8 falta ${p}`);

// G13 — paridad de pricing MONTHLY: el server canónico (validate.mjs PRICE_CENTS) vs lo que muestra el
// front (dist) y lo que cita Maya (chat.mjs). Atrapa el drift peligroso (server cobra X / display muestra Y).
{
  const m = txt('netlify/functions/_lib/validate.mjs')
    .match(/PRICE_CENTS\s*=\s*\{\s*'stain'\s*:\s*(\d+)\s*,\s*'stain-mech'\s*:\s*(\d+)/);
  if (!m) bad('G13 no pude leer PRICE_CENTS de validate.mjs');
  else {
    const dollar = (cents) => '$' + (Number(cents) / 100).toFixed(2);   // 999 → $9.99
    const stain = dollar(m[1]), mech = dollar(m[2]);
    for (const [src, name] of [[txt('dist/index.html'), 'front'], [txt('netlify/functions/chat.mjs'), 'Maya']])
      (src.includes(stain) && src.includes(mech))
        ? ok(`G13 monthly ${name}: ${stain} / ${mech}`)
        : bad(`G13 monthly drift en ${name} (faltan ${stain}/${mech})`);
  }
}

// G13b — Maya NO cita precios YEARLY (política 01-jul): el yearly es display-only en index.html PLANS,
// NO comprable (validate.mjs lo rechaza) y sus números aún no los confirma Doug (email 01-jul §7 Q5) →
// Maya remite a las plan cards, nunca promete un nº anual. Anti-regresión: ningún precio yearly conocido
// debe reaparecer en chat.mjs (evita el drift chat-vs-página que motivó esta limpieza).
{
  const maya = txt('netlify/functions/chat.mjs');
  const banned = ['109.99', '219.99', '79.99', '99.99'];   // precios yearly viejos que Maya citaba
  const leaked = banned.filter((n) => maya.includes(n));
  leaked.length
    ? bad(`G13b Maya cita precio(s) yearly no confirmados: ${leaked.join(', ')}`)
    : ok('G13b Maya no cita precios yearly (display-only en la página)');
}

// G14 — CA-4 required-data guard: el server detecta faltantes (nº orden / tipo de mueble) y fuerza
// needs_review para que Maya re-pregunte. Corre en subproceso (aísla gate.mjs del SDK de Anthropic).
try { sh('node', ['tools/gate/ca4.test.mjs']); ok('G14 CA-4 guard (nº orden / tipo de mueble)'); }
catch (e) { bad('G14 CA-4 guard: ' + (e.stdout ? e.stdout.toString() : e.message)); }

// G15 — Paso 2: el webhook copia el sales_associate del lead → la subscription (atribución del associate
// del kiosk para conciliar comisión). Anti-regresión del wiring (la columna la agrega la migración
// 20260701120000_subscriptions_sales_associate.sql).
has('netlify/functions/stripe-webhook.mjs', 'sales_associate: p.sales_associate')
  ? ok('G15 webhook copia sales_associate (atribución kiosk)')
  : bad('G15 webhook NO copia sales_associate al crear la subscription');

// G16 — single-QR handoff (recibo + pago en el teléfono): endpoints + helper compartido + token +
// modo teléfono cableados. Anti-regresión del wiring (la tabla la agrega 20260701130000_kiosk_handoffs.sql).
(existsSync('netlify/functions/kiosk-handoff.mjs') && existsSync('netlify/functions/kiosk-handoff-complete.mjs')
  && existsSync('netlify/functions/_lib/checkout.mjs')
  && has('netlify/functions/_lib/token.mjs', 'signHandoffToken')
  && has('kiosk/index.html', 'phone-handoff') && has('kiosk/index.html', '/api/kiosk-handoff'))
  ? ok('G16 single-QR handoff (endpoints + helper + token + modo teléfono)')
  : bad('G16 falta una pieza del single-QR handoff');

// G17 — SEC-1: ningún sitio estático sirve un .env. Los 4 netlify.toml deben bloquear /.env con un
// 404 FORZADO (force=true gana sobre el archivo estático → no se sirve ni existiendo). Detalle completo
// en tools/tests/sec1-dotfiles.test.mjs (lo corre `npm test`); acá el contrato mínimo del deploy, como G7.
{
  const envRule = (p) => /\[\[redirects\]\][^[]*from\s*=\s*"\/\.env"[^[]*status\s*=\s*404[^[]*force\s*=\s*true/.test(txt(p));
  for (const p of ['netlify.toml', 'kiosk/netlify.toml', 'tech/netlify.toml', 'portal/netlify.toml'])
    envRule(p) ? ok(`G17 ${p} bloquea /.env (404 forzado)`) : bad(`G17 ${p} NO bloquea /.env — secreto servible si se deploya a mano`);
}

// G18 — SEC-2: el rate limiter no vuelve al fail-open ciego ni a contar solo por IP.
// Contrato mínimo en la fuente (el detalle fino lo cubre tools/tests/sec2-ratelimit.test.mjs):
//   (a) ante un fallo del backend se degrada a un contador local acotado, no a `allowed:true`;
//   (b) auth-login y auth-otp aplican un segundo bucket por CUENTA (subject) encima del de IP.
{
  const rlSrc = txt('netlify/functions/_lib/ratelimit.mjs');
  (rlSrc.includes('localHit(') && rlSrc.includes('LOCAL_MAX_KEYS') && !/catch \(e\) \{[^}]*allowed: true/.test(rlSrc))
    ? ok('G18 ratelimit degrada a contador local (sin fail-open ciego)')
    : bad('G18 ratelimit volvió al fail-open ciego — un hipo de Supabase deja las Functions sin freno');
  for (const [p, needles] of [
    ['netlify/functions/auth-login.mjs', ['subject: email', 'auth-login-u']],
    ['netlify/functions/auth-otp.mjs', ['subject: email', 'otp-ver-u', 'otp-req-u']]   // verify y request, buckets separados
  ]) {
    const s = txt(p);
    needles.every((n) => s.includes(n))
      ? ok(`G18 ${p} limita por cuenta (${needles.length - 1} bucket/s de subject)`)
      : bad(`G18 ${p} NO limita por cuenta — fuerza bruta distribuida entre IPs sin freno`);
  }
}

// G19 — SEC-3a: la contraseña temporal caduca y el cambio obligatorio lo aplica el SERVER.
// Contrato mínimo en la fuente (el detalle fino lo cubre tools/tests/sec3a-temppw.test.mjs):
//   (a) requireUser corta con 403 mientras el cambio esté pendiente — sin esto, la pantalla
//       de cambio de account.html vuelve a ser decorativa frente a un curl;
//   (b) el webhook sella temp_password_at — sin el sello no hay nada que caducar;
//   (c) auth-login consulta la caducidad antes de emitir la sesión.
{
  (txt('netlify/functions/_lib/auth.mjs').includes('password_change_required') && existsSync('netlify/functions/_lib/temppw.mjs'))
    ? ok('G19 requireUser aplica el cambio obligatorio (403 server-side)')
    : bad('G19 requireUser NO aplica el cambio obligatorio — la temporal vuelve a servir contra la API');
  has('netlify/functions/stripe-webhook.mjs', 'temp_password_at')
    ? ok('G19 el webhook sella la emisión de la temporal')
    : bad('G19 el webhook NO sella temp_password_at — la temporal no puede caducar');
  has('netlify/functions/auth-login.mjs', 'tempPasswordExpired')
    ? ok('G19 auth-login comprueba la caducidad antes de emitir sesión')
    : bad('G19 auth-login NO comprueba la caducidad — el welcome email vuelve a ser credencial permanente');
}

// G20 — SEC-3b: no se radican service requests sobre contratos de otro dealer. El POST debe
// resolver el contrato contra subscriptions filtrando por dealer_id antes de insertar (el GET y el
// PATCH ya filtraban por org). Detalle fino en tools/tests/sec3b-sr-scope.test.mjs.
{
  const sr = txt('netlify/functions/portal-service-requests.mjs');
  (sr.includes('/subscriptions?master_no=eq.') && sr.includes('dealer_id=eq.'))
    ? ok('G20 portal-service-requests comprueba la propiedad del contrato al crear')
    : bad('G20 el POST de service requests NO comprueba propiedad — un dealer puede radicar sobre clientes de otro');
}

// G21 — SEC-3c: el export CSV neutraliza fórmulas. Escapar comillas y comas no basta: una celda que
// empieza por = + - @ la ejecuta Excel, y First/Last salen del nombre que escribe el propio cliente.
// Detalle fino en tools/tests/sec3c-csv-injection.test.mjs.
{
  const p = txt('netlify/functions/_lib/portal.mjs');
  (p.includes('CSV_FORMULA_START') && /export function toCSV[\s\S]{0,400}CSV_FORMULA_START\.test/.test(p))
    ? ok('G21 toCSV neutraliza fórmulas (CSV injection)')
    : bad('G21 toCSV NO neutraliza fórmulas — el nombre del cliente vuelve a ejecutarse en el Excel del admin');
}

// G22 — SEC-2b: la misma comisión de Connect no se paga dos veces. Antes de tocar Stripe la fila del
// ledger se RECLAMA con un UPDATE condicional (atómico bajo lock de fila); sin eso, dos entregas
// concurrentes de invoice.paid crean dos transfers. Anti-regresión doble: la Idempotency-Key debe
// seguir siendo POR INTENTO (una fija hacía que Stripe repitiera 24h un balance_insufficient, corrida
// del 15-jul). Detalle fino en tools/tests/sec2b-commission-race.test.mjs.
{
  const c = txt('netlify/functions/_lib/commissions.mjs');
  (c.includes("status: 'transferring'") && c.includes('return=representation') && c.includes('CLAIM_TTL_MS'))
    ? ok('G22 el transfer de comisión se reclama de forma atómica (sin doble pago)')
    : bad('G22 el transfer de comisión NO se reclama — dos entregas concurrentes de invoice.paid pagan dos veces');
  /Idempotency-Key.*Date\.now\(\)/.test(c)
    ? ok('G22 la Idempotency-Key sigue siendo por intento (aprendizaje del 15-jul)')
    : bad('G22 la Idempotency-Key dejó de ser por intento — Stripe repetirá 24h el error original');
  existsSync('supabase/migrations/20260728120000_commission_claim.sql')
    ? ok('G22 la migración del estado de reclamo está en el repo')
    : bad('G22 falta la migración del reclamo — sin ella el estado intermedio no existe');
}

console.log(`\n${fails ? `RED — ${fails} gate(s) fallaron` : 'GREEN — todos los gates pasan'}`);
process.exit(fails ? 1 : 0);
