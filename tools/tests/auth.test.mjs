/* AUTH-1 — unit tests de las functions de auth con GoTrue/PostgREST mockeados vía fetch.
 * Spec: misc/spec-work-order-06jul.md §7. El browser nunca toca GoTrue: todo pasa por aquí. */
import { makeT } from './helpers.mjs';

const t = makeT('auth');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

/* Mock de GoTrue + PostgREST. `gt` gobierna las respuestas por endpoint. */
const gt = {
  token: { status: 400, data: { error: 'invalid_grant' } },
  otp: { status: 200, data: {} },
  verify: { status: 401, data: { error: 'otp_expired' } },
  userPut: { status: 401, data: {} },
  userGet: { status: 401, data: {} }
};
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  const reply = (r) => new Response(JSON.stringify(r.data), { status: r.status });
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });
  if (u.includes('/auth/v1/token')) return reply(gt.token);
  if (u.includes('/auth/v1/otp')) return reply(gt.otp);
  if (u.includes('/auth/v1/verify')) return reply(gt.verify);
  if (u.includes('/auth/v1/user')) return reply(method === 'PUT' ? gt.userPut : gt.userGet);
  if (u.includes('/rest/v1/')) return new Response('[]', { status: 200 });   // builder: BD vacía
  throw new Error('unexpected fetch ' + u);
};

const SESSION = { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, token_type: 'bearer', user: { id: 'u1' } };
const load = async (name) => (await import(`../../netlify/functions/${name}.mjs`)).default;
const post = (fn, body) => fn(new Request('https://site.test/api/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}));

/* ── auth-login ── */
{
  const login = await load('auth-login');
  gt.token = { status: 200, data: SESSION };
  let res = await post(login, { email: 'a@b.co', password: 'secret123' });
  let d = await res.json();
  t(res.status === 200 && d.access_token === 'at_1' && d.refresh_token === 'rt_1', 'login: credenciales buenas → sesión');
  t(typeof d.expires_at === 'number' && d.expires_at > Date.now() / 1000, 'login: expires_at absoluto y futuro');
  t(!d.user, 'login: no se re-emite el objeto user de GoTrue (solo la sesión)');

  /* AUTH-2: cuenta nacida con contraseña temporal → el flag viaja al front */
  gt.token = { status: 200, data: { ...SESSION, user: { id: 'u1', user_metadata: { must_change_password: true } } } };
  d = await (await post(login, { email: 'a@b.co', password: 'Temp-1234-Xyz9' })).json();
  t(d.must_change_password === true, 'login: user_metadata.must_change_password → flag en la respuesta');
  gt.token = { status: 200, data: SESSION };
  d = await (await post(login, { email: 'a@b.co', password: 'secret123' })).json();
  t(!('must_change_password' in d), 'login: sin flag en metadata → el campo NO aparece');

  gt.token = { status: 400, data: { error: 'invalid_grant' } };
  const bad1 = await (await post(login, { email: 'a@b.co', password: 'wrong' })).text();
  const bad2 = await (await post(login, { email: 'nadie@nunca.co', password: 'whatever1' })).text();
  t(bad1 === bad2 && bad1.includes('invalid_credentials'), 'login: fallo UNIFORME (password mala === email inexistente, byte a byte)');
  const resBad = await post(login, { email: 'a@b.co', password: 'wrong' });
  t(resBad.status === 401, 'login: fallo → 401');
  t((await (await post(login, { email: 'no-es-email', password: 'x'.repeat(9) })).json()).error === 'invalid_credentials', 'login: email malformado → mismo error uniforme');
}

/* ── auth-otp: request ── */
{
  const otp = await load('auth-otp');
  gt.otp = { status: 200, data: {} };
  let otpUrl = '';
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (String(url).includes('/auth/v1/otp')) otpUrl = String(url); return prevFetch(url, opts); };
  let d = await (await post(otp, { email: 'a@b.co' })).json();
  globalThis.fetch = prevFetch;
  t(d.sent === true, 'otp-request: feliz → {sent:true}');
  t(otpUrl.includes('redirect_to=') && decodeURIComponent(otpUrl).includes('/account.html'),
    'otp-request: el magic link del email aterriza en /account.html (la raíz D2C despoja tokens)');
  gt.otp = { status: 400, data: { error: 'user not found' } };
  d = await (await post(otp, { email: 'nadie@nunca.co' })).json();
  t(d.sent === true, 'otp-request: usuario inexistente → TAMBIÉN {sent:true} (sin oráculo)');
  const res = await post(otp, { email: 'no-es-email' });
  t(res.status === 400 && (await res.json()).error === 'invalid_email', 'otp-request: email malformado → 400');
}

/* ── auth-otp: verify ── */
{
  const otp = await load('auth-otp');
  gt.verify = { status: 200, data: SESSION };
  let d = await (await post(otp, { email: 'a@b.co', code: '123456' })).json();
  t(d.access_token === 'at_1' && typeof d.expires_at === 'number', 'otp-verify: código bueno → sesión');
  d = await (await post(otp, { email: 'a@b.co', code: '16805510' })).json();
  t(d.access_token === 'at_1', 'otp-verify: código de 8 dígitos TAMBIÉN pasa (la longitud es config de Supabase, prod usa 8)');
  /* AUTH-2: entrar por código no apaga la temporal → el flag viaja también por OTP */
  gt.verify = { status: 200, data: { ...SESSION, user: { id: 'u1', user_metadata: { must_change_password: true } } } };
  d = await (await post(otp, { email: 'a@b.co', code: '123456' })).json();
  t(d.must_change_password === true, 'otp-verify: temporal pendiente → must_change_password en la respuesta');
  gt.verify = { status: 401, data: { error: 'otp_expired' } };
  const res = await post(otp, { email: 'a@b.co', code: '999999' });
  t(res.status === 401 && (await res.json()).error === 'invalid_code', 'otp-verify: código malo → 401 invalid_code');
  const res2 = await post(otp, { email: 'a@b.co', code: 'abc' });
  t(res2.status === 401 && (await res2.json()).error === 'invalid_code', 'otp-verify: código malformado → mismo 401 (sin tocar GoTrue)');
}

/* ── auth-set-password ── */
{
  const setpw = await load('auth-set-password');
  gt.userPut = { status: 200, data: { id: 'u1' } };
  /* Capturamos el PUT real a GoTrue: debe llevar la password Y apagar el flag AUTH-2. */
  let putBody = null;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/auth/v1/user') && opts && opts.method === 'PUT') putBody = JSON.parse(opts.body);
    return prevFetch(url, opts);
  };
  let d = await (await post(setpw, { access_token: 'at_1', password: 'nuevaClave9' })).json();
  globalThis.fetch = prevFetch;
  t(d.ok === true, 'set-password: feliz → {ok:true}');
  t(putBody && putBody.password === 'nuevaClave9' && putBody.data && putBody.data.must_change_password === false,
    'set-password: el PUT a GoTrue apaga must_change_password (cierra el flujo de la temporal)');
  let res = await post(setpw, { access_token: 'at_1', password: 'corta' });
  t(res.status === 400 && (await res.json()).error === 'weak_password', 'set-password: menos de 8 chars → 400 weak_password');
  gt.userPut = { status: 401, data: {} };
  res = await post(setpw, { access_token: 'expirado', password: 'nuevaClave9' });
  t(res.status === 401 && (await res.json()).error === 'set_password_failed', 'set-password: token inválido → 401');
}

