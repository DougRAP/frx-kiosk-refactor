/* ============================================================================
 * Helpers del harness de tests (work order 04-jul; spec: misc/spec-work-order-04jul.md).
 * Dos sabores de test:
 *   - estáticos: aserciones de texto sobre la FUENTE (src + makeT)
 *   - de comportamiento: kiosk/index.html bootea en jsdom con /api/* stubbeado
 *     (loadKiosk), localStorage sembrable y setInterval CAPTURADO (los polls se
 *     tickean a mano — sin esperas reales de 4s).
 * Correr todo: node tools/tests/run.mjs
 * ==========================================================================*/
import { readFileSync } from 'node:fs';
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;

export const src = (file) => readFileSync(file, 'utf8');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const flush = () => sleep(25);   // deja drenar la cadena de promesas de un fetch stubbeado

/* Contador de aserciones estilo tools/gate/gate.mjs: PASS/FAIL ruidoso + exit code. */
export function makeT(name) {
  let fails = 0, count = 0;
  const t = (cond, msg) => {
    count++;
    if (cond) console.log(`  PASS  ${msg}`);
    else { console.error(`  FAIL  ${msg}`); fails++; }
  };
  t.done = () => {
    console.log(`${name}: ${count - fails}/${count} aserciones`);
    process.exit(fails ? 1 : 0);
  };
  return t;
}

/* Stubs de /api/* (espejo de tools/kiosk-smoke.mjs, que es throwaway; estos son los committeados).
   `api` permite sobreescribir por substring de URL: { 'checkout-status': (u, opts) => ({...}) } */
const SUMMARY = { first_name: 'Test', lines: [{ cov: 'stain', count: 1, monthly_cents: 999 }], membership: false, total_cents: 999, mode: 'plan' };
function defaultStub(u, opts) {
  const method = (opts && opts.method) || 'GET';
  const bodyStr = opts && typeof opts.body === 'string' ? opts.body : '';
  if (u.includes('/api/kiosk-handoff-complete')) return { url: 'https://checkout.stripe.com/pay/cs_test_123' };
  if (u.includes('/api/kiosk-handoff')) {
    if (method === 'GET') return { status: 'pending', summary: SUMMARY };
    if (bodyStr.includes('attach')) return { ok: true, status: 'receipt_uploaded' };
    return { token: 'aaa.bbb', summary: SUMMARY, expires_at: '2099-01-01T00:00:00.000Z' };
  }
  if (u.includes('/api/upload-receipt')) return { path: 'receipts/2026/07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg' };
  if (u.includes('/api/checkout-status')) return { done: false, expired: false };
  if (u.includes('/api/create-checkout-session')) return { url: 'https://checkout.stripe.com/x', id: 'cs_test_1' };
  if (u.includes('/api/email-cart')) return { sent: true };
  return {};
}

/* Bootea kiosk/index.html. Devuelve { window, document, errors, intervals, tick }.
   - storage: pares clave→valor sembrados en localStorage ANTES de que corra el IIFE.
   - intervals: cada setInterval registrado como { id, cb, ms, cleared } (NUNCA corre solo).
   - tick(n): dispara n veces el último interval vivo, drenando promesas entre medias. */
export async function loadKiosk({ url = 'https://kiosk.test/', storage = {}, session = {}, api = {} } = {}) {
  const html = readFileSync('kiosk/index.html', 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e && e.message ? e.message : String(e)));
  const intervals = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.matchMedia = () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
      window.scrollTo = () => {};
      if (window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = function () {};
      window.fetch = (u, opts) => {
        const key = Object.keys(api).find((k) => String(u).includes(k));
        const data = key ? api[key](String(u), opts) : defaultStub(String(u), opts);
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve(data),
          text: () => Promise.resolve(JSON.stringify(data))
        });
      };
      try { for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v); }
      catch (e) { errors.push('localStorage seed: ' + e.message); }
      try { for (const [k, v] of Object.entries(session)) window.sessionStorage.setItem(k, v); }
      catch (e) { errors.push('sessionStorage seed: ' + e.message); }
      let nextId = 90001;   // ids propios, fuera del rango de los setTimeout reales
      window.setInterval = (cb, ms) => { intervals.push({ id: nextId, cb, ms, cleared: false }); return nextId++; };
      window.clearInterval = (id) => { const r = intervals.find((x) => x.id === id); if (r) r.cleared = true; };
    }
  });
  await sleep(350);   // deja correr el IIFE + los setTimeout cortos del boot
  const live = () => intervals.filter((r) => !r.cleared);
  async function tick(n) {
    for (let i = 0; i < n; i++) {
      const cur = live().pop();          // el poll activo más reciente
      if (!cur) return;
      cur.cb();
      await flush();
    }
  }
  return { window: dom.window, document: dom.window.document, errors, intervals, live, tick };
}

