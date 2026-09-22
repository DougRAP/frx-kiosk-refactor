/* ============================================================================
 * E2E Playwright — Resources del portal (upload admin + vista dealer). Ago-11, ChangesBLS.srt.
 * (1) ADMIN: ve el panel de upload, sube por link → aparece en la lista.
 * (2) DEALER: NO ve el panel de upload (data-roles admin), pero sí su lista.
 * /api/* stubbeado. Uso: node tools/tests/e2e-resources.mjs (parte de npm run test:e2e)
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

const ADMIN = { user_id: 'u1', name: 'Alexandria Rivera', email: 'admin@raptns.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/', rap_id: null };
const DEALER = { user_id: 'u2', name: 'Bailey Owner', email: 'owner@baileys.com', role: 'dealer', tier: 'org', world: 'retailer', org_id: 'baileys', org_name: "Bailey's", sub_entity_id: null, sub_entity_name: null, app_url: 'https://kiosk.furniturerx.net/', rap_id: 'BLS-1001' };
const RESELLERS = [{ org_id: 'd1', org_name: 'Acme Furniture' }, { org_id: 'd2', org_name: 'Bravo Home' }, { org_id: 'd3', org_name: 'Coastal Living' }];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const who of ['admin', 'dealer']) {
    const ME = who === 'admin' ? ADMIN : DEALER;
    const RESOURCES = [{ id: 'r1', title: 'Global sell sheet', description: '', resource_type: 'sell_sheet', all_dealers: true, is_link: false, url: 'https://supa.test/signed/r1' }];
    const page = await browser.newPage();
    await page.route('**/api/**', async (route) => {
      const u = route.request().url(); const method = route.request().method();
      let out = {};
      if (u.includes('/api/portal-me')) out = ME;
      else if (u.includes('/api/portal-resellers')) out = { rows: RESELLERS, total: RESELLERS.length };
      else if (u.includes('/api/portal-resources')) {
        if (method === 'POST') {
          let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* ignore */ }
          if (body.action === 'sign_upload') { out = { upload_url: ORIGIN + '/fake-storage-put', storage_path: 'resources/e2efile.pdf' }; }
          else {
            const r = { id: 'r-new', title: body.title, description: body.description || '', resource_type: body.resource_type, all_dealers: !!body.all_dealers, is_link: !!body.link_url, url: body.link_url || 'https://supa.test/signed/new' };
            RESOURCES.push(r);
            out = { resource: r };
          }
        } else out = { resources: RESOURCES };
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await page.route('**/fake-storage-put', (route) => route.fulfill({ status: 200, body: '' }));   // PUT directo a "Storage"

    const SESSION = { access_token: 'tok.resp', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    await page.addInitScript((sess) => { try { localStorage.setItem('frx_portal_session', JSON.stringify(sess)); } catch (e) { /* ignore */ } }, SESSION);
    await page.goto(ORIGIN + '/portal/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app').style.display === 'block', null, { timeout: 8000 });
    await page.evaluate(() => window.show('resources'));
    await page.waitForFunction(() => { const l = document.getElementById('res-list'); return l && !/Loading/.test(l.textContent); }, null, { timeout: 6000 });

    if (who === 'admin') {
      /* default = tab Available: se ven los recursos, el form NO */
      t(/Global sell sheet/.test(await page.textContent('#res-list')), 'admin: tab Available muestra el recurso existente');
      t(await page.locator('#res-upload').isHidden(), 'admin: el form de upload NO se ve por default (está en el tab Add)');
      await page.click('#restab-add');
      await page.waitForTimeout(120);
      t(await page.locator('#res-drop').isVisible(), 'admin: en "Add a resource" ve la dropzone (drag-and-drop)');
      t(await page.locator('#res-upload-btn').isDisabled(), 'admin: Upload nace disabled (form vacío)');

      /* selección de dealers: Specific → chips + contador + Select all + buscador */
      await page.click('#res-seg-some');
      await page.waitForSelector('#res-some:not([hidden])', { timeout: 5000 });
      t((await page.locator('.dealer-chip').count()) === 3, 'admin: dealers como 3 chips');
      t(/0 of 3 selected/.test(await page.textContent('#res-count')), 'admin: contador arranca en 0 of 3');
      await page.locator('.dealer-chip').first().click();
      await page.waitForFunction(() => /1 of 3/.test(document.getElementById('res-count').textContent), null, { timeout: 4000 });
      t(/1 of 3 selected/.test(await page.textContent('#res-count')), 'admin: marcar un chip → 1 of 3');
      await page.getByRole('button', { name: 'Select all' }).click();
      t(/3 of 3 selected/.test(await page.textContent('#res-count')), 'admin: Select all → 3 of 3');
      await page.fill('#res-search', 'bravo');
      await page.waitForTimeout(80);
      t((await page.locator('.dealer-chip:visible').count()) === 1, 'admin: buscador filtra a 1 chip');
      await page.fill('#res-search', '');

      /* volver a Everyone y subir por LINK (product_overview → campo link) */
      await page.click('#res-seg-all');
      await page.fill('#res-title', 'Product demo video');
      await page.selectOption('#res-type', 'product_overview');
      await page.fill('#res-link', 'https://youtu.be/demo');
      t(await page.locator('#res-upload-btn').isEnabled(), 'admin: form válido → Upload habilitado');
      await page.click('#res-upload-btn');
      await page.waitForFunction(() => /Product demo video/.test(document.getElementById('res-list').textContent), null, { timeout: 6000 });
      t(/Product demo video/.test(await page.textContent('#res-list')), 'admin: tras subir por link, el recurso aparece en la lista');
      t(await page.locator('#res-added').isVisible(), 'admin: confirmación inline tras subir (banner "Uploaded")');

      /* subir un ARCHIVO (PDF) por el flujo de dos pasos: sign → PUT directo → create */
      await page.selectOption('#res-type', 'sell_sheet');
      await page.setInputFiles('#res-file', { name: 'onepager.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 small file') });
      await page.waitForSelector('#res-drop-file:not([hidden])', { timeout: 4000 });
      t(/onepager\.pdf/.test(await page.textContent('#res-drop-file')), 'admin: el archivo elegido muestra preview');
      await page.fill('#res-title', 'One pager PDF');
      t(await page.locator('#res-upload-btn').isEnabled(), 'admin: con archivo + título → Upload habilitado');
      await page.click('#res-upload-btn');
      await page.waitForFunction(() => /One pager PDF/.test(document.getElementById('res-list').textContent), null, { timeout: 6000 });
      t(/One pager PDF/.test(await page.textContent('#res-list')), 'admin: archivo subido (sign→PUT→create) aparece en la lista');
    } else {
      t(await page.locator('#restab-add').isHidden(), 'dealer: NO ve el tab "Add a resource"');
      t(await page.locator('#res-upload').isHidden(), 'dealer: NO ve el panel de upload (data-roles admin)');
      t(/Global sell sheet/.test(await page.textContent('#res-list')), 'dealer: ve su lista de recursos (tab Available)');
      t((await page.locator('#res-upload-btn').count()) === 0 || await page.locator('#res-upload-btn').isHidden(), 'dealer: el botón Upload no está accesible');
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\nresources-e2e: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
