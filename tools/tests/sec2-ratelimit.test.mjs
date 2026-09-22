/* ============================================================================
 * SEC-2 — el rate limiting ya no se abre sola ante fallos ni cuenta solo por IP.
 * Hallazgo 2 de misc/auditoria-seguridad-jul28.html. Spec: misc/spec-sec2-ratelimit.md.
 *
 * Dos capas bajo prueba:
 *   4a  backend caído → degradado a un contador LOCAL (antes: barra libre)
 *   4b  la key admite `subject` (cuenta) además de `ip`, y auth-login / auth-otp
 *       aplican un segundo límite por cuenta encima del de IP.
 * Compatibilidad: con el backend sano y solo `ip`, el veredicto y la KEY son los
 * de siempre — los 38 llamadores existentes no cambian de comportamiento.
 * ==========================================================================*/
import { makeT, sleep } from './helpers.mjs';
import { createHash } from 'node:crypto';

const t = makeT('sec2-ratelimit');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.RATE_LIMIT_SALT = 'salt-de-test';
const env = process.env;

/* Mock del RPC. `mode` gobierna qué le pasa al backend; `seen` guarda los bodies. */
let mode = 'ok';
let seen = [];
const S = (i) => seen[i] || {};   // acceso tolerante: un bucket que falta no debe tumbar el runner
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('rate_limit_hit')) {
    seen.push(JSON.parse(opts.body));
    if (mode === 'throw') throw new Error('network down');
    if (mode === 'status') return new Response('{}', { status: 503 });
    if (mode === 'shape') return new Response('[]', { status: 200 });          // forma inesperada
    if (mode === 'hang') { await sleep(3000); return new Response('[]', { status: 200 }); }
    if (mode === 'deny') return new Response(JSON.stringify([{ allowed: false, hits: 99, retry_after: 42 }]), { status: 200 });
    return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });
  }
  if (u.includes('/auth/v1/token')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  if (u.includes('/auth/v1/otp')) return new Response('{}', { status: 200 });
  if (u.includes('/auth/v1/verify')) return new Response(JSON.stringify({ error: 'otp_expired' }), { status: 401 });
  throw new Error('unexpected fetch ' + u);
};

const rl = await import('../../netlify/functions/_lib/ratelimit.mjs');
const { checkRate, clientIp } = rl;

/* ── Compatibilidad: backend sano + solo `ip` = comportamiento y KEY de siempre ── */
{
  mode = 'ok'; seen = [];
  const r = await checkRate(env, { prefix: 'compat', ip: '1.2.3.4', limit: 5, windowSec: 60 });
  t(r.allowed === true && !r.degraded, 'sano: allowed=true del backend, sin marca de degradado');

  const legacy = 'compat:' + createHash('sha256').update('1.2.3.4' + 'salt-de-test').digest('hex').slice(0, 32);
  t(S(0).p_key === legacy, 'sano: la key por IP es EXACTAMENTE la de antes (hash(ip+salt), sin prefijo nuevo)');
  t(S(0).p_limit === 5 && S(0).p_window_seconds === 60, 'sano: limit y ventana viajan tal cual al RPC');

  mode = 'deny';
  const d = await checkRate(env, { prefix: 'compat', ip: '1.2.3.4', limit: 5, windowSec: 60 });
  t(d.allowed === false && d.retryAfter === 42, 'sano: el backend niega → allowed=false con su retry_after');
}

/* ── 4b: `subject` produce una key propia, distinta del espacio de las IPs ── */
{
  mode = 'ok'; seen = [];
  await checkRate(env, { prefix: 'k', subject: 'ana@ej.co', limit: 5, windowSec: 60 });
  const bySubject = S(0).p_key;
  seen = [];
  await checkRate(env, { prefix: 'k', ip: 'ana@ej.co', limit: 5, windowSec: 60 });
  const byIp = S(0).p_key;
  t(bySubject !== byIp, 'subject: la MISMA cadena como subject y como ip da keys distintas (espacios separados)');
  t(bySubject.startsWith('k:'), 'subject: conserva el prefix del llamador');

  seen = [];
  await checkRate(env, { prefix: 'k', subject: 'ana@ej.co', ip: '9.9.9.9', limit: 5, windowSec: 60 });
  t(S(0).p_key === bySubject, 'subject: cuando hay subject, manda el subject (la ip no entra en la key)');
}

