/* ============================================================================
 * SEC-2b — no se paga dos veces la misma comisión de Connect.
 * Hallazgo 6 de misc/auditoria-seguridad-jul28.html. Spec: misc/spec-sec2b-commission-race.md.
 *
 * El de-dup era por BÚSQUEDA (GET /v1/transfers) + POST, sin candado: dos entregas
 * concurrentes de invoice.paid leían la misma lista vacía y ambas creaban su transfer.
 * Ahora cada fila se RECLAMA con un UPDATE condicional (atómico en Postgres) antes de
 * tocar Stripe. La búsqueda por transfer_group se mantiene: cubre el crash entre el POST
 * y el PATCH, que es un caso distinto.
 *
 * El simulacro de PostgREST reproduce la atomicidad del UPDATE condicional: el filtro y
 * la escritura ocurren en el mismo turno síncrono, igual que bajo el lock de fila.
 * Primera cobertura real de transferCommissions.
 * ==========================================================================*/
import { makeT } from './helpers.mjs';

const t = makeT('sec2b-commission-race');

const ENV = {
  SUPABASE_URL: 'https://supa.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_PRICE_STAIN: 'price_stain',
  STRIPE_PRICE_STAIN_MECH: 'price_mech',
  STRIPE_CONNECT_TRANSFERS: '1'
};

const MIN = 60000;
const ORG = 'org-1';
const INVOICE = 'in_123';

/* ── Estado del mundo simulado ─────────────────────────────────────────────── */
let ledger, transfers, postCount, dealerAcct, transferFails, claimRejects, lastKeys;

function reset(rows) {
  ledger = rows || [{ id: 'row-a', stripe_invoice_id: INVOICE, plan_sku: 'stain', stripe_amount_cents: 200, status: 'recorded', transfer_id: null, transfer_claimed_at: null }];
  transfers = [];      // transfers "creados en Stripe"
  postCount = 0;       // POSTs reales a /v1/transfers
  dealerAcct = 'acct_1';
  transferFails = false;
  claimRejects = false;  // simula el CHECK sin migrar
  lastKeys = [];
}

const invoice = {
  id: INVOICE, subscription: 'sub_1', created: 1750000000,
  status_transitions: { paid_at: 1750000000 },
  lines: { data: [{ price: { id: 'price_stain' }, quantity: 1 }] }
};

/* Filtro estilo PostgREST sobre los pares clave=op.valor de la query. */
function matches(row, params) {
  for (const [k, raw] of params) {
    if (k === 'select' || k === 'limit' || k === 'order') continue;
    if (k === 'or') {                                  // or=(status.eq.recorded,and(status.eq.transferring,transfer_claimed_at.lt.X))
      const inner = raw.replace(/^\(|\)$/g, '');
      const alts = inner.split(/,(?![^(]*\))/);
      if (!alts.some((a) => matchAlt(row, a))) return false;
      continue;
    }
    if (!matchOne(row, k, raw)) return false;
  }
  return true;
}
function matchAlt(row, alt) {
  if (alt.startsWith('and(')) {
    return alt.slice(4, -1).split(',').every((c) => {
      const [f, op, ...v] = c.split('.');
      return matchOne(row, f, op + '.' + v.join('.'));
    });
  }
  const [f, op, ...v] = alt.split('.');
  return matchOne(row, f, op + '.' + v.join('.'));
}
function matchOne(row, field, raw) {
  const i = raw.indexOf('.');
  const op = i < 0 ? 'eq' : raw.slice(0, i);
  const val = i < 0 ? raw : raw.slice(i + 1);
  const cur = row[field];
  if (op === 'eq') return String(cur) === val;
  if (op === 'neq') return String(cur) !== val;
  if (op === 'is') return val === 'null' ? cur == null : cur != null;
  if (op === 'not') return !matchOne(row, field, val.replace(/^is\./, 'is.') === val ? val : val);
  if (op === 'lt') return cur != null && String(cur) < val;
  if (op === 'gt') return cur != null && String(cur) > val;
  return true;
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  const R = (status, data) => new Response(data === undefined ? '' : JSON.stringify(data), { status });

  /* ---- Supabase ---- */
  if (u.includes('/rest/v1/subscriptions')) return R(200, [{ dealer_id: ORG }]);
  if (u.includes('/rest/v1/commission_rates')) return R(200, []);
  if (u.includes('/rest/v1/dealers')) return R(200, dealerAcct ? [{ stripe_account_id: dealerAcct }] : []);
  if (u.includes('/rest/v1/commission_ledger')) {
    const params = [...new URL(u).searchParams.entries()];
    if (method === 'POST') return R(201);                       // el accrual ya es idempotente por UNIQUE
    const hit = ledger.filter((r) => matches(r, params));
    if (method === 'PATCH') {
      const patch = JSON.parse(opts.body);
      /* Sin la migración aplicada, el CHECK rechaza 'transferring'. */
      if (claimRejects && patch.status === 'transferring') return R(400, { message: 'violates check constraint' });
      /* ATÓMICO: filtrar y escribir en el mismo turno síncrono (= lock de fila en Postgres). */
      const touched = hit.map((r) => { Object.assign(r, patch); return { ...r }; });
      return R(200, touched);
    }
    return R(200, hit.map((r) => ({ ...r })));
  }

  /* ---- Stripe ---- */
  if (u.startsWith('https://api.stripe.com/v1/transfers?')) return R(200, { data: transfers });
  if (u === 'https://api.stripe.com/v1/transfers' && method === 'POST') {
    postCount++;
    lastKeys.push(opts.headers['Idempotency-Key']);
    if (transferFails) return R(402, { error: { code: 'balance_insufficient' } });
    const body = new URLSearchParams(opts.body);
    const tr = { id: 'tr_' + postCount, metadata: { commission_ledger_id: body.get('metadata[commission_ledger_id]') } };
    transfers.push(tr);
    return R(200, tr);
  }
  throw new Error('unexpected fetch ' + u);
};