/* Bootea portal/index.html en jsdom con /api/* stubbeado. Devuelve { window, document, errors, requests }.
   - session: si se pasa, se siembra en localStorage['frx_portal_session'] ANTES del boot (→ el front llama /api/me).
   - me: payload que devuelve /api/me (identidad); si null → /api/me responde 403 (no-portal-user).
   - resellers: filas que devuelve /api/resellers.
   - api: overrides por substring de URL → fn(u,opts) que devuelve {status?, data?} o el data plano.
   - requests: array capturado de { url, method, body } de cada fetch (para verificar payloads, p.ej. world). */
export async function loadPortal({ url = 'https://portal.test/', session = null, me = null, resellers = [], subscribers = [], customer = null, audit = [], serviceRequests = [], api = {} } = {}) {
  /* El portal es multi-archivo (script EXTERNO). jsdom no fetchea el <script src>, así que lo
     INLINEAMOS aquí antes de bootear (replacer-función → no interpreta `$` del JS). */
  const rawHtml = readFileSync('portal/index.html', 'utf8');
  const js = readFileSync('portal/assets/js/portal.js', 'utf8');
  const html = rawHtml.replace('<script src="assets/js/portal.js"></script>', () => `<script>${js}</script>`);
  const errors = [];
  const requests = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e && e.message ? e.message : String(e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      if (window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = function () {};
      window.fetch = (u, opts) => {
        u = String(u);
        const method = (opts && opts.method) || 'GET';
        let body = {};
        try { body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : {}; } catch (e) { /* ignore */ }
        requests.push({ url: u, method, body });
        let status = 200, data = {};
        const key = Object.keys(api).find((k) => u.includes(k));
        if (key) {
          const res = api[key](u, opts);
          if (res && typeof res === 'object' && ('status' in res || 'data' in res)) { status = res.status || 200; data = 'data' in res ? res.data : {}; }
          else data = res || {};
        } else if (u.includes('/api/auth-login')) {
          data = { access_token: 'tok.stub', expires_at: Math.floor(Date.now() / 1000) + 3600 };
        } else if (u.includes('/api/portal-me')) {
          if (me) data = me; else { status = 403; data = { error: 'not_portal_user' }; }
        } else if (u.includes('/api/portal-resellers')) {
          data = { rows: resellers, total: resellers.length };
        } else if (u.includes('/api/portal-subscribers')) {
          data = { rows: subscribers, total: subscribers.length };
        } else if (u.includes('/api/portal-customer')) {
          if (customer) data = customer; else { status = 404; data = { error: 'not_found' }; }
        } else if (u.includes('/api/portal-exports')) {
          data = { ok: true, filename: 'subscribers.csv', rows: subscribers.length, csv: 'First,Last\n' };
        } else if (u.includes('/api/portal-audit')) {
          data = { rows: audit, total: audit.length };
        } else if (u.includes('/api/portal-service-requests')) {
          data = method === 'POST' ? { ok: true, id: 'r1' } : { rows: serviceRequests, total: serviceRequests.length };
        } else if (u.includes('/api/portal-inquiries')) {
          data = { ok: true };
        }
        return Promise.resolve({
          ok: status >= 200 && status < 300, status,
          headers: { get: () => null },
          json: () => Promise.resolve(data),
          text: () => Promise.resolve(JSON.stringify(data))
        });
      };
      try { if (session) window.localStorage.setItem('frx_portal_session', JSON.stringify(session)); }
      catch (e) { errors.push('localStorage seed: ' + e.message); }
    }
  });
  await sleep(200);
  return { window: dom.window, document: dom.window.document, errors, requests };
}
