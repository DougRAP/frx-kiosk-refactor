/* KIOSK-16 — URL corta tecleable /p/CODIGO → 302 a Stripe (TDD; spec: misc/spec-work-order-04jul.md).
 * Unit-testea el generador de códigos y el handler pay-redirect con PostgREST mockeado (fetch). */
import { makeT } from './helpers.mjs';

const t = makeT('pay-redirect');

/* ── generador (_lib/shortcode.mjs) ── */
const { newShortCode, normalizeShortCode, CODE_ALPHABET, CODE_LEN } =
  await import('../../netlify/functions/_lib/shortcode.mjs');

t(CODE_LEN === 8, 'shortcode: largo 8 (tecleable en voz alta)');
for (const c of ['0', '1', 'O', 'I', 'L', 'B'])
  t(!CODE_ALPHABET.includes(c), `shortcode: el alfabeto excluye el ambiguo "${c}"`);
{
  const re = new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LEN + '}$');
  const seen = new Set();
  let allOk = true;
  for (let i = 0; i < 1000; i++) { const c = newShortCode(); if (!re.test(c)) allOk = false; seen.add(c); }
  t(allOk, 'shortcode: 1000 códigos válidos contra el alfabeto');
  t(seen.size === 1000, 'shortcode: 1000 códigos sin colisiones');
}
t(normalizeShortCode('acde-2345') === 'ACDE2345', 'shortcode: normaliza minúsculas y guiones');
t(normalizeShortCode('  ACDE 2345 ') === 'ACDE2345', 'shortcode: normaliza espacios');
t(normalizeShortCode('ACDE234') === null, 'shortcode: largo incorrecto → null');
t(normalizeShortCode('ACDE234!') === null, 'shortcode: caracteres fuera del alfabeto → null');
t(normalizeShortCode(null) === null, 'shortcode: null → null');

/* ── handler (pay-redirect.mjs) con PostgREST mockeado ── */
process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
const rows = {
  ACDE2345: { stripe_url: 'https://checkout.stripe.com/pay/cs_test_ok', expires_at: FUTURE, opened_at: null },
  XPRD2345: { stripe_url: 'https://checkout.stripe.com/pay/cs_test_old', expires_at: PAST, opened_at: null }
};
const patches = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  const m = u.match(/code=eq\.([A-Z0-9]+)/);
  if (method === 'PATCH') { patches.push(m && m[1]); return new Response('', { status: 204 }); }
  const row = m && rows[m[1]];
  return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
};

const handler = (await import('../../netlify/functions/pay-redirect.mjs')).default;
const hit = (qs) => handler(new Request('https://kiosk.test/p/x?code=' + qs));

{
  const res = await hit('acde-2345');   /* minúsculas + guion → debe resolver igual */
  t(res.status === 302, 'handler: código vigente → 302');
  t(res.headers.get('Location') === rows.ACDE2345.stripe_url, 'handler: Location = stripe_url');
  t((res.headers.get('Cache-Control') || '').includes('no-store'), 'handler: sin cache en la redirección');
  t(patches.length === 1 && patches[0] === 'ACDE2345', 'handler: opened_at marcado en el primer hit (señal para C7)');
}
{
  rows.ACDE2345.opened_at = '2026-07-04T10:00:00.000Z';
  await hit('ACDE2345');
  t(patches.length === 1, 'handler: opened_at NO se re-marca en hits siguientes');
}
{
  const res = await hit('XPRD2345');
  t(res.status === 410, 'handler: código expirado → 410 con página amable');
  t((await res.text()).includes('expired'), 'handler: la página de expirado lo dice');
}
{
  const res = await hit('QQQQ2345');
  t(res.status === 404, 'handler: código desconocido → 404');
}
{
  const res = await hit('nope');
  t(res.status === 404, 'handler: código malformado → 404 sin tocar la BD');
}
{
  const res = await handler(new Request('https://kiosk.test/p/x?code=ACDE2345', { method: 'POST' }));
  t(res.status === 405, 'handler: solo GET');
}

t.done();
