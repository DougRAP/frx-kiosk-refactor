/* kit-orders — endpoint de kit fulfillment (KIT-1..KIT-6) + migración + webhook ship_to.
 * Spec: misc/spec-kit-orders.md · fuente: revisiones/KitOrdersMeeting.vtt +
 * DougKitsAgo082026.srt + KitOrdersAgo132026.srt (misma reunión, 3 corridas).
 * Stub por substring vía globalThis.fetch: GoTrue /user, PostgREST /orders + /order_items (+ audit). */
import { makeT, src } from './helpers.mjs';

const t = makeT('kit-orders');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

let ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
let calls = [];   // { method, kind, body }

/* Fixture del caso literal de Doug: "Doug Wright orders 3 kits… furniture kit, stain kit,
   leather kit, rug kit, all Doug Wright" → 3 líneas en UNA orden = 3 filas (KIT-6).
   Y una segunda orden con quantity 3 del MISMO kit → 1 sola fila con qty 3. */
const ORDERS = [
  { id: 'o-1', user_id: 'u-doug', created_at: '2026-08-05T14:02:00Z', email: 'doug@rap.com', status: 'paid',
    ship_to_name: 'Doug Wright', ship_to_address: '123 Oak St, Dallas, TX', ship_to_zip: '75001', ship_to_phone: '555-1212',
    profiles: { full_name: 'Doug Wright', email: 'doug@rap.com' } },
  /* o-2: sin snapshot, PERO el perfil tiene dirección → fallback nivel 2 */
  { id: 'o-2', user_id: 'u-ann', created_at: '2026-08-04T09:00:00Z', email: 'ann@rap.com', status: 'paid',
    ship_to_name: null, ship_to_address: null, ship_to_zip: null, ship_to_phone: null,
    profiles: { full_name: 'Ann Ruiz', email: 'ann@rap.com', address: '9 Pine Ave, Austin, TX', phone: '555-3434' } },
  /* o-3: sin snapshot y sin perfil → fallback nivel 3, el lead del checkout */
  { id: 'o-3', created_at: '2026-08-03T08:00:00Z', email: 'old@rap.com', status: 'paid',
    ship_to_name: null, ship_to_address: null, ship_to_zip: null, ship_to_phone: null,
    profiles: { full_name: 'Old Buyer', email: 'old@rap.com', address: null, phone: null } }
];
const LEADS = [{ email: 'old@rap.com', addr: '77 Legacy Rd, Dallas, TX', zip: '75002', phone: '555-7777' }];
/* Doug además es suscriptor → su [View] debe abrir la ficha completa, como en Subscribers.
   Ann solo compró kits (sin suscripción) → no hay ficha que abrir. */