const { recordCommissions } = await import('../../netlify/functions/_lib/commissions.mjs');
const run = () => recordCommissions(ENV, invoice);

/* ── EL HALLAZGO: dos entregas concurrentes de invoice.paid ── */
{
  reset();
  await Promise.all([run(), run()]);
  t(postCount === 1, `carrera: dos ejecuciones CONCURRENTES crean UN solo transfer (creados: ${postCount})`);
  t(transfers.length === 1, 'carrera: Stripe recibe un único POST — la comisión no se paga dos veces');
  t(ledger[0].status === 'transferred' && ledger[0].transfer_id === 'tr_1', 'carrera: la fila queda transferida una vez, con su transfer_id');
}

/* ── Tres a la vez tampoco ── */
{
  reset();
  await Promise.all([run(), run(), run()]);
  t(postCount === 1, 'carrera: tres ejecuciones concurrentes siguen creando UN solo transfer');
}

/* ── Dos filas (dos SKUs) en carrera: una transferencia por fila, ni más ni menos ── */
{
  reset([
    { id: 'row-a', stripe_invoice_id: INVOICE, plan_sku: 'stain', stripe_amount_cents: 200, status: 'recorded', transfer_id: null, transfer_claimed_at: null },
    { id: 'row-b', stripe_invoice_id: INVOICE, plan_sku: 'stain_mech', stripe_amount_cents: 800, status: 'recorded', transfer_id: null, transfer_claimed_at: null }
  ]);
  await Promise.all([run(), run()]);
  t(postCount === 2, 'carrera con dos SKUs: exactamente dos transfers, uno por fila');
  t(ledger.every((r) => r.status === 'transferred'), 'carrera con dos SKUs: ambas filas quedan transferidas');
  t(new Set(transfers.map((x) => x.metadata.commission_ledger_id)).size === 2, 'carrera con dos SKUs: cada transfer apunta a su propia fila');
}

/* ── El camino de siempre, intacto ── */
{
  reset();
  const out = await run();
  t(postCount === 1 && transfers.length === 1, 'ejecución única: un transfer, como siempre');
  t(ledger[0].status === 'transferred' && ledger[0].transfer_id === 'tr_1', 'ejecución única: la fila queda transferred con su transfer_id');
  t(out && typeof out.recorded === 'number', 'ejecución única: recordCommissions sigue devolviendo { recorded }');

  /* Y no se re-procesa lo ya transferido. */
  await run();
  t(postCount === 1, 'idempotencia: una fila ya transferred NO se vuelve a transferir');
}

/* ── Un transfer fallido libera el reclamo (no deja la fila bloqueada) ── */
{
  reset();
  transferFails = true;
  await run();
  t(postCount === 1, 'transfer fallido: se intentó una vez');
  t(ledger[0].status === 'recorded', 'transfer fallido: la fila vuelve a recorded — el reclamo se LIBERA, no queda colgada');
  t(ledger[0].transfer_id == null, 'transfer fallido: no se inventa un transfer_id');

  transferFails = false;
  await run();
  t(postCount === 2 && ledger[0].status === 'transferred', 'transfer fallido: el reintento posterior sí la transfiere (fail-soft preservado)');
}

/* ── Reclamo huérfano: reciente NO se toca, viejo SÍ se recupera ── */
{
  reset([{ id: 'row-a', stripe_invoice_id: INVOICE, plan_sku: 'stain', stripe_amount_cents: 200, status: 'transferring', transfer_id: null, transfer_claimed_at: new Date(Date.now() - 1 * MIN).toISOString() }]);
  await run();
  t(postCount === 0, 'reclamo RECIENTE: no se re-intenta (otra ejecución lo tiene ahora mismo)');
  t(ledger[0].status === 'transferring', 'reclamo reciente: la fila se deja en paz');

  reset([{ id: 'row-a', stripe_invoice_id: INVOICE, plan_sku: 'stain', stripe_amount_cents: 200, status: 'transferring', transfer_id: null, transfer_claimed_at: new Date(Date.now() - 60 * MIN).toISOString() }]);
  await run();
  t(postCount === 1, 'reclamo HUÉRFANO (viejo): se recupera y se transfiere');
  t(ledger[0].status === 'transferred', 'reclamo huérfano: la fila termina transferida');
}

