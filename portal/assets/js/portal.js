'use strict';
/* ============================================================================
 * FurnitureRx Subscription Portal — front (fase 1: auth real + identidad + shell).
 *
 * ⚠ La frontera REAL es server-side (RLS + /api/*). Este gating (data-roles) es
 * SOLO conveniencia de UI. Render de datos con textContent (PII → cero innerHTML).
 * Login reusa /api/auth-login (mismo patrón que account.html); identidad = /api/me.
 * ==========================================================================*/

var SESSION_KEY = 'frx_portal_session';
var me = null, world = 'retailer';

function $(s) { return document.querySelector(s); }
function $all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
function setText(sel, txt) { var el = $(sel); if (el) { el.classList.remove('skel'); el.textContent = txt; } }

/* ---- PORT-20: loading fantasma. skel() marca un valor como "cargando"; setText lo
   des-marca al pintar la data real. skelRows/skelCards pintan placeholders shimmer
   que el loader reemplaza con replaceChildren. busy() bloquea un botón con spinner. ---- */
function skel(sel) { var el = $(sel); if (el) { el.textContent = '      '; el.classList.add('skel'); } }
function skelRows(sel, cols, n) {
  var tb = $(sel); if (!tb) return;
  tb.replaceChildren();
  for (var i = 0; i < (n || 4); i++) {
    var tr = document.createElement('tr'); tr.className = 'skel-row';
    for (var c = 0; c < cols; c++) { var td = document.createElement('td'); td.appendChild(document.createElement('div')); tr.appendChild(td); }
    tb.appendChild(tr);
  }
}
function skelCards(sel, n) {
  var box = $(sel); if (!box) return;
  box.replaceChildren();
  for (var i = 0; i < (n || 3); i++) {
    var d = document.createElement('div'); d.className = 'minicard skel-card skel';
    box.appendChild(d);
  }
}
function busy(btn, on) { if (btn) { btn.classList.toggle('busy', !!on); btn.disabled = !!on; } }

/* ---- session ---- */
function getSession() {
  try {
    var s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.access_token && (!s.expires_at || s.expires_at > Math.floor(Date.now() / 1000) + 30)) return s;
  } catch (e) { /* ignore */ }
  return null;
}
function setSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } }
function authHeaders() { var s = getSession(); return s ? { Authorization: 'Bearer ' + s.access_token } : {}; }

function api(path, opts) {
  opts = opts || {};
  var headers = Object.assign({}, opts.headers || {}, authHeaders());
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }, function () { return { ok: r.ok, status: r.status, d: {} }; });
  });
}

/* ---- views (landing / login / app) ---- */
function showLanding() { $('#app').style.display = 'none'; $('#view-landing').classList.add('on'); $('#view-login').classList.remove('on'); window.scrollTo(0, 0); }
function showLogin() { $('#app').style.display = 'none'; $('#view-landing').classList.remove('on'); $('#view-login').classList.add('on'); window.scrollTo(0, 0); }
function showApp() { $('#view-landing').classList.remove('on'); $('#view-login').classList.remove('on'); $('#app').style.display = 'block'; }

/* ---- auth ---- */
function loginErr(msg) { var e = $('#login-err'); if (!e) return; e.textContent = msg; e.hidden = false; }
function doLogin(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  var email = ($('#login-email') || {}).value || '';
  var pw = ($('#login-pw') || {}).value || '';
  var errBox = $('#login-err'); if (errBox) errBox.hidden = true;
  busy($('#login-btn'), true);   // PORT-20: el botón dice "procesando" en vez de quedarse pegado
  api('/api/auth-login', { method: 'POST', body: JSON.stringify({ email: email, password: pw }) }).then(function (r) {
    busy($('#login-btn'), false);
    if (r.ok && r.d && r.d.access_token) {
      setSession({ access_token: r.d.access_token, expires_at: r.d.expires_at || 0 });
      loadMe();
    } else if (r.status === 429) {
      loginErr('Too many attempts. Please wait a moment and try again.');
    } else {
      loginErr('Wrong email or password.');
    }
  }).catch(function () { busy($('#login-btn'), false); loginErr('Network error. Please try again.'); });
  return false;
}
function logout() { clearSession(); me = null; showLanding(); }

function loadMe() {
  api('/api/portal-me').then(function (r) {
    if (r.ok && r.d && r.d.role) { me = r.d; renderShell(); showApp(); loadDashboard(); }
    else if (r.status === 403) { clearSession(); showLogin(); loginErr('This account has no portal access.'); }
    else { clearSession(); showLogin(); loginErr('Session expired. Please sign in again.'); }
  });
}

/* ---- shell ---- */
function applyRoles(tier) {
  $all('[data-roles]').forEach(function (el) {
    var ok = el.getAttribute('data-roles').split(' ').indexOf(tier) >= 0;
    el.classList.toggle('role-hidden', !ok);
  });
}
function initials(s) { s = String(s || '').trim(); if (!s) return '—'; var p = s.split(/\s+/); return (((p[0] || '')[0]) || '') + (((p[1] || '')[0]) || ''); }

/* ---- PORT-19A: LEX del mock — relabeling por world (labels VERBATIM del mockup de Doug).
   Solo labels; los sample values del mock (orderVal, loc1…) eran data de muestra y no entran. ---- */
var LEX = {
  retailer: { navAdmin: 'Dealer Admin', colAssoc: 'RSA', colStore: 'Store', fAssoc: 'All associates', fStore: 'All stores', order: 'Sales order #', svcDate: 'Delivery date', dealerStore: 'Dealer / Store', assoc: 'Sales associate', byLoc: 'By location', aH1: 'Dealer Admin', aName: 'Dealer name', aId: 'Dealer RAP ID' },
  technician: { navAdmin: 'Company Admin', colAssoc: 'Technician', colStore: 'Company', fAssoc: 'All technicians', fStore: 'All companies', order: 'Workorder #', svcDate: 'Service date', dealerStore: 'Company', assoc: 'Technician', byLoc: 'By technician', aH1: 'Company Admin', aName: 'Company name', aId: 'Company RAP ID' }
};
function applyLex() {
  var map = LEX[world] || LEX.retailer;
  $all('[data-lex]').forEach(function (el) { var v = map[el.getAttribute('data-lex')]; if (v != null) el.textContent = v; });
  /* el mock oculta bloques data-world ajenos (p.ej. "By sales associate" en technician) */
  $all('main [data-world]').forEach(function (el) { el.classList.toggle('role-hidden', el.getAttribute('data-world') !== world); });
  var kn = $('#kioskNav');
  if (kn) {
    var app = world === 'technician' ? 'technician app' : 'kiosk';
    kn.title = 'Opens the ' + app + ' signed in as the reseller: every sale from there credits them automatically, no code needed.';
    kn.replaceChildren(document.createTextNode('⇗ Open ' + app + ' signed in '));
    var ext = document.createElement('span'); ext.className = 'ext'; ext.textContent = '↗'; kn.appendChild(ext);
  }
}
/* setScopes del mock: el scope refleja world + dealer elegido y se refresca al cambiarlos. */
function scopeText() {
  var retail = world !== 'technician';
  var orgLbl = retail ? 'Dealer' : 'Company', subLbl = retail ? 'Store' : 'Technician';
  var plural = retail ? 'stores + associates' : 'technicians', many = retail ? 'dealers' : 'companies';
  if (me.tier === 'admin') {
    var s = $('#dealerSelect');
    var all = !s || !s.value || s.value === 'all';
    var name = (!all && s.options[s.selectedIndex]) ? s.options[s.selectedIndex].text : '';
    return 'Admin · ' + (retail ? 'Retail' : 'Technician') + ' world · ' + (all ? 'all ' + many : 'scoped to ' + name) + '. Full record fields + management.';
  }
  if (me.tier === 'org') return orgLbl + ' view · ' + (me.org_name || 'Your organization') + ' — all ' + plural + '. View + export.';
  return subLbl + ' view · ' + (me.sub_entity_name || me.org_name || 'Your location') + ' only. Reduced: no exports, no API, no referral.';
}
function setScopes() {
  if (!me) return;
  var t = scopeText();
  $all('.scopebar').forEach(function (el) { el.textContent = t; });
}
function renderShell() {
  if (!me) return;
  setText('#userName', me.name || me.email);
  applyRoles(me.tier);
  var kn = $('#kioskNav'); if (kn && me.app_url) kn.href = me.app_url;
  if (me.tier === 'admin') {
    $('#hdr-admin').style.display = 'flex'; $('#hdr-user').style.display = 'none';
    world = me.world || 'retailer';
    var ws = $('#worldSelect'); if (ws) ws.value = world;
    setText('#adminAv', initials(me.name || me.email));
    loadResellers();
  } else {
    $('#hdr-admin').style.display = 'none'; $('#hdr-user').style.display = 'flex';
    world = me.world || 'retailer';   // PORT-19A: el world del token gobierna el LEX de org/sub
    setText('#orgName', me.org_name || '—');
    /* PORT-19D (mock): "Dealer ID #SHF-2048" / "Company ID #PFR-3120" con el rap_id real */
    var idLbl = (world === 'technician' ? 'Company ID #' : 'Dealer ID #');
    setText('#orgId', (me.tier === 'sub' && me.sub_entity_name) ? me.sub_entity_name
      : (me.rap_id ? (idLbl + me.rap_id) : ('Org ' + (me.org_id || ''))));
    setText('#orgAv', initials(me.org_name || me.email));
  }
  setText('#dash-name', me.name || me.email);
  setText('#dash-role', me.role);
  setText('#dash-world', me.world || 'cross-world');
  setText('#dash-org', me.org_name || (me.tier === 'admin' ? 'All resellers' : '—'));
  applyLex();    // PORT-19A: labels del mock según world
  setScopes();   // PORT-19A: scopebars de TODAS las pantallas
}
function loadResellers() {
  api('/api/portal-resellers?world=' + encodeURIComponent(world)).then(function (r) {
    var sel = $('#dealerSelect'); if (!sel) return;
    sel.replaceChildren();
    var optAll = document.createElement('option'); optAll.value = 'all'; optAll.textContent = 'All'; sel.appendChild(optAll);
    var rows = (r.d && r.d.rows) || [];
    /* DEAL-1: "BLS · Baileys Furniture Outlet" cuando hay alpha; solo el nombre si aún no. */
    rows.forEach(function (o) {
      var op = document.createElement('option'); op.value = o.org_id;
      op.textContent = o.alpha_code ? (o.alpha_code + ' · ' + o.org_name) : o.org_name;
      sel.appendChild(op);
    });
    setViewingPill();   // PORT-20: el reset del selector apaga el pill
  });
}
function onWorldPick() {
  world = $('#worldSelect').value;
  var kn = $('#kioskNav'); if (kn) kn.href = world === 'technician' ? 'https://tech.furniturerx.net/' : 'https://kiosk.furniturerx.net/';
  loadResellers();
  applyLex(); setScopes();   // PORT-19A: el world reetiqueta la UI y el scope
  setViewingPill();          // PORT-20: cambiar de world resetea el selector → pill fuera
}
function onDealerPick() {
  setScopes();       // PORT-19A (mock): el scopebar refleja el dealer elegido
  setViewingPill();  // PORT-20: el header muestra el dealer mientras esté seleccionado
  reloadView();      // PORT-20: la vista activa se recarga con el nuevo scope
  var s = $('#dealerSelect'); toast('Now viewing: ' + s.options[s.selectedIndex].text);
}

/* ---- nav (solo las views DENTRO de #app; landing/login se manejan aparte) ---- */
function show(id) {
  $all('#app .view').forEach(function (v) { v.classList.remove('on'); });
  var el = $('#view-' + id); if (el) el.classList.add('on');
  $all('nav.side a[data-screen]').forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-screen') === id); });
  window.scrollTo(0, 0);
  loadFor(id);
  closeNav();   // PORT-27: navegar cierra el drawer móvil (no-op en escritorio)
}
/* ---- PORT-27: nav off-canvas en móvil. Aislado y reversible (ver bloque CSS PORT-27). ---- */
function setNavOpen(open) {
  var nav = $('#sideNav'), tog = $('#navToggle'), scrim = $('#navScrim');
  if (!nav || !tog || !scrim) return;
  var wasOpen = nav.classList.contains('open');
  nav.classList.toggle('open', open);
  scrim.classList.toggle('on', open);
  tog.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) { var f = nav.querySelector('a'); if (f) f.focus(); }
  else if (wasOpen && nav.contains(document.activeElement)) tog.focus();   // devuelve el foco al botón solo si el usuario estaba dentro del drawer
}
function toggleNav() { var nav = $('#sideNav'); setNavOpen(!(nav && nav.classList.contains('open'))); }
function closeNav() { setNavOpen(false); }
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNav(); });
/* PORT-20: dispatch de loaders separado de show() para poder RECARGAR la vista
   activa al cambiar "Viewing" sin resetear el scroll. */
