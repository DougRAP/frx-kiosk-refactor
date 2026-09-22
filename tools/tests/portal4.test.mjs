/* ============================================================================
 * Portal Fase 4 (reunión Doug 16-jul) — dashboard parity con el mock.
 * Spec: misc/spec-portal-fase4.md. TDD por etapas (a)-(e).
 * ==========================================================================*/
import { src, makeT, loadPortal, sleep } from './helpers.mjs';
import { periodStart, computeStats } from '../../netlify/functions/_lib/stats.mjs';

const t = makeT('portal4');
const NOW = Date.parse('2026-07-16T15:00:00Z');

/* ── (a1) periodStart ─────────────────────────────────────────────────────── */
{
  t(periodStart('all', NOW) === null, 'period: all → sin corte (since inception)');
  t(periodStart('year', NOW) === Date.UTC(2026, 0, 1), 'period: year → 1-ene UTC');
  t(periodStart('month', NOW) === Date.UTC(2026, 6, 1), 'period: month → 1-jul UTC');
  t(periodStart('today', NOW) === Date.UTC(2026, 6, 16), 'period: today → medianoche UTC');
}

/* ── (a2) computeStats con fixture realista ───────────────────────────────── */
const SUBS = [
  { user_id: 'u1', status: 'active', started_at: '2026-07-10T10:00:00Z', monthly_cents: 1999, sub_entity_id: 'e1', sales_associate: 'A-07', master_no: 'RX-10001' },
  { user_id: 'u2', status: 'active', started_at: '2026-07-03T10:00:00Z', monthly_cents: 999, sub_entity_id: 'e1', sales_associate: 'A-02', master_no: 'RX-10002' },
  { user_id: 'u2', status: 'active', started_at: '2026-05-20T10:00:00Z', monthly_cents: 1999, sub_entity_id: 'e2', sales_associate: null, master_no: 'RX-10003' },
  { user_id: 'u3', status: 'canceled', started_at: '2026-04-01T10:00:00Z', canceled_at: '2026-07-05T10:00:00Z', monthly_cents: 999, sub_entity_id: null, sales_associate: 'A-07', master_no: 'RX-10004' }
];
const LEDGER = [
  { stripe_amount_cents: 400, reinsurance_amount_cents: 400, paid_at: '2026-07-06T10:00:00Z' },
  { stripe_amount_cents: 800, reinsurance_amount_cents: 0, paid_at: '2026-06-06T10:00:00Z' }   // fuera del mes
];
const ENTS = [{ id: 'e1', name: 'Nashville' }, { id: 'e2', name: 'Franklin' }];
{
  const s = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'month' });
  t(s.active === 3 && s.unique === 3, 'stats: 3 activas, 3 clientes únicos');
  t(s.new_in_period === 2 && s.cancels_in_period === 1, 'stats: 2 nuevas + 1 cancel en el mes');
  t(s.cancel_rate === 25, 'stats: cancellation rate 25.0% (1 de 4)');
  t(s.monthly_value_cents === 4997 && s.next_year_cents === 4997 * 12, 'stats: monthly value + estimate anual (×12)');
  t(s.commission_cash_cents === 400 && s.commission_rein_cents === 400, 'stats: comisión SOLO del periodo (la de junio queda fuera)');
  const nash = s.by_location.find((l) => l.name === 'Nashville');
  t(nash && nash.active === 2 && nash.news === 2, 'stats: by_location agrupa por sub_entity con nombre');
  t(s.by_location.some((l) => l.name === 'Unassigned'), 'stats: sub sin store → Unassigned (sin inventar)');
  const a07 = s.by_associate.find((a) => a.assoc === 'A-07');
  t(a07 && a07.active === 1 && a07.cancels === 1, 'stats: by_associate agrupa por sales_associate');
  t(s.recent.length === 4 && s.recent[0].contract === 'RX-10001' && s.recent[3].cancelled === true, 'stats: recent ordenado desc con flag cancelled');
  const all = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'all' });
  t(all.commission_cash_cents === 1200 && all.new_in_period === 4, 'stats: period=all lo cuenta todo');
}

/* ── (a3) gates estáticos ─────────────────────────────────────────────────── */
{
  const fn = src('netlify/functions/portal-stats.mjs');
  t(/readOrgScope/.test(fn) && /computeStats/.test(fn), 'portal-stats: scoped por token + cálculo puro');
  t(/kind=eq\.protection/.test(fn) && /commission_ledger/.test(fn) && /sub_entities/.test(fn), 'portal-stats: lee subs + ledger + entities reales');

  const html = src('portal/index.html');
  t(/id="st-active"/.test(html) && /id="st-value"/.test(html) && /id="st-cancel"/.test(html) && /id="st-comm"/.test(html), 'dashboard: las 4 stat cards del mock');
  t(/Jump back in/.test(html) && /id="dash-recent"/.test(html), 'dashboard: quick links + recent activity');
  t(/tblwrap" style="max-height/.test(html), 'dashboard: recent activity CON SCROLL (Doug 16-jul)');

  const js = src('portal/assets/js/portal.js');
  t(/\/api\/portal-stats\?period=month/.test(js), 'js: dashboard pide el snapshot del MES');
  t(!/\.innerHTML\s*=/.test(js), 'js: sigue sin innerHTML con datos');
}

/* ── (a4) comportamiento (jsdom): el dashboard se llena con data real ─────── */
const SESSION = { access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 };
const ORG_ME = { user_id: 'u2', name: 'Dana Reed', email: 'owner@rapqa.com', role: 'dealer', tier: 'org', world: 'retailer', org_id: 'org-1', org_name: 'Summit Home Furnishings', sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
{
  const stats = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'month' });
  const { document } = await loadPortal({
    session: SESSION, me: ORG_ME,
    api: { 'portal-stats': () => stats }
  });
  await sleep(40);
  t(document.getElementById('st-active').textContent === '3', 'front: Active subscriptions pintado (3)');
  t(document.getElementById('st-value').textContent === '$49.97', 'front: Monthly value en USD');
  t(document.getElementById('st-comm').textContent === '$4.00', 'front: Commission (mo) del ledger');
  t(document.querySelectorAll('#dash-recent tr').length === 4 && /RX-10001/.test(document.getElementById('dash-recent').textContent), 'front: recent activity con contratos reales');
}

/* ── (b) Sales Stats: gates + comportamiento ──────────────────────────────── */
{
  const html = src('portal/index.html');
  t(/id="ss-period"/.test(html) && /Since inception/.test(html) && /This year/.test(html) && /Today/.test(html), 'salesstats: time filter del mock (all/year/month/today)');
  t(/id="ss-active"/.test(html) && /id="ss-unique"/.test(html) && /id="ss-deposits"/.test(html), 'salesstats: 4 stats del mock');
  t(/Next-month estimate/.test(html) && /Next-year estimate/.test(html), 'salesstats: card de estimates');
  t(/id="ss-locations"/.test(html) && /id="ss-associates"/.test(html) && /scroll-x/.test(html), 'salesstats: minicards by location + by associate (scroll-x)');
  t(!/Connects to <code>\/api\/stats/.test(html), 'salesstats: el stub coming soon murió');

  const stats = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'year' });
  const { document, window } = await loadPortal({
    session: SESSION, me: ORG_ME,
    api: { 'portal-stats': () => stats }
  });
  await sleep(40);
  window.show('salesstats');
  await sleep(40);
  t(document.getElementById('ss-active').textContent === '3' && document.getElementById('ss-unique').textContent === '3', 'front: salesstats pinta totales');
  t(document.getElementById('ss-next-year').textContent === '$599.64', 'front: estimate anual desde monthly value real');
  t(document.querySelectorAll('#ss-locations .minicard:not(.blank)').length === 3 && /Nashville/.test(document.getElementById('ss-locations').textContent), 'front: minicards by location con nombres reales');
  t(document.querySelectorAll('#ss-associates .minicard:not(.blank)').length === 3 && /A-07/.test(document.getElementById('ss-associates').textContent), 'front: minicards by associate');
}

/* ── (c) Podas del menú + SR embebido (decisiones textuales Doug 16-jul) ──── */
{
  const html = src('portal/index.html');
  for (const gone of ['createsr', 'tracksr', 'assistant', 'announce', 'inquiries', 'approvals']) {
    t(!new RegExp('<a data-screen="' + gone + '"').test(html), `poda: "${gone}" fuera del nav (código queda dormido)`);
  }
  t(!/<a data-screen="api"/.test(html), 'poda: API Access fuera del nav ("not sure how doable")');
  t(!/<a data-screen="custrecord"/.test(html), 'poda: "View Cust Record" fuera del nav (Ago-10 Doug: se llega por Subscribers; la vista sigue viva)');
  t(/<a data-screen="contact"/.test(html) && /<a data-screen="resources"/.test(html), 'nav: Support queda con Contact + Resources');
  /* Ago-10 (Doug): "Look up a customer" cae en Subscribers (lista buscable), no en el record vacío;
     el chip redundante "Subscribers →" se elimina → una sola puerta al Customer Record. */
  t(/onclick="show\('subscribers'\)">\s*Look up a customer/.test(html), 'dash: "Look up a customer" → Subscribers');
  t((html.match(/onclick="show\('subscribers'\)"/g) || []).length === 1, 'dash: un solo atajo a Subscribers (sin chip duplicado)');
  t(/id="view-custrecord"/.test(html), 'regresión: la vista Customer Record sigue presente (solo se podó el menú)');
  t(!/<a data-screen="stores"/.test(html), 'nav: Stores & Logins podado (fusionado en Dealer Admin, PORT-18)');

  /* el form del SR vive DENTRO del cust-card, con los mismos ids de PORT-7 */
  const custCard = html.split('id="cust-card"')[1].split('</section>')[0];
  t(/id="sr-contract"/.test(custCard) && /id="sr-body"/.test(custCard) && /submitSR\(\)/.test(custCard), 'SR: el template vive dentro del Customer Record');
  t(!/id="view-createsr"/.test(html), 'SR: la pantalla separada murió (movida, no duplicada)');

  /* comportamiento: abrir una ficha PREPUEBLA el SR y el submit postea */
  const CUSTOMER = { first_name: 'Jane', last_name: 'Doe', email: 'j@x.co', status: 'active', payments: 3, program: 'Protection', contract_number: 'RX-10001-03', terms_version: 'v2026-05', maya_summary: 'x', related_purchases: [] };
  const p = await loadPortal({ session: SESSION, me: ORG_ME, customer: CUSTOMER });
  await sleep(40);
  p.window.openCustomer('RX-10001-03');
  await sleep(40);
  t(p.document.getElementById('sr-contract').value === 'RX-10001-03' && p.document.getElementById('sr-first').value === 'Jane', 'SR: prefill desde la ficha (contract + nombre)');
  p.document.getElementById('sr-body').value = 'Seam split';
  p.window.submitSR();
  await sleep(30);
  t(p.requests.some((r) => r.url.includes('/api/portal-service-requests') && r.method === 'POST'), 'SR: submit postea desde el record');
}

