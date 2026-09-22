/* ============================================================================
 * /.netlify/functions/portal-kit-orders — Kit fulfillment (KIT-1..KIT-6).
 *   GET  → una fila POR LÍNEA de kit ("you would show one row by type of kit"), con la ficha de
 *          despacho: fecha de orden, kit, qty, cliente, retail, S&H, shipping confirmation.
 *   POST (admin-only):
 *     action 'ship_info' → guarda el tracking # y DERIVA el estado (KIT-10, Doug 13-ago: "if
 *                          there's a tracking number, we presume it's shipped… pending is no
 *                          tracking number"). Tracking no vacío = shipped; vacío = pending.
 *     action 'ship_to'   → edita la dirección de envío de la orden (KIT-3b).
 *
 * ADMIN-ONLY de punta a punta: el data-roles del front es cosmético, la frontera es assertAdmin.
 * Doug: "we need to add on the admin log on a page for kit fulfillment".
 * Spec: misc/spec-kit-orders.md · fuente: revisiones/KitOrdersMeeting.vtt (+ los 2 .srt).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, assertAdmin, auditRow, dateOnly, contractNumber, paymentsSince, toCSV, PortalError } from './_lib/portal.mjs';
import { pgrest, writeAudit } from './_lib/supabase.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';

/* KIT-10: mueren 'shipped' y 'unship' — el estado ya no se marca a mano, se deriva del tracking. */
const ACTIONS = ['ship_info', 'ship_to'];
const ADDRESS_MAX = 256;   // espeja el cap del checkout (_lib/validate.mjs)
const NAME_MAX = 128;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

/* Una línea de kit + su orden → la fila que pinta la tabla.
 * `lead` es el fallback más profundo de dirección (ver resolveShipTo). */
function presentRow(item, order, lead, contract) {
  const o = order || {};
  const prof = o.profiles || {};
  const kit = item.care_kits || {};
  const qty = item.quantity || 0;
  return {
    item_id: item.id,
    order_id: item.order_id,
    order_date: dateOnly(o.created_at),
    kit_name: kit.name || null,
    kit_sku: kit.sku || null,
    quantity: qty,
    /* El nombre del perfil manda; si la compra fue de invitado, el del envío; si no, el email. */
    customer_name: prof.full_name || o.ship_to_name || o.email || null,
    customer_email: prof.email || o.email || null,
    /* Nº de contrato del cliente, si además es suscriptor: deja que [View] abra su ficha completa
       igual que en Subscribers. NULL cuando solo compró un kit (no hay ficha que abrir). */
    contract_number: contract || null,
    retail_cents: (item.unit_price_cents || 0) * qty,
    /* S&H: NULL hasta que exista el dato. El $13.50 de Doug fue una instrucción contable a Javon,
       no un cálculo de esta página — no se inventa aquí (ver KIT-8). */
    sh_cents: item.sh_cents == null ? null : item.sh_cents,
    fulfillment_status: item.fulfillment_status || 'pending',
    shipping_confirmation: item.shipping_confirmation || null,
    shipped_at: item.shipped_at || null,
    /* Para el popup [Address]: "to save space with this pop-up you can show the customer's address". */
    ship_to: resolveShipTo(o, prof, lead)
  };
}

/* Dirección en CADENA, igual que el dashboard del cliente (_lib/account.mjs):
 *   1) snapshot de la orden  2) perfil del cliente  3) lead del checkout
 * Las órdenes anteriores al snapshot no tienen ship_to_*, y sin esto el popup sale vacío.
 * `source` deja claro de dónde salió, para que la oficina sepa si está mirando el dato
 * congelado de la compra o una aproximación que conviene confirmar. */
function resolveShipTo(o, prof, lead) {
  const l = lead || {};
  const address = o.ship_to_address || prof.address || l.addr || null;
  let source = null;
  if (o.ship_to_address) source = 'order';
  else if (prof.address) source = 'profile';
  else if (l.addr) source = 'lead';
  return {
    name: o.ship_to_name || prof.full_name || null,
    address,
    zip: o.ship_to_zip || (o.ship_to_address ? null : l.zip) || null,
    phone: o.ship_to_phone || prof.phone || l.phone || null,
    source
  };
}

