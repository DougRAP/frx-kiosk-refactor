/* C6 — update-profile (Edit details del dashboard; email NO editable).
 * Spec: misc/spec-dash-block-08jul.md §C6. Mock por substring vía globalThis.fetch:
 * GoTrue para requireUser y PostgREST /profiles CAPTURADO (URL + body) para verificar
 * que el PATCH es parcial de verdad y filtra por el id del user autenticado. */
import { makeT } from './helpers.mjs';

const t = makeT('update-profile');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const mk = {
  user: { status: 200, data: { id: 'u1', email: 'a@b.co' } },   // GoTrue /user (requireUser)
  patch: { status: 204 }                                        // PostgREST PATCH (return=minimal)
};
let patches = [];   // cada PATCH capturado: { url, method, body }
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });   // limiter sano → pasa
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(mk.user.data), { status: mk.user.status });
  if (u.includes('/rest/v1/profiles')) {
    patches.push({ url: u, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return new Response(null, { status: mk.patch.status });   // 204 = null-body status (undici lo exige)
  }
  throw new Error('unexpected fetch ' + u);
};

const update = (await import('../../netlify/functions/update-profile.mjs')).default;
const call = (body, headers = { Authorization: 'Bearer at_1' }, method = 'POST') =>
  update(new Request('https://site.test/api/update-profile', {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }));

/* ── camino feliz: los 3 campos ── */
{
  patches = [];
  const res = await call({ full_name: '  Ada Lovelace  ', phone: '(407) 555-1234', address: '  123 Main St, Orlando FL  ' });
  const d = await res.json();
  t(res.status === 200 && d.ok === true, 'feliz: 200 + ok:true');
  t(res.headers.get('Cache-Control') === 'no-store', 'feliz: Cache-Control no-store');
  t(patches.length === 1 && patches[0].method === 'PATCH', 'feliz: exactamente un PATCH a profiles');
  t(patches[0].url.includes('id=eq.u1'), 'feliz: la URL filtra por id=eq.u1 (el user del Bearer)');
  t(patches[0].body.full_name === 'Ada Lovelace', 'feliz: full_name trimmeado');
  t(patches[0].body.phone === '4075551234', 'feliz: phone solo dígitos');
  t(patches[0].body.address === '123 Main St, Orlando FL', 'feliz: address trimmeada');
}

/* ── PATCH parcial: solo phone → el body NO lleva los otros campos ── */
{
  patches = [];
  const res = await call({ phone: '407-555-9999' });
  t(res.status === 200, 'solo phone: 200');
  t(patches.length === 1 && patches[0].body.phone === '4075559999', 'solo phone: el PATCH lleva el phone limpio');
  t(!('full_name' in patches[0].body) && !('address' in patches[0].body),
    'solo phone: ni full_name ni address en el body del PATCH');
}

/* ── '' = limpiar: phone y address vacíos → null ── */
{
  patches = [];
  const res = await call({ phone: '', address: '' });
  t(res.status === 200, 'phone/address vacíos: 200');
  t(patches.length === 1 && patches[0].body.phone === null, "phone '' → PATCH con phone:null (limpiar)");
  t(patches[0].body.address === null, "address '' → PATCH con address:null (limpiar)");
}

/* ── validaciones fail-closed (y sin PATCH) ── */
{
  patches = [];
  const res = await call({ phone: '12345' });
  t(res.status === 400 && (await res.json()).error === 'invalid_phone', 'phone con <7 dígitos → 400 invalid_phone');
  t(patches.length === 0, 'phone inválido: NO hay PATCH');

  const res2 = await call({ full_name: '   ' });
  t(res2.status === 400 && (await res2.json()).error === 'invalid_name', 'full_name solo espacios → 400 invalid_name');

  const res3 = await call({ address: 'x'.repeat(301) });
  t(res3.status === 400 && (await res3.json()).error === 'invalid_address', 'address de 301 chars → 400 invalid_address');
  t(patches.length === 0, 'validaciones fallidas: sigue sin haber PATCH');
}

/* ── nada que actualizar ── */
{
  patches = [];
  const res = await call({});
  t(res.status === 400 && (await res.json()).error === 'nothing_to_update', 'body {} → 400 nothing_to_update');
  const res2 = await call({ full_name: 123, email: 'nuevo@mail.co' });
  t(res2.status === 400 && (await res2.json()).error === 'nothing_to_update',
    'tipos no-string (y email, NO editable) se ignoran → nothing_to_update');
  t(patches.length === 0, 'nothing_to_update: NO hay PATCH');
}

/* ── auth ── */
{
  const res = await call({ full_name: 'Ada' }, {});
  t(res.status === 401 && (await res.json()).error === 'invalid_token', 'sin header Authorization → 401');
}

/* ── método ── */
{
  const res = await call(undefined, { Authorization: 'Bearer at_1' }, 'GET');
  t(res.status === 405 && (await res.json()).error === 'method_not_allowed', 'GET → 405 method_not_allowed');
}

/* ── PostgREST caído ── */
{
  patches = [];
  mk.patch = { status: 500 };
  const res = await call({ full_name: 'Ada' });
  t(res.status === 500 && (await res.json()).error === 'update_failed', 'PATCH de PostgREST 500 → 500 update_failed');
  mk.patch = { status: 204 };
}

t.done();