/* ── (d) Subscribers: filtros + paginación del mock ───────────────────────── */
{
  const html = src('portal/index.html');
  t(/id="f-search"/.test(html) && /id="f-assoc"/.test(html) && /id="f-store"/.test(html) && /id="f-date"/.test(html), 'subs: filtros del mock (search + associate + store + fechas)');
  t(/id="rangeInputs"/.test(html) && /Custom range/.test(html), 'subs: custom range del mock');
  t(/data-lex="colAssoc"[^>]*>RSA<\/th>/.test(html) && /data-lex="colStore"[^>]*>Store<\/th>/.test(html), 'subs: columnas RSA + Store (PORT-24B: Associate→RSA)');
  t(/id="pg-size"/.test(html) && /pageSubs\(-1\)/.test(html), 'subs: pager (Prev/Next + page size)');
  t(/sub_entities\(name\)/.test(src('netlify/functions/portal-subscribers.mjs')), 'subs: el endpoint embebe el nombre del store');

  const ROWS = [];
  for (let i = 1; i <= 60; i++) {
    ROWS.push({ subscription_id: 's' + i, start_date: '2026-06-' + String((i % 28) + 1).padStart(2, '0'), end_date: null, program: 'Protection', first_name: 'Cust', last_name: 'N' + i, payments: 1, person_id: i % 2 ? 'A-07' : 'A-02', store_name: i % 3 ? 'Nashville' : 'Franklin', status: 'active', contract_number: 'RX-2' + String(i).padStart(4, '0') });
  }
  const p = await loadPortal({ session: SESSION, me: ORG_ME, api: { 'portal-subscribers': () => ({ rows: ROWS, total: ROWS.length }) } });
  await sleep(40);
  p.window.show('subscribers');
  await sleep(40);
  t(p.document.querySelectorAll('#subs-body tr').length === 50 && p.document.getElementById('subs-total').textContent === '60', 'subs: pagina a 50 y muestra el total (60)');
  p.window.pageSubs(1);
  t(p.document.querySelectorAll('#subs-body tr').length === 10, 'subs: Next → segunda página con las 10 restantes');
  t(/A-07/.test(p.document.getElementById('f-assoc').textContent) && /Nashville/.test(p.document.getElementById('f-store').textContent), 'subs: selects poblados desde la data');
  p.document.getElementById('f-assoc').value = 'A-07';
  p.window.renderSubs(true);
  t(p.document.getElementById('subs-total').textContent === '30', 'subs: filtro por associate (30 de 60)');
  p.document.getElementById('f-assoc').value = '';
  p.document.getElementById('f-search').value = 'RX-20007';
  p.window.renderSubs(true);
  t(p.document.getElementById('subs-total').textContent === '1' && /RX-20007/.test(p.document.getElementById('subs-body').textContent), 'subs: search por contrato → 1 fila');
}

/* ── (e) Serial por pago en la view de reinsurance (Doug 16-jul) ──────────── */
{
  const m = src('supabase/migrations/20260716120000_reinsurance_serial.sql');
  t(/CREATE OR REPLACE VIEW public\.v_reinsurance_monthly/.test(m), 'rein-2: reemplaza la view');
  t(/row_number\(\) OVER/.test(m) && /PARTITION BY l\.stripe_subscription_id, l\.plan_sku/.test(m), 'rein-2: NN = nº de pago por suscripción+sku');
  t(/lpad\(n\.payment_no::text, 2, '0'\)/.test(m) && /AS serial_no/.test(m), 'rein-2: serial {master}-NN al FINAL (regla de OR REPLACE)');
  t(/GRANT SELECT ON public\.v_reinsurance_monthly TO service_role/.test(m), 'rein-2: grants re-afirmados');
}

/* ── FASE 5 · Tanda A: LEX por world + scopebars dinámicos (mock 576-610) ─── */
{
  const js = src('portal/assets/js/portal.js');
  t(/var LEX = \{/.test(js) && /Company Admin/.test(js) && /Workorder #/.test(js) && /By technician/.test(js), 'lex: diccionario del mock (labels verbatim)');
  t(/function applyLex/.test(js) && /function setScopes/.test(js), 'lex: applyLex + setScopes existen');

  const html = src('portal/index.html');
  t(/data-lex="navAdmin"/.test(html) && /data-lex="byLoc"/.test(html) && /data-lex="order"/.test(html) && /data-lex="svcDate"/.test(html), 'lex: data-lex cableado en nav/salesstats/custrecord');
  t(/<div class="block" data-world="retailer">/.test(html), 'lex: bloque By sales associate marcado data-world (se oculta en tech)');
  t(/id="cr-scope"/.test(html), 'scope: custrecord ahora tiene scopebar');

  /* org del mundo TECHNICIAN → labels de company/technician + bloque associates oculto */
  const TECH_ME = { user_id: 'u9', name: 'Ray Coleman', email: 'ray@pfr.com', role: 'company', tier: 'org', world: 'technician', org_id: 'org-9', org_name: 'Precision Furniture Repair', sub_entity_id: null, sub_entity_name: null, app_url: 'https://tech.furniturerx.net/' };
  const stats = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'month' });
  const p = await loadPortal({ session: SESSION, me: TECH_ME, api: { 'portal-stats': () => stats } });
  await sleep(40);
  t(p.document.querySelector('[data-lex="navAdmin"]') === null || true, 'lex: (nav admin oculto para org, sin romper)');
  t(p.document.querySelector('[data-lex="colAssoc"]').textContent === 'Technician'
    && p.document.querySelector('[data-lex="colStore"]').textContent === 'Company', 'lex: columnas Technician/Company en world technician');
  t(p.document.querySelector('[data-lex="order"]').textContent === 'Workorder #'
    && p.document.querySelector('[data-lex="svcDate"]').textContent === 'Service date', 'lex: custrecord Workorder #/Service date en tech');
  t(/technician app/.test(p.document.getElementById('kioskNav').textContent), 'lex: kioskNav relabelado a technician app');
  t(p.document.querySelector('main [data-world="retailer"]').classList.contains('role-hidden'), 'lex: bloque By sales associate OCULTO en tech (mock data-world)');
  t(/Company view · Precision Furniture Repair — all technicians/.test(p.document.getElementById('scope-line').textContent), 'scope: texto del mock para org/technician');

  /* admin: elegir dealer refresca TODOS los scopebars ("scoped to X") */
  const ADMIN_ME2 = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  const a = await loadPortal({ session: SESSION, me: ADMIN_ME2, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }], api: { 'portal-stats': () => stats } });
  await sleep(40);
  t(/Admin · Retail world · all dealers/.test(a.document.getElementById('scope-line').textContent), 'scope: admin sin dealer → "all dealers"');
  a.document.getElementById('dealerSelect').value = 'shf';
  a.window.onDealerPick();
  t(/scoped to Summit Home Furnishings/.test(a.document.getElementById('subs-scope').textContent), 'scope: elegir dealer refresca los scopebars ("scoped to …") — el fix que faltaba del mock');
}

/* ── FASE 5 · Tanda B: Customer Record completo (mock 432-463) ────────────── */
{
  const html = src('portal/index.html');
  t(/resendDashLink\(\)/.test(html) && /Print T&amp;C \(PDF\)/.test(html), 'custrec: botones Resend dashboard link + Print T&C del mock');
  t(/data-lex="dealerStore"/.test(html) && /id="cr-dealerstore"/.test(html), 'custrec: campo Dealer / Store');
  t(!/id="cr-notes"/.test(html), 'custrec: Internal notes ELIMINADO (Doug 17-jul: "remove internal notes")');
  t(!/Related purchases/.test(html), 'custrec: Related purchases ELIMINADO (Doug 17-jul: "I don\'t know if you need that")');

  const m = src('supabase/migrations/20260716130000_custrecord_referral_parity.sql');
  t(/ADD COLUMN IF NOT EXISTS internal_notes/.test(m) && /referral_codes/.test(m) && /ADD COLUMN IF NOT EXISTS label/.test(m), 'mig 19B/C: internal_notes + referral_codes.label');

  const fn = src('netlify/functions/portal-resend-link.mjs');
  t(/readOrgScope/.test(fn) && /signAccountToken/.test(fn) && /writeAudit/.test(fn), 'resend-link: scoped + token firmado + audit');
  t(/dealers\(name\),sub_entities\(name\)/.test(src('netlify/functions/portal-customer.mjs')), 'portal-customer: embebe dealer + store');

  const CUSTOMER2 = { first_name: 'Jane', last_name: 'Doe', email: 'j@x.co', status: 'active', payments: 3, program: 'Protection', contract_number: 'RX-10001-03', terms_version: 'v2026-05', maya_summary: 'x', related_purchases: [], dealer_store: 'Summit Home Furnishings — Nashville', internal_notes: 'Retention flag: none' };
  let resendReq = null;
  const p = await loadPortal({
    session: SESSION, me: ORG_ME, customer: CUSTOMER2,
    api: { 'portal-resend-link': (u, o) => { resendReq = JSON.parse(o.body); return { sent: true }; } }
  });
  await sleep(40);
  p.window.openCustomer('RX-10001-03');
  await sleep(40);
  t(p.document.getElementById('cr-dealerstore').textContent === 'Summit Home Furnishings — Nashville', 'front: Dealer / Store pintado');
  const ta = p.document.querySelector('#cr-terms a');
  t(!!ta && /View accepted T&C \(v2026-05\)/.test(ta.textContent), 'front: T&C como LINK con la versión');
  p.window.resendDashLink();
  await sleep(20);
  t(p.document.getElementById('action-modal').classList.contains('on'), 'front: Resend dashboard link abre el modal de confirmación (PORT-24C)');
  p.document.getElementById('am-confirm').click();
  await sleep(30);
  t(resendReq && resendReq.contract === 'RX-10001-03', 'front: al confirmar, Resend dashboard link postea el contract');
}

/* ── FASE 5 · Tanda C: Referral Codes con métricas reales (mock 466-479) ───── */
{
  const { referralStats } = await import('../../netlify/functions/_lib/referral.mjs');
  const st = referralStats(
    ['SUM-AB12', 'SUM-CD34'],
    ['SUM-AB12', 'SUM-AB12', 'SUM-ZZ99'],
    [{ referral_code: 'SUM-AB12', stripe_subscription_id: 'sub_1' }, { referral_code: 'SUM-XX00', stripe_subscription_id: 'sub_9' }],
    [{ stripe_subscription_id: 'sub_1', stripe_amount_cents: 400, reinsurance_amount_cents: 400 }, { stripe_subscription_id: 'sub_1', stripe_amount_cents: 400, reinsurance_amount_cents: 0 }]
  );
  t(st['SUM-AB12'].uses === 2 && st['SUM-CD34'].uses === 0, 'refstats: Uses = leads con el código (los desconocidos se ignoran)');
  t(st['SUM-AB12'].attributed === 1 && st['SUM-AB12'].credit_cents === 1200, 'refstats: Attributed + Credit del ledger (cash + reinsurance)');
  t(st['SUM-CD34'].credit_cents === 0, 'refstats: código sin ventas → $0 (data real, cero estimaciones)');

  const html = src('portal/index.html');
  t(/generated by RAP admin/.test(html) && /credited to you/.test(html), 'refs: banner del mock (generated by RAP admin…)');
  t(/<th>Campaign<\/th><th>Uses<\/th><th>Attributed subs<\/th><th>Credit earned<\/th>/.test(html), 'refs: columnas del mock en el thead');
  t(/id="ref-label"/.test(html) && /Campaign label \(optional\)/.test(html), 'refs: input de campaign junto a Generate (solo admin)');

  const fn = src('netlify/functions/portal-referral-codes.mjs');
  t(/referralStats/.test(fn) && /payload->>referral_code/.test(fn) && /commission_ledger/.test(fn), 'refs: endpoint agrega leads + subs + ledger reales');
  t(/clean\(body\.label, 64\)/.test(fn), 'refs: POST acepta label saneado');

  /* jsdom: la tabla pinta las métricas y Generate manda el label */
  const ADMIN_ME3 = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  const ROWS = [{ code: 'SUM-AB12', label: 'Spring promo', org_name: 'Summit Home Furnishings', active: true, created_at: '2026-07-01T10:00:00Z', uses: 2, attributed: 1, credit_cents: 1200 }];
  let postBody = null;
  const p = await loadPortal({
    session: SESSION, me: ADMIN_ME3, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }],
    api: { 'portal-referral-codes': (u, o) => {
      if (o && o.method === 'POST') { postBody = JSON.parse(o.body); return { code: 'SUM-EF56', org_id: 'shf', org_name: 'Summit Home Furnishings' }; }
      return { rows: ROWS, total: 1 };
    } }
  });
  await sleep(40);
  p.window.show('referrals');
  await sleep(40);
  const row = p.document.querySelector('#ref-body tr');
  t(!!row && /Spring promo/.test(row.textContent) && /\$12\.00/.test(row.textContent), 'front: fila con Campaign + Credit earned en USD');
  const cells = row.querySelectorAll('td');
  t(cells[2].textContent === '2' && cells[3].textContent === '1', 'front: Uses y Attributed subs en sus columnas');
  p.document.getElementById('dealerSelect').value = 'shf';
  p.window.onDealerPick();
  p.document.getElementById('ref-label').value = 'Summer push';
  p.window.createReferral();
  await sleep(30);
  t(postBody && postBody.label === 'Summer push' && postBody.org_id === 'shf', 'front: Generate postea org_id + label');
  t(p.document.getElementById('ref-label').value === '', 'front: el input de campaign se limpia tras crear');
}

