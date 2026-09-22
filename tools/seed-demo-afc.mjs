/* ============================================================================
 * SIEMBRA de Acme Furniture Company para la demo de Doug (llamada 16/17-jul).
 *
 * Qué crea (TODO con aspecto de dealer real, nada dice "demo" — decisión Adrian):
 *   - dealer "Acme Furniture Company" (rap_id AFC-1001) + 3 stores + 12 associates
 *   - referral code ACM-7K4M + commission_rates $8 cash / $0 reinsurance (stain_mech)
 *   - N clientes (default 1000) con cuenta GoTrue real (email_confirm → NO envía correo),
 *     emails nombre.apellido+afc####@rapqa.com (dominio propio: un "Resend dashboard
 *     link" en plena demo cae en casa, jamás a un desconocido)
 *   - N subscriptions $19.99 (stain_mech) abiertas hace ~1 año (330-400 días), ~4%
 *     canceladas, master_no REAL vía next_master_no() (decisión: secuencia se resetea
 *     o continúa después, lo ejecuta Adrian)
 *   - ~12 pagos mensuales por sub en commission_ledger ($8 cash / $0 rein, transferred)
 *     con paid_at backdated — el portal lee de aquí, por eso la historia SÍ se ve
 *   - 1 lead por sub con el referral code (para que "Uses" cuadre en el portal)
 *
 * Stripe: los pagos históricos NO existen en Stripe (imposible backdatear). Opcional
 * --fund-stripe: fondea el balance test de la plataforma y hace UN transfer por el
 * total cash a la Connect de Acme, para que el balance de HOY cuadre si alguien abre
 * el dashboard de Stripe.
 *
 * REGLAS: idempotente (re-ejecutable; detecta lo ya sembrado por email +afc y por el
 * UNIQUE del ledger) y JAMÁS borra nada. RNG determinista → mismos nombres siempre.
 *
 * Uso:
 *   node tools/seed-demo-afc.mjs --plan            # imprime el plan, no toca nada
 *   node tools/seed-demo-afc.mjs --count 10        # ensayo chico
 *   node tools/seed-demo-afc.mjs                   # los 1000
 *   node tools/seed-demo-afc.mjs --fund-stripe     # además, transfer test del total
 * ==========================================================================*/

'use strict';

import { readFileSync } from 'node:fs';

/* ---- args ---- */
const args = process.argv.slice(2);
const PLAN = args.includes('--plan');
const FUND = args.includes('--fund-stripe');
const COUNT = args.includes('--count') ? Math.max(1, parseInt(args[args.indexOf('--count') + 1], 10) || 1000) : 1000;

if (PLAN) {
  console.log(`seed-demo-afc — PLAN (nada se ejecuta):
  1. dealer Acme Furniture Company (AFC-1001) + 3 stores (Dallas/Houston/Austin) + code ACM-7K4M
  2. commission_rates AFC: stain_mech $8 cash / $0 reinsurance (stain $2/$0)
  3. ${COUNT} clientes GoTrue+profiles (nombre.apellido+afc####@rapqa.com, sin emails salientes)
  4. ${COUNT} subscriptions $19.99 abiertas hace 330-400 días (~4% canceladas), master_no real RX-#####
  5. ~${COUNT * 12} pagos mensuales backdated en commission_ledger ($8/$0, transferred) + ${COUNT} leads
  6. ${FUND ? 'transfer test del total cash a la Connect de Acme' : '(sin --fund-stripe: Stripe no se toca)'}
  Idempotente, cero DELETE.`);
  process.exit(0);
}

