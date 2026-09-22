/* ============================================================================
 * _lib/portal.mjs — Subscription Portal (PORT-1/3/13): identidad + FRONTERA de seguridad.
 *
 * ⚠ La frontera REAL del portal vive AQUÍ (server-side), no en el DOM (API-CONTRACT §0:
 * "role/world gating is presentation only … NOT access control"). Cada guard LANZA
 * PortalError; el gating del front es conveniencia.
 *
 * Todo lo de este módulo (salvo requirePortalUser, que toca GoTrue) es PURO → unit-testeable
 * sin BD. Charla de Doug 13-jul: admin cross-world; roles owner/store-manager/admin; lectura
 * intra-org relajada (org-wide) pero cross-tenant y capabilities intactos.
 * ==========================================================================*/

'use strict';

import { EMAIL_RE, canonicalEmail, clean, cleanPhone } from './validate.mjs';
import { gotrue, pgrest } from './supabase.mjs';

export class PortalError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/* role (de app_metadata) → tier de gating. system_admin/admin = cross-world. */
export const ROLE_TIER = {
  system_admin: 'admin', admin: 'admin',
  dealer: 'org', company: 'org',
  store: 'sub', technician: 'sub'
};
/* world por defecto si el token no lo trae explícito (los admin son cross-world → null). */
const WORLD_BY_ROLE = { dealer: 'retailer', store: 'retailer', company: 'technician', technician: 'technician' };
const WORLDS = ['retailer', 'technician'];
const ADMIN_ONLY_FIELDS = ['stripe_subscription_id', 'internal_notes'];

/* Deriva el scope SOLO del app_metadata del token (nunca de params del cliente). Devuelve null
 * si no es usuario del portal (sin portal_role → cliente normal de AUTH-2, intacto). */
export function deriveScope(appMeta) {
  const m = appMeta || {};
  const role = m.portal_role;
  if (!role || !ROLE_TIER[role]) return null;
  const tier = ROLE_TIER[role];
  const world = tier === 'admin' ? (m.world || null) : (m.world || WORLD_BY_ROLE[role] || 'retailer');
  const isAdmin = tier === 'admin';
  const canOrgFeatures = tier === 'admin' || tier === 'org';   // export/api/stripe/referral-view: NO para sub
  return {
    role, tier, world,
    org_id: m.org_id || null,
    org_name: m.org_name || null,
    sub_entity_id: m.sub_entity_id || null,
    sub_entity_name: m.sub_entity_name || null,
    isAdmin,
    canExport: canOrgFeatures,
    canApi: canOrgFeatures,
    canStripe: canOrgFeatures,
    canReferralView: canOrgFeatures,
    canReferralCreate: isAdmin,
    canAdmin: isAdmin
  };
}

/* ---- PORT-21: dealers excluidos de los agregados del admin ("Viewing: All") ----
 * dealers.include_in_rollups=false los saca de stats/subscribers/commissions/referral
 * codes agregados SIN borrar nada: con el scope del propio dealer todo sigue visible.
 * rollupExclusion devuelve el fragmento PostgREST listo para concatenar.
 * OJO: not.in() sobre NULL da NULL (excluiría las ventas directas de RAP sin dealer),
 * por eso el or() con is.null. Fail-soft: hipo de BD → sin filtro (mejor de más que
 * romper la pantalla del admin). */
export async function excludedOrgIds(env) {
  try {
    const r = await pgrest(env, '/dealers?include_in_rollups=eq.false&select=id&limit=200');
    return (r.status < 300 && Array.isArray(r.data)) ? r.data.map((d) => d.id) : [];
  } catch (err) { console.warn('[portal] excludedOrgIds fail-soft:', err.message); return []; }
}
export function rollupExclusion(col, ids) {
  if (!ids || !ids.length) return '';
  const list = ids.map((i) => encodeURIComponent(i)).join(',');
  return `&or=(${col}.is.null,${col}.not.in.(${list}))`;
}

/* "Open app / Kiosk" routeado por world (retailer→kiosk, technician→tech app).
 * DEV-AWARE: si el request viene de localhost (netlify dev, port 8888), genera links de
 * localhost para probar sin desplegar; en prod SIEMPRE devuelve los dominios fijos.
 * SEGURIDAD: solo un host localhost/127.0.0.1 cambia la base — prod nunca depende del header,
 * y un host localhost falso solo generaría un link a la propia máquina del atacante (inocuo). */