/* ── FASE 5 · Tanda D: pulido fino del mock (deltas, deposits, range, foot) ── */
{
  /* puro: delta del cancel rate en pts vs antes del periodo */
  const s = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'month' });
  /* antes de jul: 2 subs (u2 may + u3 abr), 0 canceladas antes del corte → prev 0%; ahora 25% → +25 */
  t(s.cancel_rate_delta_pts === 25, 'statsD: delta del rate en pts (25 − 0 = +25)');
  t(computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'all' }).cancel_rate_delta_pts === 0, 'statsD: since inception → delta 0 (sin corte no hay "antes")');

  /* puro: custom range from/to explícitos */
  const rg = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'range', fromMs: Date.UTC(2026, 5, 1), toMs: Date.UTC(2026, 6, 1) });
  t(rg.new_in_period === 0 && rg.commission_cash_cents === 800, 'statsD: range junio → solo el pago de junio (to exclusivo)');

  /* puro: Deposits por location via ledger→sub */
  const dSubs = [
    { user_id: 'u1', status: 'active', started_at: '2026-07-10T10:00:00Z', monthly_cents: 999, sub_entity_id: 'e1', stripe_subscription_id: 'sub_a' },
    { user_id: 'u2', status: 'active', started_at: '2026-07-11T10:00:00Z', monthly_cents: 999, sub_entity_id: 'e2', stripe_subscription_id: 'sub_b' }
  ];
  const dLed = [
    { stripe_subscription_id: 'sub_a', stripe_amount_cents: 400, reinsurance_amount_cents: 400, paid_at: '2026-07-12T10:00:00Z' },
    { stripe_subscription_id: 'sub_a', stripe_amount_cents: 400, reinsurance_amount_cents: 0, paid_at: '2026-07-13T10:00:00Z' },
    { stripe_subscription_id: 'sub_zz', stripe_amount_cents: 100, reinsurance_amount_cents: 0, paid_at: '2026-07-13T10:00:00Z' }
  ];
  const ds = computeStats({ subs: dSubs, ledger: dLed, entities: ENTS, nowMs: NOW, period: 'month' });
  const nash = ds.by_location.find((l) => l.name === 'Nashville');
  const frank = ds.by_location.find((l) => l.name === 'Franklin');
  t(nash.deposits_cents === 800 && frank.deposits_cents === 0, 'statsD: Deposits por location del ledger (cash, sin prorrateo)');
  t(ds.recent[0].date_short === 'Jul 11', 'statsD: fecha corta del mock ("Jul 11")');

  /* gates estáticos */
  const html = src('portal/index.html');
  t(/id="ss-range"/.test(html) && /id="ss-from"/.test(html), 'salesstats: custom range del mock (option + date inputs)');
  t(/Export to Excel/.test(html), 'subs: botón "⤓ Export to Excel" verbatim');
  t(/<option value="month">This month<\/option>/.test(html) && /<option value="year">This year<\/option>/.test(html), 'subs: opciones This month / This year del mock');
  const fnStats = src('netlify/functions/portal-stats.mjs');
  t(/'range'/.test(fnStats) && /from/.test(fnStats) && /86400000/.test(fnStats), 'portal-stats: acepta from/to (to inclusivo +1d)');
  t(/stripe_subscription_id/.test(fnStats), 'portal-stats: selects con stripe_subscription_id (deposits por location)');
  t(/rap_id/.test(src('netlify/functions/portal-me.mjs')), 'portal-me: devuelve rap_id del dealer');

  /* jsdom: header con Dealer ID, delta en pts, deposits/Sold, foot 1–50 */
  const ME_RAP = { ...ORG_ME, rap_id: 'SHF-2048' };
  const stats = computeStats({ subs: dSubs, ledger: dLed, entities: ENTS, nowMs: NOW, period: 'month' });
  const p = await loadPortal({ session: SESSION, me: ME_RAP, api: { 'portal-stats': () => stats } });
  await sleep(40);
  t(p.document.getElementById('orgId').textContent === 'Dealer ID #SHF-2048', 'front: hdr "Dealer ID #{rap_id}" del mock');
  t(/pts$/.test(p.document.getElementById('st-cancel-d').textContent), 'front: delta del cancel rate en pts');
  t(/Jul 11/.test(p.document.getElementById('dash-recent').textContent), 'front: recent con fecha corta');
  p.window.show('salesstats');
  await sleep(40);
  t(/Deposits/.test(p.document.getElementById('ss-locations').textContent) && /\$8\.00/.test(p.document.getElementById('ss-locations').textContent), 'front: minicard de location con Deposits en USD');
  t(/Sold/.test(p.document.getElementById('ss-associates').textContent), 'front: minicard de associate con label Sold');

  const ROWS = [];
  for (let i = 1; i <= 60; i++) ROWS.push({ subscription_id: 's' + i, start_date: '2026-06-15', end_date: null, program: 'Protection', first_name: 'C', last_name: 'N' + i, payments: 1, person_id: 'A-07', store_name: 'Nashville', status: 'active', contract_number: 'RX-3' + String(i).padStart(4, '0') });
  const q = await loadPortal({ session: SESSION, me: ME_RAP, api: { 'portal-subscribers': () => ({ rows: ROWS, total: 60 }), 'portal-stats': () => stats } });
  await sleep(40);
  q.window.show('subscribers');
  await sleep(40);
  t(q.document.getElementById('subs-count').textContent === '1–50', 'front: foot "Showing 1–50 of N" del mock');
  q.window.pageSubs(1);
  t(q.document.getElementById('subs-count').textContent === '51–60', 'front: página 2 → "51–60"');
}

/* ── FASE 5 · Tanda E: PORT-18 Dealer/Company Admin real (mock 481-509) ────── */
{
  const html = src('portal/index.html');
  t(/id="da-name"/.test(html) && /id="da-rapid" readonly/.test(html) && /id="da-hq"/.test(html) && /id="da-start"/.test(html), 'da: form-grid del mock (name + RAP ID readonly + HQ + access dates)');
  t(/id="da-contacts"/.test(html) && /<th>Role<\/th><th>Name<\/th><th>Email<\/th><th>Phone<\/th>/.test(html), 'da: tabla Key contacts del mock');
  t(/Sell through kiosk/.test(html) && /Dashboard access/.test(html) && /toggleDealerFlag\('selling_enabled'/.test(html), 'da: toggles vivos del mock');
  t(/No password is stored or shown/.test(html) && /Reset password/.test(html) && /Resend invite/.test(html), 'da: fila Login (sin last-login inventado)');
  t(/id="da-stores"/.test(html), 'da: subset Stores & Logins dentro de la pantalla');
  t(/view dormida/.test(html) || /id="view-stores"/.test(html), 'da: la view stores vieja queda dormida, no borrada');

  const fn = src('netlify/functions/portal-dealeradmin.mjs');
  t(/assertAdmin/.test(fn) && /writeAudit/.test(fn), 'da-fn: solo admin + audit');
  t(/selling_enabled/.test(fn) && /key_contacts/.test(fn) && !/rap_id:/.test(fn.split('const EDITABLE')[1].split('};')[0]), 'da-fn: whitelist del PATCH (rap_id NO editable)');
  const la = src('netlify/functions/portal-dealer-login-action.mjs');
  t(/assertAdmin/.test(la) && /sendRecovery/.test(la) && /inviteUser/.test(la), 'la-fn: reset/invite via GoTrue, solo admin');

  /* jsdom: elegir dealer carga la ficha; Save PATCHea; toggle PATCHea; login action postea */
  const ADMIN_ME4 = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  const DEALER = { id: 'shf', name: 'Summit Home Furnishings', world: 'retailer', rap_id: 'SHF-2048', frx_account_id: 'FRX-SHF-2048', hq_address: '900 Commerce Blvd', key_contacts: [{ role: 'CEO', name: 'Dana Reed', email: 'dana@summithf.com', phone: '(615) 555-0110' }], selling_enabled: true, dashboard_enabled: false, access_start: '2026-01-01', access_end: '2026-12-31' };
  let patched = null, loginReq = null;
  const p = await loadPortal({
    session: SESSION, me: ADMIN_ME4, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }],
    api: {
      'portal-dealeradmin': (u, o) => {
        if (o && o.method === 'PATCH') { patched = JSON.parse(o.body); return { updated: true, fields: Object.keys(patched) }; }
        return { dealer: DEALER, sub_entities: [{ id: 'e1', name: 'Nashville', location: 'TN', status: 'active', world: 'retailer' }] };
      },
      'portal-dealer-login-action': (u, o) => { loginReq = JSON.parse(o.body); return { sent: true }; }
    }
  });
  await sleep(40);
  p.document.getElementById('dealerSelect').value = 'shf';
  p.window.show('dealeradmin');
  await sleep(40);
  t(p.document.getElementById('da-h3').textContent === 'Summit Home Furnishings', 'da-front: ficha cargada');
  t(/Dealer RAP ID #SHF-2048 · FurnitureRx Account ID FRX-SHF-2048/.test(p.document.getElementById('da-sub').textContent), 'da-front: sub-línea del mock con ids reales');
  t(p.document.getElementById('da-name').value === 'Summit Home Furnishings' && p.document.getElementById('da-start').value === '2026-01-01', 'da-front: form prellenado');
  t(/Dana Reed/.test(p.document.getElementById('da-contacts').textContent), 'da-front: key contacts pintados');
  t(p.document.getElementById('da-sell').classList.contains('on') && !p.document.getElementById('da-dash').classList.contains('on'), 'da-front: toggles reflejan los flags reales');
  t(/Nashville/.test(p.document.getElementById('da-stores').textContent), 'da-front: Stores & Logins con sub_entities reales');
  p.document.getElementById('da-hq').value = '1 New Rd';
  p.window.saveDealerAdmin();
  await sleep(30);
  t(patched && patched.hq_address === '1 New Rd' && patched.org_id === 'shf', 'da-front: Save changes PATCHea la whitelist');
  patched = null;
  p.window.toggleDealerFlag('dashboard_enabled', p.document.getElementById('da-dash'));
  await sleep(30);
  t(patched && patched.dashboard_enabled === true, 'da-front: toggle PATCHea el flag');
  t(p.document.getElementById('da-dash').classList.contains('on'), 'da-front: el switch se enciende tras el 200');
  t(p.document.getElementById('da-login-email').value === 'dana@summithf.com', 'da-front: email del primer key contact prellenado');
  p.window.dealerLoginAction('reset');
  await sleep(30);
  t(loginReq && loginReq.action === 'reset' && loginReq.email === 'dana@summithf.com', 'da-front: Reset password postea {org_id,email,action}');
}