function loadFor(id) {
  if (id === 'subscribers') loadSubscribers();
  else if (id === 'custrecord') loadCustomer(currentContract);
  else if (id === 'audit') loadAudit();
  else if (id === 'tracksr') loadTrack();
  else if (id === 'referrals') loadReferrals();
  else if (id === 'pricing') loadPlans();
  else if (id === 'stripe') { loadCommissions(); loadReconciliation(); }
  else if (id === 'dashboard') loadDashboard();
  else if (id === 'salesstats') loadSalesStats();
  else if (id === 'dealeradmin') loadDealerAdmin();
  else if (id === 'resources') loadResources();
  else if (id === 'kitorders') loadKitOrders();
}
function reloadView() {
  var v = $('#app .view.on');
  if (v) loadFor(v.id.replace('view-', ''));
}
/* PORT-20/20b: indicador persistente del dealer elegido — franja gold full-width bajo el
   topbar (patrón Stripe test-mode / Salesforce Login-As, consulta UX 16-jul) + pill compacto
   como fallback en pantallas angostas. aria-live anuncia el cambio a lectores de pantalla. */
function setViewingPill() {
  var s = $('#dealerSelect');
  var on = s && s.value && s.value !== 'all';
  var name = on ? s.options[s.selectedIndex].text : '';
  var pill = $('#viewingPill'); if (!pill) return;
  /* retoggle para re-disparar la animación de entrada al CAMBIAR de dealer */
  pill.classList.remove('on');
  pill.replaceChildren();
  if (!on) return;
  var eye = document.createElement('span'); eye.setAttribute('aria-hidden', 'true'); eye.textContent = '👁';
  pill.appendChild(eye);
  pill.appendChild(document.createTextNode('Viewing: '));
  var b = document.createElement('b'); b.textContent = name; pill.appendChild(b);
  var x = document.createElement('button'); x.className = 'exit'; x.type = 'button';
  x.title = 'View all resellers'; x.setAttribute('aria-label', 'View all resellers');
  x.textContent = '×'; x.addEventListener('click', viewAllResellers);
  pill.appendChild(x);
  void pill.offsetWidth; pill.classList.add('on');
}
/* Salida rápida del scope (el "Log out as…" de Salesforce): vuelve a All y recarga. */
function viewAllResellers() {
  var s = $('#dealerSelect'); if (s) s.value = 'all';
  onDealerPick();
}

/* ---- PORT-18: Dealer/Company Admin (mock 481-509) — master data real del org ---- */
var daOrgId = null;
function daPickOrg() {
  var s = $('#dealerSelect');
  return (s && s.value && s.value !== 'all') ? s.value : null;
}
function loadDealerAdmin() {
  daOrgId = daPickOrg();
  if (!daOrgId) { setText('#da-h3', '—'); setText('#da-sub', 'Pick a reseller in "Viewing" to load its record.'); return; }
  skel('#da-h3'); skel('#da-sub');
  skelRows('#da-contacts', 4, 3); skelRows('#da-stores', 3, 2);
  api('/api/portal-dealeradmin?org_id=' + encodeURIComponent(daOrgId)).then(function (r) {
    if (!r.ok || !r.d || !r.d.dealer) { toast('Could not load the reseller record.'); return; }
    var d = r.d.dealer;
    setText('#da-h3', d.name || '—');
    /* mock: "Dealer RAP ID #SHF-2048 · FurnitureRx Account ID FRX-SHF-2048" — sin inventar ids */
    var idLbl = (d.world === 'technician') ? 'Company RAP ID #' : 'Dealer RAP ID #';
    setText('#da-sub', idLbl + (d.rap_id || '—') + ' · FurnitureRx Account ID ' + (d.frx_account_id || '—'));
    var set = function (sel, v) { var el = $(sel); if (el) el.value = v == null ? '' : String(v); };
    set('#da-name', d.name); set('#da-rapid', d.rap_id); set('#da-alpha', d.alpha_code); set('#da-hq', d.hq_address);
    set('#da-start', d.access_start); set('#da-end', d.access_end);
    var sw = function (sel, on) { var el = $(sel); if (el) el.classList.toggle('on', !!on); };
    sw('#da-sell', d.selling_enabled); sw('#da-dash', d.dashboard_enabled);
    sw('#da-rollup', d.include_in_rollups !== false);   // PORT-21 (default true)
    var tb = $('#da-contacts');
    if (tb) {
      tb.replaceChildren();
      (d.key_contacts || []).forEach(function (c) {
        var tr = document.createElement('tr');
        [c.role, c.name, c.email, c.phone].forEach(function (v) {
          var td = document.createElement('td'); td.textContent = v || '—'; tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      var first = (d.key_contacts || [])[0];
      var le = $('#da-login-email'); if (le && first && first.email && !le.value) le.value = first.email;
    }
    var st = $('#da-stores');
    if (st) {
      st.replaceChildren();
      (r.d.sub_entities || []).forEach(function (s) {
        var tr = document.createElement('tr');
        [s.name, s.location, s.status].forEach(function (v) {
          var td = document.createElement('td'); td.textContent = v || '—'; tr.appendChild(td);
        });
        st.appendChild(tr);
      });
    }
    loadSalesMode(daOrgId);   // KIOSK-22
    loadStripeOnboarding(daOrgId);   // Ago-11 (ChangesBLS.srt): estado de Stripe del dealer
    loadPlanTerms(daOrgId);   // PORT-25
  });
}

/* ---- PORT-25: T&C SKU por dealer (plan_terms). El input muestra SOLO el override del dealer
   (vacío = sobre la genérica); el status dice cuál rige. Guardar = upsert; "Use generic" = clear. ---- */
function loadPlanTerms(orgId) {
  if (!orgId) return;
  api('/api/portal-plan-terms?org_id=' + encodeURIComponent(orgId)).then(function (r) {
    if (!r.ok || !r.d || !Array.isArray(r.d.skus)) return;
    r.d.skus.forEach(function (s) {
      var ver = $('#pt-' + s.plan_sku + '-version'), url = $('#pt-' + s.plan_sku + '-url');
      var st = $('#pt-' + s.plan_sku + '-status'), clr = $('#pt-' + s.plan_sku + '-clear');
      var gen = s.generic ? s.generic.terms_version : null;
      if (ver) { ver.value = s.override ? s.override.terms_version : ''; ver.placeholder = gen ? ('on generic ' + gen) : 'on generic'; }
      if (url) url.value = (s.override && s.override.doc_url) ? s.override.doc_url : '';
      if (st) st.textContent = s.override ? ('Overriding generic ' + (gen || '—')) : (gen ? ('Using generic ' + gen) : 'No generic set');
      if (clr) clr.hidden = !s.override;
    });
  });
}
function savePlanTerms(sku) {
  if (!daOrgId) { toast('Pick a reseller in "Viewing" first.'); return; }
  var ver = (($('#pt-' + sku + '-version') || {}).value || '').trim();
  if (!ver) { toast('Enter a T&C SKU, or leave it on generic.'); return; }
  var url = (($('#pt-' + sku + '-url') || {}).value || '').trim();
  api('/api/portal-plan-terms', { method: 'POST', body: JSON.stringify({ org_id: daOrgId, plan_sku: sku, terms_version: ver, doc_url: url }) }).then(function (r) {
    if (r.ok && r.d && r.d.saved) { toast('Terms saved'); loadPlanTerms(daOrgId); }
    else toast(r.status === 403 ? 'Admins only.' : 'Save failed.');
  });
}
function clearPlanTerms(sku) {
  if (!daOrgId) { toast('Pick a reseller in "Viewing" first.'); return; }
  api('/api/portal-plan-terms', { method: 'POST', body: JSON.stringify({ org_id: daOrgId, plan_sku: sku, action: 'clear' }) }).then(function (r) {
    if (r.ok && r.d && r.d.cleared) { toast('Back to generic terms'); loadPlanTerms(daOrgId); }
    else toast('Change failed.');
  });
}

/* ---- KIOSK-22: sales-mode link + QR. El code es durable (bookmark + QR); el resolver /s/{code}
   acuña un handoff one-time por visita. Render del QR por DOMParser (sin innerHTML, gate del portal). ---- */
var smUrl = '', qrLoadPromise = null;
function loadSalesMode(orgId) {
  if (!orgId) return;
  api('/api/portal-sales-mode?org_id=' + encodeURIComponent(orgId)).then(function (r) {
    var active = !!(r.ok && r.d && r.d.code);
    smUrl = active ? (r.d.url || '') : '';
    var none = $('#sm-none'), act = $('#sm-active'), gen = $('#sm-gen'), dis = $('#sm-disable'), urlIn = $('#sm-url'), box = $('#sm-qr');
    if (none) none.hidden = active;
    if (act) act.hidden = !active;
    if (dis) dis.hidden = !active;
    if (gen) gen.textContent = active ? 'Regenerate link' : 'Generate link';
    if (urlIn) urlIn.value = smUrl;
    if (box) box.replaceChildren();
    if (active) renderSalesQr();
  });
}
function generateSalesMode() {
  var org = daOrgId; if (!org) { toast('Pick a reseller first.'); return; }
  busy($('#sm-gen'), true);
  api('/api/portal-sales-mode', { method: 'POST', body: JSON.stringify({ org_id: org }) }).then(function (r) {
    busy($('#sm-gen'), false);
    if (r.ok && r.d && r.d.code) { toast('Sales-mode link ready'); loadSalesMode(org); }
    else toast(r.status === 403 ? 'Admins only.' : 'Could not generate the link.');
  });
}
function disableSalesMode() {
  var org = daOrgId; if (!org) return;
  confirmAction({
    title: 'Disable sales-mode link', confirmLabel: 'Disable', danger: true,
    message: 'The current link and its QR will stop working. You can generate a new one later.',
    onConfirm: function () {
      api('/api/portal-sales-mode', { method: 'POST', body: JSON.stringify({ org_id: org, action: 'disable' }) }).then(function (r) {
        if (r.ok && r.d && r.d.disabled) { resultModal('Disabled', 'The sales-mode link is now off.'); loadSalesMode(org); }
        else resultModal('Could not disable', 'Please try again.', true);
      });
    }
  });
}
/* qrcode.min.js (mismo lib del kiosk, same-origin → OK con la CSP script-src 'self'). Lazy. */
function loadQrLib() {
  if (window.qrcode) return Promise.resolve();
  if (qrLoadPromise) return qrLoadPromise;
  qrLoadPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script'); s.src = 'qrcode.min.js'; s.async = true;
    s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('qr_lib_failed')); };
    document.head.appendChild(s);
  });
  return qrLoadPromise;
}
function qrSvgString(text, px) {
  var qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
  var n = qr.getModuleCount(), quiet = 4, total = n + quiet * 2;
  var cell = Math.max(2, Math.floor((px || 300) / total)), size = cell * total, rects = '';
  for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
    if (qr.isDark(r, c)) rects += '<rect x="' + ((c + quiet) * cell) + '" y="' + ((r + quiet) * cell) + '" width="' + cell + '" height="' + cell + '"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="Sales-mode QR code"><rect width="' + size + '" height="' + size + '" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
}
function svgToNode(svgStr) {   /* parsea el SVG a DOM (sin innerHTML) */
  var doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}
/* Los tres wrappers aceptan (url, selector) para servir a las DOS vistas con el mismo código
   (PORT-28): sin argumentos operan sobre Dealer Admin, como siempre; con ellos, sobre el modal
   del dealer. Los helpers de verdad (loadQrLib/qrSvgString/svgToNode) no se tocan. */
function renderSalesQr(url, boxSel) {
  var u = url || smUrl; if (!u) return;
  var box = $(boxSel || '#sm-qr'); if (!box) return;
  loadQrLib().then(function () { box.replaceChildren(svgToNode(qrSvgString(u, 200))); }).catch(function () { /* lib falló → sin QR; la URL sigue copiable */ });
}
function copySalesUrl(url, inputSel) {
  var u = url || smUrl; if (!u) return;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(function () { toast('Link copied'); }, function () { toast('Copy failed'); });
  else { var i = $(inputSel || '#sm-url'); if (i) { i.select(); try { document.execCommand('copy'); toast('Link copied'); } catch (e) { /* noop */ } } }
}
function downloadSalesQr(url) {
  var u = url || smUrl; if (!u) return;
  loadQrLib().then(function () {
    var blob = new Blob([qrSvgString(u, 600)], { type: 'image/svg+xml' });
    var dl = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = dl; a.download = 'sales-mode-qr.svg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(dl); }, 1000);
  }).catch(function () { toast('QR unavailable.'); });
}

