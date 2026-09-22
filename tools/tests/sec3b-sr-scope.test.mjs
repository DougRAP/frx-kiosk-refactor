/* ============================================================================
 * SEC-3b — no se pueden radicar service requests sobre contratos de otro dealer.
 * Hallazgo 4 de misc/auditoria-seguridad-jul28.html. Spec: misc/spec-sec3b-sr-scope.md.
 *
 * El POST aceptaba el contract_number del cuerpo sin comprobar propiedad (el GET y el
 * PATCH sí filtraban por org). Ahora resuelve el contrato contra subscriptions con
 * dealer_id del emisor y responde 404 si no es suyo — mismo patrón y mismo código que
 * portal-customer.mjs, que es el canon del repo.
 * Este archivo es además la PRIMERA cobertura real de esta Function (hasta hoy los
 * tests que la mencionaban la stubbeaban o leían su fuente).
 * ==========================================================================*/
import { makeT } from './helpers.mjs';

const t = makeT('sec3b-sr-scope');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const env = process.env;

const ORG_MIO = 'org-mio-1111';
const ORG_AJENO = 'org-ajeno-9999';

/* Contratos sembrados: master → dealer dueño. */
const CONTRATOS = { 'RX-10017': ORG_MIO, 'RX-20044': ORG_AJENO };

let who = { portal_role: 'dealer', org_id: ORG_MIO, org_name: 'Mío' };
let calls = [];          // toda llamada a PostgREST, en orden
let srNoCalls = 0;       // veces que se pidió un número de SR
let inserts = [];        // filas realmente insertadas
let subsFail = false;    // simula caída de la consulta de propiedad

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';

  if (u.includes('/auth/v1/user')) {
    return new Response(JSON.stringify({ id: 'u1', email: 'd@x.co', app_metadata: who, user_metadata: {} }), { status: 200 });
  }
  if (u.includes('/rpc/next_sr_no')) { srNoCalls++; return new Response(JSON.stringify('SR-01002'), { status: 200 }); }

  if (u.includes('/rest/v1/subscriptions')) {
    calls.push(u);
    if (subsFail) return new Response('{"message":"boom"}', { status: 500 });
    /* Reproduce el filtrado de PostgREST sobre los parámetros que manda la Function. */
    const qs = new URL(u).searchParams;
    const master = (qs.get('master_no') || '').replace(/^eq\./, '');
    const dealer = (qs.get('dealer_id') || '').replace(/^eq\./, '');
    const owner = CONTRATOS[master];
    const hit = owner && (!dealer || dealer === owner);
    return new Response(JSON.stringify(hit ? [{ id: 'sub-1' }] : []), { status: 200 });
  }
  if (u.includes('/rest/v1/service_requests')) {
    calls.push(u);
    if (method === 'POST') { inserts.push(JSON.parse(opts.body)); return new Response(JSON.stringify([{ id: 'sr-new' }]), { status: 201 }); }
    return new Response('[]', { status: 200 });
  }
  throw new Error('unexpected fetch ' + u);
};

const handler = (await import('../../netlify/functions/portal-service-requests.mjs')).default;

const post = (body, token) => handler(new Request('https://portal.test/api/portal-service-requests', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || 'tok') },
  body: JSON.stringify(body)
}));
const reset = () => { calls = []; srNoCalls = 0; inserts = []; subsFail = false; };
const SR = (contract) => ({ contract_number: contract, body: 'The seam split along the chaise.', category: 'Cancel plan', first_name: 'Jane', last_name: 'Doe' });

/* ── El camino legítimo no cambia ── */
{
  reset();
  who = { portal_role: 'dealer', org_id: ORG_MIO };
  const res = await post(SR('RX-10017-12'));
  const d = await res.json();
  t(res.status === 200 && d.ok === true, 'dealer sobre contrato PROPIO: 200 ok (el camino de siempre, intacto)');
  t(d.sr_number === 'SR-01002' && d.status === 'open', 'dealer sobre contrato propio: sigue devolviendo número y estado');
  t(inserts.length === 1 && inserts[0].contract_number === 'RX-10017-12',
    'dealer sobre contrato propio: se inserta con el contract_number TAL CUAL llegó (no se reescriben los datos)');
  t(inserts[0].org_id === ORG_MIO, 'dealer sobre contrato propio: el org_id guardado sigue siendo el del emisor (sin cambio de producto)');
  t(inserts[0].stage === 0 && inserts[0].status === 'open' && Array.isArray(inserts[0].history),
    'dealer sobre contrato propio: la fila conserva stage/status/history de siempre');
}

/* ── El agujero del hallazgo, cerrado ── */
{
  reset();
  who = { portal_role: 'dealer', org_id: ORG_MIO };
  const res = await post(SR('RX-20044-3'));            // contrato de OTRO dealer
  const d = await res.json();
  t(res.status === 404 && d.error === 'not_found', 'dealer sobre contrato AJENO: 404 not_found (era el hallazgo)');
  t(inserts.length === 0, 'dealer sobre contrato ajeno: NO se inserta nada');
  t(srNoCalls === 0, 'dealer sobre contrato ajeno: no se quema un número de SR en un intento rechazado');

  /* Sin oráculo: ajeno e inexistente son indistinguibles byte a byte. */
  reset();
  const ajeno = await (await post(SR('RX-20044-3'))).text();
  reset();
  const noExiste = await (await post(SR('RX-99999-1'))).text();
  t(ajeno === noExiste, 'sin oráculo: "de otro dealer" e "inexistente" responden EXACTAMENTE lo mismo');
  t(inserts.length === 0, 'contrato inexistente: tampoco se inserta');
}