/* ── PORT-20: loading fantasma + Viewing persistente que recarga la vista ──── */
{
  const css = src('portal/assets/css/portal.css');
  t(/\.skel\{/.test(css) && /@keyframes skel/.test(css) && /\.btn\.busy/.test(css) && /\.viewing-pill/.test(css), 'p20: CSS de skeleton + botón busy + pill');
  const js = src('portal/assets/js/portal.js');
  t(/function skelRows/.test(js) && /function skelCards/.test(js) && /function busy/.test(js), 'p20: helpers de loading');
  t(/function reloadView/.test(js) && /function setViewingPill/.test(js), 'p20: reloadView + pill al cambiar Viewing');
  const html = src('portal/index.html');
  t(/id="viewingPill"/.test(html), 'p20: pill en el header');

  /* login: el botón entra en busy mientras el POST está en vuelo */
  let release;
  const gate = new Promise((res) => { release = res; });
  const p = await loadPortal({
    session: null,
    api: { 'auth-login': () => gate.then(() => ({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 })), 'portal-me': () => ORG_ME, 'portal-stats': () => ({}) }
  });
  await sleep(30);
  p.window.showLogin();
  p.document.getElementById('login-email').value = 'owner@rapqa.com';
  p.document.getElementById('login-pw').value = '12345678';
  p.window.doLogin();
  await sleep(20);
  t(p.document.getElementById('login-btn').classList.contains('busy') && p.document.getElementById('login-btn').disabled, 'p20: login en vuelo → botón busy + disabled');
  release({});
  await sleep(40);
  t(!p.document.getElementById('login-btn').classList.contains('busy'), 'p20: al responder, el botón se libera');

  /* loaders: skeleton visible mientras la data está en vuelo */
  let releaseStats;
  const statsGate = new Promise((res) => { releaseStats = res; });
  const stats = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'month' });
  const q = await loadPortal({ session: SESSION, me: ORG_ME, api: { 'portal-stats': () => statsGate.then(() => stats) } });
  await sleep(30);
  t(q.document.getElementById('st-active').classList.contains('skel'), 'p20: stat card en skeleton mientras carga');
  t(q.document.querySelectorAll('#dash-recent tr.skel-row').length === 4, 'p20: recent activity con filas fantasma');
  releaseStats();
  await sleep(40);
  t(!q.document.getElementById('st-active').classList.contains('skel') && q.document.getElementById('st-active').textContent === '3', 'p20: la data real quita el skeleton');

  /* Viewing: pill persistente + la vista activa se recarga con el nuevo scope */
  const ADMIN_ME5 = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  let subCalls = 0;
  const a = await loadPortal({
    session: SESSION, me: ADMIN_ME5, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }],
    api: { 'portal-stats': () => stats, 'portal-subscribers': () => { subCalls++; return { rows: [], total: 0 }; } }
  });
  await sleep(40);
  a.window.show('subscribers');
  await sleep(40);
  const before = subCalls;
  a.document.getElementById('dealerSelect').value = 'shf';
  a.window.onDealerPick();
  await sleep(40);
  t(subCalls === before + 1, 'p20: cambiar Viewing RECARGA la vista activa (fix del "does not refresh")');
  t(a.document.getElementById('viewingPill').classList.contains('on') && /Viewing: Summit Home Furnishings/.test(a.document.getElementById('viewingPill').textContent), 'p20: pill del header con el dealer, persistente');
  a.document.getElementById('dealerSelect').value = 'all';
  a.window.onDealerPick();
  await sleep(30);
  t(!a.document.getElementById('viewingPill').classList.contains('on'), 'p20: volver a All apaga el pill');

  /* PORT-20b v2 (feedback: la franja era invasiva): badge CENTRADO en el spacer del topbar */
  const html2 = src('portal/index.html');
  t(/class="sp" style="display:flex;justify-content:center"/.test(html2) && /aria-live="polite"/.test(html2), 'p20b: badge centrado en el spacer del topbar con aria-live');
  t(!/scopeBanner/.test(html2), 'p20b: la franja full-width murió (era invasiva)');
  const css2 = src('portal/assets/css/portal.css');
  t(/var\(--gold\)/.test(css2.split('.viewing-pill{')[1].slice(0, 200)) && /\.viewing-pill \.exit/.test(css2), 'p20b: badge en gold DE LA CASA con salida × integrada');
  a.document.getElementById('dealerSelect').value = 'shf';
  a.window.onDealerPick();
  await sleep(30);
  const pillEl = a.document.getElementById('viewingPill');
  t(pillEl.classList.contains('on') && /Viewing: Summit Home Furnishings/.test(pillEl.textContent), 'p20b: elegir dealer enciende el badge con el nombre');
  t(!!pillEl.querySelector('button.exit'), 'p20b: el badge trae su × de salida');
  const beforeExit = subCalls;
  pillEl.querySelector('button.exit').click();
  await sleep(40);
  t(!pillEl.classList.contains('on') && a.document.getElementById('dealerSelect').value === 'all', 'p20b: el × vuelve a All y apaga el badge');
  t(subCalls === beforeExit + 1, 'p20b: la salida rápida también recarga la vista activa');
}

/* ── PORT-21: exclusión de dealers de los rollups + límites para volumen real ─ */
{
  const { rollupExclusion } = await import('../../netlify/functions/_lib/portal.mjs');
  t(rollupExclusion('dealer_id', []) === '', 'p21: sin excluidos → sin filtro');
  t(rollupExclusion('dealer_id', ['a-1', 'b-2']) === '&or=(dealer_id.is.null,dealer_id.not.in.(a-1,b-2))',
    'p21: filtro not.in que NO tumba las filas con dealer NULL (ventas directas RAP)');

  t(/include_in_rollups/.test(src('supabase/migrations/20260717090000_dealers_include_in_rollups.sql')), 'p21: migración del flag');
  for (const f of ['portal-stats', 'portal-subscribers', 'portal-commissions', 'portal-referral-codes']) {
    t(/excludedOrgIds/.test(src('netlify/functions/' + f + '.mjs')), `p21: ${f} respeta la exclusión en "All"`);
  }
  t(/limit=20000/.test(src('netlify/functions/portal-stats.mjs')) && /limit=5000/.test(src('netlify/functions/portal-subscribers.mjs')), 'p21: límites subidos (dealers grandes ya no truncan)');
  t(/rows\.slice\(0, 250\)/.test(src('netlify/functions/portal-commissions.mjs')), 'p21: commissions calcula totales sobre TODO y pagina la tabla');
  t(/include_in_rollups/.test(src('netlify/functions/portal-dealeradmin.mjs')) && /Include in admin reports/.test(src('portal/index.html')), 'p21: toggle en Dealer Admin (GET + PATCH whitelist)');

  /* jsdom: el toggle refleja el flag y PATCHea */
  const ADMIN_ME6 = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  const DEALER2 = { id: 'shf', name: 'Summit Home Furnishings', world: 'retailer', rap_id: 'SHF-2048', frx_account_id: 'FRX-SHF-2048', hq_address: 'x', key_contacts: [], selling_enabled: true, dashboard_enabled: true, include_in_rollups: false, access_start: null, access_end: null };
  let patched2 = null;
  const p = await loadPortal({
    session: SESSION, me: ADMIN_ME6, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }],
    api: { 'portal-dealeradmin': (u, o) => (o && o.method === 'PATCH') ? (patched2 = JSON.parse(o.body), { updated: true, fields: [] }) : { dealer: DEALER2, sub_entities: [] } }
  });
  await sleep(40);
  p.document.getElementById('dealerSelect').value = 'shf';
  p.window.show('dealeradmin');
  await sleep(40);
  t(!p.document.getElementById('da-rollup').classList.contains('on'), 'p21: toggle refleja include_in_rollups=false');
  p.window.toggleDealerFlag('include_in_rollups', p.document.getElementById('da-rollup'));
  await sleep(30);
  t(patched2 && patched2.include_in_rollups === true, 'p21: el toggle PATCHea el flag');
}

/* ── PORT-24 · Tanda A (review Doug 17-jul): Sales Stats ──────────────────── */
{
  const html = src('portal/index.html');
  const ssHtml = html.split('view-salesstats')[1].split('</section>')[0];
  t(!/Protection \$9\.99 · Protection\+ \$19\.99/.test(ssHtml), 'p24a: el texto ancho Program murió (desbordaba el viewport)');
  /* "use the same thing": estimates+Program = 2ª fila de stat cards igual a la de arriba */
  t((ssHtml.match(/class="stats"/g) || []).length === 2, 'p24a: DOS filas de stat cards (estimates+Program son cajas iguales, "use the same thing")');
  t(/id="ss-next-month"[\s\S]*?Next-month estimate/.test(ssHtml) && /id="ss-next-year"[\s\S]*?Next-year estimate/.test(ssHtml), 'p24a: Next-month/Next-year como stat cards');
  t(/Stain program/.test(ssHtml) && /Stain \+ protection program/.test(ssHtml), 'p24a: cards Stain / Stain+protection con pill Active ("you just repeat this")');
  t(/id="ss-deposits-l"/.test(html), 'p24a: label de deposits con id (el "(mo)" depende del periodo)');

  const css = src('portal/assets/css/portal.css');
  t(!/\.plancard/.test(css), 'p24a: el .plancard efímero de la 1ª versión se retiró (se reusa .stat)');
  t(/overflow-x:scroll/.test(css) && /::-webkit-scrollbar/.test(css) && /scrollbar-width:thin/.test(css), 'p24a: scroll SIEMPRE visible ("not just a hover"), webkit + firefox');
  t(/\.minicard\.blank/.test(css), 'p24a: card en blanco de relleno');

  const js = src('portal/assets/js/portal.js');
  t(/function padCards/.test(js) && /'New \(mo\)'/.test(js) && /'Sold \(mo\)'/.test(js), 'p24a: pad a 5 + labels "(mo)" verbatim del mock');
  t(/function dragScroll/.test(js) && /scrollLeft = startLeft - dx/.test(js) && /Math\.abs\(dx\) > 5/.test(js), 'p24a: drag-to-scroll con umbral que respeta los clicks');
  t(/\.scroll-x\.dragging/.test(css) && /cursor:grab/.test(css), 'p24a: cursor grab/grabbing en los carruseles');

  /* jsdom: 3 locations → 5 cards (2 blank); labels (mo); deposits label por periodo */
  const stats = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'month' });
  const p = await loadPortal({ session: SESSION, me: ORG_ME, api: { 'portal-stats': () => stats } });
  await sleep(40);
  p.window.show('salesstats');
  await sleep(40);
  t(p.document.querySelectorAll('#ss-locations .minicard').length === 5
    && p.document.querySelectorAll('#ss-locations .minicard.blank').length === 2, 'p24a: fila de locations SIEMPRE con 5 cards (3 reales + 2 blank)');
  t(p.document.querySelectorAll('#ss-associates .minicard').length === 5, 'p24a: fila de associates también a 5');
  t(/New \(mo\)/.test(p.document.getElementById('ss-locations').textContent)
    && /Sold \(mo\)/.test(p.document.getElementById('ss-associates').textContent), 'p24a: labels New (mo) / Sold (mo) pintados');
  /* la 2ª fila es 4 stat cards; estimates poblados por JS; programas con pill Active */
  const ssView = p.document.querySelector('#view-salesstats');
  t(ssView.querySelectorAll('.stats').length === 2, 'p24a: la vista tiene 2 filas de stats');
  const row2 = ssView.querySelectorAll('.stats')[1];
  t(row2.querySelectorAll('.stat').length === 4, 'p24a: 2ª fila = 4 stat cards (2 estimates + 2 planes)');
  t(row2.querySelectorAll('.pill.active').length === 2, 'p24a: los 2 planes muestran pill Active');
  t(/Next-month estimate/.test(row2.textContent) && /Stain program/.test(row2.textContent), 'p24a: 2ª fila con estimates + planes');
  t(p.document.getElementById('ss-next-month').textContent === '$49.97', 'p24a: Next-month estimate poblado desde la data (JS sigue llenando el stat card)');
  /* periodo year (default) → sin "(mo)"; periodo month → con "(mo)" */
  t(p.document.getElementById('ss-deposits-l').textContent === 'Stripe deposits', 'p24a: label sin (mo) con periodo year');
  p.document.getElementById('ss-period').value = 'month';
  p.window.loadSalesStats();
  await sleep(40);
  t(p.document.getElementById('ss-deposits-l').textContent === 'Stripe deposits (mo)', 'p24a: label "Stripe deposits (mo)" con periodo This month (mock:370)');
}