/* ---- PORT-28: el dealer ve/descarga SU propio QR desde el nav. El server resuelve el org del
   token (sin org_id en la query), así que esta vista no puede pedir el de otro. Un solo modal
   para los dos estados: con link (QR clickeable + copiar + descargar) y sin link (qué hacer). ---- */
var myKioskUrl = '';
function openMyKioskQr() {
  var m = $('#smq-modal'); if (!m) return;
  var load = $('#smq-loading'), none = $('#smq-none'), act = $('#smq-active'), pick = $('#smq-pick'), of = $('#smq-of');
  if (load) load.hidden = true;
  if (none) none.hidden = true;
  if (act) act.hidden = true;
  if (pick) pick.hidden = true;
  if (of) { of.hidden = true; of.textContent = ''; }
  m.classList.add('on');

  /* PORT-28b: el admin ve el QR del dealer que tenga en "Viewing" (orgParam pone su org_id); el
     dealer no manda nada y el server resuelve el org de su token. Con Viewing = All no hay un QR
     "suyo" que mostrar: se pide elegir dealer en vez de disparar un request que daría 400. */
  var qs = orgParam('?');
  if (me && me.tier === 'admin') {
    if (!qs) { if (pick) pick.hidden = false; return; }
    var sel = $('#dealerSelect');
    var nm = (sel && sel.options[sel.selectedIndex]) ? sel.options[sel.selectedIndex].text : '';
    if (of && nm) { of.textContent = 'Sales-mode QR for ' + nm; of.hidden = false; }
  }

  if (load) load.hidden = false;
  api('/api/portal-sales-mode' + qs).then(function (r) {
    if (load) load.hidden = true;
    var url = (r.ok && r.d && r.d.code) ? (r.d.url || '') : '';
    myKioskUrl = url;
    if (!url) { if (none) none.hidden = false; return; }
    if (act) act.hidden = false;
    var link = $('#smq-qrlink'); if (link) link.href = url;
    var inp = $('#smq-url'); if (inp) inp.value = url;
    renderSalesQr(url, '#smq-qr');
  });
}
function closeMyKioskQr() { var m = $('#smq-modal'); if (m) m.classList.remove('on'); }
/* ---- Ago-11 (ChangesBLS.srt 00:37–02:05): Stripe Connect onboarding por dealer (admin).
   Backend portal-stripe-onboard: genera el link, guarda el acct_id y muestra el estado. ---- */
var soUrl = '';
function renderStripeStatus(d) {
  var st = $('#so-status'), gen = $('#so-gen');
  var acct = d && d.account_id;
  if (st) st.textContent = acct
    ? ('Connected · ' + d.account_id + ' · charges ' + (d.charges_enabled ? 'on' : 'off') + ' · payouts ' + (d.payouts_enabled ? 'on' : 'off'))
    : 'Not connected. Generate an onboarding link and send it to the dealer.';
  if (gen) gen.textContent = acct ? 'Regenerate onboarding link' : 'Generate onboarding link';
}
function loadStripeOnboarding(orgId) {
  if (!orgId) return;
  var lw = $('#so-link'); if (lw) lw.hidden = true; soUrl = '';
  api('/api/portal-stripe-onboard?org_id=' + encodeURIComponent(orgId)).then(function (r) {
    renderStripeStatus(r.ok ? r.d : null);
  });
}
function generateStripeOnboarding() {
  var org = daOrgId; if (!org) { toast('Pick a reseller first.'); return; }
  busy($('#so-gen'), true);
  api('/api/portal-stripe-onboard', { method: 'POST', body: JSON.stringify({ org_id: org }) }).then(function (r) {
    busy($('#so-gen'), false);
    if (r.ok && r.d && r.d.onboarding_url) {
      soUrl = r.d.onboarding_url;
      var lw = $('#so-link'), urlIn = $('#so-url');
      if (urlIn) urlIn.value = soUrl;
      if (lw) lw.hidden = false;
      renderStripeStatus(r.d);
      toast('Onboarding link ready');
    } else toast(r.status === 403 ? 'Admins only.' : 'Could not create the link.');
  });
}
function refreshStripeStatus() { loadStripeOnboarding(daOrgId); }
function copyStripeUrl() {
  if (!soUrl) return;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(soUrl).then(function () { toast('Link copied'); }, function () { toast('Copy failed'); });
  else { var i = $('#so-url'); if (i) { i.select(); try { document.execCommand('copy'); toast('Link copied'); } catch (e) { /* noop */ } } }
}
/* ---- Ago-11 v1 (ChangesBLS.srt 02:10–04:11 + consultoría UX): Resources — upload admin con
   drag-and-drop + selección de dealers (segmented + chips + buscador + contador) + lista por dealer.
   Backend portal-resources SIN cambios: uploadResource sigue leyendo #res-file.files y
   .res-dealer-cb:checked, y manda el mismo payload. Render sin innerHTML (gate del portal). ---- */
var RES_TYPES = [['sell_sheet', 'Sell sheet (PDF)'], ['selling_pos', 'Selling POS for retailers'], ['product_overview', 'Product overview (video)'], ['customer_info', 'Customer information']];
var RES_MIME = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPG' };
var RES_CAP_MB = { 'application/pdf': 20, 'image/png': 10, 'image/jpeg': 10 };   // PDF 20MB, imágenes 10MB
var resWired = false, resFileOk = false;
/* -- tabs Available/Add (Parte B): ver los recursos primero; subir en el otro tab -- */
function showResTab(tab) {
  var isAdd = tab === 'add';
  var pa = $('#res-panel-available'), pd = $('#res-panel-add');
  if (pa) pa.hidden = isAdd;
  if (pd) pd.hidden = !isAdd;
  var ta = $('#restab-available'), td = $('#restab-add');
  if (ta) { ta.classList.toggle('on', !isAdd); ta.setAttribute('aria-selected', String(!isAdd)); }
  if (td) { td.classList.toggle('on', isAdd); td.setAttribute('aria-selected', String(isAdd)); }
}
/* confirmación inline tras subir: se queda en el tab Add y confirma; también está en Available. */
function showResAdded(resource) {
  var box = $('#res-added'); if (!box) return;
  box.replaceChildren();
  box.appendChild(document.createTextNode('✓ Uploaded: ' + ((resource && resource.title) || 'resource') + ' — now in the Available tab.'));
  var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn ghost sm'; btn.style.marginLeft = '10px';
  btn.textContent = 'View in Available'; btn.addEventListener('click', function () { showResTab('available'); });
  box.appendChild(btn);
  box.hidden = false;
}
function resViewingOrg() {
  if (me && me.tier === 'admin') { var s = $('#dealerSelect'); return (s && s.value && s.value !== 'all') ? s.value : null; }
  return null;   // dealer: el server usa su propio org (readOrgScope)
}
function loadResources() {
  wireResUpload();
  populateResDealers();
  onResTypeChange();
  toggleResTargets();
  var org = resViewingOrg();
  api('/api/portal-resources' + (org ? ('?org_id=' + encodeURIComponent(org)) : '')).then(function (r) {
    renderResources((r.ok && r.d && r.d.resources) ? r.d.resources : []);
  });
}

/* -- dropzone: la zona envuelve el <input type=file>; drag/drop y clic escriben el MISMO input -- */
function wireResUpload() {
  if (resWired) return; resWired = true;
  var drop = $('#res-drop'), fileEl = $('#res-file');
  if (fileEl) fileEl.addEventListener('change', function () { handleResFile(fileEl.files && fileEl.files[0]); });
  if (drop) {   /* el <input> overlay maneja clic Y drop NATIVAMENTE; el JS solo pinta .dragover */
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.add('dragover'); }); });
    ['dragleave', 'dragend', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('dragover'); }); });
  }
}
function handleResFile(file) {
  var drop = $('#res-drop'), prev = $('#res-drop-file'), err = $('#res-drop-err');
  if (!file) { clearResFile(); return; }
  if (!RES_MIME[file.type]) { showResFileError('PNG, JPG or PDF only.'); return; }
  var capMb = RES_CAP_MB[file.type] || 10;
  if (file.size > capMb * 1048576) { showResFileError('This ' + (file.type === 'application/pdf' ? 'PDF' : 'image') + ' is ' + (file.size / 1048576).toFixed(1) + ' MB — max is ' + capMb + ' MB. Upload a smaller file, or contact support to raise the limit.'); return; }
  if (err) err.hidden = true;
  if (drop) { drop.classList.remove('error'); drop.hidden = true; }   /* zona ↔ preview: hermanos, uno visible */
  if (prev) {
    prev.hidden = false; prev.replaceChildren();
    var pill = document.createElement('span'); pill.className = 'pill active'; pill.textContent = RES_MIME[file.type]; prev.appendChild(pill);
    var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = file.name; prev.appendChild(nm);
    var sz = document.createElement('span'); sz.className = 'size'; sz.textContent = (file.size / 1048576).toFixed(1) + ' MB'; prev.appendChild(sz);
    var x = document.createElement('button'); x.type = 'button'; x.className = 'btn ghost sm'; x.textContent = '✕'; x.setAttribute('aria-label', 'Remove file');
    x.addEventListener('click', function (e) { e.preventDefault(); clearResFile(); }); prev.appendChild(x);
  }
  resFileOk = true; refreshResUploadBtn();
}
function showResFileError(msg) {
  var drop = $('#res-drop'), prev = $('#res-drop-file'), err = $('#res-drop-err'), fileEl = $('#res-file');
  if (fileEl) fileEl.value = '';
  if (drop) { drop.hidden = false; drop.classList.add('error'); }
  if (prev) { prev.hidden = true; prev.replaceChildren(); }
  if (err) { err.hidden = false; err.replaceChildren(); var i = document.createElement('span'); i.textContent = '⚠'; var s = document.createElement('span'); s.textContent = msg; err.appendChild(i); err.appendChild(s); }
  resFileOk = false; refreshResUploadBtn();
}
function clearResFile() {
  var drop = $('#res-drop'), prev = $('#res-drop-file'), err = $('#res-drop-err'), fileEl = $('#res-file');
  if (fileEl) fileEl.value = '';
  if (drop) { drop.hidden = false; drop.classList.remove('error'); }
  if (prev) { prev.hidden = true; prev.replaceChildren(); }
  if (err) err.hidden = true;
  resFileOk = false; refreshResUploadBtn();
}
function onResTypeChange() {
  var isVideo = ($('#res-type') && $('#res-type').value) === 'product_overview';
  var fw = $('#res-file-wrap'), lw = $('#res-link-wrap');
  if (fw) fw.hidden = isVideo;
  if (lw) lw.hidden = !isVideo;
  if (isVideo) clearResFile(); else if ($('#res-link')) $('#res-link').value = '';
  refreshResUploadBtn();
}
function renderResources(list) {
  var wrap = $('#res-list'); if (!wrap) return;
  var isAdmin = !!(me && me.tier === 'admin');
  wrap.replaceChildren();
  RES_TYPES.forEach(function (pair) {
    var items = list.filter(function (r) { return r.resource_type === pair[0]; });
    var card = document.createElement('div'); card.className = 'card rescard';
    var h = document.createElement('div'); h.className = 'rc-t'; h.textContent = pair[1]; card.appendChild(h);
    if (!items.length) {
      var soon = document.createElement('span'); soon.className = 'rc-soon'; soon.textContent = 'None yet'; card.appendChild(soon);
    } else {
      items.forEach(function (r) {
        var row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px';
        var a = document.createElement('a'); a.className = 'lk'; a.href = r.url || '#'; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = (r.is_link ? 'Open: ' : 'Download: ') + r.title;
        row.appendChild(a);
        if (isAdmin) { var del = document.createElement('button'); del.className = 'btn ghost sm'; del.textContent = '✕'; del.title = 'Delete'; del.addEventListener('click', function () { deleteResource(r.id, r.title); }); row.appendChild(del); }
        card.appendChild(row);
      });
    }
    wrap.appendChild(card);
  });
}
/* -- dealers como CHIPS (label + checkbox oculto): mantiene semántica nativa (teclado/foco) y
   el mismo .res-dealer-cb que lee uploadResource -- */
