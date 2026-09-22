/* portal-stripe-onboard — onboarding de Stripe por dealer (admin-only).
 * Spec: misc/spec-stripe-onboarding.md · fuente: revisiones/ChangesBLS.srt 00:37–02:05.
 * Mock por substring vía globalThis.fetch: GoTrue /user (requirePortalUser), PostgREST
 * /dealers (GET row + PATCH capturado), y Stripe REST (accounts / account_links). */
import { makeT } from './helpers.mjs';

const t = makeT('stripe-onboard');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';

/* estado configurable por caso */
let ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
let DEALER = { id: 'org1', name: "Bailey's", world: 'retailer', stripe_account_id: null };
let patches = [];       // PATCH a /dealers capturados
let stripeCalls = [];   // { method, path } a api.stripe.com

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(ME), { status: 200 });

  if (u.startsWith('https://api.stripe.com/v1')) {
    const path = u.slice('https://api.stripe.com/v1'.length);
    stripeCalls.push({ method, path });
    if (method === 'POST' && path === '/accounts') return new Response(JSON.stringify({ id: 'acct_new1', charges_enabled: false, payouts_enabled: false, details_submitted: false }), { status: 200 });
    if (method === 'GET' && path.startsWith('/accounts/')) return new Response(JSON.stringify({ id: path.slice('/accounts/'.length), charges_enabled: true, payouts_enabled: true, details_submitted: true }), { status: 200 });
    if (method === 'POST' && path === '/account_links') return new Response(JSON.stringify({ url: 'https://connect.stripe.com/setup/acct_x/abc', object: 'account_link' }), { status: 200 });
    throw new Error('unexpected stripe ' + method + ' ' + path);
  }

  if (u.includes('/rest/v1/dealers')) {
    if (method === 'PATCH') { patches.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null }); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify([DEALER]), { status: 200 });   // GET dealer
  }
  if (u.includes('/rest/v1/')) return new Response('[]', { status: 201 });   // audit u otros → OK
  throw new Error('unexpected fetch ' + u);
};

const handler = (await import('../../netlify/functions/portal-stripe-onboard.mjs')).default;
const call = (method, { qs = '', body } = {}) =>
  handler(new Request('https://site.test/api/portal-stripe-onboard' + qs, {
    method, headers: { Authorization: 'Bearer at_1' }, body: body === undefined ? undefined : JSON.stringify(body)
  }));

/* ── no-admin → 403 (probado por API, no solo UI) ── */
{
  ME = { id: 'd1', email: 'd@x.co', app_metadata: { portal_role: 'dealer', org_id: 'org1' } };
  const res = await call('POST', { body: { org_id: 'org1' } });
  t(res.status === 403, 'no-admin: POST → 403');
  ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
}

/* ── GET sin cuenta → { account_id:null }, sin llamar a Stripe ── */
{
  DEALER = { id: 'org1', name: "Bailey's", world: 'retailer', stripe_account_id: null };
  stripeCalls = [];
  const res = await call('GET', { qs: '?org_id=org1' });
  const d = await res.json();
  t(res.status === 200 && d.account_id === null, 'GET sin cuenta → account_id:null');
  t(stripeCalls.length === 0, 'GET sin cuenta → no toca Stripe');
}

/* ── GET con cuenta → flags reales desde Stripe ── */
{
  DEALER = { id: 'org1', name: "Bailey's", world: 'retailer', stripe_account_id: 'acct_existing' };
  stripeCalls = [];
  const res = await call('GET', { qs: '?org_id=org1' });
  const d = await res.json();
  t(res.status === 200 && d.account_id === 'acct_existing' && d.charges_enabled === true && d.payouts_enabled === true, 'GET con cuenta → flags de Stripe');
  t(stripeCalls.some((c) => c.method === 'GET' && c.path === '/accounts/acct_existing'), 'GET con cuenta → retrieve del account');
}

/* ── POST sin cuenta → crea Express, guarda el id, devuelve onboarding_url ── */
{
  DEALER = { id: 'org1', name: "Bailey's", world: 'retailer', stripe_account_id: null };
  stripeCalls = []; patches = [];
  const res = await call('POST', { body: { org_id: 'org1' } });
  const d = await res.json();
  t(res.status === 200 && d.account_id === 'acct_new1', 'POST nuevo → account_id creado');
  t(/connect\.stripe\.com/.test(d.onboarding_url || ''), 'POST nuevo → onboarding_url de Stripe');
  t(stripeCalls.some((c) => c.method === 'POST' && c.path === '/accounts'), 'POST nuevo → crea la cuenta Express');
  t(patches.length === 1 && patches[0].body.stripe_account_id === 'acct_new1', 'POST nuevo → PATCH del dealer con el acct_id');
}

/* ── POST con cuenta → NO crea otra (reusa), solo genera link ── */
{
  DEALER = { id: 'org1', name: "Bailey's", world: 'retailer', stripe_account_id: 'acct_existing' };
  stripeCalls = []; patches = [];
  const res = await call('POST', { body: { org_id: 'org1' } });
  const d = await res.json();
  t(res.status === 200 && d.account_id === 'acct_existing', 'POST existente → reusa el account_id');
  t(!stripeCalls.some((c) => c.method === 'POST' && c.path === '/accounts'), 'POST existente → NO crea otra cuenta');
  t(patches.length === 0, 'POST existente → no re-PATCHea el dealer');
  t(/connect\.stripe\.com/.test(d.onboarding_url || ''), 'POST existente → onboarding_url nuevo');
}

/* ── dealer inexistente → 404 ── */
{
  DEALER = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(ME), { status: 200 });
    if (u.includes('/rest/v1/dealers')) return new Response('[]', { status: 200 });   // no rows
    if (u.includes('/rest/v1/')) return new Response('[]', { status: 201 });
    throw new Error('unexpected fetch ' + u);
  };
  const res = await call('GET', { qs: '?org_id=ghost' });
  t(res.status === 404, 'dealer inexistente → 404');
  globalThis.fetch = orig;
}

t.done();