const SUBS = [{ user_id: 'u-doug', master_no: 'RX-10001', started_at: '2026-06-05T00:00:00Z' }];
const ITEMS = [
  { id: 'it-1', order_id: 'o-1', quantity: 1, unit_price_cents: 4999, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, sh_cents: null, care_kits: { name: 'Wood Care Kit', sku: 'CARE-WOOD-001' } },
  { id: 'it-2', order_id: 'o-1', quantity: 1, unit_price_cents: 4999, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, sh_cents: null, care_kits: { name: 'Leather Care Kit', sku: 'CARE-LEATHER-001' } },
  { id: 'it-3', order_id: 'o-1', quantity: 1, unit_price_cents: 4999, fulfillment_status: 'shipped', shipping_confirmation: '1Z999AA1', shipped_at: '2026-08-06T10:00:00Z', sh_cents: 1350, care_kits: { name: 'Fabric Care Kit', sku: 'CARE-FABRIC-001' } },
  { id: 'it-4', order_id: 'o-2', quantity: 3, unit_price_cents: 4999, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, sh_cents: null, care_kits: { name: 'Wood Care Kit', sku: 'CARE-WOOD-001' } },
  { id: 'it-5', order_id: 'o-3', quantity: 1, unit_price_cents: 4999, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, sh_cents: null, care_kits: { name: 'Wood Care Kit', sku: 'CARE-WOOD-001' } }
];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(ME), { status: 200 });

  if (u.includes('/rest/v1/order_items')) {
    if (method === 'PATCH') {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method, kind: 'patch-item', url: u, body });
      return new Response(JSON.stringify([{ id: 'it-1', ...body }]), { status: 200 });
    }
    if (u.includes('id=eq.nope')) return new Response('[]', { status: 200 });   // item inexistente
    if (u.includes('id=eq.')) {
      const id = (u.match(/id=eq\.([^&]+)/) || [])[1];
      const found = ITEMS.find((it) => it.id === id);
      return new Response(JSON.stringify(found ? [found] : [ITEMS[0]]), { status: 200 });
    }
    return new Response(JSON.stringify(ITEMS), { status: 200 });
  }
  if (u.includes('/rest/v1/subscriptions')) return new Response(JSON.stringify(SUBS), { status: 200 });
  if (u.includes('/rest/v1/leads')) return new Response(JSON.stringify(LEADS), { status: 200 });
  if (u.includes('/rest/v1/orders')) {
    if (method === 'PATCH') {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method, kind: 'patch-order', url: u, body });
      return new Response(JSON.stringify([{ id: 'o-1', ...body }]), { status: 200 });
    }
    return new Response(JSON.stringify(ORDERS), { status: 200 });
  }
  if (u.includes('/rest/v1/audit_events')) { calls.push({ method: 'POST', kind: 'audit' }); return new Response('[]', { status: 201 }); }
  throw new Error('unexpected fetch ' + u);
};

const handler = (await import('../../netlify/functions/portal-kit-orders.mjs')).default;
const call = (method, { qs = '', body } = {}) =>
  handler(new Request('https://site.test/api/portal-kit-orders' + qs, {
    method, headers: { Authorization: 'Bearer at_1' }, body: body === undefined ? undefined : JSON.stringify(body)
  }));

/* ── (a) GET admin: una fila por LÍNEA de kit (KIT-6) ── */
{
  const res = await call('GET');
  const j = await res.json();
  t(res.status === 200, 'GET admin → 200');
  t(Array.isArray(j.rows) && j.rows.length === 5, 'GET: 5 filas (3 kits de Doug + 1 de Ann + 1 histórica)');
  const doug = j.rows.filter((r) => r.order_id === 'o-1');
  t(doug.length === 3, 'KIT-6: los 3 kits de una misma orden son 3 filas');
  t(new Set(doug.map((r) => r.item_id)).size === 3, 'KIT-6: cada fila tiene su propio item_id');
  const ann = j.rows.find((r) => r.order_id === 'o-2');
  t(ann && ann.quantity === 3, 'KIT-6: 3 unidades del MISMO kit = 1 fila con qty 3');
}

/* ── (b) forma de la fila: columnas que Doug enumeró ── */
{
  const j = await (await call('GET')).json();
  const r = j.rows.find((x) => x.item_id === 'it-1');
  t(r.order_date === '2026-08-05', 'fila: order date (YYYY-MM-DD)');
  t(r.kit_name === 'Wood Care Kit', 'fila: kit (tipo)');
  t(r.quantity === 1, 'fila: qty');
  t(r.customer_name === 'Doug Wright', 'fila: customer name');
  t(r.retail_cents === 4999, 'fila: retail = unit_price × qty');
  t(r.sh_cents === null, 'fila: S&H sin dato → null (no se inventa el $13.50)');
  t(r.fulfillment_status === 'pending', 'fila: status pending');
  t(r.ship_to && r.ship_to.address === '123 Oak St, Dallas, TX', 'fila: ship_to para el popup Address');
  const ann = j.rows.find((x) => x.item_id === 'it-4');
  t(ann.retail_cents === 4999 * 3, 'fila: retail multiplica por la cantidad');
  t(ann.customer_name === 'Ann Ruiz', 'fila: fallback de nombre desde profiles');
  const shipped = j.rows.find((x) => x.item_id === 'it-3');
  t(shipped.shipping_confirmation === '1Z999AA1', 'fila: shipping confirmation (última columna)');
  t(shipped.sh_cents === 1350, 'fila: S&H se muestra si existe el dato');
}