function populateResDealers() {
  var box = $('#res-dealers'), sel = $('#dealerSelect'); if (!box || !sel) return;
  box.replaceChildren();
  Array.prototype.forEach.call(sel.options, function (o) {
    if (!o.value || o.value === 'all') return;
    var lab = document.createElement('label'); lab.className = 'chip dealer-chip'; lab.setAttribute('data-name', (o.textContent || '').toLowerCase());
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'sr-only res-dealer-cb'; cb.value = o.value;
    cb.addEventListener('change', function () { lab.classList.toggle('on', cb.checked); updateResCount(); refreshResUploadBtn(); });
    lab.appendChild(cb); lab.appendChild(document.createTextNode(o.textContent));
    box.appendChild(lab);
  });
  updateResCount();
}
function resDealerCbs() { return Array.prototype.slice.call(document.querySelectorAll('.res-dealer-cb')); }
function updateResCount() {
  var cbs = resDealerCbs(), sel = cbs.filter(function (c) { return c.checked; }).length;
  var el = $('#res-count'); if (el) el.textContent = sel + ' of ' + cbs.length + ' selected';
}
function resSelectAll() {
  resDealerCbs().forEach(function (c) { var chip = c.closest('.dealer-chip'); if (chip && chip.hidden) return; c.checked = true; if (chip) chip.classList.add('on'); });
  updateResCount(); refreshResUploadBtn();
}
function resClearDealers() {
  resDealerCbs().forEach(function (c) { c.checked = false; var chip = c.closest('.dealer-chip'); if (chip) chip.classList.remove('on'); });
  updateResCount(); refreshResUploadBtn();
}
function resSearch() {
  var q = (($('#res-search') && $('#res-search').value) || '').trim().toLowerCase();
  Array.prototype.forEach.call(document.querySelectorAll('.dealer-chip'), function (chip) {
    chip.hidden = !!q && (chip.getAttribute('data-name') || '').indexOf(q) < 0;
  });
}
function toggleResTargets() {
  var some = document.querySelector('input[name="res-target"]:checked');
  var isSome = !!(some && some.value === 'some');
  var box = $('#res-some'); if (box) box.hidden = !isSome;
  var note = $('#res-all-note'); if (note) note.hidden = isSome;
  var segAll = $('#res-seg-all'), segSome = $('#res-seg-some');
  if (segAll) segAll.classList.toggle('on', !isSome);
  if (segSome) segSome.classList.toggle('on', isSome);
  refreshResUploadBtn();
}
/* Habilita Upload solo cuando el form es válido: título + contenido (archivo/link) + audiencia. */
function refreshResUploadBtn() {
  var btn = $('#res-upload-btn'); if (!btn) return;
  var title = ($('#res-title') && $('#res-title').value.trim()) || '';
  var isVideo = ($('#res-type') && $('#res-type').value) === 'product_overview';
  var hasContent = isVideo ? !!($('#res-link') && $('#res-link').value.trim()) : resFileOk;
  var some = document.querySelector('input[name="res-target"]:checked');
  var audienceOk = !(some && some.value === 'some') || resDealerCbs().some(function (c) { return c.checked; });
  btn.disabled = !(title && hasContent && audienceOk);
}
/* Subida en 3 pasos (Parte A): (1) sign_upload firma un URL → (2) el navegador hace PUT del archivo
   DIRECTO a Storage (sin pasar por la función → sin tope de 6MB) → (3) create con el storage_path.
   La rama link (video) sigue en un solo paso. */
function uploadResource() {
  var btn = $('#res-upload-btn');
  var title = ($('#res-title') && $('#res-title').value.trim()) || '';
  var type = ($('#res-type') && $('#res-type').value) || 'sell_sheet';
  var desc = ($('#res-desc') && $('#res-desc').value.trim()) || '';
  var some = document.querySelector('input[name="res-target"]:checked');
  var allDealers = !some || some.value === 'all';
  var dealerIds = allDealers ? [] : resDealerCbs().filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
  var fileEl = $('#res-file'), file = fileEl && fileEl.files && fileEl.files[0];
  var link = ($('#res-link') && $('#res-link').value.trim()) || '';
  if (!title || (!file && !link) || (!allDealers && !dealerIds.length)) { refreshResUploadBtn(); return; }   // cinturón de seguridad

  if ($('#res-added')) $('#res-added').hidden = true;
  busy(btn, true);
  var base = { action: 'create', title: title, description: desc, resource_type: type, all_dealers: allDealers, dealer_ids: dealerIds };
  var create = function (payload) {
    api('/api/portal-resources', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      busy(btn, false);
      if (r.ok && r.d && r.d.resource) { showResAdded(r.d.resource); resetResForm(); loadResources(); }
      else if (r.status === 400 && r.d && r.d.error === 'file_too_large') showResFileError('That file is over the limit (PDF 20MB / images 10MB). Upload a smaller file, or contact support to raise the limit.');
      else toast(r.status === 403 ? 'Admins only.' : 'Upload failed.');
    });
  };
  if (!file) { create(Object.assign(base, { link_url: link })); return; }

  api('/api/portal-resources', { method: 'POST', body: JSON.stringify({ action: 'sign_upload', mime: file.type }) }).then(function (s) {
    if (!s.ok || !s.d || !s.d.upload_url) { busy(btn, false); toast('Upload failed.'); return; }
    fetch(s.d.upload_url, { method: 'PUT', headers: { 'Content-Type': file.type, 'x-upsert': 'false' }, body: file }).then(function (up) {
      if (!up.ok) { busy(btn, false); showResFileError('Upload failed (' + up.status + '). If the file is too large, upload a smaller one or contact support to raise the limit.'); return; }
      create(Object.assign(base, { storage_path: s.d.storage_path }));
    }).catch(function () { busy(btn, false); toast('Upload failed. Check your connection and try again.'); });
  });
}
/* Reset COMPLETO tras subir: además de título/desc/link/archivo, vuelve a "Everyone" y limpia los
   dealers (si no, el próximo upload heredaría una audiencia específica por accidente). */
function resetResForm() {
  if ($('#res-title')) $('#res-title').value = '';
  if ($('#res-desc')) $('#res-desc').value = '';
  if ($('#res-link')) $('#res-link').value = '';
  clearResFile();
  var all = document.querySelector('input[name="res-target"][value="all"]'); if (all) all.checked = true;
  resClearDealers();
  if ($('#res-search')) $('#res-search').value = '';
  resSearch();
  toggleResTargets();
  refreshResUploadBtn();
}
function deleteResource(id, title) {
  confirmAction({
    title: 'Delete resource', confirmLabel: 'Delete', danger: true,
    message: 'Remove "' + (title || 'this resource') + '"? Dealers will no longer see it.',
    onConfirm: function () {
      api('/api/portal-resources', { method: 'POST', body: JSON.stringify({ action: 'delete', resource_id: id }) }).then(function (r) {
        if (r.ok && r.d && r.d.deleted) { toast('Deleted'); loadResources(); }
        else toast('Could not delete.');
      });
    }
  });
}
function saveDealerAdmin() {
  if (!daOrgId) { toast('Pick a reseller in "Viewing" first.'); return; }
  var val = function (sel) { var el = $(sel); return el ? el.value.trim() : ''; };
  /* DEAL-1: el server rechaza un alpha mal formado con 400; avisamos antes de mandarlo
     para que el error sea legible y no un "Save failed" genérico. Vacío = sin código aún. */
  var alpha = val('#da-alpha').toUpperCase();
  if (alpha && !/^[A-Z]{3}$/.test(alpha)) { toast('Alpha code must be exactly 3 letters (e.g. BLS).'); return; }
  var body = {
    org_id: daOrgId,
    name: val('#da-name'),
    alpha_code: alpha,
    hq_address: val('#da-hq'),
    access_start: val('#da-start') || null,
    access_end: val('#da-end') || null
  };
  api('/api/portal-dealeradmin', { method: 'PATCH', body: JSON.stringify(body) }).then(function (r) {
    if (r.ok && r.d && r.d.updated) { toast('Record saved'); loadDealerAdmin(); }
    else toast('Save failed.');
  });
}
function toggleDealerFlag(field, btn) {
  if (!daOrgId) { toast('Pick a reseller in "Viewing" first.'); return; }
  var next = !btn.classList.contains('on');
  var body = { org_id: daOrgId };
  body[field] = next;
  api('/api/portal-dealeradmin', { method: 'PATCH', body: JSON.stringify(body) }).then(function (r) {
    if (r.ok && r.d && r.d.updated) { btn.classList.toggle('on', next); toast(next ? 'Enabled' : 'Disabled'); }
    else toast('Change failed.');
  });
}
function dealerLoginAction(action) {
  if (!daOrgId) { toast('Pick a reseller in "Viewing" first.'); return; }
  var email = (($('#da-login-email') || {}).value || '').trim();
  if (!email) { toast('Type the login email first.'); return; }
  api('/api/portal-dealer-login-action', { method: 'POST', body: JSON.stringify({ org_id: daOrgId, email: email, action: action }) }).then(function (r) {
    if (r.ok && r.d && r.d.sent) toast(action === 'reset' ? 'Password reset email sent' : 'Invite resent');
    else toast('Could not send the email.');
  });
}

/* ---- PORT-16: Sales Stats (mock de Doug: totales + estimates + minicards) ---- */
/* PORT-24A (Doug 17-jul): "add a fifth card, but it's blank. So you always have five cards" */
function padCards(box, n) {
  while (box.children.length < n) {
    var d = document.createElement('div'); d.className = 'minicard blank'; d.setAttribute('aria-hidden', 'true');
    box.appendChild(d);
  }
}
function miniCard(title, pairs) {
  var card = document.createElement('div'); card.className = 'minicard';
  var tt = document.createElement('div'); tt.className = 't'; tt.textContent = title; card.appendChild(tt);
  var kv = document.createElement('div'); kv.className = 'kv2';
  pairs.forEach(function (p) {
    var s = document.createElement('span'); s.textContent = p[0]; kv.appendChild(s);
    var b = document.createElement('b'); b.textContent = String(p[1]); kv.appendChild(b);
  });
  card.appendChild(kv);
  return card;
}
function loadSalesStats() {
  if (!me) return;
  var sc = $('#ss-scope'); if (sc) sc.textContent = scopeText();
  var period = ($('#ss-period') || {}).value || 'year';
  /* PORT-19D: custom range del mock — muestra los date inputs y manda from/to */
  var rb = $('#ss-range'); if (rb) rb.classList.toggle('show', period === 'range');
  var extra = '';
  if (period === 'range') {
    var f = (($('#ss-from') || {}).value) || '', tt = (($('#ss-to') || {}).value) || '';
    if (!f && !tt) return;                                   // sin fechas aún: espera al usuario
    if (f) extra += '&from=' + encodeURIComponent(f);
    if (tt) extra += '&to=' + encodeURIComponent(tt);
  }
  ['#ss-active', '#ss-unique', '#ss-cancels', '#ss-rate', '#ss-deposits', '#ss-next-month', '#ss-next-year'].forEach(skel);
  skelCards('#ss-locations', 5); skelCards('#ss-associates', 5);   // PORT-24A: siempre 5 por fila
  api('/api/portal-stats?period=' + encodeURIComponent(period) + extra + orgParam('&')).then(function (r) {
    var d = (r.ok && r.d) || {};
    setText('#ss-active', d.active != null ? String(d.active) : '—');
    setText('#ss-unique', d.unique != null ? String(d.unique) : '—');
    setText('#ss-cancels', String(d.cancels_in_period || 0));
    setText('#ss-rate', (d.cancel_rate != null ? d.cancel_rate : 0) + '% rate');
    setText('#ss-deposits', usd(d.commission_cash_cents || 0));
    /* PORT-24A: "(mo)" verbatim del mock, pero solo cuando el periodo ES el mes (si no, mentiría) */
    setText('#ss-deposits-l', period === 'month' ? 'Stripe deposits (mo)' : 'Stripe deposits');
    setText('#ss-next-month', usd(d.next_month_cents || 0));
    setText('#ss-next-year', usd(d.next_year_cents || 0));
    var locs = $('#ss-locations');
    if (locs) {
      locs.replaceChildren();
      (d.by_location || []).forEach(function (l) {
        /* PORT-19D (mock): fila Deposits por location, del ledger real. PORT-24A: "New (mo)" verbatim */
        locs.appendChild(miniCard(l.name, [['Active', l.active], ['New (mo)', l.news], ['Cancels', l.cancels], ['Deposits', usd(l.deposits_cents || 0)]]));
      });
      padCards(locs, 5);
    }
    var assocs = $('#ss-associates');
    if (assocs) {
      assocs.replaceChildren();
      (d.by_associate || []).forEach(function (a) {
        assocs.appendChild(miniCard(a.assoc, [['Sold (mo)', a.news], ['Active', a.active], ['Cancels', a.cancels]]));   // mock: Sold (mo) primero
      });
      padCards(assocs, 5);
    }
  });
}

/* ---- PORT-16: Dashboard con data REAL (mock de Doug: headline numbers del mes,
   recent activity con scroll). Nada inventado: todo sale de /api/portal-stats. ---- */