const KIOSK_URL = 'https://kiosk.furniturerx.net/';
const TECH_URL = 'https://tech.furniturerx.net/';
const PORTAL_URL = 'https://portal.furniturerx.net/';
function devOrigin(req) {
  try {
    if (!req || !req.url) return null;
    const host = new URL(req.url).host;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return 'http://' + host;
  } catch { /* URL inválida → prod */ }
  return null;
}
export function appUrlFor(world, req) {
  const o = devOrigin(req);
  if (o) return o + (world === 'technician' ? '/tech/' : '/kiosk/');
  return world === 'technician' ? TECH_URL : KIOSK_URL;
}
/* Base del short link /s/ (bookmark/QR de sales-mode). En prod = el dominio del kiosk/tech
 * (donde vive el rewrite /s/). En dev = la RAÍZ del origin (el /s/ del netlify.toml raíz),
 * NO /kiosk/s/. Por eso es un helper aparte de appUrlFor. */
export function shortLinkBase(world, req) {
  const o = devOrigin(req);
  if (o) return o + '/';
  return world === 'technician' ? TECH_URL : KIOSK_URL;
}

/* DEAL-5: base del link durable de onboarding (/stripeOnboarding/{code}), que vive en
 * el dominio del PORTAL y no en el del kiosk. Dev-aware por el mismo motivo que
 * shortLinkBase: en `netlify dev` el rewrite está en el netlify.toml raíz, así que la
 * base es el origin local. PORTAL_URL manda si está definida (es la misma env var que
 * usa el return del onboarding de Stripe). */
export function portalLinkBase(req, env) {
  const o = devOrigin(req);
  if (o) return o + '/';
  const raw = ((env && env.PORTAL_URL) || PORTAL_URL).trim();
  return raw.endsWith('/') ? raw : raw + '/';
}

/* ---- Guards que LANZAN (la frontera) ---- */
export function assertPortalUser(scope) { if (!scope) throw new PortalError(403, 'not_portal_user'); }
export function assertAdmin(scope) { assertPortalUser(scope); if (!scope.canAdmin) throw new PortalError(403, 'forbidden'); }
export function assertCanExport(scope) { assertPortalUser(scope); if (!scope.canExport) throw new PortalError(403, 'forbidden'); }
export function assertCanStripe(scope) { assertPortalUser(scope); if (!scope.canStripe) throw new PortalError(403, 'forbidden'); }
export function assertCanApi(scope) { assertPortalUser(scope); if (!scope.canApi) throw new PortalError(403, 'forbidden'); }

/* Scope de LECTURA: el org_id efectivo con el que se consulta.
 * - admin → puede filtrar por un org concreto o ver 'all' (filtro dentro de scope ilimitado).
 * - org/sub → SIEMPRE su propio org_id (charla V4: sub ve org-wide). Pedir OTRO org = cross-tenant
 *   probe → 404 (§1: "404, not 403, when the caller is not permitted to know the resource exists").
 * Nunca confía en un org_id del cliente como GRANT (§0). */
export function readOrgScope(scope, requestedOrgId) {
  assertPortalUser(scope);
  const req = requestedOrgId == null || requestedOrgId === '' ? null : String(requestedOrgId);
  if (scope.isAdmin) {
    const all = req == null || req === 'all';
    return { orgId: all ? null : req, all };
  }
  if (req != null && req !== 'all' && req !== scope.org_id) throw new PortalError(404, 'not_found');
  return { orgId: scope.org_id, all: false };
}

/* Omite campos admin-only del PAYLOAD para no-admin (§3: "omitted from the response payload …
 * not returned and hidden"). Devuelve una copia sin esos campos; admin recibe el record intacto. */
export function omitAdminFields(record, scope) {
  if (!record || (scope && scope.isAdmin)) return record;
  const out = { ...record };
  for (const k of ADMIN_ONLY_FIELDS) delete out[k];
  return out;
}