/* Dos queries (orders → sus líneas) en vez de un embed con order=orders(created_at): ordenar por
 * una columna de la tabla padre desde el hijo depende de la versión de PostgREST, y si no lo
 * soporta el limit truncaría filas en silencio. Mismo patrón que _lib/account.mjs. */
async function listRows(env) {
  const oq = await pgrest(env, '/orders?status=eq.paid'
    + '&select=id,user_id,created_at,email,ship_to_name,ship_to_phone,ship_to_address,ship_to_zip,profiles(full_name,email,phone,address)'
    + '&order=created_at.desc&limit=5000');
  if (oq.status >= 300) throw new Error('orders ' + oq.status);
  const orders = Array.isArray(oq.data) ? oq.data : [];
  if (!orders.length) return [];

  /* Fallback de dirección: UN solo query batch para los emails que no tienen snapshot ni perfil
     (nunca uno por fila: el listado llega a 5000 órdenes). Se proyectan subcampos del payload
     para no arrastrar el JSON completo del lead. */
  const leadsByEmail = await fetchLeadAddresses(env, orders);
  const contractByUser = await fetchContracts(env, orders);

  const ids = orders.map((o) => encodeURIComponent(o.id)).join(',');
  const iq = await pgrest(env, `/order_items?order_id=in.(${ids})`
    + '&select=id,order_id,quantity,unit_price_cents,fulfillment_status,shipping_confirmation,shipped_at,sh_cents,care_kits(name,sku)');
  if (iq.status >= 300) throw new Error('order_items ' + iq.status);
  const items = Array.isArray(iq.data) ? iq.data : [];

  const byId = new Map(orders.map((o) => [o.id, o]));
  const rank = new Map(orders.map((o, i) => [o.id, i]));   // el orden ya viene desc de la query
  return items
    .filter((it) => byId.has(it.order_id))
    .sort((a, b) => (rank.get(a.order_id) - rank.get(b.order_id)))
    .map((it) => {
      const o = byId.get(it.order_id);
      return presentRow(it, o, leadsByEmail.get(String(o.email || '').toLowerCase()), contractByUser.get(o.user_id));
    });
}

/* Contrato del cliente (si además es suscriptor) para que [View] abra la misma ficha que
   Subscribers. Un solo query batch; fail-soft, el listado nunca depende de esto. */
async function fetchContracts(env, orders) {
  const map = new Map();
  const ids = [...new Set(orders.map((o) => o.user_id).filter(Boolean))];
  if (!ids.length) return map;
  const now = Date.now();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map((v) => encodeURIComponent(v)).join(',');
      const r = await pgrest(env, `/subscriptions?kind=eq.protection&user_id=in.(${chunk})`
        + '&select=user_id,master_no,started_at&order=started_at.desc&limit=2000');
      if (r.status >= 300 || !Array.isArray(r.data)) continue;
      for (const s of r.data) {                       // desc → la suscripción más reciente gana
        if (s.user_id && !map.has(s.user_id) && s.master_no) {
          map.set(s.user_id, contractNumber(s.master_no, paymentsSince(s.started_at, now)));
        }
      }
    }
  } catch (err) { console.warn('[portal-kit-orders] contracts:', err.message); }
  return map;
}

/* Direcciones del último lead por email, solo para las órdenes que las necesitan. Fail-soft:
   si esto falla, el popup mostrará lo que haya (nunca tumba el listado). */