/* ── Recuperación de un crash entre el POST y el PATCH: se ADOPTA, no se paga otra vez ── */
{
  reset([{ id: 'row-a', stripe_invoice_id: INVOICE, plan_sku: 'stain', stripe_amount_cents: 200, status: 'transferring', transfer_id: null, transfer_claimed_at: new Date(Date.now() - 60 * MIN).toISOString() }]);
  transfers = [{ id: 'tr_previo', metadata: { commission_ledger_id: 'row-a' } }];   // el transfer SÍ salió antes del crash
  await run();
  t(postCount === 0, 'crash entre POST y PATCH: NO se crea un segundo transfer (la búsqueda por transfer_group sigue haciendo su trabajo)');
  t(ledger[0].status === 'transferred' && ledger[0].transfer_id === 'tr_previo', 'crash entre POST y PATCH: se adopta el transfer que ya existía');
}

/* ── Las guardas de siempre ── */
{
  reset();
  dealerAcct = null;
  await run();
  t(postCount === 0 && ledger[0].status === 'recorded', 'dealer sin cuenta Connect: no se reclama ni se llama a Stripe, la fila queda recorded');

  reset();
  await recordCommissions({ ...ENV, STRIPE_CONNECT_TRANSFERS: '0' }, invoice);
  t(postCount === 0, 'flag STRIPE_CONNECT_TRANSFERS apagado: Stripe no se toca en absoluto');
  t(ledger[0].status === 'recorded', 'flag apagado: la fila queda recorded (accrual sí, transfer no)');

  reset();
  const sinSub = await recordCommissions(ENV, { ...invoice, subscription: null });
  t(sinSub.recorded === 0 && postCount === 0, 'invoice sin subscription: no-op, como antes');
}

/* ── Sin la migración aplicada, el fallo es hacia el lado SEGURO ── */
{
  reset();
  claimRejects = true;
  await run();
  t(postCount === 0, 'migración sin aplicar: el reclamo falla y NO se transfiere nada (mejor de menos que dos veces)');
  t(ledger[0].status === 'recorded', 'migración sin aplicar: la fila queda recorded, lista para cuando se aplique');
}

/* ── Anti-regresión del aprendizaje del 15-jul ── */
{
  reset();
  await run();
  const src = (await import('node:fs')).readFileSync('netlify/functions/_lib/commissions.mjs', 'utf8');
  t(/Idempotency-Key.*Date\.now\(\)/.test(src),
    'la Idempotency-Key sigue siendo POR INTENTO (una clave fija hacía que Stripe repitiera 24h un balance_insufficient — corrida del 15-jul)');
  t(lastKeys.length === 1 && /^commission_row-a_\d+$/.test(lastKeys[0]), 'la clave conserva su formato commission_<fila>_<instante>');
  t(/transfer_group=\$\{encodeURIComponent\(invoiceId\)\}|transfer_group/.test(src), 'la búsqueda por transfer_group sigue en su sitio');
}

/* ── La migración del estado existe y es del estilo del repo ── */
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const f = readdirSync('supabase/migrations').find((n) => /commission_claim/.test(n));
  t(!!f, 'existe la migración del reclamo en supabase/migrations');
  const sql = f ? readFileSync('supabase/migrations/' + f, 'utf8') : '';
  t(/status IN \('recorded','transferring','transferred'\)/.test(sql), 'migración: el CHECK admite el estado intermedio');
  t(/transfer_claimed_at/.test(sql), 'migración: añade la columna del sello del reclamo');
  t(/ADD COLUMN IF NOT EXISTS/.test(sql) && /DROP CONSTRAINT IF EXISTS/.test(sql), 'migración: idempotente (se puede correr dos veces)');
  t(/GRANT SELECT, INSERT, UPDATE ON public\.commission_ledger TO service_role/.test(sql), 'migración: reafirma los grants explícitos del Data API');
  /* Solo sentencias ejecutables: los comentarios hablan de DELETE justamente para decir que NO se concede. */
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').replace(/DROP CONSTRAINT IF EXISTS/g, '');
  t(!/\bDELETE\b|\bDROP TABLE\b|\bTRUNCATE\b/i.test(code.replace(/GRANT[^;]*;/g, '')), 'migración: no borra nada (ledger append-only)');
  t(!/GRANT[^;]*\bDELETE\b[^;]*commission_ledger/i.test(code), 'migración: tampoco concede DELETE sobre el ledger');
}

t.done();
