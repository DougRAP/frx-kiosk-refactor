/* PORT-28 — el dealer ve y descarga SU propio QR de sales-mode desde su sesión del portal.
 * El link vive junto a "Open kiosk signed in" (la otra forma de llegar al mismo kiosco) y abre
 * un modal con el QR CLICKEABLE + copiar + descargar. El MISMO modal cubre el caso de que RAP
 * todavía no le haya generado el link. jsdom con loadPortal. */
import { loadPortal, makeT, flush, src } from './helpers.mjs';

const t = makeT('sales-qr-ui');

const DEALER = { user_id: 'u2', name: 'Bailey Owner', email: 'owner@bls.com', role: 'dealer', tier: 'org', world: 'retailer', org_id: 'bls', org_name: "Bailey's", sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/', rap_id: 'BLS-1001' };
const ADMIN = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/', rap_id: null };
const SESSION = { access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 };
const LINK = { code: 'ACDE2345', url: 'https://kiosk.furniturerx.net/s/ACDE2345', created_at: '2026-08-01T00:00:00Z' };

/* ── dealer CON link: el modal trae QR clickeable, url y las dos acciones ── */
{
  const { window, document, requests } = await loadPortal({
    session: SESSION, me: DEALER,
    api: { 'portal-sales-mode': () => LINK }
  });
  const $ = (s) => document.querySelector(s);
  /* qrcode.min.js entra por <script src>, que jsdom no ejecuta: se stubea la lib (ya probada en
     el kiosk) para verificar lo que SÍ toca aquí — que el modal monte el SVG en su caja. */
  window.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: (r, c) => (r + c) % 2 === 0 });

  const nav = $('#salesQrNav');
  t(!!nav && /Sales Mode QR/.test(nav.textContent), 'PORT-28: el nav tiene "Sales Mode QR"');
  t(!nav.classList.contains('role-hidden'), 'PORT-28: el dealer (tier org) SÍ lo ve');
  const kiosk = $('#kioskNav');
  t(!!kiosk && kiosk.nextElementSibling === nav, 'PORT-28: va justo debajo de "Open kiosk signed in"');

  nav.click();
  await flush();
  t($('#smq-modal').classList.contains('on'), 'PORT-28: el click abre el modal');

  const req = requests.filter((r) => /portal-sales-mode/.test(r.url)).pop();
  t(!!req && !/org_id=/.test(req.url), 'PORT-28: pide SIN org_id — el server resuelve el org del token');

  t($('#smq-active').hidden === false && $('#smq-none').hidden === true, 'PORT-28: con link, se muestra el QR (no el aviso)');
  t($('#smq-loading').hidden === true, 'PORT-28: el estado "Loading" desaparece al responder');
  t($('#smq-qrlink').getAttribute('href') === LINK.url, 'PORT-28: el QR es CLICKEABLE y va a su kiosco en sales-mode');
  t($('#smq-qrlink').getAttribute('target') === '_blank', 'PORT-28: abre en pestaña nueva (no pierde el portal)');
  t($('#smq-url').value === LINK.url, 'PORT-28: la URL se muestra copiable');
  t(!!document.querySelector('#smq-qr svg'), 'PORT-28: el QR se dibuja como SVG');

  const acts = Array.from(document.querySelectorAll('#smq-active button')).map((b) => b.textContent.trim());
  t(acts.some((a) => /Copy/.test(a)), 'PORT-28: botón de copiar');
  t(acts.some((a) => /Download QR/.test(a)), 'PORT-28: botón de descargar');

  window.closeMyKioskQr();
  t(!$('#smq-modal').classList.contains('on'), 'PORT-28: el modal se cierra');
}