/* ── El master manda: el sufijo -NN es de presentación ── */
{
  reset();
  who = { portal_role: 'dealer', org_id: ORG_MIO };
  t((await post(SR('RX-10017'))).status === 200, 'master sin sufijo: se acepta igual');
  reset();
  t((await post(SR('RX-10017-1'))).status === 200, 'master con sufijo de 1 dígito: se acepta igual');
  reset();
  t((await post(SR('RX-10017-12'))).status === 200, 'master con sufijo de 2 dígitos: se acepta igual');
  const q = calls.find((u) => u.includes('subscriptions'));
  t(!!q && q.includes('master_no=eq.RX-10017'), 'la comprobación consulta por MASTER, no por el contract_number con sufijo');
  t(!!q && q.includes('kind=eq.protection'), 'la comprobación se ciñe a los planes de protección (mismo criterio que portal-customer)');
  t(!!q && q.includes('dealer_id=eq.' + ORG_MIO), 'la comprobación filtra por el dealer del emisor');
}

/* ── El admin sigue pudiendo todo, pero el contrato debe existir ── */
{
  reset();
  who = { portal_role: 'system_admin', org_id: null };
  t((await post(SR('RX-20044-3'))).status === 200, 'admin sobre contrato de cualquier dealer: 200 (ve y opera todo)');
  const q = calls.find((u) => u.includes('subscriptions'));
  t(!!q && !q.includes('dealer_id='), 'admin: la consulta NO lleva filtro de dealer');

  reset();
  const res = await post(SR('RX-99999-1'));
  t(res.status === 404 && (await res.json()).error === 'not_found', 'admin sobre contrato INEXISTENTE: 404 (nadie radica sobre un número inventado)');
  t(inserts.length === 0, 'admin sobre contrato inexistente: no se inserta');
}

/* ── La comprobación de autorización NO es fail-soft ── */
{
  reset();
  who = { portal_role: 'dealer', org_id: ORG_MIO };
  subsFail = true;
  const res = await post(SR('RX-10017-12'));
  t(res.status === 502 && (await res.json()).error === 'upstream',
    'si la comprobación de propiedad falla: 502, y NO se crea el SR (una autorización no puede ser fail-soft)');
  t(inserts.length === 0, 'fallo de la comprobación: no se inserta nada');
}

/* ── Lo que ya estaba bien, sigue igual ── */
{
  reset();
  who = { portal_role: 'dealer', org_id: ORG_MIO };
  const bad = await post({ contract_number: 'RX-10017-12', body: '' });   // sin texto
  t(bad.status === 400, 'validación de forma: sigue devolviendo 400 antes de tocar la BD');
  t(calls.length === 0, 'validación de forma: un cuerpo inválido ni siquiera consulta la BD');

  reset();
  const noAuth = await handler(new Request('https://portal.test/api/portal-service-requests', { method: 'POST', body: '{}' }));
  t(noAuth.status === 401, 'sin bearer: 401 de siempre');

  reset();
  who = { portal_role: 'dealer', org_id: ORG_MIO };
  const get = await handler(new Request('https://portal.test/api/portal-service-requests', { headers: { Authorization: 'Bearer tok' } }));
  t(get.status === 200, 'GET: sigue respondiendo 200');
  t(calls.some((u) => u.includes('service_requests') && u.includes('org_id=eq.' + ORG_MIO)), 'GET: sigue acotado por org (no se tocó)');

  reset();
  const patch = await handler(new Request('https://portal.test/api/portal-service-requests', {
    method: 'PATCH', headers: { Authorization: 'Bearer tok' }, body: JSON.stringify({ id: 'sr1' })
  }));
  t(patch.status === 404 || patch.status === 200, 'PATCH: sigue operando (no se tocó)');
  t(calls.some((u) => u.includes('service_requests') && u.includes('org_id=eq.' + ORG_MIO)), 'PATCH: sigue acotado por org (no se tocó)');
  t(!calls.some((u) => u.includes('subscriptions')), 'PATCH y GET no pagan la consulta nueva (solo el POST la necesita)');
}

/* ── El front explica el 404 con el copy que YA existe en el portal ── */
{
  const { readFileSync } = await import('node:fs');
  const js = readFileSync('portal/assets/js/portal.js', 'utf8');
  const submit = js.slice(js.indexOf('function submitSR'), js.indexOf('function clearSR'));
  t(/r\.status === 404/.test(submit), 'front: submitSR distingue el 404');
  t(/not in your scope/.test(submit), 'front: usa la frase que el portal YA emplea para esto, sin inventar copy');
  t((js.match(/not in your scope/g) || []).length >= 2, 'front: la frase es la misma que ya usaba resendTerms (patrón establecido)');
  t(/Add a contract # and a request before submitting/.test(submit), 'front: el mensaje de siempre sigue ahí para el resto de errores');
}

t.done();
