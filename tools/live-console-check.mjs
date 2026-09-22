/* Reproduce el reporte de Adrian: ¿el live loguea "Blocked script execution… sandboxed"
 * en un Chrome LIMPIO (sin extensiones)? Captura console + frames + iframes del DOM. */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const messages = [];
page.on('console', (m) => messages.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => messages.push(`[pageerror] ${e.message}`));

await page.goto('https://www.furniturerx.net/', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(6000);   // dar tiempo a lazy scripts / reveal / chat

const iframes = await page.evaluate(() => document.querySelectorAll('iframe').length);
const frames = page.frames().map((f) => f.url());
console.log('URL final:', page.url());
console.log('iframes en el DOM:', iframes);
console.log('frames de Playwright:', JSON.stringify(frames));
console.log('mensajes de console (' + messages.length + '):');
for (const m of messages) console.log('  ' + m);

await browser.close();