/* ── account-me ── */
{
  const me = await load('account-me');
  let res = await me(new Request('https://site.test/api/account-me'));
  t(res.status === 401, 'account-me: sin Bearer → 401');
  gt.userGet = { status: 200, data: { id: 'u1', email: 'a@b.co' } };
  res = await me(new Request('https://site.test/api/account-me', { headers: { Authorization: 'Bearer at_1' } }));
  const d = await res.json();
  t(res.status === 200 && d.ok === true && d.email === 'a@b.co', 'account-me: Bearer válido → forma rica {ok,email,…}');
  t(Array.isArray(d.plans) && 'summary' in d && 'profile' in d, 'account-me: misma forma que account-view (render() compartido)');
}

/* ── createUserWithPassword (AUTH-2 — la usa el webhook para el alta post-compra) ── */
{
  const { createUserWithPassword } = await import('../../netlify/functions/_lib/supabase.mjs');
  const prevFetch = globalThis.fetch;
  let adminBody = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/auth/v1/admin/users')) {
      adminBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ id: 'u9' }), { status: 200 });
    }
    return prevFetch(url, opts);
  };
  const r = await createUserWithPassword(process.env, 'a@b.co', 'AbCd-EfGh-JkMn', { must_change_password: true });
  t(r.id === 'u9', 'createUser: feliz → { id }');
  t(adminBody && adminBody.email_confirm === true, 'createUser: email_confirm=true (la cuenta nace confirmada, sin invite)');
  t(adminBody && adminBody.password === 'AbCd-EfGh-JkMn' && adminBody.user_metadata.must_change_password === true,
    'createUser: password temporal + must_change_password en user_metadata');
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/auth/v1/admin/users')) return new Response(JSON.stringify({ msg: 'already registered' }), { status: 422 });
    return prevFetch(url, opts);
  };
  t((await createUserWithPassword(process.env, 'a@b.co', 'xxxxxxxxxxxx', {})).exists === true,
    'createUser: 422 (email ya registrado) → { exists:true } (carrera del webhook)');
  globalThis.fetch = prevFetch;
}

t.done();