async function fetchLeadAddresses(env, orders) {
  const map = new Map();
  const emails = [...new Set(orders
    .filter((o) => !o.ship_to_address && !((o.profiles || {}).address) && o.email)
    .map((o) => String(o.email).toLowerCase()))];
  if (!emails.length) return map;
  try {
    for (let i = 0; i < emails.length; i += 100) {          // trocea por el límite de la URL
      const chunk = emails.slice(i, i + 100).map((e) => `"${encodeURIComponent(e)}"`).join(',');
      const r = await pgrest(env, `/leads?email=in.(${chunk})`
        + '&select=email,addr:payload->>address,zip:payload->>receipt_zip,phone:payload->>phone'
        + '&order=created_at.desc&limit=2000');
      if (r.status >= 300 || !Array.isArray(r.data)) continue;
      for (const row of r.data) {                            // desc → el primero de cada email gana
        const k = String(row.email || '').toLowerCase();
        if (k && !map.has(k)) map.set(k, row);
      }
    }
  } catch (err) { console.warn('[portal-kit-orders] leads fallback:', err.message); }
  return map;
}

/* Lee UNA línea; null si no existe (→ 404, no se filtra si el id es válido o no). */
async function findItem(env, itemId) {
  const r = await pgrest(env, `/order_items?id=eq.${encodeURIComponent(itemId)}&select=id,order_id,fulfillment_status,shipped_at&limit=1`);
  if (r.status >= 300) throw new Error('find ' + r.status);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function patchItem(env, itemId, patch) {
  const r = await pgrest(env, `/order_items?id=eq.${encodeURIComponent(itemId)}`, {
    method: 'PATCH', prefer: 'return=representation', body: patch
  });
  if (r.status >= 300) throw new Error('patch ' + r.status);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

export default async function handler(req) {
  const env = process.env;

  let ctx, scope;
  try {
    ctx = await requirePortalUser(req, env);
    scope = ctx.scope;
    assertAdmin(scope);                       // la página es admin-only: GET y POST
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-kit-orders] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  if (req.method === 'GET') {
    try {
      const rows = await listRows(env);
      return json(200, { rows, total: rows.length });
    } catch (err) {
      console.error('[portal-kit-orders] list:', err.message);
      return json(502, { error: 'upstream' });
    }
  }

  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  /* Escribe datos personales (dirección de envío) → límite por IP, como update-profile. */
  const rl = await checkRate(env, { prefix: 'kitship', ip: clientIp(req), limit: 20, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }
  const action = body && body.action;

  /* KIT-11 ("Can they export that list? They should be able to… maybe Excel") — CSV de la lista
   * FILTRADA (precedente PORT-24B: "it should export the filtered list"). Se despacha ANTES del
   * guard de item_id porque opera sobre una lista, no sobre un item. */
  if (action === 'export') {
    const ids = Array.isArray(body.item_ids) ? body.item_ids.map(String) : [];
    if (!ids.length) return json(400, { error: 'missing_item_ids' });
    try {
      const wanted = new Set(ids);
      const rows = (await listRows(env)).filter((r) => wanted.has(String(r.item_id)));
      const usd = (c) => (c == null ? '' : (c / 100).toFixed(2));
      /* S&H es condicional con el MISMO criterio de la tabla, aplicado al set exportado. */
      const hasSH = rows.some((r) => r.sh_cents != null);
      const cols = [
        { key: 'order_date', label: 'Order date' }, { key: 'kit_name', label: 'Kit' },
        { key: 'quantity', label: 'Qty' }, { key: 'customer_name', label: 'Customer' },
        { key: 'customer_email', label: 'Email' }, { key: 'retail', label: 'Retail' }
      ].concat(hasSH ? [{ key: 'sh', label: 'S&H' }] : []).concat([
        { key: 'shipping_confirmation', label: 'Tracking #' }, { key: 'status', label: 'Status' }
      ]);
      const out = rows.map((r) => ({
        ...r, retail: usd(r.retail_cents), sh: usd(r.sh_cents),
        status: r.fulfillment_status === 'shipped' ? 'Shipped' : 'Pending'
      }));
      await writeAudit(env, auditRow({
        actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
        category: 'kit_fulfillment', action: 'kit_export', target: 'kit-orders.csv',
        details: { rows: out.length }
      }));
      return json(200, { ok: true, filename: 'kit-orders.csv', rows: out.length, csv: toCSV(out, cols) });
    } catch (err) {
      console.error('[portal-kit-orders] export:', err.message);
      return json(502, { error: 'upstream' });
    }
  }

  const itemId = body && body.item_id;
  if (!ACTIONS.includes(action)) return json(400, { error: 'bad_action' });
  if (!itemId) return json(400, { error: 'missing_item_id' });

  try {
    const item = await findItem(env, itemId);
    if (!item) return json(404, { error: 'not_found' });

    /* Editar la dirección de envío (KIT-3b). Se guarda en la ORDEN, no en el perfil: el perfil
       lo cambia el cliente cuando quiera, y una etiqueta ya impresa no debe mudarse sola.
       El order_id se DERIVA del item validado, nunca se acepta del body. */
    if (action === 'ship_to') {
      const clean = (v, max) => { const s = String(v == null ? '' : v).trim(); return s.length > max ? null : s; };
      const address = clean(body.ship_to_address, ADDRESS_MAX);
      if (!address) return json(400, { error: 'invalid_address' });
      const name = clean(body.ship_to_name, NAME_MAX);
      if (name === null) return json(400, { error: 'invalid_name' });
      const zip = clean(body.ship_to_zip, 16);
      if (zip && !ZIP_RE.test(zip)) return json(400, { error: 'invalid_zip' });
      const phone = clean(body.ship_to_phone, 32);

      const orderPatch = {
        ship_to_name: name || null, ship_to_address: address,
        ship_to_zip: zip || null, ship_to_phone: phone || null
      };
      const r = await pgrest(env, `/orders?id=eq.${encodeURIComponent(item.order_id)}`, {
        method: 'PATCH', prefer: 'return=representation', body: orderPatch
      });
      if (r.status >= 300) throw new Error('patch order ' + r.status);
      /* El audit registra QUÉ campos se tocaron, no su contenido: no duplicamos PII en otra tabla. */
      await writeAudit(env, auditRow({
        actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
        category: 'kit_fulfillment', action: 'kit_ship_to_update', target: String(item.order_id),
        details: { fields: Object.keys(orderPatch).filter((k) => orderPatch[k]) }
      }));
      return json(200, { ok: true, ship_to: { name: orderPatch.ship_to_name, address, zip: orderPatch.ship_to_zip, phone: orderPatch.ship_to_phone, source: 'order' } });
    }

    /* KIT-10 (Doug 13-ago 05:31-06:21): el tracking number es el ÚNICO hecho; el estado se deriva.
     * No vacío → shipped (fecha: la enviada, la ya estampada, o ahora). Vacío → pending y se
     * limpian tracking + fecha (reemplaza al viejo "undo"). Sin carrier: "this is strictly manual".
     * Filas legacy shipped-sin-tracking (del flujo anterior) se muestran como están; la próxima
     * edición las normaliza a esta regla. */
    const ref = String((body.shipping_confirmation || '')).trim();
    let patch;
    if (ref) {
      const when = body.shipped_at ? new Date(body.shipped_at) : (item.shipped_at ? new Date(item.shipped_at) : new Date());
      if (isNaN(when.getTime())) return json(400, { error: 'bad_date' });
      patch = { shipping_confirmation: ref, shipped_at: when.toISOString(), fulfillment_status: 'shipped' };
    } else {
      patch = { shipping_confirmation: null, shipped_at: null, fulfillment_status: 'pending' };
    }

    const row = await patchItem(env, itemId, patch);
    await writeAudit(env, auditRow({
      actor_id: ctx.userId, actor_name: ctx.name, actor_role: scope.role,
      category: 'kit_fulfillment', action: 'kit_ship_info', target: String(itemId),
      details: ref ? { shipping_confirmation: ref } : { cleared: true }
    }));
    return json(200, { ok: true, item: row || { id: itemId, ...patch } });
  } catch (err) {
    console.error('[portal-kit-orders] ' + action + ':', err.message);
    return json(502, { error: 'upstream' });
  }
}