/* PORT-3 (display, opción a aprobada 13-jul): contract# = master estable + sufijo por nº de pagos.
 * El master (RX-#####) YA se asigna en la compra (stripe-webhook). El -NN es display mientras la
 * emisión de certificados siga apagada; coincide con el certificado del ciclo vigente al encenderla. */
export function contractNumber(masterNo, payments) {
  if (!masterNo) return null;
  /* DEC-2 (Doug 29-jul): sufijo de UN dígito, sin zero-pad (RX-#####-1, no -01), y desde el
   * ciclo 1 (min 1) — el master pelado se muestra aparte como master_number. El separador es
   * dash. El motor de serialización real por-pago (SOAR↔Supabase) está en backlog (SOAR-1). */
  const n = Math.max(1, Number(payments) || 0);
  return `${masterNo}-${String(n)}`;
}

/* PORT-13: valida el inquiry público. world OBLIGATORIO (§5.15). Honeypot `company_url` (campo
 * trampa oculto): si viene relleno → spam. Devuelve {ok:false,error} | {ok:true,fields}. */
export function validateInquiry(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };
  if (body.company_url) return { ok: false, error: 'spam' };          // honeypot
  const name = clean(body.name, 128);
  if (!name) return { ok: false, error: 'invalid_name' };
  const email = canonicalEmail(body.email);
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };
  if (!WORLDS.includes(body.world)) return { ok: false, error: 'invalid_world' };
  let phone = null;
  if (body.phone != null && body.phone !== '') {
    phone = cleanPhone(body.phone);
    if (!phone) return { ok: false, error: 'invalid_phone' };
  }
  return { ok: true, fields: { name, email, world: body.world, phone } };
}

/* Valida el Bearer contra GoTrue /user y devuelve { userId, email, name, scope }. `scope` es null
 * si el usuario no es del portal (el caller decide: /api/me → 403 not_portal_user). No añade deps:
 * mismo patrón que _lib/auth.mjs.requireUser, pero devolviendo app_metadata para el scoping. */
export async function requirePortalUser(req, env) {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new PortalError(401, 'missing_bearer');
  const { status, data } = await gotrue(env, '/user', { method: 'GET', bearer: token });
  if (status !== 200 || !data || !data.id) throw new PortalError(401, 'invalid_token');
  const scope = deriveScope(data.app_metadata);
  const name = (data.user_metadata && (data.user_metadata.full_name || data.user_metadata.name)) || null;
  return { userId: data.id, email: data.email, name, scope };
}

/* ============================================================================
 * PORT-5/6/7/11 — helpers PUROS (testeables sin BD). Las Functions los usan.
 * ==========================================================================*/

/* ---- PORT-5: mappers de lectura ---- */
export function firstLast(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}
export function dateOnly(iso) { return iso ? String(iso).slice(0, 10) : null; }
export function programLabel(kind, tier) {
  if (kind === 'membership') return 'Membership';
  return tier === 'stain_mech' ? 'Protection+' : 'Protection';
}
/* nº de ciclos pagados ≈ meses desde el inicio (opción a de PORT-3: sufijo del contract#).
 * Determinístico: recibe `nowMs`. Piso 1; SIN tope: PORT-29a (email Doug 13-ago "remove the
 * subscription renewal limit" + 14-ago "we settled on no limit"). El viejo clamp a 36 hacía
 * colisionar el contract# (RX-XXXXX-36 repetido del mes 37 en adelante). 0 si no hay inicio. */
export function paymentsSince(startedAt, nowMs) {
  const t = Date.parse(startedAt || '');
  if (!Number.isFinite(t)) return 0;
  const months = Math.floor((nowMs - t) / (30 * 86400000)) + 1;
  return Math.max(1, months);
}
export function mapSubscriberRow(row, nowMs) {
  const prof = row.profiles || {};
  const { first, last } = firstLast(prof.full_name);
  const payments = paymentsSince(row.started_at, nowMs);
  const cancelled = !!row.canceled_at || row.status === 'canceled' || row.status === 'cancelled';
  return {
    subscription_id: row.id,
    start_date: dateOnly(row.started_at),
    end_date: dateOnly(row.canceled_at),
    program: programLabel(row.kind, row.tier),
    first_name: first, last_name: last,
    payments,
    sub_entity_id: row.sub_entity_id || null,
    store_name: (row.sub_entities && row.sub_entities.name) || null,   // PORT-16d: columna Store del mock
    person_id: row.sales_associate || null,
    sales_order_number: row.sales_order_number || null,   // PORT-30: reconciliación POS del dealer
    status: cancelled ? 'cancelled' : 'active',
    contract_number: contractNumber(row.master_no, payments)
  };
}
/* PORT-24C: Maya checkout summary SIEMPRE poblado ("that should always have something in it").
 * Si no hubo chat, se SINTETIZA del checkout REAL (programa + fecha + order). Cero chat inventado. */
