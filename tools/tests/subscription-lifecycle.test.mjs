/* SUB-2 — ciclo de vida de suscripciones (customer.subscription.updated/deleted).
 * Spec: misc/spec-dash-block-08jul.md §B2. Se testean los exports directos del webhook
 * (mapStripeSubStatus + handleSubscriptionLifecycle) con PostgREST mockeado vía fetch:
 * capturamos el PATCH a /rest/v1/subscriptions y verificamos body/URL. */
import { makeT } from './helpers.mjs';

const t = makeT('sub-lifecycle');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

/* Mock: captura cada PATCH a subscriptions; `patchRows` gobierna cuántas filas "matchean". */
let patches = [];              // [{ url, body }]
let patchRows = [{ id: 1 }];   // respuesta de PostgREST (return=representation)
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  if (u.includes('/rest/v1/subscriptions') && method === 'PATCH') {
    patches.push({ url: u, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify(patchRows), { status: 200 });
  }
  throw new Error('unexpected fetch ' + u);
};

const { mapStripeSubStatus, handleSubscriptionLifecycle } =
  await import('../../netlify/functions/stripe-webhook.mjs');
const env = process.env;
const UPDATED = 'customer.subscription.updated';
const DELETED = 'customer.subscription.deleted';

/* ── mapStripeSubStatus: la tabla de mapeo ── */
{
  t(mapStripeSubStatus({ status: 'active' }, DELETED) === 'canceled',
    'deleted → canceled (aunque sub.status siga "active" en el payload)');
  t(mapStripeSubStatus({ status: 'active', pause_collection: { behavior: 'void' } }, UPDATED) === 'paused',
    'pause_collection no-null → paused (Stripe deja status "active" al pausar el cobro)');
  t(mapStripeSubStatus({ status: 'past_due' }, UPDATED) === 'past_due', 'past_due → past_due');
  t(mapStripeSubStatus({ status: 'unpaid' }, UPDATED) === 'past_due', 'unpaid → past_due');
  t(mapStripeSubStatus({ status: 'trialing' }, UPDATED) === 'active', 'trialing → active');
  t(mapStripeSubStatus({ status: 'incomplete_expired' }, UPDATED) === 'canceled', 'incomplete_expired → canceled');
  t(mapStripeSubStatus({ status: 'futuro_x' }, UPDATED) === null,
    'status desconocido → null (no tocar status, solo refrescar period_end)');
}

/* ── handleSubscriptionLifecycle: estado desconocido ── */
{
  patches = [];
  const n = await handleSubscriptionLifecycle(env, { id: 'sub_1', status: 'futuro_x' }, UPDATED);
  t(n === 0 && patches.length === 0,
    'desconocido SIN current_period_end → return 0 y NO hace PATCH (nada que escribir)');

  patches = [];
  const n2 = await handleSubscriptionLifecycle(env, { id: 'sub_1', status: 'futuro_x', current_period_end: 1767225600 }, UPDATED);
  t(n2 === 1 && patches.length === 1, 'desconocido CON current_period_end → sí hay PATCH');
  t(patches[0] && !('status' in patches[0].body) && typeof patches[0].body.current_period_end === 'string',
    'ese PATCH lleva SOLO current_period_end (sin status)');
}

/* ── handleSubscriptionLifecycle: updated past_due con period_end en epoch ── */
{
  patches = [];
  const epoch = 1767225600;   // 2026-01-01T00:00:00.000Z
  const n = await handleSubscriptionLifecycle(env, { id: 'sub_1', status: 'past_due', current_period_end: epoch }, UPDATED);
  t(n === 1, 'past_due: devuelve las filas tocadas (1)');
  const p = patches[0];
  t(p && p.body.status === 'past_due', 'past_due: el body del PATCH lleva status "past_due"');
  t(p && p.body.current_period_end === new Date(epoch * 1000).toISOString(),
    'past_due: current_period_end epoch → ISO en el PATCH');
  t(p && p.url.includes('stripe_subscription_id=eq.sub_1'),
    'past_due: la URL filtra por stripe_subscription_id=eq.sub_1 (PATCH masivo por sub)');
}

/* ── period_end a nivel ITEM (API versions nuevas lo mueven ahí) ── */
{
  patches = [];
  const epoch = 1767225600;
  await handleSubscriptionLifecycle(env, {
    id: 'sub_1', status: 'active', items: { data: [{ current_period_end: epoch }] }
  }, UPDATED);
  t(patches[0] && patches[0].body.current_period_end === new Date(epoch * 1000).toISOString(),
    'sin current_period_end a nivel sub → cae al del primer item');
}

/* ── 0 filas matcheadas (sub ajena) → 0 sin lanzar ── */
{
  patches = [];
  patchRows = [];
  let threw = false, n = -1;
  try { n = await handleSubscriptionLifecycle(env, { id: 'sub_ajena', status: 'canceled' }, UPDATED); }
  catch { threw = true; }
  t(!threw && n === 0, 'PATCH devuelve [] (sub ajena) → return 0 y NO lanza (no es error)');
}

t.done();
