/* ============================================================================
 * DEAL-5 — link durable de onboarding de Stripe Connect.
 * Parte 1: los helpers compartidos que el resolver necesita y que hoy no existen.
 * ==========================================================================*/
import { makeT } from './helpers.mjs';
import { readFileSync } from 'node:fs';

const t = makeT('connect-onboard');
const src = (p) => readFileSync(p, 'utf8');

/* ── La migración ──────────────────────────────────────────────────────────── */
{
  const sql = src('supabase/migrations/20260817120000_connect_onboard_links.sql');
  t(/CREATE TABLE IF NOT EXISTS public\.connect_onboard_links/.test(sql), 'mig: tabla propia, no reutiliza sales_mode_links');
  t(/expires_at\s+timestamptz/.test(sql), 'mig: expires_at materializada en la fila');
  t(/completed_at\s+timestamptz/.test(sql), 'mig: completed_at');
  t(/CREATE UNIQUE INDEX IF NOT EXISTS connect_onboard_links_org_active_uidx/.test(sql), 'mig: un solo link vivo por dealer, garantizado por la BD');
  t(/ENABLE ROW LEVEL SECURITY/.test(sql), 'mig: RLS activa');
  t(/REVOKE ALL ON public\.connect_onboard_links FROM anon, authenticated/.test(sql), 'mig: anon y authenticated sin acceso');
  t(/GRANT SELECT, INSERT, UPDATE ON public\.connect_onboard_links TO service_role/.test(sql), 'mig: GRANTs explícitos, sin DELETE');
  t(/ADD COLUMN IF NOT EXISTS stripe_account_livemode boolean/.test(sql), 'mig: el modo de la cuenta se recuerda, no se deduce');
  /* Sentencias, no prosa: los comentarios explican por qué NO hay DELETE. */
  t(!/^\s*(DROP|DELETE|TRUNCATE)\b/im.test(sql), 'mig: no destructiva');
}

/* ── Códigos: el de onboarding vive semanas en un email, el de venta no ────── */
{
  const { newCode, newShortCode, normalizeCode, normalizeShortCode, CODE_ALPHABET, CODE_LEN, ONBOARD_CODE_LEN } =
    await import('../../netlify/functions/_lib/shortcode.mjs');

  t(ONBOARD_CODE_LEN >= 20, 'code: el de onboarding es largo (' + ONBOARD_CODE_LEN + ' chars)');
  t(newShortCode().length === CODE_LEN, 'code: el corto sigue siendo de ' + CODE_LEN + ' (sales-mode intacto)');
  t(newCode(ONBOARD_CODE_LEN).length === ONBOARD_CODE_LEN, 'code: newCode respeta la longitud pedida');

  const c = newCode(ONBOARD_CODE_LEN);
  t([...c].every((ch) => CODE_ALPHABET.includes(ch)), 'code: mismo alfabeto sin ambiguos');

  /* 30^24 son ~117 bits. El de 8 son ~39, suficientes con TTL corto pero no para
     una URL que vive semanas y abre el alta bancaria de un dealer. */
  const bits = Math.log2(Math.pow(CODE_ALPHABET.length, ONBOARD_CODE_LEN));
  t(bits > 100, 'code: por encima de 100 bits de entropía (' + Math.round(bits) + ')');

  const many = new Set(Array.from({ length: 300 }, () => newCode(ONBOARD_CODE_LEN)));
  t(many.size === 300, 'code: 300 generados, 300 distintos');

  t(normalizeCode('  ' + c.toLowerCase() + ' ', ONBOARD_CODE_LEN) === c, 'code: normaliza mayúsculas y espacios');
  t(normalizeCode(c.slice(0, -1), ONBOARD_CODE_LEN) === null, 'code: longitud incorrecta → null');
  t(normalizeCode(c.slice(0, -1) + '!', ONBOARD_CODE_LEN) === null, 'code: carácter fuera del alfabeto → null');
  t(normalizeShortCode('ABCD2345') !== undefined, 'code: normalizeShortCode sigue existiendo');
}