export function mayaSummaryOrSynth(row) {
  if (row.maya_summary) return row.maya_summary;
  const prog = programLabel(row.kind, row.tier);
  const when = dateOnly(row.purchased_on) || dateOnly(row.started_at);
  const bits = [prog + ' plan'];
  if (when) bits.push('purchased ' + when);
  if (row.sales_order_number) bits.push('order ' + row.sales_order_number);
  return bits.join(' · ') + '.';
}

/* Ficha completa. Aplica omitAdminFields según scope (los admin-only NO viajan a org/sub). */
export function mapCustomerRecord(row, relatedRows, nowMs, scope, serviceRequests) {
  const prof = row.profiles || {};
  const { first, last } = firstLast(prof.full_name);
  const payments = paymentsSince(row.started_at, nowMs);
  const isAdmin = !!(scope && scope.isAdmin);
  const rec = {
    first_name: first, last_name: last,
    email: prof.email || null,
    phone: prof.phone || null,
    address: prof.address || null,
    start_date: dateOnly(row.started_at),
    end_date: dateOnly(row.canceled_at),
    status: (row.canceled_at || row.status === 'canceled') ? 'cancelled' : 'active',
    payments,
    program: programLabel(row.kind, row.tier),
    order_ref: row.sales_order_number || null,
    fulfilment_date: dateOnly(row.purchased_on),
    person_id: row.sales_associate || null,
    sub_entity_id: row.sub_entity_id || null,
    /* PORT-24C: master + activo (Doug: "master subscription number" + "active subscription number") */
    master_number: row.master_no || null,
    contract_number: contractNumber(row.master_no, payments),   // activo = master-NN del ciclo vigente
    terms_version: row.terms_version || null,
    maya_summary: mayaSummaryOrSynth(row),                       // PORT-24C: siempre poblado
    /* PORT-19B (mock 447): "Dealer / Store" = "Summit — Nashville" */
    dealer_store: [(row.dealers && row.dealers.name) || null, (row.sub_entities && row.sub_entities.name) || null]
      .filter(Boolean).join(' — ') || null,
    internal_notes: row.internal_notes || null,          // ADMIN ONLY (omitAdminFields lo quita para org/sub)
    /* PORT-24C: Stripe sub visible para dealer pero ENMASCARADO ("just a hash"); admin ve el id real.
     * El id real (stripe_subscription_id) sigue siendo ADMIN ONLY y NUNCA viaja a no-admin. */
    stripe_sub_display: row.stripe_subscription_id
      ? (isAdmin ? row.stripe_subscription_id : '•••• •••• •••• (admin only)')
      : '—',
    /* PORT-24C: últimos SRs de la ficha (número, categoría, status, fecha) */
    service_requests: (serviceRequests || []).map((s) => ({
      id: s.id, sr_number: s.sr_number || null, category: s.category || null,
      status: s.status || 'open', body: s.body || '', created_at: s.created_at, resolved_at: s.resolved_at || null
    })),
    related_purchases: (relatedRows || []).map((r) => ({
      contract_number: contractNumber(r.master_no, paymentsSince(r.started_at, nowMs)),
      program: programLabel(r.kind, r.tier),
      status: (r.canceled_at || r.status === 'canceled') ? 'cancelled' : 'active'
    })),
    stripe_subscription_id: row.stripe_subscription_id || null   // ADMIN ONLY
  };
  return omitAdminFields(rec, scope);
}
/* related_purchases (PORT-5, default conservador, pregunta 9 a Doug): mismo apellido + dirección,
 * normalizados (minúsculas, colapsar espacios), EXACTO, sin fuzzy (evita mezclar dos personas). */
