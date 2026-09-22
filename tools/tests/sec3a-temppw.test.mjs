/* ============================================================================
 * SEC-3a — la contraseña temporal caduca y el cambio obligatorio lo aplica el SERVER.
 * Hallazgo 3 de misc/auditoria-seguridad-jul28.html. Spec: misc/spec-sec3a-temp-password.md.
 *
 * Dos capas bajo prueba:
 *   4a  la temporal tiene ventana (TEMP_PASSWORD_TTL_DAYS, 7 por defecto): pasada,
 *       auth-login NO emite sesión. El OTP sigue funcionando (vía de recuperación).
 *   4b  requireUser devuelve 403 password_change_required mientras el cambio esté
 *       pendiente → el token de la temporal deja de servir contra la API.
 * Compatibilidad: una cuenta SIN el flag no cambia en nada, y el front no se toca.
 * ==========================================================================*/
import { makeT } from './helpers.mjs';

const t = makeT('sec3a-temppw');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const env = process.env;

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const SESSION = { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, token_type: 'bearer' };

/* Usuario que devuelve GoTrue. `gtUser` lo gobierna en todos los mocks. */
let gtUser = { id: 'u1', email: 'a@b.co', created_at: iso(0), user_metadata: {} };
const tempUser = (over) => ({ id: 'u1', email: 'a@b.co', created_at: iso(0), user_metadata: { must_change_password: true }, ...over });

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });
  if (u.includes('/auth/v1/token')) return new Response(JSON.stringify({ ...SESSION, user: gtUser }), { status: 200 });
  if (u.includes('/auth/v1/verify')) return new Response(JSON.stringify({ ...SESSION, user: gtUser }), { status: 200 });
  if (u.includes('/auth/v1/otp')) return new Response('{}', { status: 200 });
  if (u.includes('/auth/v1/user')) {
    if (method === 'PUT') return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
    return new Response(JSON.stringify(gtUser), { status: 200 });
  }
  if (u.includes('/rest/v1/')) return new Response('[]', { status: 200 });
  throw new Error('unexpected fetch ' + u);
};

/* ── 4a: el helper de caducidad ── */
{
  const mod = await import('../../netlify/functions/_lib/temppw.mjs').catch(() => null);
  t(!!mod, 'existe _lib/temppw.mjs (la regla vive en UN solo sitio)');
  const pending = (mod && mod.pendingChange) || (() => { throw new Error('sin helper'); });
  const expired = (mod && mod.tempPasswordExpired) || (() => { throw new Error('sin helper'); });
  const safe = (fn, ...a) => { try { return fn(...a); } catch { return '<sin helper>'; } };

  t(safe(pending, tempUser()) === true, 'pendingChange: flag activo → true');
  t(safe(pending, { user_metadata: {} }) === false, 'pendingChange: sin flag → false');
  t(safe(pending, null) === false, 'pendingChange: usuario ausente → false (no revienta)');

  const e = { TEMP_PASSWORD_TTL_DAYS: '7' };
  t(safe(expired, tempUser({ user_metadata: { must_change_password: true, temp_password_at: iso(2 * DAY) } }), e) === false,
    'caducidad: temporal de hace 2 días con ventana de 7 → NO caducada');
  t(safe(expired, tempUser({ user_metadata: { must_change_password: true, temp_password_at: iso(9 * DAY) } }), e) === true,
    'caducidad: temporal de hace 9 días con ventana de 7 → CADUCADA');
  t(safe(expired, tempUser({ created_at: iso(30 * DAY) }), e) === true,
    'caducidad: sin sello, cae a created_at → una cuenta vieja con temporal pendiente caduca');
  t(safe(expired, tempUser({ created_at: iso(1 * DAY) }), e) === false,
    'caducidad: sin sello pero recién creada → NO caducada');
  t(safe(expired, tempUser({ created_at: undefined }), e) === false,
    'caducidad: sin ninguna fecha utilizable → NO se juzga (nadie queda fuera por un dato ilegible)');
  t(safe(expired, tempUser({ created_at: 'no-es-fecha', user_metadata: { must_change_password: true, temp_password_at: 'basura' } }), e) === false,
    'caducidad: fechas corruptas → NO se juzga');
  t(safe(expired, { created_at: iso(999 * DAY), user_metadata: {} }, e) === false,
    'caducidad: sin cambio pendiente NUNCA caduca nada (una cuenta normal no se toca)');

  t(safe(expired, tempUser({ created_at: iso(30 * DAY) }), { TEMP_PASSWORD_TTL_DAYS: '0' }) === false,
    'palanca: TTL 0 desactiva la caducidad sin desplegar');
  t(safe(expired, tempUser({ created_at: iso(30 * DAY) }), { TEMP_PASSWORD_TTL_DAYS: 'xx' }) === false,
    'palanca: TTL no numérico → desactivada (no se inventa una ventana)');
  t(safe(expired, tempUser({ created_at: iso(30 * DAY) }), {}) === true,
    'default: sin env, la ventana por defecto (7 días) SÍ aplica');
  t(safe(expired, tempUser({ created_at: iso(3 * DAY) }), {}) === false,
    'default: 3 días está dentro de la ventana por defecto');
}