/* ── 4a: el backend caído YA NO es barra libre ── */
for (const failMode of ['throw', 'status', 'shape']) {
  mode = failMode;
  const prefix = 'down-' + failMode;
  const opts = { prefix, ip: '5.5.5.5', limit: 3, windowSec: 60 };
  const got = [];
  for (let i = 0; i < 5; i++) got.push(await checkRate(env, opts));
  t(got.slice(0, 3).every((r) => r.allowed === true), `caído (${failMode}): las primeras 3 (= limit) pasan`);
  t(got[3].allowed === false && got[4].allowed === false, `caído (${failMode}): a partir de la 4ª BLOQUEA (antes: barra libre)`);
  t(got[3].retryAfter >= 1, `caído (${failMode}): el bloqueo trae retryAfter >= 1`);
  t(got.every((r) => r.degraded === true), `caído (${failMode}): la respuesta se marca degraded:true`);
}

/* ── 4a: el timeout también degrada (no permite en silencio) ── */
{
  mode = 'hang';
  const opts = { prefix: 'down-hang', ip: '5.5.5.5', limit: 1, windowSec: 60, timeoutMs: 50 };
  const a = await checkRate(env, opts);
  const b = await checkRate(env, opts);
  t(a.allowed === true && a.degraded === true, 'timeout: la 1ª pasa pero marcada degradada');
  t(b.allowed === false, 'timeout: la 2ª (> limit) bloquea — el timeout ya no es barra libre');
}

/* ── 4a: el contador local respeta la ventana y aísla keys ── */
{
  mode = 'throw';
  const mk = (prefix, ip) => ({ prefix, ip, limit: 1, windowSec: 1 });
  await checkRate(env, mk('win', '7.7.7.7'));
  t((await checkRate(env, mk('win', '7.7.7.7'))).allowed === false, 'ventana local: dentro de la ventana bloquea');
  t((await checkRate(env, mk('win', '8.8.8.8'))).allowed === true, 'aislamiento local: otra IP tiene su propio contador');
  t((await checkRate(env, mk('otro', '7.7.7.7'))).allowed === true, 'aislamiento local: otro prefix tiene su propio contador');
  await sleep(1100);
  t((await checkRate(env, mk('win', '7.7.7.7'))).allowed === true, 'ventana local: pasada la ventana vuelve a permitir');
}

/* ── 4a: la memoria del contador local está acotada ── */
{
  mode = 'throw';
  const hasDiag = typeof rl.localBucketCount === 'function' && typeof rl.LOCAL_MAX_KEYS === 'number';
  t(hasDiag, 'diagnóstico: el helper expone localBucketCount() y LOCAL_MAX_KEYS');
  if (hasDiag) {
    for (let i = 0; i < rl.LOCAL_MAX_KEYS + 1000; i++) await checkRate(env, { prefix: 'cap', ip: 'ip-' + i, limit: 5, windowSec: 600 });
    t(rl.localBucketCount() <= rl.LOCAL_MAX_KEYS, `memoria: el mapa local no supera el cap (${rl.localBucketCount()} <= ${rl.LOCAL_MAX_KEYS})`);
    t(rl.LOCAL_MAX_KEYS > 0 && rl.LOCAL_MAX_KEYS <= 20000, 'memoria: el cap es un número sano');
  } else {
    t(false, 'memoria: el mapa local no supera el cap (sin diagnóstico expuesto)');
    t(false, 'memoria: el cap es un número sano (sin diagnóstico expuesto)');
  }
}