export function relatedKey(lastName, address) {
  const n = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return n(lastName) + '|' + n(address);
}

/* ---- PORT-6: exports + audit ---- */
/* SEC-3c (auditoría 28-jul, hallazgo 5, CWE-1236): escapar la SINTAXIS del CSV no basta. Una celda
 * que empieza por = + - @ (o por tab/CR) es una FÓRMULA para Excel, Sheets y LibreOffice, y estos
 * datos no son internos: First/Last salen de profiles.full_name, que el propio cliente escribe y que
 * update-profile solo valida por longitud, y Associate lo teclea el kiosk. El archivo lo abre un
 * admin de RAP o un dealer, y lleva PII. Se prefija un apóstrofo (recomendación de OWASP): la hoja lo
 * lee como marcador de texto y no evalúa nada.
 * Se mira el primer carácter NO BLANCO porque la hoja recorta el campo, así que '   =1+1' también se
 * evaluaría. Solo se toca lo que empieza por un carácter peligroso: 'Protection+', 'RX-10017-12' y
 * '2026-07-28' salen byte a byte como siempre (en medio de la celda esos caracteres son inofensivos).
 * Spec: misc/spec-sec3c-csv-injection.md. */
const CSV_FORMULA_START = /^[\s]*[=+\-@\t\r]/;

export function toCSV(rows, cols) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (CSV_FORMULA_START.test(s)) s = "'" + s;
    /* \r y \t se suman al entrecomillado: sin ellos un \r dentro de un nombre partía la fila y
     * desplazaba las columnas del resto del archivo (mismo defecto de fondo: contenido colándose
     * como estructura). */
    return /[",\n\r\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = cols.map((c) => esc(c.label)).join(',');
  const body = (rows || []).map((r) => cols.map((c) => esc(r[c.key])).join(',')).join('\n');
  return head + '\n' + body;
}
export function auditRow({ actor_id, actor_name, actor_role, category, action, target, details, org_id }) {
  return {
    actor_id: actor_id || null, actor_name: actor_name || null, actor_role: actor_role || null,
    category, action, target: target || null, details: details || null, org_id: org_id || null
  };
}

/* ---- PORT-7: service requests ---- */
/* PORT-24C: ítems del menú single-select del form. ESTRICTO (recert 17-jul): SOLO los que Doug
 * nombró textualmente — "a simple menu, like cancel plan, contact customers" (Part1:847). El resto
 * lo DELEGÓ ("ask Bob to generate a simple menu… we can always add to it later") → pendiente su lista.
 * "Resolved" NO es un ítem: es el 6º checkbox que mapea a status=closed. */
export const SR_CATEGORIES = ['Cancel plan', 'Contact customer'];

export function validateServiceRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };
  const contract = clean(body.contract_number, 64);
  if (!contract) return { ok: false, error: 'invalid_contract' };
  const text = clean(body.body, 4000);
  if (!text) return { ok: false, error: 'invalid_body_text' };
  const cat = clean(body.category, 64);
  return {
    ok: true,
    fields: {
      contract_number: contract,
      first_name: clean(body.first_name, 128),
      last_name: clean(body.last_name, 128),
      contact: clean(body.contact, 254),
      body: text,
      category: SR_CATEGORIES.includes(cat) ? cat : null   // fuera del allowlist → null (no rompe)
    }
  };
}

/* ---- PORT-11: ¿este org puede vender ahora? (puro; la Function pasa la fila del dealer + nowMs) ---- */
export function dealerCanSell(dealer, nowMs) {
  if (!dealer) return { ok: true };                         // org desconocido → no bloquea (regresión cero)
  if (dealer.selling_enabled === false) return { ok: false, reason: 'selling_disabled' };
  const start = dealer.access_start ? Date.parse(dealer.access_start) : null;
  const end = dealer.access_end ? Date.parse(dealer.access_end + 'T23:59:59Z') : null;
  if (Number.isFinite(start) && nowMs < start) return { ok: false, reason: 'before_window' };
  if (Number.isFinite(end) && nowMs > end) return { ok: false, reason: 'after_window' };
  return { ok: true };
}
