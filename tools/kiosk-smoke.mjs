/* Smoke test throwaway (jsdom): carga kiosk/index.html en un modo dado y verifica que el IIFE
 * inicialice SIN excepción (un throw abortaría el wiring del kiosk o del teléfono).
 * Uso: node tools/kiosk-smoke.mjs <archivo> <url>
 *   kiosk:   node tools/kiosk-smoke.mjs kiosk/index.html https://kiosk.test/
 *   teléfono:node tools/kiosk-smoke.mjs kiosk/index.html "https://kiosk.test/?h=aaa.bbb"
 * Exit 1 si hubo jsdomError. Requiere jsdom (npm i jsdom@23 --no-save). */
import { readFileSync } from 'node:fs';
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;

const file = process.argv[2];
const url = process.argv[3] || 'https://kiosk.test/';
const html = readFileSync(file, 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e && e.message ? e.message : String(e)));

/* Stubs realistas de /api/* para que initPhone()/el kiosk no tiren por respuestas degeneradas.
   argv[4]: 'receipt' → summary solo-recibo (pay_on tablet); default → plan. */
const SUMMARY = (process.argv[4] === 'receipt')
  ? { mode: 'receipt', pay_on: 'tablet', first_name: 'Test' }
  : { first_name: 'Test', lines: [{ cov: 'stain', count: 1, monthly_cents: 999 }], membership: false, total_cents: 999, mode: 'plan' };
function apiStub(u, opts) {
  const method = (opts && opts.method) || 'GET';
  const bodyStr = opts && typeof opts.body === 'string' ? opts.body : '';
  if (u.includes('/api/kiosk-handoff-complete')) return { url: 'https://checkout.stripe.com/pay/cs_test_123' };
  if (u.includes('/api/kiosk-handoff')) {
    if (method === 'GET') return { status: 'pending', summary: SUMMARY };
    if (bodyStr.includes('attach')) return { ok: true, status: 'receipt_uploaded' };
    return { token: 'aaa.bbb', summary: SUMMARY, expires_at: new Date(Date.now() + 9e5).toISOString() };
  }
  if (u.includes('/api/upload-receipt')) return { path: 'receipts/2026/07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg' };
  if (u.includes('/api/checkout-status')) return { done: false, expired: false };
  if (u.includes('/api/create-checkout-session')) return { url: 'https://checkout.stripe.com/x', id: 'cs_test_1' };
  return {};
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
  beforeParse(window) {
    window.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} disconnect(){} takeRecords(){ return []; } };
    window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
    window.matchMedia = () => ({ matches: false, media: '', onchange: null, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){ return false; } });
    window.fetch = (u, opts) => { const data = apiStub(String(u), opts); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)) }); };
    window.scrollTo = () => {};
    if (window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = function(){};
  }
});

const { window } = dom;
const doc = window.document;
await new Promise((r) => setTimeout(r, 300));   // deja correr el IIFE + microtasks (initPhone hace fetch)

const result = {
  file, url,
  isKiosk: doc.documentElement.classList.contains('kiosk'),
  isPhone: doc.documentElement.classList.contains('phone'),
  present: {
    compare: !!doc.querySelector('#compare'), cartPanel: !!doc.querySelector('#cart-panel'),
    viewHandoff: !!doc.querySelector('#cart-view-handoff'), phonePanel: !!doc.querySelector('#phone-handoff')
  },
  jsdomErrors: errors
};
console.log(JSON.stringify(result, null, 2));
process.exit(errors.length ? 1 : 0);
