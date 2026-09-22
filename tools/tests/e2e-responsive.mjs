/* ============================================================================
 * E2E responsive del Subscription Portal — PORT-26 (review Doug 17-jul item 21).
 * GATE: en cada pantalla × viewport × rol, el DOCUMENTO no debe desbordar
 * horizontalmente (document.scrollWidth <= clientWidth + 1px). Los contenedores
 * scrollables intencionales (.tblwrap, .scroll-x) scrollean ADENTRO y no cuentan.
 * Cuando algo desborda, se identifica el elemento culpable (para arreglarlo).
 * También guarda screenshots a 390px para el juicio visual (nivel SOFT).
 * Uso: node tools/tests/e2e-responsive.mjs  (parte de npm run test:e2e)
 * ==========================================================================*/
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { computeStats } from '../../netlify/functions/_lib/stats.mjs';

let fails = 0, count = 0;
const t = (cond, msg) => { count++; if (cond) console.log(`  PASS  ${msg}`); else { console.error(`  FAIL  ${msg}`); fails++; } };

const SHOTS = join(process.env.TEMP || '.', 'port26-shots');
try { mkdirSync(SHOTS, { recursive: true }); } catch (e) { /* ignore */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(process.cwd(), path.endsWith('/') ? path + 'index.html' : path);
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* ---- fixtures con strings LARGOS realistas (para estresar el overflow) ---- */
const NOW = Date.parse('2026-07-16T15:00:00Z');
const ENTS = [
  { id: 'e1', name: 'Downtown Flagship Showroom — Music Row' },
  { id: 'e2', name: 'Franklin Galleria at CoolSprings Boulevard' }
];
const SUBS = [
  { user_id: 'u1', status: 'active', started_at: '2026-07-10T10:00:00Z', monthly_cents: 1999, sub_entity_id: 'e1', sales_associate: 'ASSOCIATE-0071-DELGADILLO', master_no: 'RX-10001', stripe_subscription_id: 'sub_a' },
  { user_id: 'u2', status: 'active', started_at: '2026-06-03T10:00:00Z', monthly_cents: 999, sub_entity_id: 'e2', sales_associate: 'A-02', master_no: 'RX-10002', stripe_subscription_id: 'sub_b' },
  { user_id: 'u3', status: 'canceled', started_at: '2026-04-01T10:00:00Z', canceled_at: '2026-07-05T10:00:00Z', monthly_cents: 999, sub_entity_id: 'e1', sales_associate: 'ASSOCIATE-0071-DELGADILLO', master_no: 'RX-10003', stripe_subscription_id: 'sub_c' }
];
const LEDGER = [
  { stripe_subscription_id: 'sub_a', stripe_amount_cents: 800, reinsurance_amount_cents: 0, paid_at: '2026-07-12T10:00:00Z' },
  { stripe_subscription_id: 'sub_b', stripe_amount_cents: 200, reinsurance_amount_cents: 200, paid_at: '2026-07-06T10:00:00Z' }
];
const STATS = computeStats({ subs: SUBS, ledger: LEDGER, entities: ENTS, nowMs: NOW, period: 'all' });

const LONGNAME = { first_name: 'Maximiliano', last_name: 'Featherstonehaugh-Wetherby' };
const SUBROWS = [];
for (let i = 1; i <= 6; i++) SUBROWS.push({
  subscription_id: 's' + i, start_date: '2026-06-1' + (i % 9), end_date: null, program: i % 2 ? 'Protection+ (Stain + Structure)' : 'Protection',
  first_name: LONGNAME.first_name, last_name: LONGNAME.last_name + '-' + i, payments: (i % 5) + 1,
  person_id: 'ASSOCIATE-0071-DELGADILLO', store_name: 'Downtown Flagship Showroom — Music Row', status: i === 3 ? 'cancelled' : 'active',
  contract_number: 'RX-10001-0' + i, sr_status: i === 1 ? 'open' : undefined
});
const RECON = SUBROWS.map((s, i) => ({ ...s, stripe_payment_no: 'in_1A2B3C4D5E6F7G8H9I0J' + i, payment_date: '2026-07-1' + (i % 9) }));
const CUSTOMER = {
  first_name: LONGNAME.first_name, last_name: LONGNAME.last_name, email: 'maximiliano.featherstonehaugh@verylongdomainname-furniture.example.com',
  address: '18425 Northwestern Memorial Parkway, Suite 1400, Nashville, Tennessee 37209-4471, United States',
  status: 'active', payments: 12, program: 'Protection+ (Stain + Structure)', master_number: 'RX-10001', contract_number: 'RX-10001-12',
  terms_version: 'v2026-05', maya_summary: 'Customer chatted at length about protecting a sectional, an area rug and two floor lamps against stains and structural failure; confirmed the sales order and totals before checkout.',
  stripe_sub_display: 'sub_1A2B3C4D5E6F7G8H9I0J', dealer_store: 'Summit Home Furnishings — Downtown Flagship Showroom — Music Row',
  order_number: 'SO-FD-88231-2026', service_requests: [{ id: 'sr1', sr_number: 'SR-01001', category: 'Cancel plan', status: 'open', body: 'Customer reported a long-running seam split along the chaise section of the sectional.', created_at: '2026-07-10T00:00:00Z' }]
};
const DEALER = {
  id: 'shf', name: 'Summit Home Furnishings & Outdoor Living Group, LLC', world: 'retailer', rap_id: 'SHF-2048', frx_account_id: 'FRX-SHF-2048-000119',
  hq_address: '18425 Northwestern Memorial Parkway, Suite 1400, Nashville, Tennessee 37209-4471', key_contacts: [{ role: 'Chief Executive Officer', name: 'Dana Reed-Fitzgerald', email: 'dana.reed.fitzgerald@summithomefurnishings.example.com', phone: '(615) 555-0110' }],
  selling_enabled: true, dashboard_enabled: true, include_in_rollups: true, access_start: '2026-01-01', access_end: '2026-12-31'
};
const PLANS = [
  { sku: 'stain', label: 'Protection (Stain)', monthly_cents: 999, covers: 'Stains — all categories (furniture, outdoor, adjustable, rugs)' },
  { sku: 'stain_mech', label: 'Protection+ (Stain + Structure)', monthly_cents: 1999, covers: 'Stains + structural failure — all categories' }
];
/* Kit Orders: nombres y trackings largos a propósito — es lo que estresa el ancho de la fila. */
const KIT_ORDERS = [
  { item_id: 'k1', order_id: 'ko1', contract_number: 'RX-10001-2', order_date: '2026-08-05', kit_name: 'Fabric & Upholstery Care Kit', kit_sku: 'CARE-FABRIC-001', quantity: 2, customer_name: 'Raymond Coleman-Whitfield', customer_email: 'raymond.coleman-whitfield@precisionfurniture.com', retail_cents: 9998, sh_cents: null, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, ship_to: { name: 'Raymond Coleman-Whitfield', address: '1420 Westheimer Rd, Apt 3B, Houston, TX', zip: '77006', phone: '(713) 555-0142' } },
  { item_id: 'k2', order_id: 'ko1', contract_number: null, order_date: '2026-08-05', kit_name: 'Leather Care Kit', kit_sku: 'CARE-LEATHER-001', quantity: 1, customer_name: 'Raymond Coleman-Whitfield', customer_email: 'raymond.coleman-whitfield@precisionfurniture.com', retail_cents: 4999, sh_cents: null, fulfillment_status: 'shipped', shipping_confirmation: '1Z999AA10123456784', shipped_at: '2026-08-06T10:00:00Z', ship_to: { name: 'Raymond Coleman-Whitfield', address: '1420 Westheimer Rd, Apt 3B, Houston, TX', zip: '77006', phone: '(713) 555-0142' } },
  { item_id: 'k3', order_id: 'ko2', contract_number: null, order_date: '2026-08-04', kit_name: 'Wood Care Kit', kit_sku: 'CARE-WOOD-001', quantity: 1, customer_name: 'Ann Ruiz', customer_email: 'ann@rap.com', retail_cents: 4999, sh_cents: null, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, ship_to: { name: 'Ann Ruiz', address: '9 Pine Ave, Austin, TX', zip: '73301', phone: null } }
];
const AUDIT = [{ at: '2026-07-13T08:04:00Z', actor_name: 'Dana Reed-Fitzgerald', actor_role: 'dealer', action: 'Exported subscribers', target: 'Summit Home Furnishings & Outdoor Living Group, LLC', details: 'CSV · 1,204 rows · PII included · filtered by associate ASSOCIATE-0071-DELGADILLO' }];
const REFERRALS = [{ code: 'SUM-AB12', label: 'Spring 2026 Music Row Grand Opening Campaign', org_name: 'Summit Home Furnishings & Outdoor Living Group, LLC', active: true, created_at: '2026-07-01T10:00:00Z', uses: 42, attributed: 18, credit_cents: 21600 }];

const ROLES = {
  admin: { user_id: 'u1', name: 'Alexandria Rivera-Montgomery', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/', rap_id: null },
  'org-retail': { user_id: 'u2', name: 'Dana Reed-Fitzgerald', email: 'owner@summithf.com', role: 'dealer', tier: 'org', world: 'retailer', org_id: 'shf', org_name: 'Summit Home Furnishings & Outdoor Living Group, LLC', sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/', rap_id: 'SHF-2048' },
  'org-tech': { user_id: 'u9', name: 'Raymond Coleman-Whitfield', email: 'ray@pfr.com', role: 'company', tier: 'org', world: 'technician', org_id: 'pfr', org_name: 'Precision Furniture Repair & Restoration Co.', sub_entity_id: null, sub_entity_name: null, app_url: 'https://tech.furniturerx.net/', rap_id: 'PFR-3090' }
};
const SCREENS = {
  admin: ['dashboard', 'salesstats', 'subscribers', 'referrals', 'custrecord', 'contact', 'resources', 'downloads', 'stripe', 'dealeradmin', 'kitorders', 'pricing', 'audit'],
  'org-retail': ['dashboard', 'salesstats', 'subscribers', 'referrals', 'custrecord', 'contact', 'resources', 'downloads', 'stripe'],
  'org-tech': ['dashboard', 'salesstats', 'subscribers', 'referrals', 'custrecord', 'contact', 'resources', 'downloads', 'stripe']
};
const VIEWPORTS = [360, 390, 768, 1024, 1280, 1440, 1920];
const SHOT_SCREENS = new Set(['dashboard', 'subscribers', 'stripe', 'custrecord', 'dealeradmin', 'salesstats']);

let ME = ROLES.admin;
const RESELLERS = [
  { org_id: 'shf', org_name: 'Summit Home Furnishings & Outdoor Living Group, LLC' },
  { org_id: 'pfr', org_name: 'Precision Furniture Repair & Restoration Co.' }
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    let out = {};
    if (u.includes('/api/portal-me')) out = ME;
    else if (u.includes('/api/portal-resellers')) out = { rows: RESELLERS, total: RESELLERS.length };
    else if (u.includes('/api/portal-stats')) out = STATS;
    else if (u.includes('/api/portal-subscribers')) out = { rows: SUBROWS, total: SUBROWS.length };
    else if (u.includes('/api/portal-reconciliation')) out = { rows: RECON, total: RECON.length };
    else if (u.includes('/api/portal-commissions')) out = { rows: [], totals: { cash_cents: 1000, reinsurance_cents: 200 }, total: 0 };
    else if (u.includes('/api/portal-customer')) out = CUSTOMER;
    else if (u.includes('/api/portal-referral-codes')) out = { rows: REFERRALS, total: REFERRALS.length };
    else if (u.includes('/api/portal-dealeradmin')) out = { dealer: DEALER, sub_entities: [{ id: 'e1', name: 'Downtown Flagship Showroom — Music Row', location: 'Nashville, TN', status: 'active', world: 'retailer' }] };
    else if (u.includes('/api/portal-plans')) out = { plans: PLANS, editable: false };
    else if (u.includes('/api/portal-audit')) out = { rows: AUDIT, total: AUDIT.length };
    else if (u.includes('/api/portal-inquiries')) out = { ok: true };
    /* Kit Orders SIN filas medía un <tbody> vacío: el gate estaba ciego justo donde el CSS es más
       frágil (a ≤760px la tabla deja de estar dentro de un scroller). Datos largos a propósito. */
    else if (u.includes('/api/portal-kit-orders')) out = { rows: KIT_ORDERS, total: KIT_ORDERS.length };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  const SESSION = { access_token: 'tok.resp', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.addInitScript((sess) => { try { localStorage.setItem('frx_portal_session', JSON.stringify(sess)); } catch (e) {} }, SESSION);

  /* medición en la página: overflow del documento + culpables (fuera de scroll containers) */
  const MEASURE = () => {
    const de = document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    const culprits = [];
    if (overflow > 1) {
      for (const el of document.querySelectorAll('#app *, .landing *, .loginwrap *')) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.right <= de.clientWidth + 1) continue;
        let p = el.parentElement, scrollable = false;
        while (p) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll') { scrollable = true; break; } p = p.parentElement; }
        if (!scrollable) {
          const cls = (typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
          culprits.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''));
        }
      }
    }
    return { overflow, culprits: [...new Set(culprits)].slice(0, 5) };
  };

  for (const role of Object.keys(ROLES)) {
    ME = ROLES[role];
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(ORIGIN + '/portal/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app').style.display === 'block', null, { timeout: 8000 });

    for (const screen of SCREENS[role]) {
      if (screen === 'custrecord') await page.evaluate(() => window.openCustomer('RX-10001-12'));
      else await page.evaluate((s) => window.show(s), screen);
      await page.waitForTimeout(120);

      for (const vw of VIEWPORTS) {
        await page.setViewportSize({ width: vw, height: 900 });
        await page.waitForTimeout(60);
        const { overflow, culprits } = await page.evaluate(MEASURE);
        t(overflow <= 1, `${role} · ${screen} @${vw}px: sin overflow horizontal${overflow > 1 ? ` (desborda ${overflow}px → ${culprits.join(', ') || '?'})` : ''}`);
        if ((vw === 390 || vw === 360) && SHOT_SCREENS.has(screen)) {
          await page.screenshot({ path: join(SHOTS, `${role}_${screen}_390.png`), fullPage: true }).catch(() => {});
        }
      }
    }
  }
  /* ── PORT-27: nav off-canvas (hamburguesa) en móvil ── */
  ME = ROLES.admin;
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(ORIGIN + '/portal/', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app').style.display === 'block', null, { timeout: 8000 });
  await page.waitForTimeout(120);
  t(await page.isVisible('#navToggle'), 'p27-e2e: el botón hamburguesa es visible a 360px');
  t(!(await page.evaluate(() => document.getElementById('sideNav').classList.contains('open'))), 'p27-e2e: el drawer arranca cerrado');
  await page.click('#navToggle');
  await page.waitForTimeout(120);
  t(await page.evaluate(() => document.getElementById('sideNav').classList.contains('open') && document.getElementById('navScrim').classList.contains('on')), 'p27-e2e: el hamburguesa abre el drawer + scrim');
  const openOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  t(openOverflow <= 1, `p27-e2e: con el drawer abierto no hay overflow (got ${openOverflow}px)`);
  await page.click('#sideNav a[data-screen="subscribers"]');
  await page.waitForTimeout(120);
  t(!(await page.evaluate(() => document.getElementById('sideNav').classList.contains('open'))), 'p27-e2e: elegir una pantalla cierra el drawer');
  await page.click('#navToggle');
  await page.waitForTimeout(80);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  t(!(await page.evaluate(() => document.getElementById('sideNav').classList.contains('open'))), 'p27-e2e: Esc cierra el drawer');
  await page.click('#navToggle');
  await page.waitForTimeout(80);
  await page.click('#navScrim', { position: { x: 340, y: 400 } });
  await page.waitForTimeout(80);
  t(!(await page.evaluate(() => document.getElementById('sideNav').classList.contains('open'))), 'p27-e2e: tap en el scrim cierra el drawer');

  await page.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`e2e-responsive: ${count - fails}/${count} aserciones · screenshots en ${SHOTS}`);
process.exit(fails ? 1 : 0);