/* ── (c) orden por fecha descendente ── */
{
  const j = await (await call('GET')).json();
  t(j.rows[0].order_date >= j.rows[j.rows.length - 1].order_date, 'GET: ordenado por fecha desc');
  t(j.total === 5, 'GET: total');
}

/* ── (d) SOLO admin (la frontera real es el server, no el data-roles) ── */
{
  ME = { id: 'd1', email: 'd@bls.com', app_metadata: { portal_role: 'dealer', org_id: 'org-bls' }, user_metadata: {} };
  t((await call('GET')).status === 403, 'GET dealer → 403');
  t((await call('POST', { body: { action: 'ship_info', item_id: 'it-1', shipping_confirmation: 'X' } })).status === 403, 'POST dealer → 403');
  ME = { id: 'admin1', email: 'a@rap.com', app_metadata: { portal_role: 'admin' }, user_metadata: { full_name: 'Admin' } };
}

/* ── (e) KIT-10: ship_info DERIVA el estado del tracking ("if there's a tracking number, we
   presume it's shipped… pending is no tracking number", Doug 13-ago) ── */
{
  calls = [];
  const res = await call('POST', { body: { action: 'ship_info', item_id: 'it-1', shipping_confirmation: '1Z999AA10123456784', shipped_at: '2026-08-13' } });
  t(res.status === 200, 'POST ship_info → 200');
  const p = calls.find((c) => c.kind === 'patch-item');
  t(p && p.body.shipping_confirmation === '1Z999AA10123456784', 'ship_info: guarda el reference number');
  t(p && p.body.shipped_at, 'ship_info: guarda la fecha');
  t(p && p.body.fulfillment_status === 'shipped', 'KIT-10: con tracking → Shipped, sin click extra');
  t(p && p.url.includes('id=eq.it-1'), 'ship_info: patch a la línea correcta');
  t(calls.some((c) => c.kind === 'audit'), 'ship_info: queda auditado');
}
{
  /* Vaciar el tracking es la vuelta a Pending (reemplaza al viejo unship). */
  calls = [];
  const res = await call('POST', { body: { action: 'ship_info', item_id: 'it-3', shipping_confirmation: '  ' } });
  t(res.status === 200, 'KIT-10: guardar vacío → 200 (ya no es error)');
  const p = calls.find((c) => c.kind === 'patch-item');
  t(p && p.body.fulfillment_status === 'pending', 'KIT-10: sin tracking → Pending');
  t(p && p.body.shipping_confirmation === null && p.body.shipped_at === null, 'KIT-10: limpia tracking y fecha');
}
{
  /* Fecha previa del item se conserva si el body no trae una nueva. */
  calls = [];
  await call('POST', { body: { action: 'ship_info', item_id: 'it-3', shipping_confirmation: 'NEW-REF' } });
  const p = calls.find((c) => c.kind === 'patch-item');
  t(p && p.body.shipped_at && p.body.shipped_at.startsWith('2026-08-06'), 'KIT-10: sin fecha en el body conserva la ya estampada');
}

/* ── (f) KIT-10: las acciones manuales de estado MURIERON ── */
{
  t((await call('POST', { body: { action: 'shipped', item_id: 'it-1' } })).status === 400, 'KIT-10: action shipped → 400 (murió)');
  t((await call('POST', { body: { action: 'unship', item_id: 'it-3' } })).status === 400, 'KIT-10: action unship → 400 (murió)');
}

