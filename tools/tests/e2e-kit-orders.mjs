/* ============================================================================
 * E2E Playwright — Kit Orders (kit fulfillment, KIT-1..KIT-6). Ago-13.
 * Fuente: revisiones/KitOrdersMeeting.vtt + DougKitsAgo082026.srt + KitOrdersAgo132026.srt.
 * (1) ADMIN: ve Kit Orders, una fila por tipo de kit, imprime la dirección, teclea el
 *     shipping confirmation y marca Shipped (el flujo de 3 clicks que pidió Doug).
 * (2) DEALER: NO ve la entrada del nav (la página es admin-only).
 * /api/* stubbeado. Uso: node tools/tests/e2e-kit-orders.mjs (parte de npm run test:e2e)
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

/* El caso literal de Doug: "Doug Wright orders 3 kits… all Doug Wright" → 3 filas. */
const baseRows = () => ([
  { item_id: 'it-1', order_id: 'o-1', order_date: '2026-08-05', kit_name: 'Wood Care Kit', kit_sku: 'CARE-WOOD-001', quantity: 1, customer_name: 'Doug Wright', customer_email: 'doug@rap.com', retail_cents: 4999, sh_cents: null, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, ship_to: { name: 'Doug Wright', address: '123 Oak St, Dallas, TX', zip: '75001', phone: '555-1212' } },
  { item_id: 'it-2', order_id: 'o-1', order_date: '2026-08-05', kit_name: 'Leather Care Kit', kit_sku: 'CARE-LEATHER-001', quantity: 1, customer_name: 'Doug Wright', customer_email: 'doug@rap.com', retail_cents: 4999, sh_cents: null, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, ship_to: { name: 'Doug Wright', address: '123 Oak St, Dallas, TX', zip: '75001', phone: '555-1212' } },
  { item_id: 'it-3', order_id: 'o-2', order_date: '2026-08-04', kit_name: 'Wood Care Kit', kit_sku: 'CARE-WOOD-001', quantity: 3, customer_name: 'Ann Ruiz', customer_email: 'ann@rap.com', retail_cents: 14997, sh_cents: 1350, fulfillment_status: 'pending', shipping_confirmation: null, shipped_at: null, ship_to: { name: 'Ann Ruiz', address: '9 Pine Ave, Austin, TX', zip: '73301', phone: null } }
]);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const who of ['admin', 'dealer']) {
    const ME = who === 'admin' ? ADMIN : DEALER;
    let ROWS = baseRows();
    let posts = [];
    const page = await browser.newPage();

    await page.route('**/api/**', async (route) => {
      const u = route.request().url(); const method = route.request().method();
      let out = {};
      if (u.includes('/api/portal-me')) out = ME;
      else if (u.includes('/api/portal-kit-orders')) {
        if (method === 'POST') {
          let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* ignore */ }
          posts.push(body);
          const row = ROWS.find((r) => r.item_id === body.item_id);
          /* KIT-10: el stub espeja al server real — el estado se DERIVA del tracking. */
          if (row && body.action === 'ship_info') {
            const ref = String(body.shipping_confirmation || '').trim();
            if (ref) {
              row.shipping_confirmation = ref;
              row.shipped_at = body.shipped_at || row.shipped_at || '2026-08-14';
              row.fulfillment_status = 'shipped';
            } else {
              row.shipping_confirmation = null; row.shipped_at = null; row.fulfillment_status = 'pending';
            }
          }
          out = { ok: true };
        } else out = { rows: ROWS, total: ROWS.length };
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });

    const SESSION = { access_token: 'tok.kit', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    await page.addInitScript((sess) => {
      try { localStorage.setItem('frx_portal_session', JSON.stringify(sess)); } catch (e) { /* ignore */ }
      window.__printed = 0;
      const orig = window.print;
      window.print = () => { window.__printed++; };   // el diálogo nativo colgaría el test
      void orig;
    }, SESSION);
    await page.goto(ORIGIN + '/portal/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app').style.display === 'block', null, { timeout: 8000 });

    if (who === 'dealer') {
      t(await page.locator('a[data-screen="kitorders"]').isHidden(), 'dealer: NO ve Kit Orders en el nav (admin-only)');
      await page.close();
      continue;
    }

    /* ── admin ── */
    t(await page.locator('a[data-screen="kitorders"]').isVisible(), 'admin: ve Kit Orders en el nav');
    await page.click('a[data-screen="kitorders"]');
    await page.waitForFunction(() => {
      const b = document.getElementById('kit-body');
      return b && b.querySelectorAll('tr:not(.skel-row)').length > 0;
    }, null, { timeout: 6000 });

    /* KIT-1 + KIT-6 */
    t((await page.locator('#kit-body tr').count()) === 3, 'KIT-6: una fila por tipo de kit (3 filas)');
    const heads = await page.locator('#view-kitorders thead th').allTextContents();
    t(heads[0].trim() === 'Order date' && heads[1].trim() === 'Kit', 'KIT-1: columnas Order date + Kit');
    t(heads[6].trim() === 'Tracking #', 'KIT-1: Tracking # es la última columna de datos');
    t(!heads.some((h) => h.trim() === 'SR'), 'KIT-1: sin columna SR');
    const row0 = await page.locator('#kit-body tr').first().textContent();
    t(/Doug Wright/.test(row0) && /\$49\.99/.test(row0), 'fila: cliente + retail');
    t(/—/.test(row0), 'fila: S&H sin dato pinta —');

    /* Regresión de layout: un <td> con display:flex dejaba de medirse como celda y los botones
       se desbordaban hacia la izquierda, montándose sobre S&H / Shipping confirmation / Status. */
    const spill = await page.evaluate(() => {
      const td = document.querySelector('#kit-body td.kit-acts');
      if (!td) return 'no cell';
      const cell = td.getBoundingClientRect();
      const out = [...td.querySelectorAll('button')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left < cell.left - 1 || r.right > cell.right + 1;
      });
      return out.length ? out.map((b) => b.textContent.trim()).join(',') : '';
    });
    t(spill === '', 'layout: los botones no se salen de su celda' + (spill ? ' (se salen: ' + spill + ')' : ''));
    const statusVisible = await page.evaluate(() => {
      const tr = document.querySelector('#kit-body tr');
      const pill = tr && tr.children[7] && tr.children[7].querySelector('.pill');
      if (!pill) return false;
      const r = pill.getBoundingClientRect();
      return r.width > 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== null;
    });
    t(statusVisible, 'layout: el pill de Status se ve (no queda tapado por los botones)');

    /* KIT-3: dirección + Print */
    await page.locator('#kit-body tr').first().getByRole('button', { name: 'Address' }).click();
    await page.waitForSelector('#kit-addr-modal.on', { timeout: 4000 });
    const addr = await page.textContent('#kit-addr-body');
    t(/Doug Wright/.test(addr) && /123 Oak St/.test(addr) && /75001/.test(addr), 'KIT-3: el popup muestra el ship-to');
    await page.click('#kit-addr-print');
    t((await page.evaluate(() => window.__printed)) === 1, 'KIT-3: Print dispara window.print');
    /* El papel debe traer SOLO la dirección. Con visibility:hidden el layout seguía en pie y el
       documento medía miles de px → Chrome se quedaba en "Loading preview". Se mide de verdad. */
    await page.emulateMedia({ media: 'print' });
    const printed = await page.evaluate(() => ({
      h: document.documentElement.scrollHeight,
      vh: document.documentElement.clientHeight,
      addr: !!document.querySelector('#kit-addr-body') && getComputedStyle(document.querySelector('#kit-addr-body')).display !== 'none',
      nav: getComputedStyle(document.getElementById('app')).display,
      chrome: getComputedStyle(document.getElementById('kit-addr-actions')).display
    }));
    t(printed.h <= printed.vh + 1, 'print: el documento no crece más allá de la página (' + printed.h + 'px), sin hojas en blanco');
    t(printed.addr, 'print: la dirección sí se imprime');
    t(printed.nav === 'none' && printed.chrome === 'none', 'print: el portal y los botones NO se imprimen');
    await page.emulateMedia({ media: null });
    await page.click('#kit-addr-modal .x');

    /* El atributo `hidden` DEBE ocultar de verdad. `.btn{display:inline-flex}` (hoja de autor) le
       ganaba al [hidden] del UA stylesheet, así que los botones marcados hidden se veían siempre y
       en este modal convivían Close + Cancel + Save. jsdom no evalúa la cascada, así que esto solo
       se puede comprobar en un navegador real. */
    await page.locator('#kit-body tr').first().getByRole('button', { name: 'Address' }).click();
    await page.waitForSelector('#kit-addr-modal.on', { timeout: 4000 });
    const hiddenReally = await page.evaluate(() => {
      const shown = (id) => { const el = document.getElementById(id); return el && getComputedStyle(el).display !== 'none'; };
      return { cancel: shown('kit-addr-cancel'), save: shown('kit-addr-save'), edit: shown('kit-addr-editbtn') };
    });
    t(!hiddenReally.cancel && !hiddenReally.save, 'los botones con [hidden] NO se ven (modo lectura: sin Cancel ni Save)');
    t(hiddenReally.edit, 'y los que sí deben verse siguen visibles (Edit)');
    await page.click('#kit-addr-modal .x');

    /* KIT-4 + KIT-10: guardar el tracking marca Shipped SOLO, sin click extra. */
    await page.locator('#kit-body tr').first().getByRole('button', { name: 'Enter tracking #' }).click();
    await page.waitForSelector('#kit-ship-modal.on', { timeout: 4000 });
    t((await page.locator('#kit-ship-modal select').count()) === 0, 'KIT-4: sin dropdown de carrier (es manual)');
    t((await page.locator('#kit-ship-modal .finenote').textContent()).includes('marks the kit as Shipped'),
      'KIT-10: el popup explica la regla tracking=Shipped');
    await page.fill('#kit-ref', '1Z999AA10123456784');
    await page.fill('#kit-date', '2026-08-13');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/portal-kit-orders') && r.request().method() === 'POST'),
      page.click('#kit-ship-save')
    ]);
    const shipInfo = posts.find((p) => p.action === 'ship_info');
    t(shipInfo && shipInfo.shipping_confirmation === '1Z999AA10123456784', 'KIT-4: POST lleva el reference number');
    t(shipInfo && shipInfo.shipped_at === '2026-08-13', 'KIT-4: POST lleva la fecha');
    t(!posts.some((p) => p.action === 'shipped'), 'KIT-10: NO existe un POST shipped aparte');
    /* la fila queda Shipped, con el tracking visible, el slot "Sent" y SIN botón primario extra */
    await page.waitForFunction(() => {
      const tr = document.querySelectorAll('#kit-body tr')[0];
      return tr && /1Z999AA10123456784/.test(tr.textContent) && /Shipped/.test(tr.textContent)
        && /Sent/.test(tr.textContent) && !tr.querySelector('button.primary');
    }, null, { timeout: 5000 });
    t(true, 'KIT-10: guardar el tracking dejó la fila Shipped, sin click extra');

    /* KIT-10: vaciar el tracking devuelve a Pending (el camino de reversión). */
    await page.locator('#kit-body tr').first().getByRole('button', { name: 'Edit tracking #' }).click();
    await page.waitForSelector('#kit-ship-modal.on', { timeout: 4000 });
    t(await page.inputValue('#kit-ref') === '1Z999AA10123456784', 'KIT-10: el popup trae el tracking prellenado');
    await page.fill('#kit-ref', '');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/portal-kit-orders') && r.request().method() === 'POST'),
      page.click('#kit-ship-save')
    ]);
    await page.waitForFunction(() => {
      const tr = document.querySelectorAll('#kit-body tr')[0];
      return tr && /Pending/.test(tr.textContent) && !/Sent/.test(tr.textContent);
    }, null, { timeout: 5000 });
    t(true, 'KIT-10: vaciar el tracking devolvió la fila a Pending');
    t((await page.locator('#kit-body tr').first().getByRole('button', { name: 'Shipped' }).count()) === 0,
      'KIT-10: no existe botón Shipped en la fila');

    /* Dejar it-2 enviada para que el check de alineación compare pendiente vs enviada. */
    await page.locator('#kit-body tr').nth(1).getByRole('button', { name: 'Enter tracking #' }).click();
    await page.waitForSelector('#kit-ship-modal.on', { timeout: 4000 });
    await page.fill('#kit-ref', '1Z777BB2');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/portal-kit-orders') && r.request().method() === 'POST'),
      page.click('#kit-ship-save')
    ]);
    await page.waitForFunction(() => /Sent/.test(document.querySelectorAll('#kit-body tr')[1].textContent), null, { timeout: 5000 });
    const aligned = await page.evaluate(() => {
      const rows = document.querySelectorAll('#kit-body tr');
      const cell = (tr) => tr.querySelector('td.kit-acts').getBoundingClientRect();
      const a = cell(rows[0]), b = cell(rows[1]);
      return Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1;
    });
    t(aligned, 'layout: la columna de acciones NO salta entre una fila pendiente y una enviada');

    /* KIT-12 (Doug 13-ago: "the buttons should be lined up neatly... see how they're not even").
       Con estados MIXTOS (fila 1 enviada = "Edit tracking #", filas 0 y 2 = "Enter tracking #"),
       cada slot debe ocupar la MISMA x en todas las filas: el ancho ya no depende del texto. */
    const slotAligned = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#kit-body tr'));
      const rect = (tr, sel) => { const el = tr.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
      const addr = rows.map((r) => rect(r, '.kit-b-addr'));
      const trk = rows.map((r) => rect(r, '.kit-b-trk'));
      const same = (arr, k) => arr.every((x) => x && Math.abs(x[k] - arr[0][k]) < 1);
      return same(addr, 'left') && same(addr, 'right') && same(trk, 'left') && same(trk, 'right');
    });
    t(slotAligned, 'KIT-12: cada slot ocupa la misma x en todas las filas (Enter vs Edit ya no descuadra)');

    /* buscador */
    await page.fill('#kit-search', 'ann');
    await page.waitForTimeout(120);
    t((await page.locator('#kit-body tr').count()) === 1, 'buscador filtra por cliente');
    await page.fill('#kit-search', '');
    await page.waitForTimeout(120);
    t((await page.locator('#kit-body tr').count()) === 3, 'buscador vacío muestra todo');

    /* S&H condicional: con el fixture hay un importe → visible; al quitarlos todos → oculta.
       Se comprueba el display COMPUTADO, que es lo que el usuario ve. */
    const shShown = await page.evaluate(() => getComputedStyle(document.getElementById('kit-th-sh')).display !== 'none');
    t(shShown, 'S&H visible cuando alguna orden trae importe');
    const shHidden = await page.evaluate(() => {
      window.kitRows = window.kitRows.map((r) => ({ ...r, sh_cents: null }));
      window.renderKits(true);
      const th = document.getElementById('kit-th-sh');
      const td = document.querySelector('#kit-body tr').children[5];
      return getComputedStyle(th).display === 'none' && getComputedStyle(td).display === 'none';
    });
    t(shHidden, 'S&H se oculta sola cuando ninguna orden trae importe');

    /* View se queda */
    await page.locator('#kit-body tr').first().getByText('View', { exact: true }).click();
    await page.waitForSelector('#kit-detail-modal.on', { timeout: 4000 });
    t(/Wood Care Kit/.test(await page.textContent('#kit-detail-body')), 'View abre el detalle de la orden');
    await page.click('#kit-detail-modal .x');

    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\ne2e-kit-orders: ${count - fails}/${count} aserciones`);
process.exit(fails ? 1 : 0);