/* ── El modo de la plataforma sale de la clave, único dato fiable ──────────── */
{
  const { stripeLivemode } = await import('../../netlify/functions/_lib/stripe.mjs');
  t(stripeLivemode({ STRIPE_SECRET_KEY: 'sk_live_abc' }) === true, 'mode: sk_live → live');
  t(stripeLivemode({ STRIPE_SECRET_KEY: 'rk_live_abc' }) === true, 'mode: rk_live (restricted) también es live');
  t(stripeLivemode({ STRIPE_SECRET_KEY: 'sk_test_abc' }) === false, 'mode: sk_test → test');
  t(stripeLivemode({}) === false, 'mode: sin clave se asume test (nunca live por defecto)');
}

/* ── stripeApi tiene que poder mandar Idempotency-Key ──────────────────────── */
{
  const { stripeApi } = await import('../../netlify/functions/_lib/stripe.mjs');
  let seen = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { seen = { url: String(url), opts }; return new Response('{}', { status: 200 }); };

  await stripeApi({ STRIPE_SECRET_KEY: 'sk_test_x' }, 'POST', '/accounts', { type: 'express' }, { 'Idempotency-Key': 'abc-123' });
  t(seen && seen.opts.headers['Idempotency-Key'] === 'abc-123', 'stripeApi: manda las cabeceras extra');
  t(seen.opts.headers.Authorization === 'Bearer sk_test_x', 'stripeApi: la Authorization sigue puesta');
  t(seen.opts.headers['Content-Type'] === 'application/x-www-form-urlencoded', 'stripeApi: el form-encoded sigue igual');

  seen = null;
  await stripeApi({ STRIPE_SECRET_KEY: 'sk_test_x' }, 'GET', '/accounts/acct_1');
  t(seen && !seen.opts.body, 'stripeApi: sin form no manda body (comportamiento previo intacto)');
  globalThis.fetch = orig;
}

/* ── La base del link del portal, dev-aware como la del kiosk ──────────────── */
{
  const { portalLinkBase } = await import('../../netlify/functions/_lib/portal.mjs');
  const req = (url) => new Request(url);

  t(portalLinkBase(req('https://furniturerx.netlify.app/x'), {}) === 'https://portal.furniturerx.net/',
    'portalLinkBase: en prod, el dominio del portal');
  t(portalLinkBase(req('https://furniturerx.netlify.app/x'), { PORTAL_URL: 'https://otro.test/' }) === 'https://otro.test/',
    'portalLinkBase: PORTAL_URL manda si está definida');
  t(portalLinkBase(req('http://localhost:8888/x'), {}) === 'http://localhost:8888/',
    'portalLinkBase: en dev, el origin local (para netlify dev)');
  t(portalLinkBase(req('https://furniturerx.netlify.app/x'), { PORTAL_URL: 'https://otro.test' }).endsWith('/'),
    'portalLinkBase: siempre termina en barra');
}

/* ══════════════════════════════════════════════════════════════════════════
 * Parte 2: el resolver. Mock de fetch al estilo de sales-mode.test.mjs.
 * ════════════════════════════════════════════════════════════════════════*/

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.PORTAL_URL = 'https://portal.test/';

const CODE = 'ACDEFGHJKMNPQRSTUVWXYZ23';          // 24 chars del alfabeto

let linkRow = null;        // lo que devuelve connect_onboard_links
let dealerRow = null;      // lo que devuelve dealers
let acctGet = null;        // respuesta de GET /accounts/{id}
let rateAllowed = true;
let rateThrows = false;