/* ── dealer SIN link generado: el MISMO modal explica qué falta ── */
{
  const { document } = await loadPortal({
    session: SESSION, me: DEALER,
    api: { 'portal-sales-mode': () => ({ code: null }) }
  });
  const $ = (s) => document.querySelector(s);
  $('#salesQrNav').click();
  await flush();
  t($('#smq-modal').classList.contains('on'), 'PORT-28 (sin link): se abre el MISMO modal, no una pantalla en blanco');
  t($('#smq-none').hidden === false, 'PORT-28 (sin link): muestra el aviso de que falta configurarlo');
  t($('#smq-active').hidden === true, 'PORT-28 (sin link): no hay QR ni URL vacía');
  t(/Contact us/.test($('#smq-none').textContent), 'PORT-28 (sin link): le dice qué hacer (pedirlo a RAP)');
  t(!document.querySelector('#smq-none button'), 'PORT-28: el dealer NO puede generarlo él (eso es de RAP)');
}

/* ── admin: TAMBIÉN ve el link del nav; el QR es el del dealer que tenga en "Viewing" ── */
{
  const RESELLERS = [{ org_id: 'bls', org_name: "Bailey's" }, { org_id: 'acme', org_name: 'Acme Furniture' }];
  const { window, document, requests } = await loadPortal({
    session: SESSION, me: ADMIN, resellers: RESELLERS,
    api: { 'portal-sales-mode': () => LINK }
  });
  const $ = (s) => document.querySelector(s);
  window.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: (r, c) => (r + c) % 2 === 0 });

  const nav = $('#salesQrNav');
  t(!!nav && !nav.classList.contains('role-hidden'), 'PORT-28b: el admin SÍ ve "Sales Mode QR" en el nav');

  /* Sin dealer elegido (Viewing = All) no hay QR que mostrar: su vista es cross-dealer. */
  let before = requests.length;
  nav.click();
  await flush();
  t($('#smq-modal').classList.contains('on'), 'PORT-28b: el modal abre igual');
  t($('#smq-pick').hidden === false, 'PORT-28b: con Viewing=All pide elegir un reseller');
  t($('#smq-active').hidden === true && $('#smq-none').hidden === true, 'PORT-28b: no muestra QR ni el aviso de "sin link"');
  t(requests.filter((r) => /portal-sales-mode/.test(r.url)).length === 0, 'PORT-28b: no dispara request sin dealer elegido');
  window.closeMyKioskQr();

  /* Con dealer elegido: pide SU org_id y muestra su QR. */
  $('#dealerSelect').value = 'bls';
  window.onDealerPick();
  await flush();
  nav.click();
  await flush();
  const req = requests.filter((r) => /portal-sales-mode/.test(r.url)).pop();
  t(!!req && /org_id=bls/.test(req.url), 'PORT-28b: el admin pide el org_id del dealer en Viewing');
  t($('#smq-active').hidden === false && $('#smq-pick').hidden === true, 'PORT-28b: muestra el QR de ese dealer');
  t($('#smq-qrlink').getAttribute('href') === LINK.url, 'PORT-28b: el QR del admin también es clickeable');
  t(/Bailey/.test($('#smq-of').textContent), 'PORT-28b: el modal dice de QUÉ dealer es el QR (evita confundirse)');

  t(!!$('#sm-qr'), 'KIOSK-22 intacto: el bloque de Dealer Admin (Generate/Rotate/Disable) sigue ahí');
  void before;
}

/* ── DRY: un solo juego de helpers de QR sirve a las dos vistas ── */
{
  const js = src('portal/assets/js/portal.js');
  t(/function renderSalesQr\(url, boxSel\)/.test(js), 'PORT-28: renderSalesQr parametrizado (Dealer Admin + modal)');
  t(/function copySalesUrl\(url, inputSel\)/.test(js), 'PORT-28: copySalesUrl parametrizado');
  t(/function downloadSalesQr\(url\)/.test(js), 'PORT-28: downloadSalesQr parametrizado');
  t((js.match(/function qrSvgString/g) || []).length === 1, 'PORT-28: el generador de QR NO se duplicó');
  const fn = src('netlify/functions/portal-sales-mode.mjs');
  t(/if \(req\.method === 'GET'\) gate = readOrgScope/.test(fn), 'PORT-28: el GET se acota por scope (dealer = su org)');
  t(/else assertAdmin\(scope\)/.test(fn), 'PORT-28: generar/rotar/apagar sigue siendo admin-only');
}

t.done();
