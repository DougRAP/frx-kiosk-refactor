/* ============================================================================
 * E2E Playwright — Stripe onboarding en Dealer Admin (portal). Ago-11, ChangesBLS.srt.
 * Admin selecciona un dealer en "Viewing" → ve el bloque "Stripe payouts" (Not connected)
 * → Generate → aparece el onboarding_url de Stripe. /api/* stubbeado.
 * Uso: node tools/tests/e2e-stripe-onboard.mjs  (parte de npm run test:e2e)
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

const ME = { user_id: 'u1', name: 'Alexandria Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/', rap_id: null };
const RESELLERS = [{ org_id: 'baileys', org_name: "Bailey's" }];
const DEALER = { id: 'baileys', name: "Bailey's", world: 'retailer', rap_id: 'BLS-1001', frx_account_id: 'FRX-BLS-1001', hq_address: '', key_contacts: [], selling_enabled: true, dashboard_enabled: true, include_in_rollups: true, access_start: '2026-01-01', access_end: '2026-12-31' };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    const method = route.request().method();
    let out = {};
    if (u.includes('/api/portal-me')) out = ME;
    else if (u.includes('/api/portal-resellers')) out = { rows: RESELLERS, total: RESELLERS.length };
    else if (u.includes('/api/portal-dealeradmin')) out = { dealer: DEALER, sub_entities: [] };
    else if (u.includes('/api/portal-stripe-onboard')) {
      out = method === 'POST'
        ? { account_id: 'acct_bls1', onboarding_url: 'https://connect.stripe.com/setup/acct_bls1/abc', charges_enabled: false, payouts_enabled: false, details_submitted: false }
        : { account_id: null };
    } else if (u.includes('/api/portal-sales-mode')) out = { code: null };
    else if (u.includes('/api/portal-plan-terms')) out = { rows: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  const SESSION = { access_token: 'tok.resp', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.addInitScript((sess) => { try { localStorage.setItem('frx_portal_session', JSON.stringify(sess)); } catch (e) { /* ignore */ } }, SESSION);

  await page.goto(ORIGIN + '/portal/', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app').style.display === 'block', null, { timeout: 8000 });

  /* seleccionar el dealer en "Viewing" (el select se puebla de portal-resellers) */
  await page.waitForFunction(() => { const s = document.getElementById('dealerSelect'); return s && [...s.options].some((o) => o.value === 'baileys'); }, null, { timeout: 8000 });
  await page.evaluate(() => { const s = document.getElementById('dealerSelect'); s.value = 'baileys'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => window.show('dealeradmin'));
  await page.waitForTimeout(300);

  /* bloque presente + estado inicial "Not connected" + link oculto */
  t((await page.locator('#so-gen').count()) === 1, 'e2e: bloque "Stripe payouts" presente (botón Generate)');
  const status0 = (await page.textContent('#so-status')) || '';
  t(/Not connected/i.test(status0), 'e2e: estado inicial "Not connected"');
  t(await page.locator('#so-link').isHidden(), 'e2e: el link del onboarding nace oculto');

  /* Generate → aparece el onboarding_url de Stripe */
  await page.click('#so-gen');
  await page.waitForFunction(() => { const i = document.getElementById('so-url'); return i && /connect\.stripe\.com/.test(i.value); }, null, { timeout: 5000 });
  const url = await page.inputValue('#so-url');
  t(/connect\.stripe\.com/.test(url), 'e2e: Generate → onboarding_url de Stripe en #so-url');
  t(await page.locator('#so-link').isVisible(), 'e2e: el bloque del link se muestra tras generar');
} finally {
  await browser.close();
  server.close();
}
console.log(`\nstripe-onboard-e2e: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