/* ── 4a en auth-login: dentro de la ventana todo sigue igual ── */
{
  const login = (await import('../../netlify/functions/auth-login.mjs')).default;
  const post = (body) => login(new Request('https://site.test/api/auth-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));

  gtUser = { id: 'u1', email: 'a@b.co', created_at: iso(0), user_metadata: {} };
  let res = await post({ email: 'a@b.co', password: 'secret123' });
  let d = await res.json();
  t(res.status === 200 && d.access_token === 'at_1', 'login normal (sin flag): sesión intacta, sin regresión');
  t(!('must_change_password' in d), 'login normal: el aviso no aparece donde no debe');

  gtUser = tempUser({ user_metadata: { must_change_password: true, temp_password_at: iso(1 * DAY) } });
  res = await post({ email: 'a@b.co', password: 'Temp-1234-Xyz9' });
  d = await res.json();
  t(res.status === 200 && d.access_token === 'at_1' && d.must_change_password === true,
    'login con temporal VIGENTE: sesión + aviso, exactamente como antes (el front no cambia)');

  /* Caducada → 401 y NINGÚN token. */
  gtUser = tempUser({ user_metadata: { must_change_password: true, temp_password_at: iso(40 * DAY) } });
  res = await post({ email: 'a@b.co', password: 'Temp-1234-Xyz9' });
  d = await res.json();
  t(res.status === 401, 'login con temporal CADUCADA: 401');
  t(!d.access_token && !d.refresh_token, 'login con temporal caducada: NO se emite ningún token');
  t(d.error === 'temp_password_expired', 'login con temporal caducada: código propio para dejar rastro en el server');

  /* Cuenta vieja sin sello: cae a created_at. */
  gtUser = tempUser({ created_at: iso(60 * DAY) });
  res = await post({ email: 'a@b.co', password: 'Temp-1234-Xyz9' });
  t(res.status === 401, 'login: cuenta vieja con temporal pendiente y sin sello también caduca (por created_at)');

  /* La palanca de emergencia funciona de punta a punta. */
  env.TEMP_PASSWORD_TTL_DAYS = '0';
  res = await post({ email: 'a@b.co', password: 'Temp-1234-Xyz9' });
  d = await res.json();
  t(res.status === 200 && d.access_token === 'at_1', 'login: con TTL 0 la caducidad se desactiva de punta a punta');
  delete env.TEMP_PASSWORD_TTL_DAYS;
}

/* ── 4a: el OTP sigue siendo la salida (no se toca) ── */
{
  const otp = (await import('../../netlify/functions/auth-otp.mjs')).default;
  const post = (body) => otp(new Request('https://site.test/api/auth-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));

  gtUser = tempUser({ created_at: iso(90 * DAY) });   // temporal caducadísima
  const res = await post({ email: 'a@b.co', code: '123456' });
  const d = await res.json();
  t(res.status === 200 && d.access_token === 'at_1',
    'OTP: con la temporal caducada el código SIGUE entrando (nadie queda sin acceso)');
  t(d.must_change_password === true, 'OTP: y el aviso de cambio viaja igual, así que el front pide la nueva');
}

/* ── 4b: requireUser aplica el cambio obligatorio en el SERVER ── */
{
  const { requireUser, AuthError } = await import('../../netlify/functions/_lib/auth.mjs');
  const withBearer = (tok) => new Request('https://site.test/api/x', { headers: { Authorization: 'Bearer ' + (tok || 'at_1') } });
  const grab = async (req) => { try { return { ok: await requireUser(req, env) }; } catch (e) { return { err: e }; } };

  gtUser = { id: 'u1', email: 'a@b.co', created_at: iso(0), user_metadata: {} };
  let r = await grab(withBearer());
  t(r.ok && r.ok.userId === 'u1' && r.ok.email === 'a@b.co', 'requireUser: usuario normal → pasa igual que antes');

  gtUser = tempUser();
  r = await grab(withBearer());
  t(r.err instanceof AuthError, 'requireUser: cambio pendiente → AuthError');
  t(r.err && r.err.status === 403, 'requireUser: es 403, no 401 (el token vale; falta una acción del usuario)');
  t(r.err && r.err.code === 'password_change_required', 'requireUser: código explícito password_change_required');

  /* Caducada o no, mientras el cambio esté pendiente el token no sirve contra la API. */
  gtUser = tempUser({ user_metadata: { must_change_password: true, temp_password_at: iso(90 * DAY) } });
  r = await grab(withBearer());
  t(r.err && r.err.status === 403, 'requireUser: el bloqueo depende del cambio PENDIENTE, no de la caducidad');

  /* Los 401 de siempre, intactos. */
  r = await grab(new Request('https://site.test/api/x'));
  t(r.err && r.err.status === 401 && r.err.code === 'missing_bearer', 'requireUser: sin bearer → 401 de siempre');
}

/* ── 4b end-to-end: el bypass de la auditoría queda cerrado ── */
{
  const me = (await import('../../netlify/functions/account-me.mjs')).default;
  const call = () => me(new Request('https://site.test/api/account-me', { headers: { Authorization: 'Bearer at_1' } }));

  gtUser = tempUser();
  let res = await call();
  t(res.status === 403 && (await res.json()).error === 'password_change_required',
    'account-me: el token sacado con la temporal YA NO lee la cuenta (era el bypass del hallazgo)');

  /* Tras cambiar la contraseña (el flag se apaga en GoTrue) el acceso se restablece solo. */
  gtUser = { id: 'u1', email: 'a@b.co', created_at: iso(0), user_metadata: { must_change_password: false } };
  res = await call();
  t(res.status === 200, 'account-me: apagado el flag, el MISMO token vuelve a servir (requireUser lee el dato fresco de GoTrue)');
}

/* ── 4b: la única puerta que debe seguir abierta, sigue abierta ── */
{
  const setpw = (await import('../../netlify/functions/auth-set-password.mjs')).default;
  gtUser = tempUser();
  const res = await setpw(new Request('https://site.test/api/auth-set-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: 'at_1', password: 'nuevaClave9' })
  }));
  t(res.status === 200 && (await res.json()).ok === true,
    'auth-set-password: con el cambio pendiente SIGUE funcionando (no pasa por requireUser, a propósito)');
}

/* ── 4a: el webhook sella la emisión ── */
{
  const src = (await import('node:fs')).readFileSync('netlify/functions/stripe-webhook.mjs', 'utf8');
  t(/temp_password_at/.test(src), 'webhook: sella temp_password_at al crear la cuenta');
  t(/must_change_password:\s*true/.test(src), 'webhook: sigue poniendo must_change_password (no se perdió nada)');

  /* Y el sello llega de verdad al Admin API. */
  const { createUserWithPassword } = await import('../../netlify/functions/_lib/supabase.mjs');
  let adminBody = null;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/auth/v1/admin/users')) { adminBody = JSON.parse(opts.body); return new Response(JSON.stringify({ id: 'u9' }), { status: 200 }); }
    return prev(url, opts);
  };
  await createUserWithPassword(env, 'a@b.co', 'AbCd-EfGh-JkMn', { must_change_password: true, temp_password_at: iso(0) });
  globalThis.fetch = prev;
  t(adminBody && adminBody.user_metadata && adminBody.user_metadata.must_change_password === true
    && typeof adminBody.user_metadata.temp_password_at === 'string',
    'createUser: el metadata viaja completo (flag + sello) al Admin API');
}

t.done();
