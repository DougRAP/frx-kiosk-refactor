/* C5 — get-billing (panel Billing del dashboard, SOLO lectura).
 * Spec: misc/spec-dash-block-08jul.md §C5. Todo mockeado vía globalThis.fetch (por eso
 * la function usa fetch directo a api.stripe.com y NO el SDK): GoTrue para requireUser,
 * PostgREST para la fila de subscriptions, y los 4 endpoints de Stripe (sub expandida,
 * customer expandido, upcoming invoice, lista de invoices). */
import { makeT } from './helpers.mjs';

const t = makeT('billing');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';

/* Mock enrutado por substring; `mk` gobierna cada pieza por caso. */
const PM_SUB = {
  id: 'pm_1',
  card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
  billing_details: { address: { line1: '1 Main St', city: 'Logan', state: 'UT', postal_code: '84321', country: 'US' } }
};
const PM_CUS = { id: 'pm_2', card: { brand: 'amex', last4: '0005', exp_month: 3, exp_year: 2031 } };   // sin billing_details → address null
const UPCOMING = { next_payment_attempt: 1760000000, period_end: 1759000000, amount_due: 999 };
const INVOICES = { data: [
  { created: 1751328000, amount_paid: 999, amount_due: 999, status: 'paid',       // pagada → amount_paid
    lines: { data: [{ description: '1 × Stain Protection (at $9.99 / month)' }] } },  // 1 línea → su description
  { created: 1748736000, amount_paid: 0, amount_due: 1999, status: 'open',        // abierta → amount_due
    lines: { data: [{ description: 'Stain' }, { description: 'Structure' }] } },  // >1 línea → "2 items"
  { created: 1746057600, amount_paid: 0, amount_due: 999, status: 'void' }        // sin lines ni description → null
] };

const fresh = () => ({
  user: { status: 200, data: { id: 'u1', email: 'a@b.co' } },                     // GoTrue /user (requireUser)
  subs: [{ stripe_subscription_id: 'sub_1' }],                                    // PostgREST /subscriptions
  sub: { status: 200, data: { id: 'sub_1', customer: 'cus_9', default_payment_method: PM_SUB } },
  customer: { status: 200, data: { id: 'cus_9', invoice_settings: { default_payment_method: PM_CUS } } },
  upcoming: { status: 200, data: UPCOMING },
  invoices: { status: 200, data: INVOICES }
});
let mk = fresh();
let customerCalled = false;   // ¿cayó al fallback del customer expand?
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });   // limiter sano → pasa
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(mk.user.data), { status: mk.user.status });
  if (u.includes('/rest/v1/subscriptions')) return new Response(JSON.stringify(mk.subs), { status: 200 });
  if (u.includes('api.stripe.com/v1/subscriptions/sub_1')) return new Response(JSON.stringify(mk.sub.data), { status: mk.sub.status });
  if (u.includes('api.stripe.com/v1/customers/cus_9')) { customerCalled = true; return new Response(JSON.stringify(mk.customer.data), { status: mk.customer.status }); }
  if (u.includes('api.stripe.com/v1/invoices/upcoming')) return new Response(JSON.stringify(mk.upcoming.data), { status: mk.upcoming.status });
  if (u.includes('api.stripe.com/v1/invoices?')) return new Response(JSON.stringify(mk.invoices.data), { status: mk.invoices.status });
  throw new Error('unexpected fetch ' + u);
};

const billing = (await import('../../netlify/functions/get-billing.mjs')).default;
const call = (headers, method = 'GET') => billing(new Request('https://site.test/api/get-billing', { method, headers }));

/* ── camino feliz: pm inline por el expand de la sub ── */
{
  mk = fresh(); customerCalled = false;
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(res.status === 200 && d.ok === true, 'feliz: 200 + ok:true');
  t(res.headers.get('Cache-Control') === 'no-store', 'feliz: Cache-Control no-store (PII de facturación)');
  t(d.billing && d.billing.card && d.billing.card.last4 === '4242' && d.billing.card.brand === 'visa',
    'feliz: card del default_payment_method expandido en la sub (last4 4242)');
  t(customerCalled === false, 'feliz: NO llama al customer si la sub ya trae pm');
  t(d.billing.billing_address === '1 Main St, Logan, UT 84321',
    'feliz: billing_address desde pm.billing_details cuando el customer (string) no trae dirección');
  t(d.billing.next_charge && d.billing.next_charge.date === new Date(1760000000 * 1000).toISOString(),
    'feliz: next_charge.date ISO desde next_payment_attempt');
  t(d.billing.next_charge.amount_cents === 999, 'feliz: next_charge.amount_cents = amount_due');
  t(Array.isArray(d.billing.invoices) && d.billing.invoices.length === 3, 'feliz: 3 invoices mapeadas');
  t(d.billing.invoices[0].amount_cents === 999 && d.billing.invoices[0].status === 'paid'
    && d.billing.invoices[0].date === new Date(1751328000 * 1000).toISOString(),
    'feliz: invoice pagada usa amount_paid (>0) + fecha ISO desde created');
  t(d.billing.invoices[0].description === '1 × Stain Protection (at $9.99 / month)',
    'feliz: invoice de 1 línea → description de la línea tal cual');
  t(d.billing.invoices[1].amount_cents === 1999 && d.billing.invoices[1].status === 'open',
    'feliz: invoice con amount_paid 0 cae a amount_due');
  t(d.billing.invoices[1].description === '2 items', 'feliz: invoice de 2 líneas → "2 items"');
  t(d.billing.invoices[2].description === null, 'feliz: invoice sin lines ni description → null');
}