const calls = { stripe: [], patchDealer: [], patchLink: [] };
const reset = () => { calls.stripe = []; calls.patchDealer = []; calls.patchLink = []; };

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { /* form */ }

  if (u.includes('rate_limit_hit')) {
    if (rateThrows) throw new Error('limiter down');
    return new Response(JSON.stringify([{ allowed: rateAllowed, hits: 1, retry_after: 30 }]), { status: 200 });
  }
  if (u.includes('/rest/v1/connect_onboard_links')) {
    if (method === 'PATCH') { calls.patchLink.push({ url: u, body }); return new Response('[]', { status: 200 }); }
    /* El resolver trae el dealer embebido en la misma consulta (dealers(...)), que es
       como lo hace sales-mode-redirect. El mock reproduce esa forma. */
    const row = linkRow ? { ...linkRow, dealers: dealerRow } : null;
    return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
  }
  if (u.includes('/rest/v1/dealers')) {
    if (method === 'PATCH') {
      calls.patchDealer.push({ url: u, body });
      const won = u.includes('stripe_account_id=is.null');
      return new Response(JSON.stringify(won ? [{ id: 'org1' }] : []), { status: 200 });
    }
    return new Response(JSON.stringify(dealerRow ? [dealerRow] : []), { status: 200 });
  }
  if (u.startsWith('https://api.stripe.com/v1')) {
    const path = u.replace('https://api.stripe.com/v1', '');
    calls.stripe.push({ path, method, headers: (opts && opts.headers) || {}, body: opts && opts.body });
    if (path.startsWith('/accounts/')) return new Response(JSON.stringify(acctGet.body), { status: acctGet.status });
    if (path === '/accounts') return new Response(JSON.stringify({ id: 'acct_new1', capabilities: {}, requirements: { currently_due: ['x'] } }), { status: 200 });
    if (path === '/account_links') return new Response(JSON.stringify({ url: 'https://connect.stripe.com/setup/e/acct_new1/xyz' }), { status: 200 });
  }
  if (u.includes('/rest/v1/')) return new Response('[]', { status: method === 'POST' ? 201 : 200 });
  throw new Error('unexpected fetch ' + u);
};

const resolver = (await import('../../netlify/functions/stripe-onboarding-redirect.mjs')).default;
const call = (qs, method = 'GET') =>
  resolver(new Request('https://furniturerx.netlify.app/.netlify/functions/stripe-onboarding-redirect' + qs, { method }));

const ACTIVE_LINK = { id: 'l1', code: CODE, org_id: 'org1', org_name: 'Baileys', active: true, expires_at: null, completed_at: null, open_count: 0 };
const NOT_DONE = { status: 200, body: { id: 'acct_1', capabilities: { transfers: 'pending' }, payouts_enabled: false, requirements: { currently_due: ['bank_account'] } } };
const DONE = { status: 200, body: { id: 'acct_1', capabilities: { transfers: 'active' }, payouts_enabled: true, requirements: { currently_due: [] } } };
const MISSING = { status: 404, body: { error: { code: 'resource_missing', message: 'No such account' } } };

/* ── El GET es inerte: los antivirus de correo abren enlaces, no aprietan botones ── */
{
  reset(); linkRow = ACTIVE_LINK; dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: null, stripe_account_livemode: null };
  const r = await call('?code=' + CODE);
  const html = await r.text();
  t(r.status === 200, 'GET: 200 con un code vivo');
  t(calls.stripe.length === 0, 'GET: NO llama a Stripe (esto es lo que evita las cuentas fantasma)');
  t(calls.patchDealer.length === 0, 'GET: NO crea ni enlaza ninguna cuenta');
  t(/<form[^>]+method="post"/i.test(html), 'GET: pinta un formulario POST, no un redirect');
  t(html.includes('Baileys'), 'GET: nombra al dealer para que el usuario sepa dónde entra');
  t(/no-store/.test(r.headers.get('cache-control') || ''), 'GET: no-store');
}

