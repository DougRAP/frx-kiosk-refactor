/* ============================================================================
 * tools/seed-portal.mjs — siembra logins de prueba del portal (PORT-1).
 * Uso:  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node tools/seed-portal.mjs
 *
 * Crea 1 org (dealer, world retailer) + 1 sub-entity (store) + 3 logins con su
 * app_metadata (el scoping se DERIVA del token, nunca del cliente). Idempotente-ish:
 * si un email ya existe, GoTrue devuelve 422 y se ignora. NO se aplica en tests
 * (toca BD real); es una utilidad operativa para verificar en vivo.
 * ==========================================================================*/

'use strict';

import { pgrest, gotrue } from '../netlify/functions/_lib/supabase.mjs';

const env = process.env;
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const PW = '12345678';   // password fija de prueba QA

async function ensureOrg() {
  const found = await pgrest(env, `/dealers?slug=eq.summit-hf&select=id,name&limit=1`);
  if (found.status < 300 && Array.isArray(found.data) && found.data[0]) return found.data[0];
  const ins = await pgrest(env, '/dealers', {
    method: 'POST', prefer: 'return=representation',
    body: { name: 'Summit Home Furnishings', slug: 'summit-hf', world: 'retailer', rap_id: 'SHF-2048', selling_enabled: true, dashboard_enabled: true }
  });
  if (ins.status >= 300 || !Array.isArray(ins.data) || !ins.data[0]) throw new Error(`org insert failed (${ins.status})`);
  return ins.data[0];
}

async function ensureStore(orgId) {
  const found = await pgrest(env, `/sub_entities?org_id=eq.${orgId}&name=eq.Summit%20%E2%80%94%20Nashville&select=id,name&limit=1`);
  if (found.status < 300 && Array.isArray(found.data) && found.data[0]) return found.data[0];
  const ins = await pgrest(env, '/sub_entities', {
    method: 'POST', prefer: 'return=representation',
    body: { org_id: orgId, world: 'retailer', name: 'Summit — Nashville', location: 'Nashville, TN', status: 'active' }
  });
  if (ins.status >= 300 || !Array.isArray(ins.data) || !ins.data[0]) throw new Error(`store insert failed (${ins.status})`);
  return ins.data[0];
}

async function findUserId(email) {
  const { status, data } = await gotrue(env, '/admin/users', { method: 'GET', query: { per_page: '200' } });
  if (status >= 300) return null;
  const users = Array.isArray(data) ? data : (data && data.users) || [];
  const u = users.find((x) => x && x.email && x.email.toLowerCase() === email.toLowerCase());
  return u ? u.id : null;
}

/* Idempotente-de-verdad: si el email ya existe (422) ACTUALIZA password + app_metadata,
   así re-correr el seed deja a todos con la password/metadata actual (no la vieja). */
async function makeUser(email, appMeta, fullName) {
  const create = await gotrue(env, '/admin/users', {
    method: 'POST',
    body: { email, password: PW, email_confirm: true, app_metadata: appMeta, user_metadata: { full_name: fullName } }
  });
  if (create.status < 300 && create.data && create.data.id) { console.log(`  + ${email} creado (${appMeta.portal_role})`); return; }
  if (create.status === 422) {
    const id = await findUserId(email);
    if (!id) { console.log(`  = ${email} ya existe (no pude actualizar: id no hallado)`); return; }
    const upd = await gotrue(env, `/admin/users/${id}`, { method: 'PUT', body: { password: PW, app_metadata: appMeta, user_metadata: { full_name: fullName } } });
    console.log(upd.status < 300 ? `  ~ ${email} actualizado (password + metadata)` : `  ! ${email} update falló (${upd.status})`);
    return;
  }
  throw new Error(`user ${email} failed (${create.status})`);
}

/* Data demo: 1 cliente + 2 suscripciones atadas al org/store, para que las screens del portal
   (Subscribers / Customer Record) muestren contenido en vivo. Idempotente por stripe_subscription_id. */
async function ensureDemoData(orgId, storeId) {
  const email = 'customer1@rapqa.com';
  let custId = null;
  const cr = await gotrue(env, '/admin/users', { method: 'POST', body: { email, password: PW, email_confirm: true, user_metadata: { full_name: 'Jane Doe' } } });
  if (cr.status < 300 && cr.data && cr.data.id) custId = cr.data.id;
  else {
    const lg = await gotrue(env, '/token', { method: 'POST', query: { grant_type: 'password' }, body: { email, password: PW } });
    if (lg.status < 300 && lg.data && lg.data.access_token) custId = JSON.parse(Buffer.from(lg.data.access_token.split('.')[1], 'base64url').toString()).sub;
  }
  if (!custId) { console.log('  ! customer demo: no pude crear/obtener id'); return; }
  await pgrest(env, '/profiles', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { id: custId, email, full_name: 'Jane Doe', phone: '(615) 555-0148', address: '412 Elm St, Nashville, TN 37201' } });
  const subs = [
    { user_id: custId, kind: 'protection', tier: 'stain', status: 'active', monthly_cents: 999, started_at: '2026-05-14T00:00:00Z', stripe_subscription_id: 'sub_demo_1', master_no: 'RX-90001', dealer_id: orgId, sub_entity_id: storeId, sales_associate: 'A-07', sales_order_number: 'SO-88231', purchased_on: '2026-05-28', terms_version: 'v2026-05', maya_summary: 'Asked whether kid stains were covered; confirmed accidental damage is included.' },
    { user_id: custId, kind: 'protection', tier: 'stain_mech', status: 'active', monthly_cents: 1999, started_at: '2026-04-02T00:00:00Z', stripe_subscription_id: 'sub_demo_2', master_no: 'RX-90002', dealer_id: orgId, sub_entity_id: storeId, sales_associate: 'A-02', sales_order_number: 'SO-88190', purchased_on: '2026-04-10', terms_version: 'v2026-05', maya_summary: null }
  ];
  for (const s of subs) {
    const r = await pgrest(env, '/subscriptions', { method: 'POST', prefer: 'return=minimal', body: s });
    console.log(r.status === 201 ? `  + sub demo ${s.master_no}` : (r.status === 409 ? `  = sub demo ${s.master_no} ya existe` : `  ! sub demo ${s.master_no} status ${r.status}`));
  }
}

(async () => {
  const org = await ensureOrg();
  const store = await ensureStore(org.id);
  console.log(`org=${org.id} store=${store.id}`);

  await makeUser('admin@raptns.com',
    { portal_role: 'admin', world: null }, 'Alex Rivera');
  await makeUser('owner@rapqa.com',
    { portal_role: 'dealer', world: 'retailer', org_id: org.id, org_name: org.name }, 'Dana Reed');
  await makeUser('store@rapqa.com',
    { portal_role: 'store', world: 'retailer', org_id: org.id, org_name: org.name, sub_entity_id: store.id, sub_entity_name: store.name }, 'Sam Lee');

  await ensureDemoData(org.id, store.id);

  console.log(`\nSeed listo. Password de todos: ${PW}`);
})().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