function loadDashboard() {
  if (!me) return;
  ['#st-active', '#st-active-d', '#st-value', '#st-cancel', '#st-cancel-d', '#st-comm'].forEach(skel);
  skelRows('#dash-recent', 4, 4);
  api('/api/portal-stats?period=month' + orgParam('&')).then(function (r) {
    var d = (r.ok && r.d) || {};
    setText('#st-active', d.active != null ? String(d.active) : '—');
    setText('#st-active-d', '▲ ' + (d.new_in_period || 0) + ' new this month');
    setText('#st-value', usd(d.monthly_value_cents || 0));
    setText('#st-cancel', (d.cancel_rate != null ? d.cancel_rate : 0) + '%');
    /* PORT-19D (mock): delta del rate en pts ("▲ 0.3 pts"), calculado vs antes del periodo */
    var dp = d.cancel_rate_delta_pts != null ? d.cancel_rate_delta_pts : 0;
    setText('#st-cancel-d', (dp >= 0 ? '▲ ' : '▼ ') + Math.abs(dp) + ' pts');
    setText('#st-comm', usd(d.commission_cash_cents || 0));
    var body = $('#dash-recent'); if (!body) return;
    body.replaceChildren();
    (d.recent || []).forEach(function (s) {
      var tr = document.createElement('tr');
      [s.date_short || s.date || '—', s.contract || '—', s.associate || '—'].forEach(function (v) {   // mock: "Jul 12"
        var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      });
      var td = document.createElement('td'); var pill = document.createElement('span');
      pill.className = 'pill ' + (s.cancelled ? 'cancel' : 'active');
      pill.textContent = s.cancelled ? 'Cancelled' : 'Active';
      td.appendChild(pill); tr.appendChild(td);
      body.appendChild(tr);
    });
  });
}