/* ---- env (.env local, mismo mecanismo que smoke-circuit-live) ---- */
const env = {};
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('FALTA .env (SUPABASE_URL / SERVICE_ROLE_KEY)'); process.exit(2); }
if (FUND && !(env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')) { console.error('--fund-stripe exige STRIPE_SECRET_KEY sk_test_ (jamás live)'); process.exit(2); }

const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
async function db(path, opts = {}) {
  const res = await fetch(env.SUPABASE_URL + '/rest/v1' + path, {
    method: opts.method || 'GET',
    headers: { ...H, ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let data = null; const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}
async function gotrueAdmin(path, body) {
  const res = await fetch(env.SUPABASE_URL + '/auth/v1' + path, {
    method: 'POST', headers: H, body: JSON.stringify(body)
  });
  let data = null; try { data = await res.json(); } catch { /* vacío */ }
  return { status: res.status, data };
}

/* ---- RNG determinista (mulberry32): mismos nombres/fechas en cada corrida ---- */
let rngState = 20260717;
function rng() { rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0; let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
function weighted(pairs) { const r = rng(); let acc = 0; for (const [v, w] of pairs) { acc += w; if (r < acc) return v; } return pairs[pairs.length - 1][0]; }

const FIRST = ['James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Daniel', 'Lisa', 'Matthew', 'Nancy', 'Anthony', 'Betty', 'Mark', 'Sandra', 'Steven', 'Ashley', 'Andrew', 'Emily', 'Paul', 'Donna', 'Joshua', 'Kimberly', 'Kenneth', 'Michelle', 'Kevin', 'Carol', 'Brian', 'Amanda', 'George', 'Melissa', 'Timothy', 'Deborah', 'Ronald', 'Stephanie', 'Jason', 'Rebecca', 'Edward', 'Sharon', 'Jeffrey', 'Laura', 'Ryan', 'Cynthia', 'Jacob', 'Amy', 'Gary', 'Kathleen', 'Nicholas', 'Angela', 'Eric', 'Shirley', 'Jonathan', 'Brenda', 'Stephen', 'Emma', 'Larry', 'Anna', 'Justin', 'Pamela', 'Scott', 'Nicole', 'Brandon', 'Samantha', 'Benjamin', 'Katherine', 'Samuel', 'Christine'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts', 'Gomez', 'Phillips', 'Evans', 'Turner', 'Diaz', 'Parker', 'Cruz', 'Edwards', 'Collins', 'Reyes', 'Stewart', 'Morris', 'Morales', 'Murphy', 'Cook', 'Rogers', 'Gutierrez', 'Ortiz', 'Morgan', 'Cooper', 'Peterson', 'Bailey', 'Reed', 'Kelly', 'Howard', 'Ramos', 'Kim', 'Cox', 'Ward', 'Richardson'];
const STREETS = ['Oak', 'Maple', 'Cedar', 'Elm', 'Pine', 'Walnut', 'Willow', 'Magnolia', 'Pecan', 'Sycamore', 'Juniper', 'Hickory'];
const STYPES = ['St', 'Ave', 'Dr', 'Ln', 'Ct', 'Blvd'];
const CITIES = [['Dallas', 'TX', '75201'], ['Houston', 'TX', '77002'], ['Austin', 'TX', '78701'], ['Fort Worth', 'TX', '76102'], ['Plano', 'TX', '75024'], ['Arlington', 'TX', '76010']];
const PIECES = [['furniture', 0.55], ['mattress', 0.75], ['rugs', 0.88], ['outdoor', 0.96], ['adjbed', 1]];

const NOW = Date.now();
const DAY = 86400000, MONTH = 30.44 * DAY;
const iso = (ms) => new Date(ms).toISOString();
const pad = (n, l) => String(n).padStart(l, '0');
/* ids con formato Stripe verosímil, deterministas por índice (nada dice demo) */
const b36 = (i, salt) => (Math.imul(i + 7919, salt) >>> 0).toString(36) + (i + 1000).toString(36);
const subId = (i) => 'sub_1Rf' + b36(i, 2654435761).slice(0, 10).padEnd(10, 'k') + pad(i, 4);
const invId = (i, m) => 'in_1Rf' + b36(i, 40503).slice(0, 8).padEnd(8, 'q') + pad(i, 4) + 'M' + pad(m, 2);
const trId = (i, m) => 'tr_1Rf' + b36(i, 65599).slice(0, 8).padEnd(8, 'z') + pad(i, 4) + pad(m, 2);

const created = [];
const log = (s) => console.log('  ' + s);
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length); let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  console.log(`seed-demo-afc — sembrando ${COUNT} clientes de Acme Furniture Company\n`);

  /* 1) dealer + stores + code + rates */
  let d = (await db('/dealers?slug=eq.acme-furniture-company&select=id,name&limit=1')).data;
  let org = d && d[0];
  if (!org) {
    const ins = await db('/dealers', {
      method: 'POST', prefer: 'return=representation',
      body: {
        /* Doug en la llamada: "We need to use some RAP Company, RAP furniture company".
           El slug y los ids AFC se conservan (internos); solo el nombre es marca visible. */
        name: 'RAP Furniture Company', slug: 'acme-furniture-company', world: 'retailer',
        rap_id: 'AFC-1001', frx_account_id: 'FRX-AFC-1001',
        hq_address: '2400 Commerce St, Dallas, TX 75201',
        key_contacts: [
          { role: 'Owner', name: 'Walt Bennett', email: 'walt.bennett@rapqa.com', phone: '(214) 555-0180' },
          { role: 'Controller', name: 'Rita Vaughn', email: 'rita.vaughn@rapqa.com', phone: '(214) 555-0181' }
        ],
        selling_enabled: true, dashboard_enabled: true,
        stripe_account_id: env.AFC_STRIPE_ACCOUNT || 'acct_1TuCBULa50kgn8p1'
      }
    });
    org = ins.data && ins.data[0];
    if (!org) throw new Error('dealer insert failed: ' + JSON.stringify(ins.data).slice(0, 200));
    created.push('dealer ' + org.id);
  }
  log(`dealer: ${org.id} (Acme Furniture Company)`);

  const storeNames = ['RAP Furniture — Dallas', 'RAP Furniture — Houston', 'RAP Furniture — Austin'];
  const stores = [];
  for (const name of storeNames) {
    let s = (await db(`/sub_entities?org_id=eq.${org.id}&name=eq.${encodeURIComponent(name)}&select=id&limit=1`)).data;
    if (!(s && s[0])) {
      const ins = await db('/sub_entities', { method: 'POST', prefer: 'return=representation', body: { org_id: org.id, world: 'retailer', name, location: name.split('— ')[1] + ', TX', status: 'active' } });
      s = ins.data; created.push('store ' + name);
    }
    stores.push(s[0].id);
  }
  log(`stores: ${stores.length}`);

  const CODE = 'ACM-7K4M';
  const c = (await db(`/referral_codes?code=eq.${CODE}&select=code&limit=1`)).data;
  if (!(c && c[0])) { await db('/referral_codes', { method: 'POST', prefer: 'return=minimal', body: { code: CODE, org_id: org.id, active: true, label: 'Acme website' } }); created.push('code ' + CODE); }
  log(`referral code: ${CODE}`);

  for (const [sku, cash] of [['stain_mech', 800], ['stain', 200]]) {
    const r = (await db(`/commission_rates?org_id=eq.${org.id}&plan_sku=eq.${sku}&select=id&limit=1`)).data;
    if (!(r && r[0])) { await db('/commission_rates', { method: 'POST', prefer: 'return=minimal', body: { org_id: org.id, plan_sku: sku, stripe_amount_cents: cash, reinsurance_amount_cents: 0 } }); created.push('rate ' + sku); }
  }
  log('commission split: $8 cash / $0 reinsurance (Doug: "all eight dollars goes to Stripe")');

  /* 2) los N clientes (deterministas) */
  const people = [];
  const seen = new Set();
  for (let i = 0; i < COUNT; i++) {
    let first, last, key;
    do { first = pick(FIRST); last = pick(LAST); key = first + last; } while (seen.has(key) && seen.size < FIRST.length * LAST.length - 5);
    seen.add(key);
    const email = `${first.toLowerCase()}.${last.toLowerCase()}+afc${pad(i + 1, 4)}@rapqa.com`;
    const [city, st, zip] = pick(CITIES);
    people.push({
      i, first, last, email, full_name: `${first} ${last}`,
      phone: `(${pick(['214', '713', '512', '817'])}) 555-${pad(Math.floor(rng() * 10000), 4)}`,
      address: `${100 + Math.floor(rng() * 9800)} ${pick(STREETS)} ${pick(STYPES)}, ${city}, ${st} ${zip}`,
      startedAt: NOW - (330 + rng() * 70) * DAY,                    // "todas abiertas hace un año"
      canceled: rng() < 0.04,
      store: weighted([[stores[0], 0.5], [stores[1], 0.8], [stores[2], 1]]),
      associate: 'A-' + pad(1 + Math.floor(rng() * 12), 2),
      order: 'AFC-' + pad(100000 + Math.floor(rng() * 899999), 6),
      zip
    });
  }

  /* 3) GoTrue + profiles (idempotente por email; email_confirm → sin correos) */
  const existing = (await db(`/profiles?email=like.*%2Bafc*%40rapqa.com&select=id,email&limit=${COUNT * 2}`)).data || [];
  const byEmail = {}; for (const p of existing) byEmail[p.email] = p.id;
  let newUsers = 0;
  await mapWithConcurrency(people, 10, async (p) => {
    if (byEmail[p.email]) { p.userId = byEmail[p.email]; return; }
    const r = await gotrueAdmin('/admin/users', {
      email: p.email, password: 'Frx-' + b36(p.i, 9176).slice(0, 10), email_confirm: true,
      user_metadata: { full_name: p.full_name }
    });
    if (r.status < 300 && r.data && r.data.id) { p.userId = r.data.id; newUsers++; }
    else if (r.status === 422) {   // ya existía en auth sin profile → recupéralo por profiles después
      const q = await db(`/profiles?email=eq.${encodeURIComponent(p.email)}&select=id&limit=1`);
      p.userId = q.data && q.data[0] && q.data[0].id;
    }
    if (!p.userId) console.warn('  !! sin userId para ' + p.email + ' (status ' + r.status + ')');
  });
  const withUser = people.filter((p) => p.userId);
  log(`usuarios GoTrue: ${withUser.length}/${COUNT} (${newUsers} nuevos)`);

  for (let ofs = 0; ofs < withUser.length; ofs += 500) {
    const batch = withUser.slice(ofs, ofs + 500).map((p) => ({ id: p.userId, email: p.email, full_name: p.full_name, phone: p.phone, address: p.address }));
    const r = await db('/profiles?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: batch });
    if (r.status >= 300) throw new Error('profiles batch failed ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
  }
  log('profiles: ok');

  /* 4) subscriptions (skip si el user ya tiene una de Acme) + master_no real */
  const have = (await db(`/subscriptions?dealer_id=eq.${org.id}&select=user_id&limit=${COUNT * 2}`)).data || [];
  const hasSub = new Set(have.map((s) => s.user_id));
  const toCreate = withUser.filter((p) => !hasSub.has(p.userId));
  log(`subscriptions a crear: ${toCreate.length} (${withUser.length - toCreate.length} ya existían)`);

  let subsCreated = 0;
  await mapWithConcurrency(toCreate, 10, async (p) => {
    const m = await db('/rpc/next_master_no', { method: 'POST', body: {} });
    const masterNo = typeof m.data === 'string' ? m.data : null;
    if (!masterNo) { console.warn('  !! sin master_no (status ' + m.status + ')'); return; }
    const canceledAt = p.canceled ? p.startedAt + (60 + rng() * 240) * DAY : null;
    const ins = await db('/subscriptions', {
      method: 'POST', prefer: 'return=representation',
      body: {
        user_id: p.userId, kind: 'protection', tier: 'stain_mech',
        status: p.canceled ? 'canceled' : 'active',
        started_at: iso(p.startedAt), canceled_at: canceledAt ? iso(canceledAt) : null,
        monthly_cents: 1999,
        stripe_subscription_id: subId(p.i), stripe_subscription_item_id: 'si_' + b36(p.i, 3121).slice(0, 12),
        master_no: masterNo, sales_order_number: p.order, sales_associate: p.associate,
        receipt_zip: p.zip, purchased_on: iso(p.startedAt).slice(0, 10),
        dealer_id: org.id, sub_entity_id: p.store,
        attribution_source: 'referral_code', referral_code: CODE,
        terms_version: 'v2026-05'   // la genérica vigente (lo que termsFor resolvería sin fila custom)
      }
    });
    if (ins.status === 201 && Array.isArray(ins.data) && ins.data[0]) {
      p.subRowId = ins.data[0].id; p.masterNo = masterNo; p.canceledAt = canceledAt; subsCreated++;
    } else if (ins.status !== 409) console.warn('  !! sub failed ' + ins.status + ' ' + JSON.stringify(ins.data).slice(0, 120));
  });
  log(`subscriptions creadas: ${subsCreated}`);

  /* 5) covered_pieces (solo subs nuevas) */
  const pieceRows = [];
  for (const p of toCreate) {
    if (!p.subRowId) continue;
    const n = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) pieceRows.push({ subscription_id: p.subRowId, piece_type: weighted(PIECES), purchased_at: iso(p.startedAt).slice(0, 10) });
  }
  for (let ofs = 0; ofs < pieceRows.length; ofs += 500) {
    const r = await db('/covered_pieces', { method: 'POST', prefer: 'return=minimal', body: pieceRows.slice(ofs, ofs + 500) });
    if (r.status >= 300) throw new Error('covered_pieces batch failed ' + r.status);
  }
  log(`covered_pieces: ${pieceRows.length}`);

  /* 6) ledger: un pago de $8/$0 por mes desde el alta hasta hoy (o el cancel).
   * Idempotente por el UNIQUE (stripe_invoice_id, plan_sku) + ignore-duplicates. */
  const ledger = [];
  let totalCash = 0;
  for (const p of withUser) {
    const end = p.canceled ? (p.canceledAt || p.startedAt + 300 * DAY) : NOW;
    for (let m = 0; ; m++) {
      const paidAt = p.startedAt + m * MONTH;
      if (paidAt > end || paidAt > NOW) break;
      ledger.push({
        stripe_invoice_id: invId(p.i, m), stripe_subscription_id: subId(p.i), org_id: org.id,
        plan_sku: 'stain_mech', qty: 1, stripe_amount_cents: 800, reinsurance_amount_cents: 0,
        transfer_id: trId(p.i, m), status: 'transferred', paid_at: iso(paidAt)
      });
      totalCash += 800;
    }
  }
  let ledgerInserted = 0;
  for (let ofs = 0; ofs < ledger.length; ofs += 500) {
    const batch = ledger.slice(ofs, ofs + 500);
    const r = await db('/commission_ledger?on_conflict=stripe_invoice_id,plan_sku', {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: batch
    });
    if (r.status >= 300) throw new Error('ledger batch failed ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
    ledgerInserted += batch.length;
    if (ofs % 2000 === 0) log(`ledger… ${ofs + batch.length}/${ledger.length}`);
  }
  log(`ledger: ${ledger.length} pagos, cash total $${(totalCash / 100).toLocaleString('en-US')}`);

  /* 7) leads (solo para subs nuevas: Uses del código en el portal) */
  const leadRows = toCreate.filter((p) => p.subRowId).map((p) => ({
    source: 'other', email: p.email,
    payload: {
      intent: 'checkout', plans: [{ cov: 'stain-mech', term: 'monthly', type: 'furniture', count: 1, tier: 'stain_mech', monthly_cents: 1999 }],
      full_name: p.full_name, phone: p.phone, address: p.address,
      sales_order_number: p.order, receipt_zip: p.zip, purchase_date: iso(p.startedAt).slice(0, 10),
      sales_associate: p.associate, dealer_id: org.id, attribution_source: 'referral_code', referral_code: CODE
    }
  }));
  for (let ofs = 0; ofs < leadRows.length; ofs += 500) {
    const r = await db('/leads', { method: 'POST', prefer: 'return=minimal', body: leadRows.slice(ofs, ofs + 500) });
    if (r.status >= 300) throw new Error('leads batch failed ' + r.status);
  }
  log(`leads: ${leadRows.length}`);

  /* 8) opcional: que el balance de Stripe de HOY cuadre (un transfer por el total) */
  if (FUND) {
    const acct = env.AFC_STRIPE_ACCOUNT || 'acct_1TuCBULa50kgn8p1';
    const sk = env.STRIPE_SECRET_KEY;
    const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const call = async (path, body) => {
      const res = await fetch('https://api.stripe.com/v1' + path, {
        method: 'POST', headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body)
      });
      return { status: res.status, data: await res.json() };
    };
    /* fondear el balance disponible de la plataforma con la tarjeta test bypass-pending */
    const pi = await call('/payment_intents', {
      amount: totalCash, currency: 'usd', confirm: 'true', payment_method: 'pm_card_bypassPending',
      'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never',
      description: 'Platform balance funding'
    });
    if (pi.status >= 300) { console.warn('  !! funding falló: ' + JSON.stringify(pi.data && pi.data.error && pi.data.error.message)); }
    else {
      const tr = await call('/transfers', { amount: totalCash, currency: 'usd', destination: acct, description: 'Accumulated commission payout — Acme Furniture Company' });
      if (tr.status < 300) log(`Stripe: transfer ${tr.data.id} de $${(totalCash / 100).toLocaleString('en-US')} a ${acct}`);
      else console.warn('  !! transfer falló: ' + JSON.stringify(tr.data && tr.data.error && tr.data.error.message));
    }
  }

  console.log(`\nLISTO. Acme Furniture Company (org ${org.id})
  clientes: ${withUser.length} · subs nuevas: ${subsCreated} · pagos: ${ledger.length} · cash: $${(totalCash / 100).toLocaleString('en-US')}
  referral code: ${CODE} · login demo del portal: como admin, "Viewing: Acme Furniture Company"
  ${created.length ? 'creado ahora: ' + created.slice(0, 8).join(', ') + (created.length > 8 ? '…' : '') : 'todo existía (corrida idempotente)'}`);
}

main().catch((e) => { console.error('SEED FALLÓ:', e.message); process.exit(1); });