/* ── Los cuatro finales muertos son indistinguibles entre sí ───────────────── */
{
  const bodies = [];
  linkRow = null;                                              // inexistente
  let r = await call('?code=' + CODE); bodies.push([r.status, await r.text()]);
  linkRow = { ...ACTIVE_LINK, expires_at: '2020-01-01T00:00:00Z' };   // caducado
  r = await call('?code=' + CODE); bodies.push([r.status, await r.text()]);
  linkRow = { ...ACTIVE_LINK, completed_at: '2026-08-01T00:00:00Z' }; // ya completado
  r = await call('?code=' + CODE); bodies.push([r.status, await r.text()]);
  r = await call('?code=NOPE');                                       // malformado
  bodies.push([r.status, await r.text()]);

  t(bodies.every(([st]) => st === bodies[0][0]), 'finales: los 4 devuelven el MISMO status');
  t(bodies.every(([, b]) => b === bodies[0][1]), 'finales: los 4 devuelven el MISMO cuerpo');
  t(!bodies[0][1].includes('Baileys'), 'finales: no nombran al dealer (no confirman que exista)');
}

/* ── POST: crea la cuenta una sola vez y con clave de idempotencia ─────────── */
{
  reset(); linkRow = ACTIVE_LINK; dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: null, stripe_account_livemode: null };
  const r = await call('?code=' + CODE, 'POST');
  const created = calls.stripe.find((c) => c.path === '/accounts' && c.method === 'POST');
  const link = calls.stripe.find((c) => c.path === '/account_links');

  t(r.status === 302, 'POST: 302 hacia Stripe');
  t(/connect\.stripe\.com/.test(r.headers.get('location') || ''), 'POST: el Location es el Account Link recién acuñado');
  t(!!created, 'POST: crea la cuenta Express');
  t(!!created.headers['Idempotency-Key'], 'POST: la creación lleva Idempotency-Key (dos clics no crean dos cuentas)');
  t(!link.headers['Idempotency-Key'], 'POST: el account_link NO la lleva (devolvería el link ya consumido)');
  t(calls.patchDealer.some((p) => p.url.includes('stripe_account_id=is.null')), 'POST: reclamo atómico, no un PATCH ciego');
  t(calls.patchDealer.some((p) => p.body && p.body.stripe_account_livemode === false), 'POST: guarda el modo junto al acct');
}

/* ── refresh_url vuelve aquí, con contador para que no sea un bucle ────────── */
{
  reset(); linkRow = ACTIVE_LINK; dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: 'acct_1', stripe_account_livemode: false };
  acctGet = NOT_DONE;
  await call('?code=' + CODE, 'POST');
  const link = calls.stripe.find((c) => c.path === '/account_links');
  const form = new URLSearchParams(link.body);
  t(form.get('refresh_url').includes('/stripeOnboarding/' + CODE), 'refresh: vuelve al propio link, no a la home del portal');
  t(/r=1/.test(form.get('refresh_url')), 'refresh: lleva contador de vueltas');
  t(!form.get('return_url').includes(CODE), 'return: sin identificadores en la URL de vuelta');
  t(calls.stripe.filter((c) => c.path === '/accounts' && c.method === 'POST').length === 0, 'reutiliza la cuenta existente, no crea otra');
}
{
  reset(); linkRow = ACTIVE_LINK; dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: 'acct_1', stripe_account_livemode: false };
  acctGet = NOT_DONE;
  const r = await call('?code=' + CODE + '&r=3', 'POST');
  t(r.status !== 302, 'bucle: a la tercera vuelta deja de redirigir');
  t(calls.stripe.filter((c) => c.path === '/account_links').length === 0, 'bucle: y deja de acuñar links');
}

/* ── El modo y la auto-reparación ──────────────────────────────────────────── */
{
  reset(); linkRow = ACTIVE_LINK;
  dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: 'acct_test1', stripe_account_livemode: true };  // live, plataforma en test
  await call('?code=' + CODE, 'POST');
  t(calls.stripe.some((c) => c.path === '/accounts' && c.method === 'POST'), 'modo: una cuenta del otro universo se ignora y se crea la buena');
  t(!calls.stripe.some((c) => c.path.startsWith('/accounts/acct_test1')), 'modo: ni siquiera se le pregunta a Stripe por ella');
}
{
  reset(); linkRow = ACTIVE_LINK;
  dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: 'acct_ghost', stripe_account_livemode: false };
  acctGet = MISSING;
  const r = await call('?code=' + CODE, 'POST');
  t(r.status === 302, 'auto-reparación: resource_missing ya no es un 502 sin salida');
  t(calls.stripe.some((c) => c.path === '/accounts' && c.method === 'POST'), 'auto-reparación: crea la cuenta que falta');
}