/* ── default_payment_method null en la sub → fallback al customer expand ── */
{
  mk = fresh(); customerCalled = false;
  mk.sub.data = { id: 'sub_1', customer: 'cus_9', default_payment_method: null };
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(res.status === 200 && customerCalled === true, 'pm null en la sub: cae al GET customer expandido');
  t(d.billing.card && d.billing.card.last4 === '0005' && d.billing.card.brand === 'amex',
    'pm null en la sub: card sale de invoice_settings.default_payment_method del customer');
  t(d.billing.billing_address === null, 'pm sin billing_details → billing_address null (card intacta)');
}

/* ── BUG 08-jul (Adrian): la dirección editada en el PORTAL vive en customer.address y
      debe GANARLE a la del payment method (que es la AVS vieja de la tarjeta) ── */
{
  mk = fresh(); customerCalled = false;
  mk.sub.data = { id: 'sub_1',
    customer: { id: 'cus_9', address: { line1: '99 Nueva Ave', city: 'Logan', state: 'UT', postal_code: '84341' } },
    default_payment_method: PM_SUB };   // el pm sigue diciendo "1 Main St" (viejo)
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(d.billing.billing_address === '99 Nueva Ave, Logan, UT 84341',
    'portal-edit: customer.address (lo que edita el portal) GANA sobre la dirección del pm');
  t(customerCalled === false, 'portal-edit: el customer llega expandido en la misma llamada (sin request extra)');
  t(d.billing.card && d.billing.card.last4 === '4242', 'portal-edit: la card sigue saliendo del pm');
}

/* ── customer expandido SIN dirección → fallback a la del pm ── */
{
  mk = fresh();
  mk.sub.data = { id: 'sub_1', customer: { id: 'cus_9', address: null }, default_payment_method: PM_SUB };
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(d.billing.billing_address === '1 Main St, Logan, UT 84321',
    'customer sin address → fallback a pm.billing_details.address');
}

/* ── pm con billing_details pero address null → billing_address null, card intacta ── */
{
  mk = fresh();
  mk.sub.data = { id: 'sub_1', customer: 'cus_9', default_payment_method: {
    id: 'pm_3', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    billing_details: { address: null }
  } };
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(res.status === 200 && d.billing.billing_address === null, 'address null en el pm → billing_address null');
  t(d.billing.card && d.billing.card.last4 === '4242', 'address null en el pm: la card sigue saliendo');
}

/* ── upcoming 404 (sub cancelada) → next_charge null, resto intacto ── */
{
  mk = fresh();
  mk.upcoming = { status: 404, data: { error: { message: 'No upcoming invoices' } } };
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(res.status === 200 && d.ok === true, 'upcoming 404: sigue siendo 200 ok (no es error)');
  t(d.billing.next_charge === null, 'upcoming 404: next_charge null');
  t(d.billing.card && d.billing.card.last4 === '4242' && d.billing.invoices.length === 3,
    'upcoming 404: card e invoices intactos');
}

/* ── lista de invoices caída (500) → [] fail-soft ── */
{
  mk = fresh();
  mk.invoices = { status: 500, data: { error: { message: 'boom' } } };
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(res.status === 200 && d.ok === true, 'invoices 500: sigue siendo 200 ok (fail-soft)');
  t(Array.isArray(d.billing.invoices) && d.billing.invoices.length === 0, 'invoices 500: invoices []');
  t(d.billing.card && d.billing.next_charge && d.billing.next_charge.amount_cents === 999,
    'invoices 500: card y next_charge intactos');
}

/* ── sin filas de subscriptions → cuenta solo-kit, billing null ── */
{
  mk = fresh();
  mk.subs = [];
  const res = await call({ Authorization: 'Bearer at_1' });
  const d = await res.json();
  t(res.status === 200 && d.ok === true && d.billing === null, 'sin sub con stripe id → 200 { ok, billing:null }');
}

/* ── auth ── */
{
  mk = fresh();
  const res = await call({});
  t(res.status === 401 && (await res.json()).error === 'invalid_token', 'sin header Authorization → 401');
  mk.user = { status: 401, data: {} };
  const res2 = await call({ Authorization: 'Bearer expirado' });
  t(res2.status === 401 && (await res2.json()).error === 'invalid_token', 'GoTrue 401 (token inválido) → 401 uniforme');
}

/* ── GET de la sub en Stripe caído → 502 ── */
{
  mk = fresh();
  mk.sub = { status: 500, data: { error: { message: 'boom' } } };
  const res = await call({ Authorization: 'Bearer at_1' });
  t(res.status === 502 && (await res.json()).error === 'billing_failed', 'GET subscription 500 → 502 billing_failed');
}

/* ── método ── */
{
  mk = fresh();
  const res = await call({ Authorization: 'Bearer at_1' }, 'POST');
  t(res.status === 405 && (await res.json()).error === 'method_not_allowed', 'POST → 405 method_not_allowed');
}

t.done();