/* ── (f2) KIT-11: export CSV de la lista FILTRADA (precedente PORT-24B) ── */
{
  calls = [];
  const res = await call('POST', { body: { action: 'export', item_ids: ['it-1', 'it-3', 'nope'] } });
  t(res.status === 200, 'export → 200');
  const j = await res.json();
  t(j.ok === true && j.filename === 'kit-orders.csv', 'export: filename kit-orders.csv');
  t(j.rows === 2, 'export: ids desconocidos se ignoran (2 de 3)');
  const lines = j.csv.split('\n');
  t(/^Order date,Kit,Qty,Customer,Email,Retail,S&H,Tracking #,Status$/.test(lines[0]), 'export: columnas espejo de la tabla (con S&H: it-3 lo trae)');
  t(lines.length === 3, 'export: cabecera + 2 filas');
  t(/Fabric Care Kit/.test(j.csv) && /1Z999AA1/.test(j.csv) && /Shipped/.test(j.csv), 'export: la fila enviada lleva kit, tracking y status');
  t(/49\.99/.test(j.csv), 'export: retail en dólares, no en centavos');
  t(calls.some((c) => c.kind === 'audit'), 'export: queda auditado');
}
{
  /* Sin ningún sh_cents en el set exportado, la columna S&H no aparece (criterio: el SET del export). */
  const res = await call('POST', { body: { action: 'export', item_ids: ['it-1', 'it-2'] } });
  const j = await res.json();
  t(!/S&H/.test(j.csv.split('\n')[0]), 'export: sin importes en el set, la columna S&H no viaja');
  t((await call('POST', { body: { action: 'export', item_ids: [] } })).status === 400, 'export sin ids → 400');
}

/* ── (g) errores ── */
{
  t((await call('POST', { body: { action: 'nope', item_id: 'it-1' } })).status === 400, 'acción desconocida → 400');
  t((await call('POST', { body: { action: 'ship_info' } })).status === 400, 'sin item_id → 400');
  t((await call('POST', { body: { action: 'ship_info', item_id: 'nope', shipping_confirmation: 'X' } })).status === 404, 'item inexistente → 404');
  t((await call('PUT')).status === 405, 'método no soportado → 405');
  const noAuth = await handler(new Request('https://site.test/api/portal-kit-orders'));
  t(noAuth.status === 401, 'sin bearer → 401');
}

/* ── (h) KIT-2: la migración es aditiva e idempotente ── */
{
  const m = src('supabase/migrations/20260813000000_kit_fulfillment.sql');
  t(/ALTER TABLE public\.order_items/.test(m), 'migración: toca order_items');
  t(/fulfillment_status/.test(m) && /shipping_confirmation/.test(m) && /shipped_at/.test(m), 'migración: los 3 campos de despacho');
  t(/sh_cents/.test(m), 'migración: sh_cents (S&H, nullable)');
  t(/ALTER TABLE public\.orders/.test(m) && /ship_to_address/.test(m), 'migración: ship_to_* en orders');
  t((m.match(/ADD COLUMN IF NOT EXISTS/g) || []).length >= 8, 'migración: idempotente (ADD COLUMN IF NOT EXISTS)');
  t(!/DROP\s+(TABLE|COLUMN)/i.test(m), 'migración: NO destructiva');
  t(!/^\s*REVOKE/im.test(m), 'migración: no cambia la postura de grants existente (sin sentencia REVOKE)');
  t(/GRANT[\s\S]*service_role/.test(m), 'migración: grant explícito a service_role (regla de la casa)');
  t(/CHECK[\s\S]*pending[\s\S]*shipped/.test(m), 'migración: CHECK de valores (no enum)');
}

/* ── (i) KIT-3: el webhook copia la dirección del lead a la orden ── */
{
  const w = src('netlify/functions/stripe-webhook.mjs');
  t(/ship_to_address:/.test(w), 'webhook: pasa ship_to_address al insertOrder');
  t(/ship_to_name:/.test(w) && /ship_to_zip:/.test(w), 'webhook: nombre y zip del envío');
  t(/stripe_payment_intent_id: payRef/.test(w), 'webhook: NO se rompió la idempotencia por payment_intent');
}

/* ── (j) dirección: cadena de fallback orden → perfil → lead (mismo patrón que _lib/account.mjs).
       Sin esto, las órdenes anteriores al snapshot muestran el popup vacío. ── */
{
  const j = await (await call('GET')).json();
  const snap = j.rows.find((x) => x.item_id === 'it-1');
  t(snap.ship_to.address === '123 Oak St, Dallas, TX' && snap.ship_to.source === 'order', 'ship_to: la orden con snapshot manda');

  const prof = j.rows.find((x) => x.item_id === 'it-4');
  t(prof.ship_to.address === '9 Pine Ave, Austin, TX', 'ship_to: sin snapshot cae al perfil');
  t(prof.ship_to.phone === '555-3434' && prof.ship_to.source === 'profile', 'ship_to: origen marcado como profile');

  const lead = j.rows.find((x) => x.item_id === 'it-5');
  t(lead.ship_to.address === '77 Legacy Rd, Dallas, TX', 'ship_to: sin perfil cae al lead del checkout');
  t(lead.ship_to.zip === '75002' && lead.ship_to.source === 'lead', 'ship_to: origen marcado como lead');
}

/* ── (j2) [View] igual que en Subscribers: la fila trae el contrato del cliente si es suscriptor ── */
{
  const j = await (await call('GET')).json();
  const doug = j.rows.find((x) => x.item_id === 'it-1');
  t(/^RX-10001-\d+$/.test(doug.contract_number || ''), 'fila: contract_number del suscriptor (View abre su ficha)');
  const ann = j.rows.find((x) => x.item_id === 'it-4');
  t(ann.contract_number === null, 'comprador de solo-kit: sin contrato → View muestra el detalle de la orden');
}

/* ── (k) editar la dirección (la oficina la corrige o la teclea si no existe) ── */
{
  calls = [];
  const res = await call('POST', { body: { action: 'ship_to', item_id: 'it-1', ship_to_name: 'Doug Wright', ship_to_address: '500 New Rd, Plano, TX', ship_to_zip: '75023', ship_to_phone: '5551234567' } });
  t(res.status === 200, 'POST ship_to → 200');
  const p = calls.find((c) => c.kind === 'patch-order');
  t(p && p.body.ship_to_address === '500 New Rd, Plano, TX', 'ship_to: guarda la dirección en la ORDEN (no en el perfil)');
  t(p && p.body.ship_to_zip === '75023', 'ship_to: guarda el zip');
  t(p && p.url.includes('id=eq.o-1'), 'ship_to: patchea la orden derivada del item (no un order_id del body)');
  t(!calls.some((c) => c.kind === 'patch-item'), 'ship_to: no toca la línea de kit');
  const audit = calls.find((c) => c.kind === 'audit');
  t(!!audit, 'ship_to: queda auditado');
}
{
  t((await call('POST', { body: { action: 'ship_to', item_id: 'it-1', ship_to_address: '   ' } })).status === 400, 'ship_to sin dirección → 400');
  t((await call('POST', { body: { action: 'ship_to', item_id: 'it-1', ship_to_address: 'x'.repeat(300) } })).status === 400, 'ship_to con dirección > 256 → 400');
  t((await call('POST', { body: { action: 'ship_to', item_id: 'it-1', ship_to_address: 'ok', ship_to_zip: '9999' } })).status === 400, 'ship_to con zip inválido → 400');
}

/* ── (l) la PII no se duplica en el audit trail ── */
{
  const s = src('netlify/functions/portal-kit-orders.mjs');
  t(!/details:\s*\{[^}]*ship_to_address/.test(s), 'audit: NO vuelca la dirección en details (PII)');
  t(/checkRate/.test(s), 'POST: tiene rate limit (escribe PII)');
}

t.done();
