/* ============================================================================
 * DEAL-1 — `dealers.alpha_code`: el código de 3 letras con el que el reporte de
 * underwriting identifica al dealer. Antes vivía por convención dentro de
 * `rap_id` ('BLS-1001'): nullable, sin UNIQUE y sin formato garantizado.
 *
 * Cubre las tres capas: la migración (contrato SQL), las dos Functions que la
 * exponen (dealeradmin + resellers) y el front (campo editable + dropdown).
 * Mock de fetch con el patrón de sales-mode.test.mjs.
 * ==========================================================================*/
import { makeT, loadPortal } from './helpers.mjs';
import { readFileSync } from 'node:fs';

const t = makeT('alpha-code');
const src = (p) => readFileSync(p, 'utf8');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

let meUser = { id: 'u1', email: 'admin@raptns.com', app_metadata: { portal_role: 'admin', world: null }, user_metadata: { full_name: 'Alex' } };
let dealerRows = [{ id: 'o1', name: 'Baileys Furniture Outlet', world: 'retailer', rap_id: 'BLS-1001', alpha_code: 'BLS' }];
let lastGetUrl = null, lastPatch = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { /* no-json */ }
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify(meUser), { status: 200 });
  if (u.includes('rate_limit_hit')) return new Response(JSON.stringify([{ allowed: true, hits: 1, retry_after: 0 }]), { status: 200 });
  if (u.includes('/rest/v1/dealers')) {
    if (method === 'PATCH') { lastPatch = body; return new Response(JSON.stringify([{ id: 'o1', name: 'Baileys Furniture Outlet' }]), { status: 200 }); }
    lastGetUrl = u;
    return new Response(JSON.stringify(dealerRows), { status: 200 });
  }
  if (u.includes('/rest/v1/')) return new Response('[]', { status: method === 'POST' ? 201 : 200 });
  throw new Error('unexpected fetch ' + u);
};

const dealerAdmin = (await import('../../netlify/functions/portal-dealeradmin.mjs')).default;
const resellers = (await import('../../netlify/functions/portal-resellers.mjs')).default;
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const req = (url, method = 'GET', body) => new Request(url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

/* ── 1) La migración: contrato SQL ─────────────────────────────────────────── */
{
  const sql = src('supabase/migrations/20260817000000_dealers_alpha_code.sql');
  t(/ADD COLUMN IF NOT EXISTS alpha_code/.test(sql), 'mig: añade dealers.alpha_code');
  t(/dealers_alpha_code_chk/.test(sql) && /\^\[A-Z\]\{3\}\$/.test(sql), 'mig: CHECK de 3 mayúsculas exactas');
  t(/CREATE UNIQUE INDEX IF NOT EXISTS dealers_alpha_code_uidx/.test(sql), 'mig: UNIQUE (un alpha = un dealer)');
  t(/split_part\(rap_id, ?'-', ?1\)/.test(sql), 'mig: backfill desde el prefijo de rap_id');
  t(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/.test(sql), 'mig: idempotente (re-aplicable sin error)');
  t(!/\b(DROP|DELETE|TRUNCATE)\b/i.test(sql), 'mig: no destructiva');
}

/* ── 2) portal-dealeradmin: lee y edita el alpha ───────────────────────────── */
{
  const r = await dealerAdmin(req('https://site.test/api/portal-dealeradmin?org_id=o1', 'GET'));
  const d = await r.json();
  t(r.status === 200 && d.dealer && d.dealer.alpha_code === 'BLS', 'GET: devuelve alpha_code');
  t(/select=[^&]*alpha_code/.test(lastGetUrl || ''), 'GET: alpha_code va en el select de PostgREST');
}
{
  lastPatch = null;
  const r = await dealerAdmin(req('https://site.test/api/portal-dealeradmin', 'PATCH', { org_id: 'o1', alpha_code: 'bls' }));
  t(r.status === 200, 'PATCH: alpha_code es editable (William corrige sin tocar la BD)');
  t(lastPatch && lastPatch.alpha_code === 'BLS', 'PATCH: normaliza a mayúsculas');
}
{
  for (const bad of ['BL', 'BLSX', '1BL', 'B-S', 42]) {
    lastPatch = null;
    const r = await dealerAdmin(req('https://site.test/api/portal-dealeradmin', 'PATCH', { org_id: 'o1', alpha_code: bad }));
    t(r.status === 400 && !lastPatch, 'PATCH: rechaza alpha inválido (' + JSON.stringify(bad) + ')');
  }
}
{
  lastPatch = null;
  const r = await dealerAdmin(req('https://site.test/api/portal-dealeradmin', 'PATCH', { org_id: 'o1', alpha_code: '' }));
  t(r.status === 200 && lastPatch && lastPatch.alpha_code === null, 'PATCH: vacío limpia la columna (null, no cadena vacía)');
}
{
  lastPatch = null;
  await dealerAdmin(req('https://site.test/api/portal-dealeradmin', 'PATCH', { org_id: 'o1', rap_id: 'XXX-9', name: 'Nuevo' }));
  t(lastPatch && lastPatch.rap_id === undefined && lastPatch.name === 'Nuevo', 'PATCH: rap_id sigue fuera de la whitelist');
}

/* ── 3) portal-resellers: el dropdown recibe el alpha ──────────────────────── */
{
  const r = await resellers(req('https://site.test/api/portal-resellers?world=retailer', 'GET'));
  const d = await r.json();
  t(r.status === 200 && d.rows[0] && d.rows[0].alpha_code === 'BLS', 'resellers: cada fila trae su alpha_code');
  t(/select=[^&]*alpha_code/.test(lastGetUrl || ''), 'resellers: alpha_code va en el select');
}

/* ── 4) Front: campo en Dealer Admin + etiqueta del dropdown ───────────────── */
{
  const html = src('portal/index.html');
  t(/id="da-alpha"/.test(html), 'UI: el form de Dealer Admin tiene el campo Alpha code');
  t(!/id="da-alpha"[^>]*readonly/.test(html), 'UI: el Alpha code es editable (no readonly como el RAP ID)');
  const js = src('portal/assets/js/portal.js');
  t(/set\('#da-alpha'/.test(js), 'UI: fillDealerAdmin pinta el alpha');
  t(/alpha_code:/.test(js), 'UI: saveDealerAdmin lo manda en el PATCH');
}
{
  const { document } = await loadPortal({
    session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 },
    me: { tier: 'admin', role: 'admin', world: null, name: 'Alex', email: 'admin@raptns.com' },
    resellers: [
      { org_id: 'o1', org_name: 'Baileys Furniture Outlet', alpha_code: 'BLS' },
      { org_id: 'o2', org_name: 'Sin código todavía', alpha_code: null }
    ]
  });
  const opts = Array.from(document.querySelectorAll('#dealerSelect option')).map((o) => o.textContent);
  t(opts.includes('BLS · Baileys Furniture Outlet'), 'dropdown: "ALPHA · Nombre" cuando hay código');
  t(opts.includes('Sin código todavía'), 'dropdown: solo el nombre cuando el alpha falta (sin separador huérfano)');
}

t.done();