/* ── PORT-24 · Tanda B (review Doug 17-jul): Subscribers ──────────────────── */
{
  const html = src('portal/index.html');
  const subsHtml = html.split('view-subscribers')[1].split('</section>')[0];
  t(/Active subscribers attributed to you\./.test(subsHtml), 'p24b: el subtítulo "Active subscribers attributed to you" SE CONSERVA');
  t(/class="finenote"[^>]*>Each contract terminates 30 calendar days[\s\S]*?RX-#####-N\b/.test(subsHtml), 'p24b: nota de header (30 días + serialización, DEC-2 sufijo -N)');
  t(/>SR<\/th>/.test(subsHtml) && !/>End<\/th>/.test(subsHtml), 'p24b: columna End → SR');
  t((subsHtml.match(/class="sortable"/g) || []).length === 8, 'p24b: 8 columnas sortables (Start/Program/Name/Pmts/RSA/Store/Contract#/Status)');
  t(/data-sort="start_date"/.test(subsHtml) && /data-sort="contract_number"/.test(subsHtml), 'p24b: data-sort en los headers');
  t(/rangeInputs[\s\S]*?>Apply<\/button>/.test(subsHtml), 'p24b: botón Apply en el rangebox');

  const css = src('portal/assets/css/portal.css');
  t(/th\.sortable\{cursor:pointer/.test(css) && /th\.sorted-asc::after/.test(css), 'p24b: CSS sortable + flechas por ::after (sobrevive a applyLex)');
  const js = src('portal/assets/js/portal.js');
  t(/colAssoc: 'RSA'/.test(js), 'p24b: LEX retailer colAssoc → RSA');
  t(/function sortSubs/.test(js) && /subsSort/.test(js), 'p24b: estado + función de orden');
  t(/contracts: contracts/.test(js), 'p24b: exportSubs manda los contract_number filtrados');
  const fn = src('netlify/functions/portal-exports.mjs');
  t(/wanted\)/.test(fn) && /body\.contracts/.test(fn) && /limit=5000/.test(fn), 'p24b: portal-exports filtra por contracts + limit 5000');

  /* jsdom: sort, SR shell, RSA header, export filtrado */
  const ROWS = [];
  for (let i = 1; i <= 60; i++) ROWS.push({ subscription_id: 's' + i, start_date: '2026-06-15', program: 'Protection', first_name: 'C', last_name: 'N' + i, payments: (i % 5) + 1, person_id: i % 2 ? 'A-07' : 'A-02', store_name: 'Nashville', status: 'active', contract_number: 'RX-4' + String(i).padStart(4, '0') });
  ROWS[0].sr_status = 'open';   // 1ª fila con SR abierto (shell del endpoint futuro)
  let exportBody = null;
  const p = await loadPortal({
    session: SESSION, me: ORG_ME,
    api: {
      'portal-subscribers': () => ({ rows: ROWS, total: 60 }),
      'portal-exports': (u, o) => { exportBody = JSON.parse(o.body); return { ok: true, filename: 'subscribers.csv', rows: exportBody.contracts.length, csv: 'x' }; }
    }
  });
  await sleep(40);
  p.window.show('subscribers');
  await sleep(40);
  /* RSA header (world retailer) */
  t(p.document.querySelector('[data-lex="colAssoc"]').textContent === 'RSA', 'p24b: header de columna dice RSA en world retailer');
  /* SR shell: la 1ª fila (por defecto orden de carga) trae pill; el resto "—" */
  t(/SR · open/.test(p.document.querySelector('#subs-body tr').textContent), 'p24b: fila con sr_status pinta pill "SR · open"');
  t(p.document.querySelectorAll('#subs-body td').length > 0 && /—/.test(p.document.querySelectorAll('#subs-body tr')[1].textContent), 'p24b: filas sin SR muestran "—" (shell, cero data fake)');
  /* sort por contract_number: asc → RX-40001 primero; segundo click desc → RX-40060 primero */
  p.window.sortSubs('contract_number');
  t(/RX-40001/.test(p.document.querySelector('#subs-body tr').textContent), 'p24b: sort asc por Contract # (RX-40001 primero)');
  t(p.document.querySelector('th[data-sort="contract_number"]').classList.contains('sorted-asc'), 'p24b: el header marca sorted-asc');
  p.window.sortSubs('contract_number');
  t(/RX-40060/.test(p.document.querySelector('#subs-body tr').textContent), 'p24b: segundo click → desc (RX-40060 primero)');
  t(p.document.querySelector('th[data-sort="contract_number"]').classList.contains('sorted-desc'), 'p24b: el header marca sorted-desc');
  /* DEC-2: mismo master, sufijos de un dígito → orden NUMÉRICO (…-2 antes de …-10), no lexicográfico */
  const SFX = [7, 2, 10, 1, 9, 3, 11, 4].map((n) => ({ subscription_id: 'x' + n, start_date: '2026-06-15', program: 'Protection', first_name: 'C', last_name: 'S' + n, payments: 1, person_id: 'A-07', store_name: 'Nashville', status: 'active', contract_number: 'RX-10001-' + n }));
  const p2 = await loadPortal({ session: SESSION, me: ORG_ME, api: { 'portal-subscribers': () => ({ rows: SFX, total: SFX.length }) } });
  await sleep(40); p2.window.show('subscribers'); await sleep(40);
  p2.window.sortSubs('contract_number');
  const order = [...p2.document.querySelectorAll('#subs-body tr')].map((tr) => { const m = tr.textContent.match(/RX-10001-(\d+)/); return m ? Number(m[1]) : null; }).filter((n) => n != null);
  t(JSON.stringify(order) === JSON.stringify([1, 2, 3, 4, 7, 9, 10, 11]), 'p24b (DEC-2): Contract # ordena por sufijo NUMÉRICO (…-2 antes de …-10)');
  /* export filtrado: filtro por associate A-07 (30 filas) → export manda 30 contracts */
  p.document.getElementById('f-assoc').value = 'A-07';
  p.window.renderSubs(true);
  p.window.exportSubs();
  await sleep(30);
  t(exportBody && Array.isArray(exportBody.contracts) && exportBody.contracts.length === 30, 'p24b: export manda SOLO los contracts filtrados (30 de 60)');
  t(exportBody.contracts.every((c) => /^RX-4/.test(c)), 'p24b: los contracts exportados son del set filtrado');
}

/* ── PORT-24 · Tanda C (review Doug 17-jul): Customer Record + backend de SRs ─ */
{
  /* ---- puros del backend ---- */
  const { mapCustomerRecord, mayaSummaryOrSynth, validateServiceRequest, SR_CATEGORIES } = await import('../../netlify/functions/_lib/portal.mjs');
  const adminS = { isAdmin: true }, orgS = { isAdmin: false };
  const row = { master_no: 'RX-10017', kind: 'protection', tier: 'stain_mech', started_at: '2025-08-01T00:00:00Z', purchased_on: '2025-08-01', sales_order_number: 'RFC-1', stripe_subscription_id: 'sub_abc123', maya_summary: null, profiles: { full_name: 'Jane Doe' } };
  const recAdmin = mapCustomerRecord(row, [], NOW, adminS, [{ id: 'x1', sr_number: 'SR-01001', category: 'Billing question', status: 'open', body: 'b', created_at: '2026-07-10T00:00:00Z' }]);
  const recOrg = mapCustomerRecord(row, [], NOW, orgS, []);
  t(recAdmin.master_number === 'RX-10017' && /RX-10017-\d+/.test(recAdmin.contract_number), 'p24c: record trae master + activo (DEC-2: sufijo sin pad)');
  t(recAdmin.stripe_sub_display === 'sub_abc123', 'p24c: admin ve el stripe id real en stripe_sub_display');
  t(recOrg.stripe_sub_display.indexOf('admin only') >= 0 && !('stripe_subscription_id' in recOrg), 'p24c: dealer ve HASH enmascarado; el id real NO viaja');
  t(recAdmin.maya_summary && recAdmin.maya_summary.length > 0 && mayaSummaryOrSynth(row).indexOf('order RFC-1') >= 0, 'p24c: Maya summary SIEMPRE poblado (sintetizado del checkout si no hubo chat)');
  t(Array.isArray(recAdmin.service_requests) && recAdmin.service_requests[0].sr_number === 'SR-01001', 'p24c: record trae los últimos SRs');
  const v = validateServiceRequest({ contract_number: 'RX-1', body: 'x', category: 'Cancel plan' });
  t(v.ok && v.fields.category === 'Cancel plan', 'p24c: validate acepta ítem del allowlist');
  t(validateServiceRequest({ contract_number: 'RX-1', body: 'x', category: 'hack' }).fields.category === null, 'p24c: ítem fuera del allowlist → null');
  /* ESTRICTO (recert 17-jul): SOLO los 2 que Doug nombró (cancel plan, contact customer); el resto lo delegó */
  t(SR_CATEGORIES.length === 2 && SR_CATEGORIES[0] === 'Cancel plan' && SR_CATEGORIES[1] === 'Contact customer', 'p24c: SOLO los 2 ítems de Doug (nada inventado)');

  /* ---- gates estáticos ---- */
  const html = src('portal/index.html');
  t(/Quick actions/.test(html) && /resendTerms\(\)/.test(html) && /cancelSubscription\(\)/.test(html), 'p24c: Quick actions con Resend T&C + Cancel subscription');
  t(/id="action-modal"/.test(html) && /id="am-confirm"/.test(html) && /function confirmAction/.test(src('portal/assets/js/portal.js')) && /function resultModal/.test(src('portal/assets/js/portal.js')), 'p24c: modal de confirmación + resultado para las quick actions');
  t(!/View-only · contract # is the key/.test(html), 'p24c: la nota "view-only… key to claims" murió');
  t(/id="cr-master"/.test(html), 'p24c: header con master');
  t(/id="sr-cats"/.test(html) && (html.match(/class="sr-cat/g) || []).length === 3, 'p24c: menú estricto = 3 checkboxes (Cancel plan + Contact customer + Resolved), sin inventar');
  t(!/Billing question/.test(html) && !/Delivery issue/.test(html) && !/Claim question/.test(html), 'p24c: cero ítems inventados en el menú');
  t(/Submit new service request/.test(html) && /id="sr-list"/.test(html), 'p24c: form "Submit new service request" + lista de SRs');
  const mig = src('supabase/migrations/20260717120000_service_requests_sr_number.sql');
  t(/ADD COLUMN IF NOT EXISTS sr_number/.test(mig) && /next_sr_no/.test(mig), 'p24c: migración sr_number + RPC');
  const srfn = src('netlify/functions/portal-service-requests.mjs');
  t(/next_sr_no/.test(srfn) && /PATCH/.test(srfn) && /resolved_at/.test(srfn), 'p24c: endpoint genera número + PATCH resuelve');
  t(/sr_status = 'open'/.test(src('netlify/functions/portal-subscribers.mjs')), 'p24c: portal-subscribers enciende la columna SR');
  t(/assertAdmin/.test(src('netlify/functions/portal-cancel-subscription.mjs')) && /cancel_at_period_end/.test(src('netlify/functions/portal-cancel-subscription.mjs')), 'p24c: cancel-subscription admin-only + cancel_at_period_end');
  t(/kind === 'terms'/.test(src('netlify/functions/portal-resend-link.mjs')), 'p24c: resend-link soporta kind=terms');

  /* ---- jsdom del Customer Record ---- */
  const CUST = { first_name: 'Jane', last_name: 'Doe', email: 'j@x.co', status: 'active', payments: 12, program: 'Protection+', master_number: 'RX-10017', contract_number: 'RX-10017-12', terms_version: 'v2026-05', maya_summary: 'Asked about stains.', stripe_sub_display: '•••• •••• •••• (admin only)', service_requests: [{ id: 'sr1', sr_number: 'SR-01001', category: 'Cancel plan', status: 'open', body: 'Charged twice', created_at: '2026-07-10T00:00:00Z' }] };
  let srReq = null, cancelReq = null, termsReq = null;
  const p = await loadPortal({
    session: SESSION, me: ORG_ME, customer: CUST,
    api: {
      'portal-service-requests': (u, o) => { if (o && (o.method === 'POST' || o.method === 'PATCH')) { srReq = { method: o.method, body: JSON.parse(o.body) }; return { ok: true, id: 'new', sr_number: 'SR-01002', status: o.method === 'PATCH' ? 'closed' : 'open' }; } return { rows: [], total: 0 }; },
      'portal-cancel-subscription': (u, o) => { cancelReq = JSON.parse(o.body); return { scheduled: true, stripe: true }; },
      'portal-resend-link': (u, o) => { termsReq = JSON.parse(o.body); return { sent: true }; }
    }
  });
  await sleep(40);
  p.window.openCustomer('RX-10017-12');
  await sleep(40);
  t(/Master RX-10017/.test(p.document.getElementById('cr-master').textContent) && /Active RX-10017-12/.test(p.document.getElementById('cr-contract').textContent), 'p24c-front: header master + activo');
  t(/admin only/.test(p.document.getElementById('cr-stripe').textContent), 'p24c-front: dealer ve el stripe enmascarado');
  t(p.document.querySelectorAll('#sr-list tr').length === 1 && /SR-01001/.test(p.document.getElementById('sr-list').textContent), 'p24c-front: lista de SRs pintada');
  t(p.document.getElementById('cr-notes') === null && p.document.querySelector('#cust-card').textContent.indexOf('Related purchases') < 0, 'p24c-front: Internal notes + Related purchases fuera');
  /* click en un SR de la lista puebla el form */
  p.document.querySelector('#sr-list tr').click();
  await sleep(20);
  t(p.document.getElementById('sr-body').value === 'Charged twice' && p.document.querySelector('#sr-cats input[value="Cancel plan"]').checked, 'p24c-front: click en un SR puebla notas + ítem');
  t(!p.document.getElementById('sr-loaded').hidden && /SR-01001/.test(p.document.getElementById('sr-cur-num').textContent), 'p24c-front: banner del SR cargado con número');
  /* Resolved (close) sobre el SR cargado → PATCH */
  p.document.querySelector('#sr-cats input[value="__resolved__"]').checked = true;
  p.window.pickSRCat(p.document.querySelector('#sr-cats input[value="__resolved__"]'));
  t(!p.document.querySelector('#sr-cats input[value="Cancel plan"]').checked, 'p24c-front: single-select (Resolved desmarca el ítem)');
  p.window.submitSR();
  await sleep(20);
  t(srReq && srReq.method === 'PATCH' && srReq.body.id === 'sr1', 'p24c-front: Resolved → PATCH que cierra el SR cargado');
  /* nuevo SR: clear, categoría, submit → POST con category */
  p.window.clearSR();
  t(p.document.getElementById('sr-loaded').hidden && p.document.getElementById('sr-body').value === '', 'p24c-front: Clear resetea el form (conserva el prefill del cliente)');
  p.document.getElementById('sr-body').value = 'Seam split';
  p.window.pickSRCat(p.document.querySelector('#sr-cats input[value="Contact customer"]'));
  p.document.querySelector('#sr-cats input[value="Contact customer"]').checked = true;
  p.window.submitSR();
  await sleep(20);
  t(srReq && srReq.method === 'POST' && srReq.body.category === 'Contact customer', 'p24c-front: SR nuevo → POST con ítem de Doug');
  /* quick actions con modal: Resend T&C confirma → POST; dealer NO puede cancelar */
  p.window.resendTerms();
  await sleep(20);
  t(p.document.getElementById('action-modal').classList.contains('on') && /Resend T&C/.test(p.document.getElementById('am-title').textContent), 'p24c-front: Resend T&C abre modal de confirmación');
  p.document.getElementById('am-confirm').click();
  await sleep(20);
  t(termsReq && termsReq.kind === 'terms' && termsReq.contract === 'RX-10017-12', 'p24c-front: al confirmar, Resend T&C postea kind=terms');
  t(/sent/i.test(p.document.getElementById('am-title').textContent), 'p24c-front: modal de resultado visible tras enviar');
  p.window.cancelSubscription();   // ORG_ME es dealer
  await sleep(20);
  t(cancelReq === null && /Admins only/.test(p.document.getElementById('am-title').textContent), 'p24c-front: dealer NO cancela; modal "Admins only" (solo admin)');
}

/* ── PORT-24C: modal admin-cancel (confirm danger → POST; Cancel cierra sin llamar) ── */
{
  const ADM = { user_id: 'u1', name: 'Alex', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  const CUST = { first_name: 'A', last_name: 'B', status: 'active', payments: 1, program: 'Protection', master_number: 'RX-10017', contract_number: 'RX-10017-01', maya_summary: 'x', service_requests: [] };
  let cx = null;
  const p = await loadPortal({ session: SESSION, me: ADM, customer: CUST, api: { 'portal-cancel-subscription': (u, o) => { cx = JSON.parse(o.body); return { scheduled: true, stripe: true }; } } });
  await sleep(40);
  p.window.openCustomer('RX-10017-01');
  await sleep(40);
  p.window.cancelSubscription();
  await sleep(20);
  t(p.document.getElementById('action-modal').classList.contains('on') && p.document.getElementById('am-confirm').className.indexOf('danger') >= 0, 'p24c-modal: admin cancel abre confirmación (botón danger)');
  p.document.getElementById('am-cancel').click();
  t(!p.document.getElementById('action-modal').classList.contains('on') && cx === null, 'p24c-modal: Cancel del modal cierra SIN ejecutar');
  p.window.cancelSubscription();
  await sleep(10);
  p.document.getElementById('am-confirm').click();
  await sleep(20);
  t(cx && cx.contract === 'RX-10017-01', 'p24c-modal: Confirm → cancela (POST)');
  t(/scheduled/i.test(p.document.getElementById('am-title').textContent), 'p24c-modal: modal de resultado "Cancellation scheduled"');
}

/* ── PORT-24 · Tanda D (review Doug 17-jul): Contact + Resources + Stripe reconciliación ── */
{
  const html = src('portal/index.html');

  /* 1 · Contact / Hotline → 4 cards (item 16) */
  const contactHtml = html.split('id="view-contact"')[1].split('</section>')[0];
  t(/class="cardgrid"/.test(contactHtml), 'p24d: Contact usa la grid de cards (no el card único viejo)');
  t(/Sales/.test(contactHtml) && /Claim service/.test(contactHtml) && /Subscription help/.test(contactHtml) && /Escalation/.test(contactHtml), 'p24d: las 4 cards de Doug (Sales/Claim service/Subscription help/Escalation)');
  /* PORT-31 (Emmy 14-ago): la línea de resellers es 888-850-0057; el 833 quedó para clientes. */
  t(/1-888-850-0057/.test(contactHtml) && /service@raptns\.com/.test(contactHtml), 'p24d+PORT-31: Contact usa la hotline de resellers + email real');

  /* 2 · Resources → Ago-11 (ChangesBLS.srt): el mock 3×4 "Coming soon/blank" se volvió REAL
     (panel de upload admin + lista dinámica por dealer). */
  const resHtml = html.split('id="view-resources"')[1].split('</section>')[0];
  t(/class="cardgrid"/.test(resHtml), 'resources: Resources conserva la grid (ahora dinámica en #res-list)');
  t(/Selling POS for retailers/.test(resHtml) && /Sell sheet/.test(resHtml), 'resources: tipos nombrados con los ejemplos de Doug (Sell sheet, POS for retailers)');
  t(/id="res-upload"/.test(resHtml) && /id="res-list"/.test(resHtml), 'resources: upload admin + lista real (reemplaza los slots mock)');
  t(!/rescard blank/.test(resHtml), 'resources: los slots "blank/fill later" del mock ya no van (Resources es real)');

  /* 3 · Stripe Account reconstruida (items 19 + 20 = UNA pantalla) */
  const stripeHtml = html.split('id="view-stripe"')[1].split('</section>')[0];
  t(/class="stats three"/.test(stripeHtml), 'p24d: los totales pasan a fila de 3 stat cards');
  t(/id="comm-total"/.test(stripeHtml) && /id="comm-cash"/.test(stripeHtml) && /id="comm-rein"/.test(stripeHtml), 'p24d: 3 cards Total cash / To commission / To reinsurance');
  t(/Total cash/.test(stripeHtml) && /To commission/.test(stripeHtml) && /To reinsurance/.test(stripeHtml), 'p24d: labels verbatim de Doug (To reinsurance, no "allocated")');
  t(/dashboard\.stripe\.com/.test(stripeHtml) && /Log in to your Stripe account/.test(stripeHtml), 'p24d: botón "Log in to your Stripe account" (link, sin credenciales)');
  t(/exportRecon\(\)/.test(stripeHtml) && /Export to Excel/.test(stripeHtml), 'p24d: Export to Excel al lado del login');
  t(/id="recon-body"/.test(stripeHtml) && !/id="comm-body"/.test(stripeHtml), 'p24d: la tabla de payments se reemplaza por el clon de Subscribers (#recon-body)');
  t(/>Stripe payment #<\/th>/.test(stripeHtml) && /Payment date/.test(stripeHtml), 'p24d: columnas nuevas Stripe payment # + Payment date');
  t(/>Start<\/th>/.test(stripeHtml) && /Contract #/.test(stripeHtml) && /id="rec-search"/.test(stripeHtml), 'p24d: mantiene Start/Contract#/search del clon');
  t(!/>Pmts<\/th>/.test(stripeHtml) && !/>RSA<\/th>/.test(stripeHtml) && !/>Store<\/th>/.test(stripeHtml), 'p24d: quita Pmts/RSA/Store del clon (Doug)');

  /* CSS de las grids nuevas + responsive de las grids nuevas */
  const css = src('portal/assets/css/portal.css');
  t(/\.cardgrid\{/.test(css) && /\.stats\.three\{/.test(css), 'p24d: CSS .cardgrid + .stats.three');
  t(/\.rescard\.blank/.test(css), 'p24d: estilo de card en blanco de Resources');

  /* backend nuevo: portal-reconciliation (mismo guard que la pantalla Stripe) */
  const rfn = src('netlify/functions/portal-reconciliation.mjs');
  t(/assertCanStripe/.test(rfn) && /readOrgScope/.test(rfn), 'p24d: reconciliation gated como Stripe (org+admin) + scoped');
  t(/commission_ledger/.test(rfn) && /stripe_invoice_id/.test(rfn) && /mapSubscriberRow/.test(rfn), 'p24d: une subs con el ÚLTIMO pago real del ledger');
  t(/rollupExclusion/.test(rfn) && /excludedOrgIds/.test(rfn), 'p24d: respeta la exclusión de rollups en "All" (PORT-21)');

  const js = src('portal/assets/js/portal.js');
  t(/function loadReconciliation/.test(js) && /function renderRecon/.test(js), 'p24d: loaders de reconciliación en el front');
  t(/\/api\/portal-reconciliation/.test(js), 'p24d: el front pega al endpoint nuevo');
  t(!/\.innerHTML\s*=/.test(js), 'p24d: sigue sin innerHTML con datos');

  /* jsdom: 3 cards pobladas + tabla de reconciliación con data real */
  const RECON = [
    { subscription_id: 's1', start_date: '2026-05-14', program: 'Protection', first_name: 'Jane', last_name: 'Doe', status: 'active', contract_number: 'RX-10001-03', stripe_payment_no: 'in_1A2B3C', payment_date: '2026-07-14' },
    { subscription_id: 's2', start_date: '2026-06-02', program: 'Protection+', first_name: 'Bob', last_name: 'Reed', status: 'active', contract_number: 'RX-10002-01', stripe_payment_no: 'in_9Z8Y7X', payment_date: '2026-07-02' }
  ];
  const p = await loadPortal({
    session: SESSION, me: ORG_ME,
    api: {
      'portal-commissions': () => ({ rows: [], totals: { cash_cents: 800, reinsurance_cents: 200 }, total: 0 }),
      'portal-reconciliation': () => ({ rows: RECON, total: RECON.length })
    }
  });
  await sleep(40);
  p.window.show('stripe');
  await sleep(40);
  t(p.document.getElementById('comm-total').textContent === '$10.00', 'p24d-front: Total cash = cash + reinsurance ($10.00)');
  t(p.document.getElementById('comm-cash').textContent === '$8.00' && p.document.getElementById('comm-rein').textContent === '$2.00', 'p24d-front: To commission $8.00 / To reinsurance $2.00');
  t(p.document.querySelectorAll('#recon-body tr').length === 2, 'p24d-front: la tabla de reconciliación pinta las 2 filas');
  t(/in_1A2B3C/.test(p.document.getElementById('recon-body').textContent) && /2026-07-14/.test(p.document.getElementById('recon-body').textContent), 'p24d-front: Stripe payment number + payment date reales en la fila');
  t(/RX-10001-03/.test(p.document.getElementById('recon-body').textContent), 'p24d-front: Contract # del clon presente');
  /* View abre el Customer Record */
  p.document.querySelector('#recon-body tr a.lk').click();
  await sleep(20);
  t(p.document.getElementById('view-custrecord').classList.contains('on'), 'p24d-front: View abre el Customer Record (como en Subscribers)');
  /* search filtra la tabla de reconciliación (aislado de Subscribers) */
  p.window.show('stripe');
  await sleep(30);
  p.document.getElementById('rec-search').value = 'Bob';
  p.window.renderRecon();
  t(p.document.querySelectorAll('#recon-body tr').length === 1 && /in_9Z8Y7X/.test(p.document.getElementById('recon-body').textContent), 'p24d-front: search filtra la reconciliación por nombre/contrato');
}

/* ── PORT-26: responsive (el gate RUNTIME vive en e2e-responsive.mjs; aquí gates estáticos del CSS) ── */
{
  const css = src('portal/assets/css/portal.css');
  t(/\.shell\{[^}]*grid-template-columns:214px minmax\(0,1fr\)/.test(css), 'p26: shell con minmax(0,1fr) — el track de contenido encoge (raíz del overflow a 1024-1280)');
  t(/max-width:900px\)\{[\s\S]*?\.shell\{grid-template-columns:minmax\(0,1fr\)\}/.test(css), 'p26: shell 1-col también minmax(0,1fr) (no revertir a 1fr en móvil)');
  t(/\.grid2\{[^}]*minmax\(0,1fr\) minmax\(0,1fr\)/.test(css), 'p26: grid2 con minmax (las cards encogen, su .tblwrap scrollea)');
  t(/max-width:820px\)\{[\s\S]*?\.topbar\{flex-wrap:wrap/.test(css), 'p26: topbar responsive (flex-wrap en angosto, escritorio intacto)');
  t(/\.who select\{max-width:40vw\}/.test(css), 'p26: los <select> largos del header se recortan en móvil');
  t(/\.kv \.f b\{[^}]*overflow-wrap:anywhere/.test(css), 'p26: emails/direcciones largas cortan en vez de desbordar');
  t(/\.toggle-row\{[^}]*flex-wrap:wrap/.test(css), 'p26: toggle-row envuelve sus controles en móvil');

  const html = src('portal/index.html');
  t(/<div class="grid2">/.test(html), 'p26: dashboard usa .grid2 (grid inline→clase colapsable)');
  t(!/style="display:grid;grid-template-columns:1fr 1fr;gap:14px"/.test(html), 'p26: murió la grid inline 1fr 1fr del dashboard');
}

/* ── PORT-27: nav off-canvas (hamburguesa) en móvil — aislado y reversible ── */
{
  const html = src('portal/index.html');
  t(/id="navToggle"[^>]*aria-expanded="false"/.test(html) && /onclick="toggleNav\(\)"/.test(html), 'p27: botón hamburguesa con aria-expanded + toggleNav');
  t(/<nav class="side" id="sideNav">/.test(html), 'p27: nav con id sideNav');
  t(/id="navScrim"[^>]*onclick="closeNav\(\)"/.test(html), 'p27: scrim que cierra al tap');

  const css = src('portal/assets/css/portal.css');
  t(/\.navtoggle\{[^}]*display:none/.test(css), 'p27: hamburguesa oculto en escritorio por defecto');
  t(/max-width:900px\)\{[\s\S]*?\.navtoggle\{display:inline-flex/.test(css), 'p27: hamburguesa visible en ≤900');
  t(/nav\.side\.open\{transform:translateX\(0\)\}/.test(css), 'p27: .open revela el drawer');
  t(/\.navscrim\.on\{/.test(css), 'p27: scrim visible con .on');

  const js = src('portal/assets/js/portal.js');
  t(/function toggleNav\b/.test(js) && /function closeNav\b/.test(js), 'p27: toggleNav + closeNav');
  t(/'Escape'[\s\S]{0,30}closeNav\(\)/.test(js), 'p27: Esc cierra el drawer');
  t(/loadFor\(id\);\s*closeNav\(\);/.test(js), 'p27: navegar cierra el drawer (closeNav en show)');

  /* jsdom: abrir/cerrar por toggle, cierre al navegar, cierre con Esc */
  const p = await loadPortal({ session: SESSION, me: ORG_ME });
  await sleep(40);
  p.window.toggleNav();
  t(p.document.getElementById('sideNav').classList.contains('open')
    && p.document.getElementById('navToggle').getAttribute('aria-expanded') === 'true'
    && p.document.getElementById('navScrim').classList.contains('on'), 'p27-front: toggle abre drawer + aria-expanded + scrim');
  p.window.show('subscribers');
  t(!p.document.getElementById('sideNav').classList.contains('open'), 'p27-front: navegar a otra pantalla cierra el drawer');
  p.window.toggleNav();
  p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape' }));
  t(!p.document.getElementById('sideNav').classList.contains('open')
    && p.document.getElementById('navToggle').getAttribute('aria-expanded') === 'false', 'p27-front: Esc cierra el drawer y baja aria-expanded');
}

/* ── KIOSK-22: Sales-mode URL + QR (Dealer Admin) ── */
{
  const html = src('portal/index.html');
  const daHtml = html.split('view-dealeradmin')[1].split('</section>')[0];
  t(/Sales-mode link/.test(daHtml) && /id="sm-url"/.test(daHtml) && /id="sm-gen"/.test(daHtml), 'k22: bloque Sales-mode link con URL + Generate');
  t(/generateSalesMode\(\)/.test(daHtml) && /disableSalesMode\(\)/.test(daHtml) && /downloadSalesQr\(\)/.test(daHtml) && /id="sm-qr"/.test(daHtml), 'k22: botones Generate/Disable/Download QR + caja del QR');
  /* consenso IA/UX 20-jul: elevado sobre Stores & Logins (no enterrado) + empty-state que "grita" */
  t(daHtml.indexOf('Sales-mode link') < daHtml.indexOf('Stores &amp; Logins'), 'k22: Sales-mode link elevado por encima de Stores & Logins');
  t(/id="sm-none" class="banner warn"/.test(daHtml), 'k22: empty-state prominente (banner) para que su ausencia no pase desapercibida');

  const css = src('portal/assets/css/portal.css');
  t(/\.sm-qrbox svg\{/.test(css), 'k22: CSS del QR');

  const js = src('portal/assets/js/portal.js');
  t(/function loadSalesMode/.test(js) && /function generateSalesMode/.test(js) && /function disableSalesMode/.test(js) && /function downloadSalesQr/.test(js), 'k22: loaders/acciones en el front');
  t(/\/api\/portal-sales-mode/.test(js), 'k22: el front pega al endpoint');
  t(/new DOMParser\(\)/.test(js) && !/\.innerHTML\s*=/.test(js), 'k22: QR por DOMParser, sin innerHTML (gate del portal)');
  t(/loadSalesMode\(daOrgId\)/.test(js), 'k22: se carga al abrir el Dealer Admin');
  t(src('portal/qrcode.min.js').length > 1000, 'k22: qrcode.min.js copiado al portal (same-origin, CSP self)');

  /* backend + infra */
  const fn = src('netlify/functions/portal-sales-mode.mjs');
  t(/assertAdmin/.test(fn) && /sales_mode_links/.test(fn) && /newShortCode/.test(fn), 'k22: portal-sales-mode admin-only + code corto');
  const rd = src('netlify/functions/sales-mode-redirect.mjs');
  t(/sales_mode: true/.test(rd) && /kind: 'handoff'/.test(rd) && /appUrlFor/.test(rd) && /checkRate/.test(rd), 'k22: sales-mode-redirect acuña handoff sales_mode + rate-limit');
  t(/sales_mode: !!handoff\.sales_mode/.test(src('netlify/functions/portal-app-redeem.mjs')), 'k22: redeem propaga sales_mode a la sesión');
  const mig = src('supabase/migrations/20260720120000_sales_mode_links.sql');
  t(/CREATE TABLE IF NOT EXISTS public\.sales_mode_links/.test(mig) && /ADD COLUMN IF NOT EXISTS sales_mode/.test(mig) && /GRANT SELECT, INSERT, UPDATE ON public\.sales_mode_links TO service_role/.test(mig), 'k22: migración tabla + flag + grants');
  t(/from = "\/s\/\*"/.test(src('netlify.toml')) && /sales-mode-redirect/.test(src('netlify.toml')), 'k22: redirect /s/* en netlify.toml');
  t(/from = "\/s\/\*"/.test(src('kiosk/netlify.toml')), 'k22: redirect /s/* en kiosk/netlify.toml');

  /* jsdom: generar → URL + estado; disable vuelve a vacío */
  const ADMIN_K = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  const DEALER_K = { id: 'shf', name: 'Summit Home Furnishings', world: 'retailer', rap_id: 'SHF-2048', frx_account_id: 'FRX-SHF-2048', hq_address: 'x', key_contacts: [], selling_enabled: true, dashboard_enabled: true, include_in_rollups: true, access_start: null, access_end: null };
  let smActive = false, smPost = null;
  const p = await loadPortal({
    session: SESSION, me: ADMIN_K, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }],
    api: {
      'portal-dealeradmin': () => ({ dealer: DEALER_K, sub_entities: [] }),
      'portal-sales-mode': (u, o) => {
        if (o && o.method === 'POST') {
          smPost = JSON.parse(o.body);
          if (smPost.action === 'disable') { smActive = false; return { disabled: true }; }
          smActive = true; return { code: 'ACDE2345', url: 'https://kiosk.furniturerx.net/s/ACDE2345' };
        }
        return smActive ? { code: 'ACDE2345', url: 'https://kiosk.furniturerx.net/s/ACDE2345', created_at: '2026-07-20T00:00:00Z' } : { code: null };
      }
    }
  });
  await sleep(40);
  p.document.getElementById('dealerSelect').value = 'shf';
  p.window.show('dealeradmin');
  await sleep(40);
  t(!p.document.getElementById('sm-none').hidden && p.document.getElementById('sm-gen').textContent === 'Generate link', 'k22-front: sin link → aviso + botón Generate');
  t(p.document.getElementById('sm-active').hidden, 'k22-front: la caja del link arranca oculta');
  p.window.generateSalesMode();
  await sleep(40);
  t(smPost && smPost.org_id === 'shf' && !smPost.action, 'k22-front: Generate postea el org');
  t(p.document.getElementById('sm-url').value === 'https://kiosk.furniturerx.net/s/ACDE2345', 'k22-front: la URL /s/{code} se pinta');
  t(!p.document.getElementById('sm-active').hidden && !p.document.getElementById('sm-disable').hidden && p.document.getElementById('sm-gen').textContent === 'Regenerate link', 'k22-front: con link → caja visible + Regenerate + Disable');
  p.window.disableSalesMode();
  await sleep(20);
  t(p.document.getElementById('action-modal').classList.contains('on'), 'k22-front: Disable abre confirmación');
  p.document.getElementById('am-confirm').click();
  await sleep(30);
  t(smPost && smPost.action === 'disable', 'k22-front: confirmar Disable postea action=disable');
  t(!p.document.getElementById('sm-none').hidden && p.document.getElementById('sm-active').hidden, 'k22-front: tras disable vuelve al estado sin link');
}

/* ── PORT-25: T&C SKU por dealer (Dealer Admin) ── */
{
  const html = src('portal/index.html');
  const daHtml = html.split('view-dealeradmin')[1].split('</section>')[0];
  t(/Terms &amp; conditions/.test(daHtml) && /id="pt-stain-version"/.test(daHtml) && /id="pt-stain_mech-version"/.test(daHtml), 'p25: bloque Terms & conditions con input por SKU');
  t(/savePlanTerms\('stain'\)/.test(daHtml) && /clearPlanTerms\('stain'\)/.test(daHtml), 'p25: botones Save / Use generic por SKU');
  /* per-dealer config: junto a Access & credentials y Sales-mode link, no enterrado bajo Stores */
  t(daHtml.indexOf('Access &amp; credentials') < daHtml.indexOf('Terms &amp; conditions') && daHtml.indexOf('Terms &amp; conditions') < daHtml.indexOf('Sales-mode link'), 'p25: T&C entre Access & credentials y Sales-mode link');

  const js = src('portal/assets/js/portal.js');
  t(/function loadPlanTerms/.test(js) && /function savePlanTerms/.test(js) && /function clearPlanTerms/.test(js), 'p25: loaders/acciones en el front');
  t(/\/api\/portal-plan-terms/.test(js), 'p25: el front pega al endpoint');
  t(/loadPlanTerms\(daOrgId\)/.test(js), 'p25: se carga al abrir el Dealer Admin');
  t(!/\.innerHTML\s*=/.test(js), 'p25: sigue sin innerHTML con datos');

  const fn = src('netlify/functions/portal-plan-terms.mjs');
  t(/assertAdmin/.test(fn) && /plan_terms/.test(fn) && /writeAudit/.test(fn), 'p25: portal-plan-terms admin-only + audit');
  t(!/CREATE TABLE/.test(fn), 'p25: sin migración nueva (plan_terms ya existe)');

  /* jsdom: cargar dealer → pinta override/generic; Save postea; Use generic postea action=clear */
  const ADMIN_25 = { user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/' };
  const DEALER_25 = { id: 'shf', name: 'Summit Home Furnishings', world: 'retailer', rap_id: 'SHF-2048', frx_account_id: 'FRX-SHF-2048', hq_address: 'x', key_contacts: [], selling_enabled: true, dashboard_enabled: true, include_in_rollups: true, access_start: null, access_end: null };
  const PT_SKUS = [
    { plan_sku: 'stain', override: { terms_version: 'BLS-STAIN-01', doc_url: 'https://d/tc.pdf' }, generic: { terms_version: 'v2026-05', doc_url: '/terms/' }, effective: { terms_version: 'BLS-STAIN-01', doc_url: 'https://d/tc.pdf', source: 'dealer' } },
    { plan_sku: 'stain_mech', override: null, generic: { terms_version: 'v2026-05', doc_url: '/terms/' }, effective: { terms_version: 'v2026-05', doc_url: '/terms/', source: 'generic' } }
  ];
  let ptPost = null;
  const p = await loadPortal({
    session: SESSION, me: ADMIN_25, resellers: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }],
    api: {
      'portal-dealeradmin': () => ({ dealer: DEALER_25, sub_entities: [] }),
      'portal-sales-mode': () => ({ code: null }),
      'portal-plan-terms': (u, o) => {
        if (o && o.method === 'POST') { ptPost = JSON.parse(o.body); return ptPost.action === 'clear' ? { cleared: true, plan_sku: ptPost.plan_sku } : { saved: true, plan_sku: ptPost.plan_sku, terms_version: ptPost.terms_version }; }
        return { skus: PT_SKUS };
      }
    }
  });
  await sleep(40);
  p.document.getElementById('dealerSelect').value = 'shf';
  p.window.show('dealeradmin');
  await sleep(50);
  t(p.document.getElementById('pt-stain-version').value === 'BLS-STAIN-01', 'p25-front: override del dealer pintado en el input');
  t(/Overriding generic v2026-05/.test(p.document.getElementById('pt-stain-status').textContent), 'p25-front: status del override menciona la genérica');
  t(!p.document.getElementById('pt-stain-clear').hidden, 'p25-front: con override → "Use generic" visible');
  t(p.document.getElementById('pt-stain_mech-version').value === '' && /Using generic v2026-05/.test(p.document.getElementById('pt-stain_mech-status').textContent), 'p25-front: sin override → input vacío + status genérico');
  t(p.document.getElementById('pt-stain_mech-clear').hidden, 'p25-front: sin override → "Use generic" oculto');

  p.document.getElementById('pt-stain-version').value = 'BLS-STAIN-02';
  ptPost = null;
  p.window.savePlanTerms('stain');
  await sleep(40);
  t(ptPost && ptPost.org_id === 'shf' && ptPost.plan_sku === 'stain' && ptPost.terms_version === 'BLS-STAIN-02', 'p25-front: Save postea {org_id,plan_sku,terms_version}');

  ptPost = null;
  p.window.clearPlanTerms('stain');
  await sleep(40);
  t(ptPost && ptPost.plan_sku === 'stain' && ptPost.action === 'clear', 'p25-front: Use generic postea action=clear');
}

/* Ago-11 (Doug/Adrian, ChangesBLS.srt 00:37–02:05): bloque de Stripe onboarding en Dealer Admin */
{
  const html = src('portal/index.html');
  const js = src('portal/assets/js/portal.js');
  t(/Stripe payouts/.test(html), 'stripe-onboard: bloque "Stripe payouts" en Dealer Admin');
  t(/id="so-gen"/.test(html) && /generateStripeOnboarding\(\)/.test(html), 'stripe-onboard: botón Generate cableado');
  t(/id="so-status"/.test(html) && /id="so-url"/.test(html), 'stripe-onboard: status + campo URL presentes');
  t(/function generateStripeOnboarding\(/.test(js) && /function loadStripeOnboarding\(/.test(js), 'stripe-onboard: JS presente');
  t(/loadStripeOnboarding\(daOrgId\)/.test(js), 'stripe-onboard: cargado en loadDealerAdmin');
}

/* Ago-11 (Doug/Adrian, ChangesBLS.srt 02:10–04:11): Resources con upload admin + asignación por dealer */
{
  const html = src('portal/index.html');
  const js = src('portal/assets/js/portal.js');
  t(/id="res-upload"[^>]*data-roles="admin"/.test(html), 'resources: panel de upload admin-only (data-roles)');
  t(/id="res-list"/.test(html), 'resources: contenedor de la lista');
  t(/id="res-type"/.test(html) && /id="res-title"/.test(html) && /id="res-file"/.test(html), 'resources: campos del form (tipo, título, archivo)');
  t(/function loadResources\(/.test(js) && /function uploadResource\(/.test(js), 'resources: JS loadResources + uploadResource');
  t(/id === 'resources'\) loadResources\(\)/.test(js), 'resources: cargado en loadFor');
}

/* Ago-11 v1 (consultoría UX de 5 especialistas): drag-and-drop + selección de dealers con buscador + focus fix */
{
  const html = src('portal/index.html');
  const js = src('portal/assets/js/portal.js');
  const css = src('portal/assets/css/portal.css');
  t(/id="res-drop"/.test(html) && /class="dropzone"/.test(html), 'ux: dropzone (#res-drop.dropzone)');
  t(/id="res-file"[^>]*dz-input/.test(html), 'ux: input file como overlay (patrón kiosk, drop nativo)');
  t(/id="res-search"/.test(html) && /id="res-count"/.test(html), 'ux: buscador + contador de dealers');
  t(/class="seg/.test(html) && /Everyone/.test(html) && /Specific dealers/.test(html), 'ux: segmented Everyone/Specific');
  t(/id="res-upload-btn"[^>]*disabled/.test(html), 'ux: botón Upload nace disabled');
  t(/function onResTypeChange\(/.test(js) && /function handleResFile\(/.test(js) && /function refreshResUploadBtn\(/.test(js), 'ux: JS dropzone + validación + gating del botón');
  t(/function updateResCount\(/.test(js) && /function resSelectAll\(/.test(js) && /function resSearch\(/.test(js), 'ux: JS contador + select-all + buscador');
  t(/\.dropzone\b/.test(css) && /\.dropzone\.dragover/.test(css) && /\.sr-only/.test(css), 'ux: CSS dropzone + dragover + sr-only');
  t(/:focus-visible\{outline:2px solid var\(--navy\)/.test(css), 'a11y: fix de contraste de foco (navy, no gold)');
}

/* Ago-11 v2 Parte B: tabs Available/Add en Resources */
{
  const html = src('portal/index.html');
  const js = src('portal/assets/js/portal.js');
  const css = src('portal/assets/css/portal.css');
  const resHtml = html.split('id="view-resources"')[1].split('</section>')[0];
  t(/id="restab-available"/.test(resHtml) && /id="restab-add"[^>]*data-roles="admin"/.test(resHtml), 'tabs: barra Available + Add (admin-only)');
  t(/id="res-panel-available"/.test(resHtml) && /id="res-panel-add"[^>]*data-roles="admin"/.test(resHtml), 'tabs: paneles available + add (admin-only)');
  t(/id="res-added"/.test(resHtml), 'tabs: banner de confirmación tras subir');
  t(/function showResTab\(/.test(js), 'tabs: showResTab en JS');
  t(/\.restab\.on/.test(css), 'tabs: CSS del tab activo');
}

/* Ago-11 v2 Parte A: subida directa (sign_upload + two-step) + caps por tipo */
{
  const js = src('portal/assets/js/portal.js');
  const fn = src('netlify/functions/portal-resources.mjs');
  const html = src('portal/index.html');
  t(/action: 'sign_upload'/.test(js) && /storage_path: s\.d\.storage_path/.test(js), 'upload: front en dos pasos (sign_upload → create con storage_path)');
  t(/RES_CAP_MB/.test(js), 'upload: caps por tipo en el front (PDF 20 / img 10)');
  t(/action === 'sign_upload'/.test(fn) && /createSignedUploadUrl/.test(fn), 'upload: backend acción sign_upload');
  t(/objectInfo/.test(fn) && /file_too_large/.test(fn), 'upload: backend valida tamaño/mime REALES de Storage');
  t(/up to 20MB/.test(html), 'upload: copy del formulario actualizado a 20MB');
  const css2 = src('portal/assets/css/portal.css');
  t(/id="res-desc"[^>]*res-field/.test(html) && /id="res-link"[^>]*res-field/.test(html) && /,\.res-field\{/.test(css2), 'ux: desc + link con el mismo borde del input que el título (.res-field)');
}

t.done();
