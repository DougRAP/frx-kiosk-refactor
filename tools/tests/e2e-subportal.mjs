/* ============================================================================
 * E2E del Subscription Portal en CHROME REAL — Playwright (PORT-0/1/13).
 * Sirve portal/ (archivos reales, incl. el JS externo que jsdom no carga) y stubbea /api/*.
 * Verifica: landing, become-a-reseller (world en el POST), login real → shell con la
 * identidad de /api/me y el selector cross-world del admin poblado.
 * Uso: npm run test:e2e
 * ==========================================================================*/
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

let fails = 0, count = 0;
const t = (cond, msg) => { count++; if (cond) console.log(`  PASS  ${msg}`); else { console.error(`  FAIL  ${msg}`); fails++; } };

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

const ADMIN_ME = {
  user_id: 'u1', name: 'Alex Rivera', email: 'admin@raptns.com',
  role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null,
  sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/'
};

let inquiryReq = null;   // body del POST a /api/portal-inquiries
let loginReq = null;     // body del POST a /api/auth-login
let ptPost = null;       // body del POST a /api/portal-plan-terms (PORT-25)

const DEALER_25 = { id: 'shf', name: 'Summit Home Furnishings', world: 'retailer', rap_id: 'SHF-2048', frx_account_id: 'FRX-SHF-2048', hq_address: '1 Main', key_contacts: [], selling_enabled: true, dashboard_enabled: true, include_in_rollups: true, access_start: null, access_end: null };
const PT_SKUS = [
  { plan_sku: 'stain', override: { terms_version: 'BLS-STAIN-01', doc_url: 'https://d/tc.pdf' }, generic: { terms_version: 'v2026-05', doc_url: '/terms/' }, effective: { terms_version: 'BLS-STAIN-01', doc_url: 'https://d/tc.pdf', source: 'dealer' } },
  { plan_sku: 'stain_mech', override: null, generic: { terms_version: 'v2026-05', doc_url: '/terms/' }, effective: { terms_version: 'v2026-05', doc_url: '/terms/', source: 'generic' } }
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    const method = route.request().method();
    const body = method === 'POST' ? JSON.parse(route.request().postData() || '{}') : {};
    let out = {};
    if (u.includes('/api/auth-login')) { loginReq = body; out = { access_token: 'tok.e2e', expires_at: Math.floor(Date.now() / 1000) + 3600 }; }
    else if (u.includes('/api/portal-me')) { out = ADMIN_ME; }
    else if (u.includes('/api/portal-resellers')) { out = { rows: [{ org_id: 'shf', org_name: 'Summit Home Furnishings' }, { org_id: 'r2g', org_name: 'Rooms2Go #3' }], total: 2 }; }
    else if (u.includes('/api/portal-subscribers')) { out = { rows: [{ subscription_id: 's1', start_date: '2026-05-14', end_date: null, program: 'Protection', first_name: 'Jane', last_name: 'Doe', payments: 3, status: 'active', contract_number: 'RX-10001-03' }], total: 1 }; }
    else if (u.includes('/api/portal-customer')) { out = { first_name: 'Jane', last_name: 'Doe', email: 'j@x.co', status: 'active', payments: 3, program: 'Protection', contract_number: 'RX-10001-03', terms_version: 'v2026-05', maya_summary: 'Asked about stains.', related_purchases: [] }; }
    else if (u.includes('/api/portal-exports')) { out = { ok: true, filename: 'subscribers.csv', rows: 1, csv: 'First,Last\nJane,Doe\n' }; }
    else if (u.includes('/api/portal-audit')) { out = { rows: [{ at: '2026-07-13T08:04:00Z', actor_name: 'Dana', actor_role: 'dealer', action: 'Exported subscribers', target: 'Summit', details: 'CSV · 1 rows · PII included' }], total: 1 }; }
    else if (u.includes('/api/portal-service-requests')) { out = { rows: [], total: 0 }; }
    else if (u.includes('/api/portal-dealeradmin')) { out = { dealer: DEALER_25, sub_entities: [] }; }
    else if (u.includes('/api/portal-sales-mode')) { out = { code: null }; }
    else if (u.includes('/api/portal-plan-terms')) { if (method === 'POST') { ptPost = body; out = body.action === 'clear' ? { cleared: true } : { saved: true }; } else out = { skus: PT_SKUS }; }
    else if (u.includes('/api/portal-inquiries')) { inquiryReq = body; out = { ok: true }; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  /* 1 · Landing */
  await page.goto(ORIGIN + '/portal/', { waitUntil: 'load' });
  t(/Subscription Portal/.test(await page.title()), 'portal: title propio');
  t(await page.isVisible('.landing .hero h1'), 'portal: landing hero visible');
  t((await page.$$('.acct')).length === 0, 'portal: sin el login stub de 5 personas (auth real)');

  /* 2 · Become a reseller → el world viaja en el POST (§5.15) */
  await page.click('button[onclick="openReseller()"]');
  await page.waitForSelector('#reseller.on', { timeout: 5000 });
  await page.fill('#rs-name', 'Nash Upholstery Repair');
  await page.fill('#rs-email', 'shop@nashupholstery.com');
  await page.selectOption('#rs-world', 'technician');
  await page.click('#reseller-form button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById('rs-msg').hidden, null, { timeout: 5000 });
  t(inquiryReq && inquiryReq.world === 'technician', 'portal: become-a-reseller POST lleva world:"technician"');
  t(inquiryReq && inquiryReq.name === 'Nash Upholstery Repair', 'portal: el lead lleva nombre + email');
  await page.click('#reseller .x');   /* cierra el modal (si no, tapa el resto) */
  await page.waitForSelector('#reseller.on', { state: 'hidden', timeout: 5000 });

  /* 3 · Login real → shell con identidad + selector cross-world del admin */
  await page.click('button[onclick="showLogin()"]');
  await page.waitForSelector('#view-login.on', { timeout: 5000 });
  await page.fill('#login-email', 'admin@raptns.com');
  await page.fill('#login-pw', 'PortalTest!2026');
  await page.click('#login-btn');
  await page.waitForFunction(() => document.getElementById('app').style.display === 'block', null, { timeout: 8000 });
  t(loginReq && loginReq.email === 'admin@raptns.com', 'portal: doLogin postea a /api/auth-login');
  t(await page.textContent('#userName') === 'Alex Rivera', 'portal: identidad de /api/me pintada en el shell');
  t(await page.isVisible('#hdr-admin'), 'portal: admin ve el selector cross-world (World + Viewing)');
  const opts = await page.$$eval('#dealerSelect option', (ns) => ns.map((n) => n.textContent));
  t(opts.length === 3 && opts[0] === 'All', 'portal: dropdown Viewing poblado desde /api/resellers (All + 2)');
  t(await page.textContent('#dash-role') === 'admin', 'portal: dashboard pinta el role real');

  /* 3b · PORT-5/6: Subscribers pinta filas, Export dispara POST, Audit Log pinta filas */
  await page.click('a[data-screen="subscribers"]');
  await page.waitForSelector('#subs-body tr:not(.skel-row)', { timeout: 5000 });
  t((await page.$$('#subs-body tr')).length === 1 && /RX-10001-03/.test(await page.textContent('#subs-body')), 'portal: Subscribers pinta filas con contract#');
  const [exp] = await Promise.all([
    page.waitForResponse('**/api/portal-exports**', { timeout: 8000 }),
    page.click('#view-subscribers button[onclick="exportSubs()"]')
  ]);
  t(exp.request().method() === 'POST', 'portal: Export dispara POST /api/portal-exports');
  await page.click('a[data-screen="audit"]');
  await page.waitForSelector('#audit-body tr:not(.skel-row)', { timeout: 5000 });
  t((await page.$$('#audit-body tr')).length === 1, 'portal: Audit Log pinta filas (admin)');

  /* 3c · Contact → 4 cards + Resources → panel de upload admin + 4 type cards (Ago-11 ChangesBLS.srt:
     el mock 3×4 "blanks fill later" se volvió real). */
  await page.click('a[data-screen="contact"]');
  await page.waitForSelector('#view-contact.on .cardgrid', { timeout: 5000 });
  t((await page.$$('#view-contact .contactcard')).length === 4, 'portal: Contact → 4 cards (Sales/Claim/Subscription/Escalation)');
  await page.click('a[data-screen="resources"]');
  await page.waitForSelector('#view-resources.on #res-list', { timeout: 5000 });
  await page.waitForFunction(() => { const l = document.getElementById('res-list'); return l && l.querySelectorAll('.rescard').length === 4; }, null, { timeout: 5000 });
  t((await page.$$('#view-resources .rescard')).length === 4, 'portal: Resources → tab Available con 4 type cards (default)');
  t(await page.locator('#res-upload').isHidden(), 'portal: el form de upload NO se ve por default (Ago-11 v2: está en el tab Add)');
  await page.click('#restab-add');
  await page.waitForTimeout(120);
  t(await page.locator('#res-upload').isVisible(), 'portal: click en "Add a resource" → aparece el form');

  /* 3d · PORT-25: Dealer Admin → bloque T&C carga override del dealer + Save dispara POST */
  await page.selectOption('#dealerSelect', 'shf');
  await page.click('a[data-screen="dealeradmin"]');
  await page.waitForSelector('#pt-stain-version', { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('pt-stain-version').value === 'BLS-STAIN-01', null, { timeout: 5000 });
  t(/Overriding generic v2026-05/.test(await page.textContent('#pt-stain-status')), 'portal: T&C block muestra override del dealer vs genérica');
  t(await page.getAttribute('#pt-stain_mech-clear', 'hidden') !== null && (await page.inputValue('#pt-stain_mech-version')) === '', 'portal: SKU sin override → input vacío + "Use generic" oculto');
  await page.fill('#pt-stain-version', 'BLS-STAIN-09');
  const [ptResp] = await Promise.all([
    page.waitForResponse('**/api/portal-plan-terms**', { timeout: 8000 }),
    page.click("button[onclick=\"savePlanTerms('stain')\"]")
  ]);
  t(ptResp.request().method() === 'POST' && ptPost && ptPost.plan_sku === 'stain' && ptPost.terms_version === 'BLS-STAIN-09', 'portal: T&C Save dispara POST con {plan_sku,terms_version}');

  /* 4 · Logout → vuelve al landing */
  await page.click('.topbar .logout');
  await page.waitForSelector('#view-landing.on', { timeout: 5000 });
  t(await page.isVisible('.landing .hero h1'), 'portal: logout vuelve al landing');
} finally {
  await browser.close();
  server.close();
}

console.log(`e2e-subportal: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