/* ── Cuenta ya operativa: se cierra el link en vez de reabrir el formulario ── */
{
  reset(); linkRow = ACTIVE_LINK;
  dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: 'acct_1', stripe_account_livemode: false };
  acctGet = DONE;
  const r = await call('?code=' + CODE, 'POST');
  t(r.status !== 302, 'completa: no manda de vuelta al formulario bancario');
  t(calls.patchLink.some((p) => p.body && p.body.completed_at), 'completa: sella completed_at');
  t(calls.patchLink.some((p) => p.body && p.body.active === false), 'completa: y desactiva el link');
  t(calls.stripe.filter((c) => c.path === '/account_links').length === 0, 'completa: no acuña otro Account Link');
}

/* ── Rechazada por Stripe: regenerar no arregla nada ───────────────────────── */
{
  reset(); linkRow = ACTIVE_LINK;
  dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: 'acct_1', stripe_account_livemode: false };
  acctGet = { status: 200, body: { id: 'acct_1', capabilities: { transfers: 'inactive' }, payouts_enabled: false, requirements: { currently_due: [], disabled_reason: 'rejected.fraud' } } };
  const r = await call('?code=' + CODE, 'POST');
  t(r.status !== 302, 'rechazada: no se regenera el link');
  t(calls.stripe.filter((c) => c.path === '/account_links').length === 0, 'rechazada: no se llama a account_links');
}

/* ── Rate limit: aquí el premio es una cuenta bancaria, así que fail-closed ── */
{
  reset(); linkRow = ACTIVE_LINK; dealerRow = { id: 'org1', name: 'Baileys', stripe_account_id: null, stripe_account_livemode: null };
  rateAllowed = false;
  const r = await call('?code=' + CODE);
  t(r.status === 429, 'rate: agotado → 429');
  t(calls.stripe.length === 0, 'rate: y no se llega a tocar Stripe');
  rateAllowed = true;

  /* checkRate NUNCA lanza: degrada solo a un contador local en memoria. Así que
     "fail-closed" aquí significa no envolverlo en un catch que ignore el veredicto,
     que es justo lo que hace sales-mode (allí es correcto: bloquear corta una venta). */
  const fn = src('netlify/functions/stripe-onboarding-redirect.mjs');
  t(!/catch\s*\{\s*\/\*\s*fail-open/.test(fn), 'rate: sin el fail-open copiado de sales-mode');
  t(/subject:/.test(fn), 'rate: hay un bucket por code, no solo por IP');
}

/* ── Métodos ───────────────────────────────────────────────────────────────── */
{
  linkRow = ACTIVE_LINK;
  const r = await call('?code=' + CODE, 'PUT');
  t(r.status === 405 || r.status === 404, 'PUT: rechazado');
}

/* ── El cableado de las rutas ──────────────────────────────────────────────── */
{
  const portal = src('portal/netlify.toml');
  t(/from = "\/stripeOnboarding\/\*"/.test(portal), 'toml portal: la ruta existe');
  t(/stripe-onboarding-redirect\?code=:splat/.test(portal), 'toml portal: pasa el splat como code');
  t(/furniturerx\.netlify\.app/.test(portal.slice(portal.indexOf('/stripeOnboarding/*'))), 'toml portal: apunta al backend central');
  const root = src('netlify.toml');
  t(/from = "\/stripeOnboarding\/\*"/.test(root), 'toml raíz: la ruta existe (netlify dev)');
  t(/\/\.netlify\/functions\/stripe-onboarding-redirect\?code=:splat/.test(root), 'toml raíz: forma local');
}

t.done();