/* ---- PORT-6: export + audit ---- */
function downloadCSV(name, csv) {
  try {
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  } catch (e) { /* jsdom sin Blob → no-op */ }
}
function exportSubs() {
  /* PORT-24B (Doug 17-jul: "it should export the filtered list"): mandamos los contract_number
     del set filtrado; el server filtra los mapeados a ese set y AUDITA el conteo filtrado. */
  var contracts = subsFiltered().map(function (s) { return s.contract_number; }).filter(Boolean);
  if (!contracts.length) { toast('No rows to export with the current filters.'); return; }
  api('/api/portal-exports' + orgParam('?'), { method: 'POST', body: JSON.stringify({ contracts: contracts }) }).then(function (r) {
    if (r.status === 403) { toast('Export is not allowed for your role.'); return; }
    if (r.ok && r.d && r.d.ok) { downloadCSV(r.d.filename || 'subscribers.csv', r.d.csv || ''); toast('Exported ' + (r.d.rows || 0) + ' rows'); }
    else toast('Export failed.');
  });
}
function loadAudit() {
  skelRows('#audit-body', 6, 6);
  api('/api/portal-audit').then(function (r) {
    var body = $('#audit-body'); if (!body) return; body.replaceChildren();
    var rows = (r.d && r.d.rows) || [];
    rows.forEach(function (a) {
      var tr = document.createElement('tr');
      [String(a.at || '').replace('T', ' ').slice(0, 16), a.actor_name || '—', a.actor_role || '—', a.action || '—', a.target || '—', a.details || '—'].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    setText('#audit-count', String(rows.length));
  });
}

/* ---- PORT-7 + PORT-24C: service requests (crear con categoría, o cerrar el cargado con "Resolved") ---- */
function srMsg(text) { var m = $('#sr-msg'); if (m) { m.textContent = text; m.hidden = false; } }
function submitSR() {
  var cat = selectedSRCat();
  /* "Resolved (close)" sobre un SR cargado → lo cierra (PATCH). */
  if (cat === '__resolved__') {
    if (!currentSRId) { srMsg('Pick a service request from the list to resolve, or choose a category to open a new one.'); return; }
    api('/api/portal-service-requests', { method: 'PATCH', body: JSON.stringify({ id: currentSRId }) }).then(function (r) {
      if (r.ok && r.d && r.d.ok) { srMsg('Service request closed.'); if (currentContract) loadCustomer(currentContract); }
      else srMsg('Could not close the request.');
    });
    return;
  }
  /* si no, crea uno nuevo (la categoría es opcional; el número lo genera el server). */
  var payload = {
    contract_number: ($('#sr-contract') || {}).value || '', contact: ($('#sr-contact') || {}).value || '',
    first_name: ($('#sr-first') || {}).value || '', last_name: ($('#sr-last') || {}).value || '',
    body: ($('#sr-body') || {}).value || '', category: cat || undefined
  };
  api('/api/portal-service-requests', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
    if (r.ok && r.d && r.d.ok) { srMsg('Request submitted' + (r.d.sr_number ? ' (' + r.d.sr_number + ')' : '') + ', routed to RAP\'s service center.'); if (currentContract) loadCustomer(currentContract); }
    /* SEC-3b: el server ya no acepta contratos fuera del scope. Mismo copy que usan las quick
       actions para este caso, para no dejar un fallo legítimo bajo un mensaje engañoso. */
    else if (r.status === 404) srMsg('That record is not in your scope.');
    else srMsg('Add a contract # and a request before submitting.');
  });
}
/* limpia el form para una solicitud NUEVA; conserva el prefill del cliente (contract/nombre/contacto). */
function clearSR() {
  currentSRId = null;
  var tb = $('#sr-body'); if (tb) tb.value = '';
  $all('#sr-cats input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
  var box = $('#sr-loaded'); if (box) box.hidden = true;
  var m = $('#sr-msg'); if (m) m.hidden = true;
}
/* ---- PORT-24C: quick actions nuevas ---- */
function resendTerms() {
  if (!currentContract) { toast('Open a customer record first.'); return; }
  confirmAction({
    title: 'Resend T&C', confirmLabel: 'Send terms',
    message: 'Email this customer the terms & conditions of their plan?',
    onConfirm: function () {
      api('/api/portal-resend-link', { method: 'POST', body: JSON.stringify({ contract: currentContract, kind: 'terms' }) }).then(function (r) {
        if (r.ok && r.d && r.d.sent) resultModal('Terms sent', 'The customer got an email with their terms & conditions.');
        else if (r.status === 404) resultModal('Not in your scope', 'That record is not in your scope.', true);
        else resultModal('Could not send', 'The terms were not sent. Please try again.', true);
      });
    }
  });
}
function cancelSubscription() {
  if (!currentContract) { toast('Open a customer record first.'); return; }
  /* Doug: el botón es visible para todos pero SOLO funciona para RAP admin. */
  if (!(me && me.tier === 'admin')) { resultModal('Admins only', 'Only RAP admins can cancel a subscription.', true); return; }
  confirmAction({
    title: 'Cancel subscription', confirmLabel: 'Cancel subscription', danger: true,
    message: 'This schedules the subscription to end at the close of the current billing period (no more charges). Continue?',
    onConfirm: function () {
      api('/api/portal-cancel-subscription', { method: 'POST', body: JSON.stringify({ contract: currentContract }) }).then(function (r) {
        if (r.ok && r.d && r.d.scheduled) resultModal('Cancellation scheduled', 'The subscription will end at the close of the current billing period.');
        else if (r.status === 403) resultModal('Admins only', 'Only RAP admins can cancel a subscription.', true);
        else resultModal('Could not cancel', 'The cancellation was not scheduled. Please try again.', true);
      });
    }
  });
}
function loadTrack() {
  api('/api/portal-service-requests' + orgParam('?')).then(function (r) {
    var box = $('#track-list'); if (!box) return; box.replaceChildren();
    var rows = (r.d && r.d.rows) || [];
    if (!rows.length) { var c = document.createElement('div'); c.className = 'card panel'; var p = document.createElement('p'); p.className = 'sub'; p.style.margin = '0'; p.textContent = 'No requests yet.'; c.appendChild(p); box.appendChild(c); return; }
    rows.forEach(function (rq) {
      var card = document.createElement('div'); card.className = 'card panel'; card.style.marginBottom = '12px';
      var h = document.createElement('b'); h.style.cssText = 'font-family:var(--serif);font-size:15px;color:var(--navy)'; h.textContent = 'Contract ' + (rq.contract_number || '—'); card.appendChild(h);
      var sub = document.createElement('p'); sub.className = 'sub'; sub.style.margin = '6px 0 0'; sub.textContent = String(rq.body || '').slice(0, 140); card.appendChild(sub);
      box.appendChild(card);
    });
  });
}

/* ---- PORT-12a: Pricing & Plans (display-only — "just show it for now", Doug 15-jul) ---- */
function usd(cents) { return '$' + ((cents | 0) / 100).toFixed(2); }
function loadPlans() {
  skelRows('#plans-body', 4, 2);
  api('/api/portal-plans').then(function (r) {
    var body = $('#plans-body'); if (!body) return; body.replaceChildren();
    ((r.d && r.d.plans) || []).forEach(function (p) {
      var tr = document.createElement('tr');
      [p.sku, p.label, usd(p.monthly_cents) + '/mo', p.covers || '—'].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  });
}

/* ---- PORT-9: referral codes (ver = admin+org; crear = admin: "we generate for the dealer") ---- */
function loadReferrals() {
  var sc = $('#ref-scope'); if (sc && me) sc.textContent = scopeText();
  skelRows('#ref-body', 9, 3);
  api('/api/portal-referral-codes' + orgParam('?')).then(function (r) {
    var body = $('#ref-body'); if (!body) return; body.replaceChildren();
    var rows = (r.d && r.d.rows) || [];
    rows.forEach(function (c) {
      var tr = document.createElement('tr');
      /* PORT-19C: columnas del mock (Campaign/Uses/Attributed/Credit) con data REAL */
      [c.code, c.label || '—', String(c.uses || 0), String(c.attributed || 0), usd(c.credit_cents || 0),
       c.org_name || '—', c.active ? 'Active' : 'Off', String(c.created_at || '').slice(0, 10)].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      });
      /* Link permanente por dealer: la URL del front con ?ref=CODIGO pre-llena el código en el
         cart (misma vía B, verificada server-side). El dealer lo imprime/manda UNA vez. */
      var tdL = document.createElement('td');
      [['kiosk', 'https://kiosk.furniturerx.net/?ref='], ['online', 'https://furniturerx.net/?ref=']].forEach(function (p) {
        var a = document.createElement('a'); a.className = 'lk';
        a.style.cssText = 'cursor:pointer;margin-right:12px;white-space:nowrap';
        a.textContent = 'Copy ' + p[0] + ' link';
        a.addEventListener('click', function () {
          var url = p[1] + encodeURIComponent(c.code);
          var w = (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(url) : Promise.reject();
          w.then(function () { toast('Copied: ' + url); }, function () { toast(url); });
        });
        tdL.appendChild(a);
      });
      tr.appendChild(tdL);
      body.appendChild(tr);
    });
    setText('#ref-count', String(rows.length));
  });
}
function createReferral() {
  var orgId = me && me.org_id;
  if (me && me.tier === 'admin') { var s = $('#dealerSelect'); orgId = (s && s.value && s.value !== 'all') ? s.value : null; }
  if (!orgId) { toast('Pick a reseller in "Viewing" first.'); return; }
  var label = (($('#ref-label') || {}).value || '').trim() || undefined;   // Campaign del mock (opcional)
  api('/api/portal-referral-codes', { method: 'POST', body: JSON.stringify({ org_id: orgId, label: label }) }).then(function (r) {
    if (r.ok && r.d && r.d.code) { toast('Code created: ' + r.d.code); var li = $('#ref-label'); if (li) li.value = ''; loadReferrals(); }
    else toast(r.status === 403 ? 'Only RAP admins generate codes.' : 'Could not create the code.');
  });
}

/* ---- PORT-8/24D: totales de comisión → 3 stat cards (§5.9: SOLO comisión, jamás revenue) ---- */
function loadCommissions() {
  var sc = $('#comm-scope'); if (sc && me) sc.textContent = scopeText();
  ['#comm-total', '#comm-cash', '#comm-rein'].forEach(skel);
  api('/api/portal-commissions' + orgParam('?')).then(function (r) {
    var t = (r.d && r.d.totals) || { cash_cents: 0, reinsurance_cents: 0 };
    setText('#comm-total', usd((t.cash_cents | 0) + (t.reinsurance_cents | 0)));   // Total cash = cash + reinsurance
    setText('#comm-cash', usd(t.cash_cents));                                       // To commission (a tu Stripe)
    setText('#comm-rein', usd(t.reinsurance_cents));                                // To reinsurance
  });
}

/* ---- PORT-24D: reconciliación = clon de Subscribers + último pago Stripe (Doug 17-jul).
   Estado PROPIO (reconAll) — no toca subsAll ni el sort/pager de Subscribers. ---- */
var reconAll = [];
function reconFiltered() {
  var q = (($('#rec-search') || {}).value || '').trim().toLowerCase();
  var fd = (($('#rec-date') || {}).value) || 'all';
  var today = new Date().toISOString().slice(0, 10);
  var from = null;
  if (fd === 'mtd' || fd === 'month') from = today.slice(0, 8) + '01';
  else if (fd === 'ytd' || fd === 'year') from = today.slice(0, 5) + '01-01';
  return reconAll.filter(function (s) {
    if (q) {
      var hay = (((s.first_name || '') + ' ' + (s.last_name || '')) + ' ' + (s.contract_number || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (from && s.payment_date && s.payment_date < from) return false;   // filtra por fecha de PAGO
    return true;
  });
}
function renderRecon() {
  var body = $('#recon-body'); if (!body) return;
  var rows = reconFiltered();
  body.replaceChildren();
  rows.forEach(function (s) {
    var tr = document.createElement('tr');
    /* Start, Name, Contract # */
    [s.start_date || '—', ((s.first_name || '') + ' ' + (s.last_name || '')).trim() || '—', s.contract_number || '—'].forEach(function (v) {
      var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    /* Status (pill, como en Subscribers) */
    var tdSt = document.createElement('td'); var pill = document.createElement('span');
    pill.className = 'pill ' + (s.status === 'cancelled' ? 'cancel' : 'active'); pill.textContent = s.status === 'cancelled' ? 'Cancelled' : 'Active';
    tdSt.appendChild(pill); tr.appendChild(tdSt);
    /* Stripe payment # + Payment date (— si aún no pagó; cero data fake) */
    [s.stripe_payment_no || '—', s.payment_date || '—'].forEach(function (v) {
      var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    /* View → Customer Record (idéntico a Subscribers) */
    var tdV = document.createElement('td'); var a = document.createElement('a');
    a.className = 'lk'; a.textContent = 'View'; a.style.cursor = 'pointer';
    a.addEventListener('click', function () { openCustomer(s.contract_number); });
    tdV.appendChild(a); tr.appendChild(tdV);
    body.appendChild(tr);
  });
  setText('#recon-count', String(rows.length));
  setText('#recon-total', String(reconAll.length));
}
function loadReconciliation() {
  skelRows('#recon-body', 8, 7);
  api('/api/portal-reconciliation' + orgParam('?')).then(function (r) {
    reconAll = (r.d && r.d.rows) || [];
    renderRecon();
  });
}
function exportRecon() {
  var contracts = reconFiltered().map(function (s) { return s.contract_number; }).filter(Boolean);
  if (!contracts.length) { toast('No rows to export with the current filters.'); return; }
  api('/api/portal-exports' + orgParam('?'), { method: 'POST', body: JSON.stringify({ contracts: contracts }) }).then(function (r) {
    if (r.status === 403) { toast('Export is not allowed for your role.'); return; }
    if (r.ok && r.d && r.d.ok) { downloadCSV(r.d.filename || 'reconciliation.csv', r.d.csv || ''); toast('Exported ' + (r.d.rows || 0) + ' rows'); }
    else toast('Export failed.');
  });
}

/* ---- PORT-10: Open Kiosk vía SSO — handoff one-time → el kiosk abre YA identificado (método A).
   Fallback: si el handoff falla o el admin no eligió reseller, el href público sigue vivo. ---- */
document.addEventListener('click', function (e) {
  var kn = e.target && e.target.closest ? e.target.closest('#kioskNav') : null;
  if (!kn || !me) return;
  var body = {};
  if (me.tier === 'admin') {
    var s = $('#dealerSelect');
    if (!s || !s.value || s.value === 'all') return;          // sin org concreto → link público normal
    body.org_id = s.value;
  } else if (!me.org_id) { return; }
  e.preventDefault();
  api('/api/portal-app-handoff', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
    if (r.ok && r.d && r.d.url) window.open(r.d.url, '_blank', 'noopener');
    else window.open(kn.href, '_blank', 'noopener');
  });
});

/* ---- PORT-5: Subscribers + Customer Record (scoped) ---- */
var currentContract = null;
function orgParam(prefix) {
  if (me && me.tier === 'admin') { var s = $('#dealerSelect'); if (s && s.value && s.value !== 'all') return prefix + 'org_id=' + encodeURIComponent(s.value); }
  return '';
}
/* PORT-16d: filtros + paginación del mock, client-side sobre las filas cargadas. */
var subsAll = [], subsPage = 1;
/* PORT-24B: orden por columna (Doug 17-jul: "make these settings sortable, you click and it sorts") */
var subsSort = { key: '', dir: 1 };
function sortVal(s, k) {
  if (k === 'name') return ((s.last_name || '') + ' ' + (s.first_name || '')).toLowerCase();
  if (k === 'payments') return s.payments | 0;
  if (k === 'contract_number') {
    /* DEC-2: el sufijo -N ahora es de UN dígito (sin zero-pad), así que un compare de string daría
     * -1, -10, -2. Se pad-ea SOLO el sufijo a un ancho fijo en una clave derivada para que el
     * compare relacional existente ordene numéricamente. El master (RX-#####) NO se toca: el regex
     * exige dos grupos, así que un valor master-solo (sin -N) pasa intacto. */
    return String(s.contract_number || '')
      .replace(/^(RX-\d+)-(\d+)$/, function (_m, master, n) { return master + '-' + n.padStart(6, '0'); })
      .toLowerCase();
  }
  var v = s[k];
  return typeof v === 'string' ? v.toLowerCase() : (v == null ? '' : v);
}
function sortSubs(key) {
  if (subsSort.key === key) subsSort.dir = -subsSort.dir;   // segundo click en la misma columna → invierte
  else { subsSort.key = key; subsSort.dir = 1; }
  renderSubs(true);
}
function markSortHeaders() {
  $all('#view-subscribers thead th.sortable').forEach(function (th) {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (subsSort.key && th.getAttribute('data-sort') === subsSort.key) {
      th.classList.add(subsSort.dir > 0 ? 'sorted-asc' : 'sorted-desc');
    }
  });
}
function toggleRange() { var r = $('#rangeInputs'); if (r) r.classList.toggle('show', (($('#f-date') || {}).value) === 'range'); }
function fillFilter(sel, values) {
  var el = $(sel); if (!el) return;
  while (el.options.length > 1) el.remove(1);              // conserva el "All …"
  values.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); });
}
function subsFiltered() {
  var q = (($('#f-search') || {}).value || '').trim().toLowerCase();
  var fa = (($('#f-assoc') || {}).value) || '';
  var fs = (($('#f-store') || {}).value) || '';
  var fd = (($('#f-date') || {}).value) || 'all';
  var today = new Date().toISOString().slice(0, 10);
  var from = null, to = null;
  if (fd === 'today') from = today;
  else if (fd === 'mtd' || fd === 'month') from = today.slice(0, 8) + '01';   // PORT-19D: This month del mock
  else if (fd === 'ytd' || fd === 'year') from = today.slice(0, 5) + '01-01'; // PORT-19D: This year del mock
  else if (fd === 'range') { from = (($('#f-from') || {}).value) || null; to = (($('#f-to') || {}).value) || null; }
  var out = subsAll.filter(function (s) {
    if (q) {
      var hay = (((s.first_name || '') + ' ' + (s.last_name || '')) + ' ' + (s.contract_number || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (fa && (s.person_id || '—') !== fa) return false;
    if (fs && (s.store_name || '—') !== fs) return false;
    var d = s.start_date || '';
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  if (subsSort.key) {                                        // PORT-24B: orden por la columna elegida
    var k = subsSort.key, dir = subsSort.dir;
    out = out.slice().sort(function (a, b) {
      var va = sortVal(a, k), vb = sortVal(b, k);
      return va < vb ? -dir : va > vb ? dir : 0;
    });
  }
  return out;
}
function pageSubs(delta) { subsPage += delta; renderSubs(); }
function renderSubs(reset) {
  if (reset) subsPage = 1;
  var body = $('#subs-body'); if (!body) return;
  var rows = subsFiltered();
  var size = parseInt((($('#pg-size') || {}).value) || '50', 10) || 50;
  var pages = Math.max(1, Math.ceil(rows.length / size));
  if (subsPage > pages) subsPage = pages;
  if (subsPage < 1) subsPage = 1;
  var slice = rows.slice((subsPage - 1) * size, subsPage * size);
  body.replaceChildren();
  slice.forEach(function (s) {
    var tr = document.createElement('tr');
    /* Start */
    var td0 = document.createElement('td'); td0.textContent = s.start_date || '—'; tr.appendChild(td0);
    /* SR (PORT-24B): donde estaba End. Shell hasta Tanda C: "—" salvo que el endpoint traiga
       sr_status; entonces pill open(pending)/closed(active) clickable a la ficha. Cero data fake. */
    var tdSR = document.createElement('td');
    if (s.sr_status) {
      var srp = document.createElement('span');
      srp.className = 'pill ' + (s.sr_status === 'open' ? 'pending' : 'active');
      srp.textContent = 'SR · ' + s.sr_status;
      srp.style.cursor = 'pointer';
      srp.addEventListener('click', function () { openCustomer(s.contract_number); });
      tdSR.appendChild(srp);
    } else tdSR.textContent = '—';
    tr.appendChild(tdSR);
    /* Program, Name, Pmts, RSA, Store, Contract # */
    [s.program, ((s.first_name || '') + ' ' + (s.last_name || '')).trim() || '—', String(s.payments),
     s.person_id || '—', s.store_name || '—', s.contract_number || '—'].forEach(function (v) {
      var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    var tdSt = document.createElement('td'); var pill = document.createElement('span');
    pill.className = 'pill ' + (s.status === 'cancelled' ? 'cancel' : 'active'); pill.textContent = s.status === 'cancelled' ? 'Cancelled' : 'Active';
    tdSt.appendChild(pill); tr.appendChild(tdSt);
    var tdV = document.createElement('td'); var a = document.createElement('a');
    a.className = 'lk'; a.textContent = 'View'; a.style.cursor = 'pointer';
    a.addEventListener('click', function () { openCustomer(s.contract_number); });
    tdV.appendChild(a); tr.appendChild(tdV);
    body.appendChild(tr);
  });
  markSortHeaders();   // PORT-24B: refleja la columna/dirección activa
  /* PORT-19D (mock): "Showing 1–50 of 3,412 subscribers" */
  var first = rows.length ? (subsPage - 1) * size + 1 : 0;
  setText('#subs-count', rows.length ? (first + '–' + (first + slice.length - 1)) : '0');
  setText('#subs-total', rows.length.toLocaleString('en-US'));
}
function loadSubscribers() {
  var sc = $('#subs-scope'); if (sc && me) sc.textContent = scopeText();
  skelRows('#subs-body', 10, 8);
  api('/api/portal-subscribers' + orgParam('?')).then(function (r) {
    subsAll = (r.d && r.d.rows) || [];
    var uniq = function (key) {
      var set = {};
      subsAll.forEach(function (s) { var v = s[key]; if (v) set[v] = 1; });
      return Object.keys(set).sort();
    };
    fillFilter('#f-assoc', uniq('person_id'));
    fillFilter('#f-store', uniq('store_name'));
    renderSubs(true);
  });
}
/* ============================================================================
 * KIT-1..KIT-6 — Kit Orders (kit fulfillment manual, admin).
 * Doug: copia de la tabla de Subscribers "but it's just for kits", una fila POR TIPO DE KIT
 * ("in manual mode it's three different packages"), y tres botones: ver/imprimir la dirección,
 * teclear el shipping confirmation, y marcar Shipped. Spec: misc/spec-kit-orders.md
 * ==========================================================================*/
var kitRows = [], kitPage = 1, kitCurrent = null;

function kitFind(id) { for (var i = 0; i < kitRows.length; i++) if (kitRows[i].item_id === id) return kitRows[i]; return null; }
/* Rango de fechas a partir de un <select> con las mismas 7 opciones que Subscribers. */
function dateRange(sel, fromSel, toSel) {
  var fd = (($(sel) || {}).value) || 'all';
  var today = new Date().toISOString().slice(0, 10);
  var r = { from: null, to: null };
  if (fd === 'today') r.from = today;
  else if (fd === 'mtd' || fd === 'month') r.from = today.slice(0, 8) + '01';
  else if (fd === 'ytd' || fd === 'year') r.from = today.slice(0, 5) + '01-01';
  else if (fd === 'range') { r.from = (($(fromSel) || {}).value) || null; r.to = (($(toSel) || {}).value) || null; }
  return r;
}
function toggleKitRange() { var b = $('#kitRangeInputs'); if (b) b.classList.toggle('show', (($('#kit-fdate') || {}).value) === 'range'); }
function kitFiltered() {
  var q = (($('#kit-search') || {}).value || '').trim().toLowerCase();
  var fk = (($('#kit-kit') || {}).value) || '';
  var fs = (($('#kit-status') || {}).value) || '';
  var r = dateRange('#kit-fdate', '#kit-from', '#kit-to');
  return kitRows.filter(function (k) {
    if (q) {
      var hay = [k.customer_name, k.kit_name, k.shipping_confirmation, k.order_date, k.customer_email]
        .map(function (v) { return String(v || ''); }).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (fk && (k.kit_name || '') !== fk) return false;
    if (fs && (k.fulfillment_status || 'pending') !== fs) return false;
    var d = k.order_date || '';
    if (r.from && d < r.from) return false;
    if (r.to && d > r.to) return false;
    return true;
  });
}
function pageKits(delta) { kitPage += delta; renderKits(); }
function renderKits(reset) {
  if (reset) kitPage = 1;
  var body = $('#kit-body'); if (!body) return;
  var rows = kitFiltered();
  var size = parseInt((($('#kit-pg-size') || {}).value) || '50', 10) || 50;
  var pages = Math.max(1, Math.ceil(rows.length / size));
  if (kitPage > pages) kitPage = pages;
  if (kitPage < 1) kitPage = 1;
  var slice = rows.slice((kitPage - 1) * size, kitPage * size);
  /* S&H se muestra SOLO si existe el dato en alguna orden — se mira el conjunto completo
     (no lo filtrado), para que la columna no aparezca y desaparezca al buscar. */
  var showSH = kitRows.some(function (k) { return k.sh_cents != null; });
  var thSH = $('#kit-th-sh'); if (thSH) thSH.hidden = !showSH;
  body.replaceChildren();
  slice.forEach(function (k) {
    var tr = document.createElement('tr');
    /* Order date · Kit · Qty · Customer · Retail · S&H · Shipping confirmation.
       S&H y confirmación pintan "—" cuando no hay dato: no se inventa nada. */
    var shipped = k.fulfillment_status === 'shipped';
    /* data-label alimenta los rótulos de la vista de tarjetas en móvil (CSS ::before). */
    [['Order date', k.order_date || '—'], ['Kit', k.kit_name || '—'], ['Qty', String(k.quantity || 0)],
      ['Customer', k.customer_name || '—'], ['Retail', usd(k.retail_cents)],
      ['S&H', k.sh_cents == null ? '—' : usd(k.sh_cents), 'sh'],
      ['Tracking #', k.shipping_confirmation || '—']
    ].forEach(function (p) {
      var td = document.createElement('td'); td.setAttribute('data-label', p[0]); td.textContent = p[1];
      if (p[2] === 'sh' && !showSH) td.hidden = true;
      tr.appendChild(td);
    });
    /* Status en columna propia: el estado es un dato, no una acción. */
    var tdS = document.createElement('td'); tdS.setAttribute('data-label', 'Status');
    var pill = document.createElement('span');
    pill.className = 'pill ' + (shipped ? 'active' : 'pending');
    pill.textContent = shipped ? 'Shipped' : 'Pending';
    tdS.appendChild(pill); tr.appendChild(tdS);

    var td = document.createElement('td'); td.className = 'kit-acts';
    var mk = function (label, fn, cls) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + (cls || 'ghost') + ' sm';
      b.textContent = label; b.addEventListener('click', fn); td.appendChild(b); return b;
    };
    /* KIT-12 ("the buttons should be lined up neatly"): cada control lleva una clase de SLOT y el
       CSS le fija el ancho en desktop, para que "Enter" vs "Edit" no descuadre la columna. */
    mk('Address', function () { openKitAddress(k.item_id); }, 'ghost kit-b-addr');
    /* "Enter" cuando no hay número, "Edit" cuando ya lo hay: el popup lo trae prellenado.
       KIT-10: guardar el tracking marca Shipped solo; ya no existe el botón "Shipped". */
    mk((k.shipping_confirmation ? 'Edit' : 'Enter') + ' tracking #', function () { openKitShipping(k.item_id); }, 'ghost kit-b-trk');
    if (shipped) {
      /* La fila enviada conserva un tercer SLOT informativo (la fecha), para que la columna no
         baile entre filas enviadas y pendientes. */
      var done = document.createElement('span'); done.className = 'kit-done kit-b-sent';
      done.textContent = k.shipped_at ? 'Sent ' + String(k.shipped_at).slice(0, 10) : 'Sent';
      td.appendChild(done);
    }
    tr.appendChild(td);

    /* View en su propia columna, la última y sin cabecera (igual que en Subscribers). */
    var tdV = document.createElement('td'); tdV.className = 'kit-view';
    var view = document.createElement('button'); view.type = 'button'; view.className = 'btn link';
    view.textContent = 'View';
    view.addEventListener('click', function () { viewKitOrder(k.item_id); });
    tdV.appendChild(view); tr.appendChild(tdV);
    body.appendChild(tr);
  });
  var first = rows.length ? (kitPage - 1) * size + 1 : 0;
  setText('#kit-count', rows.length ? (first + '–' + (first + slice.length - 1)) : '0');
  setText('#kit-total', rows.length.toLocaleString('en-US'));
}
function loadKitOrders() {
  var sc = $('#kit-scope');
  if (sc) sc.textContent = 'Shipped from the RAP office · manual fulfillment';
  skelRows('#kit-body', 10, 8);
  api('/api/portal-kit-orders').then(function (r) {
    kitRows = (r.d && r.d.rows) || [];
    var kinds = {};
    kitRows.forEach(function (k) { if (k.kit_name) kinds[k.kit_name] = 1; });
    fillFilter('#kit-kit', Object.keys(kinds).sort());
    renderKits(true);
  });
}

/* KIT-3 — ship-to en popup ("to save space") + Print. La impresión es manual en la oficina. */
function kitShipLines(k) {
  var s = (k && k.ship_to) || {};
  return [s.name || k.customer_name, s.address, s.zip, s.phone].filter(Boolean);
}
var KIT_SRC = { order: 'From this order.', profile: 'From the customer profile — confirm before shipping.', lead: 'From the original checkout — confirm before shipping.' };
function openKitAddress(id) {
  var k = kitFind(id); if (!k) return;
  kitCurrent = id;
  var box = $('#kit-addr-body'); if (!box) return;
  box.replaceChildren();
  var lines = kitShipLines(k);
  if (!lines.length) { var e = document.createElement('div'); e.textContent = 'No shipping address on file — use Edit to add it.'; box.appendChild(e); }
  lines.forEach(function (v) { var d = document.createElement('div'); d.textContent = v; box.appendChild(d); });
  /* De dónde salió la dirección: la oficina debe saber si es el dato congelado de la compra
     o una aproximación traída del perfil/checkout que conviene confirmar. */
  var src = $('#kit-addr-src'), s = (k.ship_to || {}).source;
  if (src) { src.textContent = KIT_SRC[s] || ''; src.hidden = !s; }
  cancelKitAddress();
  var m = $('#kit-addr-modal'); if (m) m.classList.add('on');
}
function closeKitAddress() { var m = $('#kit-addr-modal'); if (m) m.classList.remove('on'); }
function printKitAddress() { window.print(); }
/* Edición de la dirección: para corregirla o teclearla cuando no existe en ningún lado. */
function kitAddrMode(editing) {
  var ids = ['#kit-addr-read', '#kit-addr-editbtn', '#kit-addr-print'];
  ids.forEach(function (s) { var el = $(s); if (el) el.hidden = editing; });
  ['#kit-addr-edit', '#kit-addr-cancel', '#kit-addr-save'].forEach(function (s) { var el = $(s); if (el) el.hidden = !editing; });
}
function editKitAddress() {
  var k = kitFind(kitCurrent); if (!k) return;
  var s = k.ship_to || {};
  var set = function (sel, v) { var el = $(sel); if (el) el.value = v || ''; };
  set('#kit-addr-name', s.name || k.customer_name); set('#kit-addr-street', s.address);
  set('#kit-addr-zip', s.zip); set('#kit-addr-phone', s.phone);
  var err = $('#kit-addr-err'); if (err) err.hidden = true;
  kitAddrMode(true);
}
function cancelKitAddress() { kitAddrMode(false); }
function saveKitAddress() {
  var val = function (sel) { return (($(sel) || {}).value || '').trim(); };
  var address = val('#kit-addr-street'), zip = val('#kit-addr-zip');
  var err = $('#kit-addr-err');
  if (!address || (zip && !/^\d{5}(-\d{4})?$/.test(zip))) { if (err) err.hidden = false; return; }
  if (err) err.hidden = true;
  kitPost({
    action: 'ship_to', item_id: kitCurrent, ship_to_name: val('#kit-addr-name'),
    ship_to_address: address, ship_to_zip: zip, ship_to_phone: val('#kit-addr-phone')
  }, 'Shipping address saved.', function () { kitAddrMode(false); closeKitAddress(); });
}

/* KIT-10 (Doug 13-ago: "if there's a tracking number, we presume it's shipped… pending is no
   tracking number"). El tracking es el ÚNICO hecho: guardarlo marca Shipped solo; borrarlo
   devuelve la fila a Pending (reemplaza al viejo botón Shipped y al undo). */
function openKitShipping(id) {
  var k = kitFind(id); if (!k) return;
  kitCurrent = id;
  var ttl = $('#kit-ship-title');
  if (ttl) ttl.textContent = (k.shipping_confirmation ? 'Edit' : 'Enter') + ' tracking number';
  var ref = $('#kit-ref'), date = $('#kit-date');
  if (ref) ref.value = k.shipping_confirmation || '';
  if (date) date.value = (k.shipped_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  var m = $('#kit-ship-modal'); if (m) m.classList.add('on');
}
function closeKitShipping() { var m = $('#kit-ship-modal'); if (m) m.classList.remove('on'); }
function saveKitShipping() {
  var k = kitFind(kitCurrent) || {};
  var ref = (($('#kit-ref') || {}).value || '').trim();
  var payload = { action: 'ship_info', item_id: kitCurrent, shipping_confirmation: ref };
  var d = (($('#kit-date') || {}).value || '').trim();
  if (ref && d) payload.shipped_at = d;
  /* El toast cuenta la TRANSICIÓN que el guardado produce, porque el estado cambia solo. */
  var wasShipped = k.fulfillment_status === 'shipped';
  var msg = ref
    ? (wasShipped ? 'Tracking updated.' : 'Marked shipped · ' + (k.customer_name || '') + ', ' + (k.kit_name || ''))
    : 'Back to Pending.';
  kitPost(payload, msg, function () { closeKitShipping(); });
}

/* KIT-11 — export de lo FILTRADO (PORT-24B: "it should export the filtered list"). El server
   arma el CSV con las mismas columnas de la tabla; aquí solo se mandan los item_ids visibles. */
function exportKits() {
  var ids = kitFiltered().map(function (k) { return k.item_id; });
  if (!ids.length) { toast('No rows to export with the current filters.'); return; }
  api('/api/portal-kit-orders', { method: 'POST', body: JSON.stringify({ action: 'export', item_ids: ids }) }).then(function (r) {
    if (r.ok && r.d && r.d.ok) { downloadCSV(r.d.filename || 'kit-orders.csv', r.d.csv || ''); toast('Exported ' + (r.d.rows || 0) + ' rows'); }
    else toast('Export failed.');
  });
}

/* POST + refresco. Un solo camino para las dos acciones (DRY). */
function kitPost(payload, okMsg, after, undo) {
  return api('/api/portal-kit-orders', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
    if (r && r.ok) { if (after) after(); toast(okMsg, undo); loadKitOrders(); }
    else toast('Could not save. Try again.');
  });
}

/* View — mismo comportamiento que en Subscribers: abre la ficha COMPLETA del cliente.
   Si el comprador solo llevó un kit (no es suscriptor) no hay ficha, y entonces se muestra
   el detalle de la orden, que es lo que Doug describió ("you see the information in total"). */
function viewKitOrder(id) {
  var k = kitFind(id); if (!k) return;
  if (k.contract_number) { openCustomer(k.contract_number); return; }
  var box = $('#kit-detail-body'); if (!box) return;
  box.replaceChildren();
  var pairs = [
    ['Order date', k.order_date || '—'], ['Customer', k.customer_name || '—'],
    ['Email', k.customer_email || '—'], ['Kit', (k.kit_name || '—') + (k.kit_sku ? ' (' + k.kit_sku + ')' : '')],
    ['Quantity', String(k.quantity || 0)], ['Retail', usd(k.retail_cents)],
    ['Shipping & handling', k.sh_cents == null ? '—' : usd(k.sh_cents)],
    ['Status', k.fulfillment_status === 'shipped' ? 'Shipped' : 'Pending'],
    ['Tracking #', k.shipping_confirmation || '—'],
    ['Ship to', kitShipLines(k).join(' · ') || '—']
  ];
  pairs.forEach(function (p) {
    var row = document.createElement('div'); row.className = 'kit-kv';
    var kEl = document.createElement('b'); kEl.textContent = p[0];
    var vEl = document.createElement('span'); vEl.textContent = p[1];
    row.appendChild(kEl); row.appendChild(vEl); box.appendChild(row);
  });
  kitCurrent = id;
  var m = $('#kit-detail-modal'); if (m) m.classList.add('on');
}
function closeKitDetail() { var m = $('#kit-detail-modal'); if (m) m.classList.remove('on'); }

/* ---- PORT-24C: modal de confirmación + resultado para las Quick actions ---- */
function closeAM() { var m = $('#action-modal'); if (m) m.classList.remove('on'); }
function confirmAction(opts) {
  setText('#am-title', opts.title || 'Confirm');
  setText('#am-msg', opts.message || '');
  var head = $('#am-head'); if (head) head.className = 'modal-h';
  var cancel = $('#am-cancel'), confirm = $('#am-confirm'), close = $('#am-close'), alt = $('#am-alt');
  if (cancel) cancel.hidden = false;
  if (close) close.hidden = true;
  /* altLabel (opcional): tercera salida que RESUELVE el motivo del aviso en vez de ignorarlo.
     Sin ella el modal se comporta exactamente igual que siempre. */
  if (alt) {
    alt.hidden = !opts.altLabel;
    if (opts.altLabel) {
      alt.textContent = opts.altLabel;
      alt.className = 'btn primary';
      alt.onclick = function () { closeAM(); if (opts.onAlt) opts.onAlt(); };
    }
  }
  if (confirm) {
    confirm.hidden = false;
    confirm.textContent = opts.confirmLabel || 'Confirm';
    confirm.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    confirm.onclick = function () { closeAM(); if (opts.onConfirm) opts.onConfirm(); };
  }
  var m = $('#action-modal'); if (m) m.classList.add('on');
}
function resultModal(title, message, isError) {
  setText('#am-title', title);
  setText('#am-msg', message);
  var head = $('#am-head'); if (head) head.className = 'modal-h ' + (isError ? 'err' : 'ok');
  var cancel = $('#am-cancel'), confirm = $('#am-confirm'), close = $('#am-close');
  if (cancel) cancel.hidden = true;
  if (confirm) confirm.hidden = true;
  if (close) close.hidden = false;
  var m = $('#action-modal'); if (m) m.classList.add('on');
}

/* ---- PORT-19B/24C: Quick actions del Customer Record (confirmación + resultado visible) ---- */
var TERMS_URL = 'https://furniturerx.net/terms/';
function resendDashLink() {
  if (!currentContract) { toast('Open a customer record first.'); return; }
  confirmAction({
    title: 'Resend dashboard link', confirmLabel: 'Send link',
    message: 'Email this customer a fresh link to their own coverage dashboard?',
    onConfirm: function () {
      api('/api/portal-resend-link', { method: 'POST', body: JSON.stringify({ contract: currentContract }) }).then(function (r) {
        if (r.ok && r.d && r.d.sent) resultModal('Link sent', 'The customer got an email with a link to their dashboard.');
        else if (r.status === 404) resultModal('Not in your scope', 'That record is not in your scope.', true);
        else resultModal('Could not send', 'The dashboard link was not sent. Please try again.', true);
      });
    }
  });
}
function printTerms() {
  confirmAction({
    title: 'Print T&C (PDF)', confirmLabel: 'Open terms',
    message: 'Open the plan terms & conditions in a new tab to print or save as PDF?',
    onConfirm: function () { window.open(TERMS_URL, '_blank', 'noopener'); }
  });
}

function openCustomer(contract) { currentContract = contract; show('custrecord'); }
function loadCustomer(contract) {
  var empty = $('#cust-empty'), card = $('#cust-card');
  if (!contract) { if (empty) empty.hidden = false; if (card) card.hidden = true; return; }
  ['#cr-name', '#cr-contact', '#cr-address', '#cr-start', '#cr-payments', '#cr-program',
   '#cr-order', '#cr-fulfil', '#cr-associate', '#cr-dealerstore', '#cr-receipt', '#cr-terms',
   '#cr-stripe', '#cr-maya'].forEach(skel);
  api('/api/portal-customer?contract=' + encodeURIComponent(contract) + orgParam('&')).then(function (r) {
    if (!r.ok || !r.d || !r.d.contract_number) {
      if (card) card.hidden = true;
      if (empty) { empty.hidden = false; empty.replaceChildren(); var b = document.createElement('b'); b.textContent = r.status === 404 ? 'Not found' : 'Could not load'; empty.appendChild(b); empty.appendChild(document.createTextNode(r.status === 404 ? 'That record is not in your scope.' : 'Please try again.')); }
      return;
    }
    var d = r.d;
    if (empty) empty.hidden = true; if (card) card.hidden = false;
    /* SR embebido (Doug 16-jul): el template se PREPUEBLA desde la ficha abierta. */
    var pre = [['#sr-contract', d.contract_number], ['#sr-first', d.first_name], ['#sr-last', d.last_name], ['#sr-contact', d.email || d.phone]];
    pre.forEach(function (p) { var el = $(p[0]); if (el) el.value = p[1] || ''; });
    setText('#cr-name', ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || '—');
    var st = $('#cr-status'); if (st) { st.textContent = d.status === 'cancelled' ? 'Cancelled' : 'Active'; st.className = 'pill ' + (d.status === 'cancelled' ? 'cancel' : 'active'); }
    /* PORT-24C: master + activo en el header */
    setText('#cr-master', 'Master ' + (d.master_number || '—'));
    setText('#cr-contract', 'Active ' + (d.contract_number || '—'));
    setText('#cr-contact', [d.email, d.phone].filter(Boolean).join(' · ') || '—');
    setText('#cr-address', d.address || '—');
    setText('#cr-start', d.start_date || '—');
    setText('#cr-payments', String(d.payments || 0));
    setText('#cr-program', d.program || '—');
    setText('#cr-order', d.order_ref || '—');
    setText('#cr-fulfil', d.fulfilment_date || '—');
    setText('#cr-associate', d.person_id || '—');
    setText('#cr-dealerstore', d.dealer_store || '—');            // PORT-19B (mock 447)
    var rc = $('#cr-receipt'); if (rc) { rc.classList.remove('skel'); rc.replaceChildren(); if (d.receipt_url) { var a = document.createElement('a'); a.className = 'lk'; a.href = d.receipt_url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View receipt'; rc.appendChild(a); } else rc.textContent = '—'; }
    /* PORT-19B (mock 450): T&C como LINK "View accepted T&C (v…)" */
    var tn = $('#cr-terms');
    if (tn) {
      tn.classList.remove('skel');
      tn.replaceChildren();
      if (d.terms_version) {
        var ta = document.createElement('a'); ta.className = 'lk';
        ta.href = TERMS_URL; ta.target = '_blank'; ta.rel = 'noopener';
        ta.textContent = 'View accepted T&C (' + d.terms_version + ')';
        tn.appendChild(ta);
      } else tn.textContent = '—';
    }
    setText('#cr-maya', d.maya_summary || 'No chat summary.');
    /* PORT-24C: Stripe sub enmascarado para dealer (admin ve el id real vía stripe_sub_display) */
    setText('#cr-stripe', d.stripe_sub_display || d.stripe_subscription_id || '—');
    loadSRList(d.service_requests || []);   // PORT-24C: últimos 5 SRs de la ficha
    clearSR();                              // form limpio para una solicitud nueva (contract queda del prefill)
  });
}

/* ---- PORT-24C: service requests dentro del Customer Record ---- */
var currentSRId = null;
function loadSRList(list) {
  var body = $('#sr-list'); if (!body) return;
  body.replaceChildren();
  if (!list.length) {
    var tr = document.createElement('tr'); var td = document.createElement('td'); td.colSpan = 4;
    td.style.color = 'var(--muted)'; td.textContent = 'No service requests yet.'; tr.appendChild(td); body.appendChild(tr);
    return;
  }
  list.forEach(function (s) {
    var tr = document.createElement('tr');
    [s.sr_number || '—', String(s.created_at || '').slice(0, 10), s.category || '—'].forEach(function (v) {
      var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    var tdS = document.createElement('td'); var pill = document.createElement('span');
    pill.className = 'pill ' + (s.status === 'closed' ? 'active' : 'pending'); pill.textContent = s.status === 'closed' ? 'Closed' : 'Open';
    tdS.appendChild(pill); tr.appendChild(tdS);
    tr.addEventListener('click', function () { populateSRFromRow(s); });   // "if you click one it just populates this"
    body.appendChild(tr);
  });
}
function pickSRCat(el) {   // single-select: el 6º "Resolved" desmarca los demás y viceversa
  $all('#sr-cats input[type=checkbox]').forEach(function (cb) { if (cb !== el) cb.checked = false; });
}
function selectedSRCat() {
  var el = $('#sr-cats input[type=checkbox]:checked');
  return el ? el.value : null;
}
function populateSRFromRow(s) {
  currentSRId = s.id || null;
  var tb = $('#sr-body'); if (tb) tb.value = s.body || '';
  $all('#sr-cats input[type=checkbox]').forEach(function (cb) { cb.checked = (cb.value === s.category); });
  var box = $('#sr-loaded'); if (box) box.hidden = false;
  setText('#sr-cur-num', s.sr_number || '—');
  setText('#sr-cur-date', String(s.created_at || '').slice(0, 10));
  setText('#sr-cur-status', s.status === 'closed' ? 'Closed' : 'Open');
}

/* ---- become a reseller ---- */
function openReseller() { $('#reseller').classList.add('on'); }
function closeReseller() { $('#reseller').classList.remove('on'); }
function submitReseller(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  var body = {
    name: ($('#rs-name') || {}).value || '',
    email: ($('#rs-email') || {}).value || '',
    phone: ($('#rs-phone') || {}).value || '',
    world: ($('#rs-world') || {}).value || 'retailer',
    company_url: ($('#rs-company-url') || {}).value || ''
  };
  var msg = $('#rs-msg');
  api('/api/portal-inquiries', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
    if (r.ok && r.d && r.d.ok) { if (msg) { msg.textContent = 'Thanks — we\'ll be in touch.'; msg.hidden = false; } var f = $('#reseller-form'); if (f) f.reset(); }
    else if (r.status === 429) { if (msg) { msg.textContent = 'Please wait a moment and try again.'; msg.hidden = false; } }
    else { if (msg) { msg.textContent = 'Please check your details and try again.'; msg.hidden = false; } }
  });
  return false;
}

/* ---- toast (createTextNode, sin innerHTML) ---- */
/* `undo` (opcional) = { label, onClick } → añade una acción al aviso. Sin él, se comporta
   exactamente igual que siempre (el resto del portal no se entera). */
function toast(m, undo) {
  var t = document.createElement('div'); t.className = 'toast';
  var b = document.createElement('b'); b.textContent = '✓ '; t.appendChild(b);
  t.appendChild(document.createTextNode(m));
  if (undo && undo.onClick) {
    var u = document.createElement('button'); u.type = 'button'; u.className = 'toast-undo';
    u.textContent = undo.label || 'Undo';
    u.addEventListener('click', function () { t.remove(); undo.onClick(); });
    t.appendChild(u);
  }
  $('#toasts').appendChild(t);
  setTimeout(function () { t.style.opacity = '0'; t.style.transition = '.4s'; setTimeout(function () { t.remove(); }, 400); }, undo ? 8000 : 3000);
}

/* ---- PORT-24A: drag-to-scroll en los carruseles horizontales (By location / By sales
   associate, y cualquier .scroll-x). El scrollbar visible sigue siendo la señal; esto solo
   añade "agarrar y arrastrar" con el mouse. Umbral de 5px para NO comerse los clicks reales. ---- */
(function dragScroll() {
  var el = null, startX = 0, startLeft = 0, moved = false;
  document.addEventListener('mousedown', function (e) {
    var sx = (e.button === 0 && e.target && e.target.closest) ? e.target.closest('.scroll-x') : null;
    if (!sx || sx.scrollWidth <= sx.clientWidth) return;   // no hay nada que desplazar
    el = sx; startX = e.pageX; startLeft = sx.scrollLeft; moved = false;
    sx.classList.add('dragging');
  });
  document.addEventListener('mousemove', function (e) {
    if (!el) return;
    var dx = e.pageX - startX;
    if (Math.abs(dx) > 5) moved = true;
    if (moved) { el.scrollLeft = startLeft - dx; e.preventDefault(); }   // preventDefault solo al arrastrar → el click sin mover sobrevive
  });
  function end() { if (el) { el.classList.remove('dragging'); el = null; } }
  document.addEventListener('mouseup', end);
  document.addEventListener('mouseleave', end);
})();

/* ---- boot ---- */
document.addEventListener('click', function (e) {
  var nav = e.target && e.target.closest ? e.target.closest('nav.side a[data-screen]') : null;
  if (nav) { show(nav.getAttribute('data-screen')); return; }
  if (e.target && e.target.id === 'reseller') closeReseller();
  if (e.target && e.target.id === 'action-modal') closeAM();   // PORT-24C: click fuera cierra el modal
});
(function boot() {
  if (getSession()) loadMe();
  else showLanding();
})();
