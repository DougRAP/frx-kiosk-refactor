/* kit-orders-ui — la página Kit Orders en jsdom (KIT-1, KIT-3, KIT-4, KIT-5, KIT-6).
 * Spec: misc/spec-kit-orders.md · fuente: revisiones/KitOrdersMeeting.vtt (+ los 2 .srt).
 * Doug: copia de Subscribers, columnas de kit, 3 botones (Address / Enter shipping / Shipped)
 * y View se queda. Una fila por tipo de kit. */
import { loadPortal, makeT, flush, src } from './helpers.mjs';

const t = makeT('kit-orders-ui');

const ADMIN = { user_id: 'u1', name: 'Admin', email: 'a@rap.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, app_url: 'https://kiosk.furniturerx.net/' };
/* El caso literal de Doug: 3 kits distintos de Doug Wright (misma orden) + 3 unidades del mismo kit. */
const ROWS = [
  { item_id: 'it-1', order_id: 'o-1', contract_number: 'RX-10001-2', order_date: '2026-08-05', kit_name: 'Wood Care Kit', kit_sku: 'CARE-WOOD-001', quantity: 1, customer_name: 'Doug Wright', customer_email: 'doug@rap.com', retail_cents: 4999, sh_cents: null, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, ship_to: { name: 'Doug Wright', address: '123 Oak St, Dallas, TX', zip: '75001', phone: '555-1212' } },
  { item_id: 'it-2', order_id: 'o-1', order_date: '2026-08-05', kit_name: 'Leather Care Kit', kit_sku: 'CARE-LEATHER-001', quantity: 1, customer_name: 'Doug Wright', customer_email: 'doug@rap.com', retail_cents: 4999, sh_cents: null, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, ship_to: { name: 'Doug Wright', address: '123 Oak St, Dallas, TX', zip: '75001', phone: '555-1212' } },
  { item_id: 'it-3', order_id: 'o-2', order_date: '2026-08-04', kit_name: 'Wood Care Kit', kit_sku: 'CARE-WOOD-001', quantity: 3, customer_name: 'Ann Ruiz', customer_email: 'ann@rap.com', retail_cents: 14997, sh_cents: 1350, fulfillment_status: 'shipped', shipping_confirmation: '1Z999AA1', shipped_at: '2026-08-06T10:00:00Z', ship_to: { name: 'Ann Ruiz', address: '9 Pine Ave, Austin, TX', zip: '73301', phone: null } }
];

const { window, document, requests } = await loadPortal({
  session: { access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 },
  me: ADMIN,
  api: { 'portal-kit-orders': (u, o) => (o && o.method === 'POST' ? { ok: true } : { rows: ROWS, total: ROWS.length }) }
});
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

window.show('kitorders');
await flush();

/* ── KIT-1: la página y sus columnas ── */
{
  t(!!$('#view-kitorders'), 'existe la vista #view-kitorders');
  t($('#view-kitorders').getAttribute('data-roles') === 'admin', 'la vista es admin-only');
  const nav = $('a[data-screen="kitorders"]');
  t(!!nav && nav.getAttribute('data-roles') === 'admin', 'nav: entrada Kit Orders admin-only');
  const heads = $$('#view-kitorders thead th').map((th) => th.textContent.trim());
  t(heads[0] === 'Order date', 'col 1: Order date');
  t(heads[1] === 'Kit', 'col 2: Kit (antes Program)');
  t(heads[2] === 'Qty', 'col 3: Qty');
  t(heads[3] === 'Customer', 'col 4: Customer');
  t(heads[4] === 'Retail', 'col 5: Retail');
  t(heads[5] === 'S&H', 'col 6: Shipping & handling');
  t(heads[6] === 'Tracking #', 'col 7: Tracking # (el shipping confirmation de Doug, con nombre entendible)');
  t(!heads.includes('SR'), 'sin columna SR (Doug no la incluyó en esta página)');
  t(!!$('#kit-search'), 'buscador (se conserva el marco de Subscribers)');
}

/* ── KIT-6: una fila por tipo de kit ── */
{
  const rows = $$('#kit-body tr');
  t(rows.length === 3, 'KIT-6: 3 filas (2 kits de Doug + 1 de Ann)');
  const c0 = Array.from(rows[0].children).map((td) => td.textContent.trim());
  t(c0[0] === '2026-08-05' && c0[1] === 'Wood Care Kit', 'fila 1: fecha + kit');
  t(c0[2] === '1' && c0[3] === 'Doug Wright', 'fila 1: qty + cliente');
  t(c0[4] === '$49.99', 'fila 1: retail formateado');
  t(c0[5] === '—', 'S&H sin dato pinta — (no se inventa el $13.50)');
  t(c0[6] === '—', 'shipping confirmation vacía pinta —');
  const c2 = Array.from(rows[2].children).map((td) => td.textContent.trim());
  t(c2[2] === '3', 'KIT-6: 3 unidades del mismo kit = 1 fila con qty 3');
  t(c2[5] === '$13.50', 'S&H se muestra cuando hay dato');
  t(c2[6] === '1Z999AA1', 'shipping confirmation se muestra');
  t(/Shipped/i.test(rows[2].textContent), 'fila ya despachada se ve como Shipped');
}

/* ── botones: los 3 de Doug en su celda + View en columna propia ── */
{
  const rows = $$('#kit-body tr');
  const labels = Array.from(rows[0].querySelectorAll('td.kit-acts *')).map((e) => e.textContent.trim());
  t(labels.some((l) => /Address/i.test(l)), 'botón Address');
  t(labels.some((l) => /^Enter tracking/i.test(l)), 'sin número: el botón dice Enter tracking #');
  const withTrk = Array.from(rows[2].querySelectorAll('td.kit-acts *')).map((e) => e.textContent.trim());
  t(withTrk.some((l) => /^Edit tracking/i.test(l)), 'con número ya puesto: el botón dice Edit tracking #');
  /* KIT-10: el botón Shipped MURIÓ — el estado se deriva del tracking number. */
  t(!labels.some((l) => /^Shipped$/i.test(l)), 'KIT-10: ya no existe el botón Shipped');
  t(!labels.includes('View'), 'View ya no vive entre las acciones');

  const vcell = rows[0].querySelector('td.kit-view');
  t(!!vcell && vcell.textContent.trim() === 'View', 'View tiene su propia columna, la última');
  const heads = $$('#view-kitorders thead th');
  t(heads.length === 10 && heads[9].textContent.trim() === '', 'la columna de View no lleva cabecera');

  /* fila ya enviada: tercer slot informativo con la fecha */
  const doneLabels = Array.from(rows[2].querySelectorAll('td.kit-acts *')).map((e) => e.textContent.trim());
  t(doneLabels.some((l) => /^Sent/.test(l)), 'la fila enviada mantiene el slot con la fecha de envío');
  t(!doneLabels.includes('Undo'), 'la fila enviada NO mete un control extra');
  t(rows[0].querySelectorAll('td.kit-acts .btn').length === rows[2].querySelectorAll('td.kit-acts .btn').length,
    'pendiente y enviada tienen los MISMOS botones (Address + tracking)');

  /* KIT-12: clases de slot para los anchos fijos del CSS desktop. */
  t(!!rows[0].querySelector('.kit-b-addr') && !!rows[0].querySelector('.kit-b-trk'), 'KIT-12: los botones llevan su clase de slot');
  t(!!rows[2].querySelector('.kit-b-sent'), 'KIT-12: el slot Sent de la fila enviada lleva su clase');
  const css = src('portal/assets/css/portal.css');
  t(/@media \(min-width:761px\)[\s\S]*kit-b-trk\{width/.test(css), 'KIT-12: ancho fijo por slot SOLO en desktop (la tarjeta móvil apila)');
}

/* ── KIT-3: popup de la dirección + Print ── */
{
  window.openKitAddress('it-1');
  t($('#kit-addr-modal').classList.contains('on'), 'Address abre el popup');
  const txt = $('#kit-addr-body').textContent;
  t(/Doug Wright/.test(txt) && /123 Oak St/.test(txt) && /75001/.test(txt), 'popup muestra el ship-to completo');
  let printed = 0; window.print = () => { printed++; };
  window.printKitAddress();
  t(printed === 1, 'Print invoca window.print (impresión manual en la oficina)');
  window.closeKitAddress();
  t(!$('#kit-addr-modal').classList.contains('on'), 'popup se cierra');
}

/* ── KIT-4 + KIT-10: popup del tracking. Guardar con número marca Shipped; vacío → Pending ── */
{
  window.openKitShipping('it-1');
  t($('#kit-ship-modal').classList.contains('on'), 'Enter tracking abre el popup');
  t(!!$('#kit-ref') && !!$('#kit-date'), 'popup: reference number + fecha');
  t(!document.querySelector('#kit-ship-modal select'), 'sin dropdown de carrier (Doug no lo pidió)');
  t(!document.getElementById('kit-ship-err'), 'KIT-10: murió el error inline (vacío ya es un estado válido)');
  const note = document.querySelector('#kit-ship-modal .finenote');
  t(!!note && /marks the kit as Shipped/i.test(note.textContent), 'el popup explica la regla (guardar = Shipped, vaciar = Pending)');

  $('#kit-ref').value = '1Z999AA10123456784';
  $('#kit-date').value = '2026-08-13';
  window.saveKitShipping();
  await flush();
  const post = requests.filter((r) => r.method === 'POST' && /portal-kit-orders/.test(r.url)).pop();
  t(post && post.body.action === 'ship_info', 'POST action ship_info');
  t(post && post.body.item_id === 'it-1', 'POST lleva el item_id de la línea');
  t(post && post.body.shipping_confirmation === '1Z999AA10123456784', 'POST lleva el reference number');
  t(post && post.body.shipped_at === '2026-08-13', 'POST lleva la fecha');
  t(!$('#kit-ship-modal').classList.contains('on'), 'guardar cierra el popup');
}

/* ── KIT-10: vaciar el tracking devuelve la fila a Pending (reemplaza al viejo Shipped/unship) ── */
{
  window.openKitShipping('it-3');
  t($('#kit-ship-title').textContent.startsWith('Edit'), 'con número el título dice Edit');
  t($('#kit-ref').value === '1Z999AA1', 'el popup trae el tracking existente prellenado');
  $('#kit-ref').value = '';
  window.saveKitShipping();
  await flush();
  const post = requests.filter((r) => r.method === 'POST' && /portal-kit-orders/.test(r.url)).pop();
  t(post && post.body.action === 'ship_info' && post.body.shipping_confirmation === '', 'guardar vacío manda el tracking vacío');
  t(post && !('shipped_at' in post.body), 'guardar vacío no manda fecha (el server limpia ambas)');

  /* Ya no existen los caminos manuales de estado. */
  t(typeof window.markKitShipped === 'undefined', 'KIT-10: markKitShipped murió');
  t(typeof window.undoKitShipped === 'undefined', 'KIT-10: undoKitShipped murió');
  t(typeof window.unshipFromDetail === 'undefined', 'KIT-10: unshipFromDetail murió');
  t(!document.getElementById('kit-detail-unship'), 'KIT-10: el botón Move to Pending del detalle murió');
}

/* ── buscador ── */
{
  $('#kit-search').value = 'ann';
  window.renderKits(true);
  t($$('#kit-body tr').length === 1, 'buscador filtra por cliente');
  $('#kit-search').value = 'leather';
  window.renderKits(true);
  t($$('#kit-body tr').length === 1, 'buscador filtra por kit');
  $('#kit-search').value = '';
  window.renderKits(true);
  t($$('#kit-body tr').length === 3, 'buscador vacío muestra todo');
}

/* ── filtros heredados de Subscribers ── */
{
  t(!!$('#kit-kit') && !!$('#kit-status') && !!$('#kit-fdate'), 'filtros: kit, estado y fecha');
  t($$('#kit-fdate option').length === 7, 'filtro de fecha: las mismas 7 opciones que Subscribers');
  t(!!$('#kitRangeInputs') && !!$('#kit-from') && !!$('#kit-to'), 'filtro de fecha: rango personalizado');
  t($$('#kit-kit option').length === 3, 'el filtro de kit se puebla con los kits de las filas (All + 2)');

  window.toggleKitRange();
  t(!$('#kitRangeInputs').classList.contains('show'), 'el rango solo se muestra con "Custom range"');
  $('#kit-fdate').value = 'range'; window.toggleKitRange();
  t($('#kitRangeInputs').classList.contains('show'), 'elegir "Custom range" revela las fechas');
  $('#kit-fdate').value = 'all'; window.toggleKitRange();

  $('#kit-status').value = 'shipped'; window.renderKits(true);
  t($$('#kit-body tr').length === 1, 'filtro de estado: solo los enviados');
  $('#kit-status').value = 'pending'; window.renderKits(true);
  t($$('#kit-body tr').length === 2, 'filtro de estado: solo los pendientes');
  $('#kit-status').value = ''; window.renderKits(true);

  $('#kit-kit').value = 'Leather Care Kit'; window.renderKits(true);
  t($$('#kit-body tr').length === 1, 'filtro por tipo de kit');
  $('#kit-kit').value = ''; window.renderKits(true);

  $('#kit-fdate').value = 'range'; $('#kit-from').value = '2026-08-05'; window.renderKits(true);
  t($$('#kit-body tr').length === 2, 'filtro por rango de fechas');
  $('#kit-fdate').value = 'all'; $('#kit-from').value = ''; window.renderKits(true);
  t($$('#kit-body tr').length === 3, 'quitar filtros vuelve a mostrar todo');
}

/* ── Status es columna propia, no va mezclado con las acciones ── */
{
  const heads = $$('#view-kitorders thead th').map((th) => th.textContent.trim());
  t(heads[7] === 'Status', 'col 8: Status (separada de las acciones)');
  const rows = $$('#kit-body tr');
  t(rows[0].children[7].textContent.trim() === 'Pending', 'fila pendiente: pill Pending');
  t(rows[2].children[7].textContent.trim() === 'Shipped', 'fila enviada: pill Shipped');
  t(!rows[0].children[8].querySelector('.pill'), 'la celda de acciones ya no lleva el pill de estado');
  t(!rows[2].children[8].querySelector('button.primary'), 'una fila ya enviada no ofrece el botón Shipped');
  t(rows[0].children[0].getAttribute('data-label') === 'Order date', 'celdas con data-label (vista de tarjetas en móvil)');
}

/* ── KIT-3b: la dirección se puede corregir cuando llega vacía o mal ── */
{
  window.openKitAddress('it-1');
  t($('#kit-addr-edit').hidden === true && $('#kit-addr-save').hidden === true, 'el popup abre en modo lectura');
  window.editKitAddress();
  t($('#kit-addr-edit').hidden === false && $('#kit-addr-read').hidden === true, 'Edit revela el formulario');
  t($('#kit-addr-street').value === '123 Oak St, Dallas, TX', 'el formulario viene prellenado con la dirección actual');

  $('#kit-addr-street').value = '';
  const before = requests.length;
  window.saveKitAddress();
  await flush();
  t(requests.length === before && !$('#kit-addr-err').hidden, 'guardar sin dirección muestra error y no envía');

  $('#kit-addr-street').value = '500 New Rd, Plano, TX'; $('#kit-addr-zip').value = '999';
  window.saveKitAddress();
  await flush();
  t(requests.length === before, 'un ZIP inválido tampoco envía');

  $('#kit-addr-zip').value = '75023';
  window.saveKitAddress();
  await flush();
  const post = requests.filter((r) => r.method === 'POST' && /portal-kit-orders/.test(r.url)).pop();
  t(post && post.body.action === 'ship_to', 'guardar dispara action ship_to');
  t(post && post.body.ship_to_address === '500 New Rd, Plano, TX', 'POST lleva la dirección corregida');
  t(post && post.body.ship_to_zip === '75023', 'POST lleva el ZIP');
  window.closeKitAddress();
}

/* ── View: mismo comportamiento que Subscribers (abre la ficha completa del cliente) ── */
{
  window.show('kitorders'); await flush();
  const rows = $$('#kit-body tr');
  rows[0].querySelector('td.kit-view .btn.link').click();   // it-1 → Doug es suscriptor
  await flush();
  t(document.querySelector('#view-custrecord').classList.contains('on'), 'View abre el Customer Record, como en Subscribers');

  window.show('kitorders'); await flush();
  $$('#kit-body tr')[2].querySelector('td.kit-view .btn.link').click();   // it-3 → solo compró kit
  await flush();
  t($('#kit-detail-modal').classList.contains('on'), 'sin contrato: View muestra el detalle de la orden');
  t(/Wood Care Kit/.test($('#kit-detail-body').textContent), 'el detalle trae los datos del kit');
  window.closeKitDetail();
}

/* ── S&H condicional: oculta mientras NADIE tenga importe, visible en cuanto haya uno ── */
{
  window.show('kitorders'); await flush();
  /* el fixture tiene una fila con 1350 → la columna se muestra */
  t($('#kit-th-sh').hidden === false, 'con al menos un importe, la cabecera S&H se muestra');
  t($$('#kit-body tr')[0].children[5].hidden === false, 'con dato, las celdas S&H se muestran');

  const SIN_SH = ROWS.map((r) => ({ ...r, sh_cents: null }));
  const b = await loadPortal({
    session: { access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 },
    me: ADMIN,
    api: { 'portal-kit-orders': () => ({ rows: SIN_SH, total: SIN_SH.length }) }
  });
  b.window.show('kitorders'); await flush();
  const $b = (s) => b.document.querySelector(s);
  t($b('#kit-th-sh').hidden === true, 'sin ningún importe, la cabecera S&H se oculta');
  t(b.document.querySelectorAll('#kit-body tr')[0].children[5].hidden === true, 'sin importe, las celdas S&H se ocultan');
  t(b.document.querySelectorAll('#kit-body tr')[0].children.length === 10, 'la columna se oculta, NO se elimina (el orden no cambia)');
  const heads = Array.from(b.document.querySelectorAll('#view-kitorders thead th'));
  t(heads[6].textContent.trim() === 'Tracking #', 'ocultar S&H no desplaza las columnas siguientes');
}

/* ── KIT-10: el detalle ya no revierte estados — la vuelta a Pending es vaciar el tracking ── */
{
  window.show('kitorders'); await flush();
  window.viewKitOrder('it-2');           // pendiente y sin contrato (abre el detalle, no la ficha)
  t($('#kit-detail-modal').classList.contains('on'), 'View de una compra solo-kit abre el detalle');
  t(!document.getElementById('kit-detail-unship'), 'el detalle no ofrece reversión manual (KIT-10)');
  window.closeKitDetail();
  t(!$('#kit-detail-modal').classList.contains('on'), 'el detalle se cierra');
}

/* ── KIT-11: export de lo filtrado ── */
{
  window.show('kitorders'); await flush();
  const btn = document.querySelector('#view-kitorders .filters button[onclick="exportKits()"]');
  t(!!btn && /Export to Excel/.test(btn.textContent), 'KIT-11: botón Export en la barra de filtros (patrón Subscribers)');

  /* filtra a UNA fila y exporta: solo viajan los ids visibles */
  $('#kit-search').value = 'ann';
  window.renderKits(true);
  window.exportKits();
  await flush();
  const post = requests.filter((r) => r.method === 'POST' && /portal-kit-orders/.test(r.url)).pop();
  t(post && post.body.action === 'export', 'KIT-11: POST action export');
  t(post && post.body.item_ids.length === 1 && post.body.item_ids[0] === 'it-3', 'KIT-11: viajan SOLO los item_ids filtrados');

  /* 0 filas → aviso y ningún POST */
  $('#kit-search').value = 'zzz-nadie';
  window.renderKits(true);
  const before = requests.length;
  window.exportKits();
  await flush();
  t(requests.length === before, 'KIT-11: sin filas no hay POST');
  t(/No rows to export/.test(document.getElementById('toasts').textContent), 'KIT-11: el aviso explica el porqué');
  $('#kit-search').value = '';
  window.renderKits(true);
}

/* ── no rompemos las reglas de la casa ── */
{
  const js = src('portal/assets/js/portal.js');
  t(!/\.innerHTML\s*=/.test(js), 'portal.js sigue sin innerHTML (PII → textContent)');
  const html = src('portal/index.html');
  t((html.match(/id="view-subscribers"/g) || []).length === 1, 'Subscribers intacta (una sola vez)');
  t(/<th>SR<\/th>/.test(html), 'la columna SR de Subscribers NO se tocó');
}

t.done();
