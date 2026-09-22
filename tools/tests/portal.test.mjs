/* DASH-1 — create-portal-session (Billing Portal de Stripe, botón "Manage billing").
 * Spec: misc/spec-dash-block-08jul.md §B3. Todo mockeado vía globalThis.fetch (por eso
 * la function usa fetch directo a api.stripe.com y NO el SDK): GoTrue para requireUser,
 * PostgREST para la fila de subscriptions, y los dos endpoints de Stripe. */
import { makeT } from './helpers.mjs';

const t = makeT('portal');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.SITE_URL = 'https://site.test';

/* Mock enrutado por substring; `mk` gobierna cada pieza por caso. */
const mk = {
  user: { status: 200, data: { id: 'u1', email: 'a@b.co' } },   // GoTrue /user (requireUser)
  subs: [{ stripe_subscription_id: 'sub_1' }],                  // PostgREST /subscriptions
  portal: { status: 200, data: { url: 'https://billing.stripe.com/p/xyz' } }
};
let portalBody = null;   // body form-encoded capturado del POST a billing_portal/sessions
let subsUrl = null;      // URL del lookup a PostgREST (DASH-1b: verifica el ownership check)
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });   // limiter sano → pasa
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(mk.user.data), { status: mk.user.status });
  if (u.includes('/rest/v1/subscriptions')) { subsUrl = u; return new Response(JSON.stringify(mk.subs), { status: 200 }); }
  if (u.includes('api.stripe.com/v1/subscriptions/sub_1')) {
    return new Response(JSON.stringify({ id: 'sub_1', customer: 'cus_9' }), { status: 200 });
  }
  if (u.includes('api.stripe.com/v1/billing_portal/sessions')) {
    portalBody = String(opts.body);
    return new Response(JSON.stringify(mk.portal.data), { status: mk.portal.status });
  }
  throw new Error('unexpected fetch ' + u);
};

const portal = (await import('../../netlify/functions/create-portal-session.mjs')).default;
const call = (headers, method = 'POST', body) => portal(new Request('https://site.test/api/create-portal-session',
  { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));

/* ── camino feliz ── */
{
  portalBody = null;
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(res.status === 200 && d.url === 'https://billing.stripe.com/p/xyz', 'feliz: 200 + { url } del portal');
  t(res.headers.get('Cache-Control') === 'no-store', 'feliz: Cache-Control no-store (la url lleva sesión)');
  t(portalBody !== null && portalBody.includes('customer=cus_9'), 'feliz: el form body lleva customer=cus_9');
  t(portalBody !== null && portalBody.includes('return_url=') && decodeURIComponent(portalBody).includes('/account.html'),
    'feliz: return_url apunta a SITE_URL/account.html');
  t(!portalBody.includes('flow_data'), 'feliz: SIN body no hay flow_data (portal genérico, DASH-1 intacto)');
}

/* ── DASH-1b: flow dirigido de cancelación ── */
{
  portalBody = null; subsUrl = null;
  const res = await call({ Authorization: 'Bearer at_1', 'Content-Type': 'application/json' }, 'POST', { subscription: 'sub_1' });
  const d = await res.json();
  t(res.status === 200 && d.url === 'https://billing.stripe.com/p/xyz', 'cancel-flow: 200 + { url } del portal');
  t(subsUrl !== null && subsUrl.includes('user_id=eq.u1') && subsUrl.includes('stripe_subscription_id=eq.sub_1'),
    'cancel-flow: ownership check server-side (user + sub id en el filtro)');
  const dec = decodeURIComponent(portalBody || '');
  t(dec.includes('flow_data[type]=subscription_cancel'), 'cancel-flow: flow_data type=subscription_cancel');
  t(dec.includes('flow_data[subscription_cancel][subscription]=sub_1'), 'cancel-flow: dirigido a la suscripción pedida');
}
{
  portalBody = null;
  mk.subs = [];   // el sub id pedido NO es de este user
  const res = await call({ Authorization: 'Bearer at_1', 'Content-Type': 'application/json' }, 'POST', { subscription: 'sub_1' });
  t(res.status === 404 && (await res.json()).error === 'no_subscription', 'cancel-flow: sub ajena → 404 uniforme (sin oráculo)');
  t(portalBody === null, 'cancel-flow: sub ajena NUNCA llega a Stripe');
  mk.subs = [{ stripe_subscription_id: 'sub_1' }];
}
{
  portalBody = null; subsUrl = null;
  const res = await call({ Authorization: 'Bearer at_1', 'Content-Type': 'application/json' }, 'POST', { subscription: 'sub_1; DROP' });
  t(res.status === 400 && (await res.json()).error === 'invalid_subscription', 'cancel-flow: formato malo → 400 invalid_subscription');
  t(subsUrl === null && portalBody === null, 'cancel-flow: formato malo no toca ni la BD ni Stripe');
}

/* ── auth ── */
{
  const res = await call({});
  t(res.status === 401 && (await res.json()).error === 'invalid_token', 'sin header Authorization → 401');
  mk.user = { status: 401, data: {} };
  const res2 = await call({ Authorization: 'Bearer expirado' });
  t(res2.status === 401 && (await res2.json()).error === 'invalid_token', 'GoTrue 401 (token inválido) → 401 uniforme');
  mk.user = { status: 200, data: { id: 'u1', email: 'a@b.co' } };
}

/* ── sin suscripción con stripe id ── */
{
  mk.subs = [];
  const res = await call({ Authorization: 'Bearer at_1' });
  t(res.status === 404 && (await res.json()).error === 'no_subscription', 'sin filas de subscription → 404 no_subscription');
  mk.subs = [{ stripe_subscription_id: 'sub_1' }];
}

/* ── Stripe caído ── */
{
  mk.portal = { status: 500, data: { error: { message: 'boom' } } };
  const res = await call({ Authorization: 'Bearer at_1' });
  t(res.status === 502 && (await res.json()).error === 'portal_failed', 'portal-sessions responde 500 → 502 portal_failed');
  mk.portal = { status: 200, data: { url: 'https://billing.stripe.com/p/xyz' } };
}

/* ── método ── */
{
  const res = await call({ Authorization: 'Bearer at_1' }, 'GET');
  t(res.status === 405 && (await res.json()).error === 'method_not_allowed', 'GET → 405 method_not_allowed');
}

t.done();