/* ── clientIp: sin cambios (el vector del XFF lo cubre el bucket por cuenta) ── */
{
  const h = (o) => new Request('https://x.test', { headers: o });
  t(clientIp(h({ 'x-nf-client-connection-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9' })) === '1.1.1.1',
    'clientIp: manda el header del edge de Netlify sobre x-forwarded-for');
  t(clientIp(h({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8' })) === '9.9.9.9', 'clientIp: fallback dev = primer XFF');
  t(clientIp(h({})) === 'unknown', 'clientIp: sin nada → "unknown"');
}

/* ── 4b en auth-login: el límite por CUENTA se suma al de IP ── */
{
  mode = 'ok'; seen = [];
  const login = (await import('../../netlify/functions/auth-login.mjs')).default;
  const post = (body) => login(new Request('https://site.test/api/auth-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));

  await post({ email: 'Ana@Ej.CO', password: 'secret123' });
  t(seen.length === 2, 'auth-login: dos buckets por intento (IP + cuenta)');
  t(S(0).p_limit === 5 && S(0).p_window_seconds === 60, 'auth-login: el límite por IP existente NO cambia (5/60s)');
  t(S(1).p_limit === 20 && S(1).p_window_seconds === 900, 'auth-login: el límite por cuenta es 20/15min');
  t(S(0).p_key !== S(1).p_key, 'auth-login: los dos buckets son independientes');

  /* La key de cuenta usa el email CANÓNICO → Ana@Ej.CO y ana@ej.co comparten bucket. */
  seen = [];
  await post({ email: 'ana@ej.co', password: 'secret123' });
  const canon = S(1).p_key;
  seen = [];
  await post({ email: '  ANA@ej.co ', password: 'secret123' });
  t(S(1).p_key === canon, 'auth-login: el bucket de cuenta usa el email canónico (no se evade cambiando mayúsculas)');

  /* Email inválido → uniforme 401 sin quemar el bucket de cuenta (no hay cuenta que contar). */
  seen = [];
  const bad = await post({ email: 'no-es-email', password: 'x'.repeat(9) });
  t(bad.status === 401 && seen.length === 1, 'auth-login: email malformado → solo el bucket por IP, y el mismo 401 uniforme');

  /* Cuenta pasada de vueltas → 429 aunque la IP esté limpia. */
  let n = 0;
  mode = 'custom';
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('rate_limit_hit')) {
      const b = JSON.parse(opts.body);
      n++;
      const denyAccount = b.p_limit === 20;   // el bucket de cuenta dice basta; el de IP está sano
      return new Response(JSON.stringify([{ allowed: !denyAccount, hits: 1, retry_after: denyAccount ? 300 : 0 }]), { status: 200 });
    }
    return prevFetch(url, opts);
  };
  const res = await post({ email: 'ana@ej.co', password: 'secret123' });
  const body = await res.json();
  globalThis.fetch = prevFetch; mode = 'ok';
  t(res.status === 429 && body.error === 'rate_limited', 'auth-login: cuenta pasada de vueltas → 429 rate_limited aunque la IP esté limpia');
  t(res.headers.get('Retry-After') === '300', 'auth-login: el 429 por cuenta trae Retry-After');
  t(n === 2, 'auth-login: el bucket de IP se evalúa primero (sigue siendo la primera barrera)');
}

/* ── 4b en auth-otp: límite por cuenta en los DOS modos, con prefijos distintos ── */
{
  mode = 'ok'; seen = [];
  const otp = (await import('../../netlify/functions/auth-otp.mjs')).default;
  const post = (body) => otp(new Request('https://site.test/api/auth-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));

  await post({ email: 'ana@ej.co' });
  t(seen.length === 2, 'auth-otp request: dos buckets (IP + cuenta)');
  t(S(0).p_limit === 3 && S(1).p_limit === 5 && S(1).p_window_seconds === 900,
    'auth-otp request: IP 3/60s intacto + cuenta 5/15min (frena el mail bombing a una víctima)');
  const reqKey = S(1).p_key;

  seen = [];
  await post({ email: 'ana@ej.co', code: '123456' });
  t(seen.length === 2, 'auth-otp verify: dos buckets (IP + cuenta)');
  t(S(0).p_limit === 8 && S(1).p_limit === 10 && S(1).p_window_seconds === 900,
    'auth-otp verify: IP 8/60s intacto + cuenta 10/15min (frena la fuerza bruta del código)');
  t(S(1).p_key !== reqKey, 'auth-otp: pedir y verificar usan buckets de cuenta SEPARADOS');

  /* Cuenta pasada de vueltas en verify → 429 (no 401), aunque la IP esté limpia. */
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('rate_limit_hit')) {
      const b = JSON.parse(opts.body);
      const deny = b.p_window_seconds === 900;
      return new Response(JSON.stringify([{ allowed: !deny, hits: 1, retry_after: deny ? 120 : 0 }]), { status: 200 });
    }
    return prevFetch(url, opts);
  };
  const res = await post({ email: 'ana@ej.co', code: '123456' });
  globalThis.fetch = prevFetch;
  t(res.status === 429 && (await res.json()).error === 'rate_limited',
    'auth-otp verify: cuenta pasada de vueltas → 429 (el código deja de ser fuerza-bruta-able desde muchas IPs)');

  /* Email malformado en verify → 401 de siempre, sin bucket de cuenta. */
  seen = [];
  const bad = await post({ email: 'no-es-email', code: '123456' });
  t(bad.status === 401 && seen.length === 1, 'auth-otp verify: email malformado → 401 de siempre, sin bucket de cuenta');
}

/* ── auth-set-password: deliberadamente SIN bucket de cuenta (spec §4b) ── */
{
  mode = 'ok'; seen = [];
  const setpw = (await import('../../netlify/functions/auth-set-password.mjs')).default;
  await setpw(new Request('https://site.test/api/auth-set-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: 'at_1', password: 'nuevaClave9' })
  })).catch(() => {});
  t(seen.length === 1 && S(0).p_limit === 5, 'set-password: sigue con UN solo bucket por IP (el token no es un objetivo adivinable)');
}

t.done();
