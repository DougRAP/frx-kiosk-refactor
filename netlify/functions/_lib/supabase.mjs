/* ============================================================================
 * _lib/supabase.mjs — acceso a Supabase con service_role (PostgREST + GoTrue Admin).
 * Sin SDK: fetch directo. Credenciales SOLO por env (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY). Todas las llamadas bypassan RLS (service_role).
 * ==========================================================================*/

'use strict';

function cfg(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return { url, key };
}

/* Llamada genérica a PostgREST (/rest/v1). Devuelve { status, data }.
 * No lanza por status != 2xx (el caller decide); sí lanza por fallo de red. */
export async function pgrest(env, path, { method = 'GET', prefer, body } = {}) {
  const { url, key } = cfg(env);
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}

/* Llamada a GoTrue (/auth/v1). Devuelve { status, data }.
 * Por defecto autentica como Admin (service_role). Si se pasa `bearer`, ese
 * token reemplaza al service_role en Authorization — necesario para validar
 * un JWT de usuario vía /auth/v1/user (ver _lib/auth.mjs.requireUser). */
export async function gotrue(env, path, { method = 'POST', body, query, bearer } = {}) {
  const { url, key } = cfg(env);
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${url}/auth/v1${path}${qs}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${bearer || key}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}

/* Sube bytes a Supabase Storage (object API, /storage/v1) con service_role. Espeja el patrón
 * de pgrest/gotrue (apikey + Bearer service_role) pero con cuerpo BINARIO y el content-type real
 * de la imagen. `objectPath` = ruta DENTRO del bucket. x-upsert:false (la key es un uuid → no
 * colisiona). Lanza en fallo. Devuelve la ruta completa `bucket/objectPath` (= receipt_path). */
export async function uploadToStorage(env, bucket, objectPath, bytes, contentType) {
  const { url, key } = cfg(env);
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': contentType, 'x-upsert': 'false' },
    body: bytes
  });
  if (res.status >= 200 && res.status < 300) return `${bucket}/${objectPath}`;
  let detail = '';
  try { detail = await res.text(); } catch { /* ignore */ }
  throw new Error(`storage upload failed (${res.status}) ${detail.slice(0, 200)}`);
}

/* Firma una URL TEMPORAL para un objeto de un bucket PRIVADO (Storage sign API). `objectPath` =
 * ruta DENTRO del bucket. Devuelve la URL ABSOLUTA firmada (vence en `expiresIn` seg) o null si
 * falla — FAIL-SOFT: el dashboard no debe romperse porque un recibo no se pueda firmar. */
export async function signStorageUrl(env, bucket, objectPath, expiresIn = 3600) {
  try {
    const { url, key } = cfg(env);
    const res = await fetch(`${url}/storage/v1/object/sign/${bucket}/${objectPath}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn })
    });
    if (res.status < 200 || res.status >= 300) return null;
    const j = await res.json().catch(() => null);
    const signed = j && j.signedURL;            // p.ej. "/object/sign/receipts/uuid.jpg?token=..."
    if (!signed) return null;
    if (signed.startsWith('http')) return signed;
    if (signed.startsWith('/storage/v1')) return `${url}${signed}`;
    return `${url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
  } catch { return null; }
}

/* Borra un objeto de un bucket (Storage object API). FAIL-SOFT: un objeto huérfano no debe
 * tumbar el borrado del registro en la BD. `objectPath` = ruta DENTRO del bucket. */
export async function deleteFromStorage(env, bucket, objectPath) {
  try {
    const { url, key } = cfg(env);
    await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
      method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
  } catch { /* best-effort */ }
}

/* Crea un SIGNED UPLOAD URL para que el navegador suba el archivo DIRECTO a Storage (sin pasar por
 * la función → sin el límite de payload de Netlify de ~6MB). Devuelve { upload_url } absoluto. Lanza en fallo. */
export async function createSignedUploadUrl(env, bucket, objectPath) {
  const { url, key } = cfg(env);
  const res = await fetch(`${url}/storage/v1/object/upload/sign/${bucket}/${objectPath}`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}'   // Supabase rechaza (400) si el content-type es json pero el body va vacío
  });
  if (res.status < 200 || res.status >= 300) {
    let detail = ''; try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`sign upload failed (${res.status}) ${detail.slice(0, 200)}`);   // incluye el motivo real (p.ej. "Bucket not found")
  }
  const j = await res.json().catch(() => null);
  const signed = j && (j.url || j.signedUrl);
  if (!signed) throw new Error('sign upload: no url in response');
  if (signed.startsWith('http')) return { upload_url: signed };
  if (signed.startsWith('/storage/v1')) return { upload_url: `${url}${signed}` };
  return { upload_url: `${url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}` };
}

/* Metadatos REALES de un objeto (size, mimetype) vía Storage list. null si no existe. Se usa para
 * validar server-side lo que el navegador subió — NUNCA confiar en lo que dice el cliente. */
export async function objectInfo(env, bucket, objectPath) {
  const { url, key } = cfg(env);
  const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100, prefix: '', search: objectPath })
  });
  if (res.status < 200 || res.status >= 300) return null;
  const arr = await res.json().catch(() => null);
  const row = Array.isArray(arr) ? arr.find((o) => o && o.name === objectPath) : null;
  if (!row) return null;
  const m = row.metadata || {};
  return { size: m.size != null ? Number(m.size) : null, mimetype: m.mimetype || null };
}

/* ---- LEADS ----------------------------------------------------------------*/

/* Inserta un lead de checkout desde los `fields` de validateCheckout.
 * Devuelve el uuid del lead. Lanza en fallo. */
export async function insertLead(env, fields) {
  const row = {
    source: 'other',                       // el enum lead_source no tiene 'checkout'
    email: fields.email,
    payload: {
      intent: 'checkout',
      plans: fields.plans || [],           // [{cov,term,type,count,tier,monthly_cents}]
      kits: fields.kits || [],             // [{sku,quantity,kit_id?,unit_price_cents?}] (resueltos en create-checkout-session)
      membership: !!fields.membership,     // registro de intención (cross-check); el cobro real lo decide Stripe/price-id
      full_name: fields.full_name || null,
      phone: fields.phone || null,
      address: fields.address || null,    // no existe columna en profiles → vive aquí
      sales_order_number: fields.order,
      receipt_zip: fields.zip,
      purchase_date: fields.date,           // KIOSK-1: en kiosk esta fecha es la delivery/coverage-start date
      sales_associate: fields.associate || null,  // KIOSK-1: nº de sales associate (atribución de dealer)
      receipt_path: fields.receipt_path || null,   // BE-1: ruta de la foto del recibo en Storage (bucket privado)
      terms_version: fields.terms_version || null, // PORT-4: T&C aceptado (server-stamped)
      maya_summary: fields.maya_summary || null,   // PORT-4: resumen del chat de Maya (opcional)
      /* PORT-9: atribución A/B resuelta SERVER-SIDE en _lib/checkout (jamás del body crudo).
         El webhook la copia a la subscription (dealer_id + attribution_source + referral_code). */
      dealer_id: fields.dealer_id || null,
      attribution_source: fields.attribution_source || null,
      referral_code: fields.referral_code || null
    }
  };
  const { status, data } = await pgrest(env, '/leads', {
    method: 'POST', prefer: 'return=representation', body: row
  });
  if (status >= 300 || !Array.isArray(data) || !data[0]) {
    throw new Error(`lead insert failed (${status})`);
  }
  return data[0].id;
}

export async function getLead(env, id) {
  const { status, data } = await pgrest(env, `/leads?id=eq.${encodeURIComponent(id)}&select=*`);
  if (status >= 300) throw new Error(`getLead failed (${status})`);
  return Array.isArray(data) && data[0] ? data[0] : null;
}

export async function linkLeadUser(env, id, userId) {
  await pgrest(env, `/leads?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', prefer: 'return=minimal', body: { user_id: userId }
  });
}

/* ---- KIOSK HANDOFFS (single-QR: recibo + pago en el teléfono) --------------*/

/* Crea un handoff efímero (config validado del carrito + summary para mostrar). Devuelve el uuid.
 * Lanza en fallo. La fila vence sola (expires_at default +15min). */
export async function insertHandoff(env, { config, summary }) {
  const { status, data } = await pgrest(env, '/kiosk_handoffs', {
    method: 'POST', prefer: 'return=representation',
    body: { config, summary: summary || null }
  });
  if (status >= 300 || !Array.isArray(data) || !data[0]) {
    throw new Error(`handoff insert failed (${status})`);
  }
  return data[0].id;
}

export async function getHandoff(env, id) {
  const { status, data } = await pgrest(env, `/kiosk_handoffs?id=eq.${encodeURIComponent(id)}&select=*`);
  if (status >= 300) throw new Error(`getHandoff failed (${status})`);
  return Array.isArray(data) && data[0] ? data[0] : null;
}

/* PATCH parcial. `guard` (opcional) = filtro extra de PostgREST (p.ej. 'status=eq.receipt_uploaded')
 * para serializar transiciones concurrentes: si no matcheó ninguna fila, devuelve null (otro tap ganó). */
export async function updateHandoff(env, id, patch, guard) {
  const q = `/kiosk_handoffs?id=eq.${encodeURIComponent(id)}${guard ? `&${guard}` : ''}`;
  const { status, data } = await pgrest(env, q, {
    method: 'PATCH', prefer: 'return=representation', body: patch
  });
  if (status >= 300) throw new Error(`updateHandoff failed (${status})`);
  return Array.isArray(data) && data[0] ? data[0] : null;
}

/* Purga oportunista de handoffs vencidos (la llama el endpoint create con random()<0.05). Fail-soft. */
export async function purgeExpiredHandoffs(env) {
  try {
    await pgrest(env, `/kiosk_handoffs?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, {
      method: 'DELETE', prefer: 'return=minimal'
    });
  } catch { /* best-effort */ }
}

/* ---- PROFILES / USERS -----------------------------------------------------*/

/* profiles.email es UNIQUE y profiles.id = auth.users.id → lo usamos como índice
 * por email (evita el lookup admin-by-email, poco estable en GoTrue). */
export async function getUserIdByEmail(env, email) {
  const { status, data } = await pgrest(
    env, `/profiles?email=eq.${encodeURIComponent(email)}&select=id`
  );
  if (status >= 300) throw new Error(`getUserIdByEmail failed (${status})`);
  return Array.isArray(data) && data[0] ? data[0].id : null;
}

/* Upsert idempotente. `contact` opcional (full_name, phone) — si viene null,
 * NO se sobrescriben los valores existentes (útil para reentregas de webhook). */
export async function upsertProfile(env, userId, email, contact) {
  const body = { id: userId, email };
  if (contact && contact.full_name) body.full_name = contact.full_name;
  if (contact && contact.phone) body.phone = contact.phone;
  const { status } = await pgrest(env, '/profiles', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body
  });
  if (status >= 300) throw new Error(`upsertProfile failed (${status})`);
}

/* AUTH-2: crea el usuario YA confirmado y CON contraseña (Admin API). NO envía email
 * (el welcome propio sale por _lib/email desde el webhook, con la password temporal).
 * user_metadata lleva must_change_password:true → auth-login/auth-otp lo propagan y el
 * front fuerza el cambio en el primer login. Devuelve { id } o lanza.
 * status 422 = el email ya existe → { exists: true } (carrera/recurrente, como inviteUser). */
export async function createUserWithPassword(env, email, password, userMetadata) {
  const { status, data } = await gotrue(env, '/admin/users', {
    method: 'POST',
    body: { email, password, email_confirm: true, user_metadata: userMetadata || {} }
  });
  if (status === 422) return { exists: true };
  if (status >= 300 || !data || !data.id) throw new Error(`createUserWithPassword failed (${status})`);
  return { id: data.id };
}

/* Invita por email: crea el usuario (estado "invited", email NO confirmado) y
 * Supabase ENVÍA el correo de activación (SMTP). Devuelve { id } o lanza.
 * status 422 = el email ya existe (lo maneja el caller como carrera/recurrente).
 * NOTA AUTH-2: el webhook ya NO invita — crea con createUserWithPassword. Se conserva
 * por si algún flujo futuro necesita el invite clásico de GoTrue. */
export async function inviteUser(env, email, redirectTo) {
  const { status, data } = await gotrue(env, '/invite', {
    method: 'POST', body: { email }, query: redirectTo ? { redirect_to: redirectTo } : undefined
  });
  if (status === 422) return { exists: true };
  if (status >= 300 || !data || !data.id) throw new Error(`inviteUser failed (${status})`);
  return { id: data.id };
}

/* Para clientes recurrentes (ya tienen cuenta): envía email de recovery (SMTP)
 * para que entren / restablezcan password. */
export async function sendRecovery(env, email, redirectTo) {
  const { status } = await gotrue(env, '/recover', {
    method: 'POST', body: { email }, query: redirectTo ? { redirect_to: redirectTo } : undefined
  });
  if (status >= 300) throw new Error(`sendRecovery failed (${status})`);
}

/* ---- SUBSCRIPTIONS / PIECES -----------------------------------------------*/

/* INSERT plano (sin merge) → distinguimos insert real (201) de reentrega (409 por
 * stripe_subscription_id UNIQUE). Devuelve { created:boolean }. */
export async function insertSubscription(env, row) {
  const { status, data } = await pgrest(env, '/subscriptions', {
    method: 'POST', prefer: 'return=representation', body: row
  });
  if (status === 201) return { created: true, row: Array.isArray(data) ? data[0] : null };
  if (status === 409) return { created: false };   // ya procesada (reentrega) → idempotente
  throw new Error(`insertSubscription failed (${status})`);
}

/* Expande {sofa:2, bed:1} a filas individuales y las inserta. Sin tope de piezas
 * desde UNLIM-1 (Doug 06-jul); el trigger trg_piece_limit se dropea en la migración 20260706200000. Solo se llama en el insert real. */
export async function insertCoveredPieces(env, subscriptionId, pieces, purchasedOn) {
  const rows = [];
  for (const [type, qty] of Object.entries(pieces || {})) {
    for (let i = 0; i < qty; i++) {
      rows.push({ subscription_id: subscriptionId, piece_type: type, purchased_at: purchasedOn });
    }
  }
  if (!rows.length) return;
  const { status } = await pgrest(env, '/covered_pieces', {
    method: 'POST', prefer: 'return=minimal', body: rows
  });
  if (status >= 300) throw new Error(`insertCoveredPieces failed (${status})`);
}

/* SUB-2 — ciclo de vida: PATCH MASIVO por stripe_subscription_id (una compra de Stripe
 * puede tener VARIAS filas nuestras — una por item/cobertura + membership — y todas
 * comparten el mismo sub.id, así que el estado se refleja en bloque). Devuelve cuántas
 * filas tocó; 0 filas = suscripción ajena a esta BD (test-mode, otro entorno) → NORMAL,
 * no es error. Solo lanza en fallo real de PostgREST (≥300) → el webhook responde 500
 * y Stripe reintenta. */
export async function updateSubscriptionsByStripeId(env, stripeSubscriptionId, patch) {
  const { status, data } = await pgrest(env, `/subscriptions?stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`, {
    method: 'PATCH', prefer: 'return=representation', body: patch
  });
  if (status >= 300) throw new Error(`updateSubscriptionsByStripeId failed (${status})`);
  return Array.isArray(data) ? data.length : 0;   // 0 filas = sub ajena (OK, no es error)
}

/* ---- SERIALIZACIÓN (opción B) ---------------------------------------------*/

/* Master# del plan (RX-#####). Estable: una compra de Stripe = un master#, compartido por
 * sus filas de protección. IDEMPOTENTE ante reintentos parciales del webhook: si ya hay una
 * fila con este stripe_subscription_id + master_no, lo REUSA; si no, pide el siguiente a la
 * secuencia (RPC next_master_no). Así un reintento tras insertar solo parte de las filas no
 * genera un nº distinto. */
export async function getOrAssignMasterNo(env, stripeSubscriptionId) {
  const q = `/subscriptions?stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`
    + `&master_no=not.is.null&select=master_no&limit=1`;
  const { status, data } = await pgrest(env, q);
  if (status < 300 && Array.isArray(data) && data[0] && data[0].master_no) return data[0].master_no;

  const r = await pgrest(env, '/rpc/next_master_no', { method: 'POST', body: {} });
  if (r.status >= 300) throw new Error(`next_master_no failed (${r.status})`);
  const mn = typeof r.data === 'string' ? r.data : (Array.isArray(r.data) ? r.data[0] : r.data);
  if (!mn || typeof mn !== 'string') throw new Error('next_master_no returned empty');
  return mn;
}

/* Devuelve {master_no, user_id} de una fila de protección de esa suscripción de Stripe (o null
 * si la suscripción no tiene plan serializado — p.ej. membership standalone). Lo usa el listener
 * de invoice.paid para colgar el certificado del ciclo. */
export async function getPlanBySubscription(env, stripeSubscriptionId) {
  const q = `/subscriptions?stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`
    + `&kind=eq.protection&master_no=not.is.null&select=master_no,user_id&limit=1`;
  const { status, data } = await pgrest(env, q);
  if (status < 300 && Array.isArray(data) && data[0]) return data[0];
  return null;
}

/* Nº de certificados ya emitidos para una suscripción de Stripe → deriva el sequence_no del
 * próximo ciclo (count + 1). */
export async function countCertificates(env, stripeSubscriptionId) {
  const q = `/coverage_certificates?stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}&select=id`;
  const { status, data } = await pgrest(env, q);
  return (status < 300 && Array.isArray(data)) ? data.length : 0;
}

/* INSERT de un certificado de ciclo. Idempotente por stripe_invoice_id UNIQUE (409 = ya emitido)
 * y por serial UNIQUE. Devuelve { created }. */
export async function insertCoverageCertificate(env, row) {
  const { status } = await pgrest(env, '/coverage_certificates', {
    method: 'POST', prefer: 'return=minimal', body: row
  });
  if (status === 201) return { created: true };
  if (status === 409) return { created: false };   // reentrega (invoice/serial ya emitido)
  throw new Error(`insertCoverageCertificate failed (${status})`);
}

/* ---- ORDERS / CARE KITS ----------------------------------------------------*/

/* Catálogo canónico de kits: resuelve sku → { id, price_cents } desde care_kits
 * (solo activos). Devuelve un mapa { [sku]: {id, price_cents} }. El precio del kit
 * SIEMPRE sale de aquí, nunca del cliente. */
export async function getCareKitsBySku(env, skus) {
  const list = (skus || []).filter(Boolean);
  if (!list.length) return {};
  const inList = list.map(encodeURIComponent).join(',');
  const { status, data } = await pgrest(env, `/care_kits?sku=in.(${inList})&active=eq.true&select=id,sku,name,price_cents`);
  if (status >= 300) throw new Error(`getCareKitsBySku failed (${status})`);
  const map = {};
  if (Array.isArray(data)) for (const k of data) map[k.sku] = { id: k.id, name: k.name, price_cents: k.price_cents };
  return map;
}

/* INSERT plano de una orden (kits, pago único). Idempotente por
 * orders.stripe_payment_intent_id UNIQUE: 201 = insert real, 409 = reentrega.
 * Devuelve { created, row }. */
export async function insertOrder(env, row) {
  const { status, data } = await pgrest(env, '/orders', {
    method: 'POST', prefer: 'return=representation', body: row
  });
  if (status === 201) return { created: true, row: Array.isArray(data) ? data[0] : null };
  if (status === 409) return { created: false };   // reentrega (payment_intent ya registrado)
  throw new Error(`insertOrder failed (${status})`);
}

/* Inserta las líneas de una orden. items = [{kit_id, quantity, unit_price_cents, sh_cents?}].
 * sh_cents (BE-5): lo calcula el CALLER con kitCharges() — aquí solo se persiste (evita el
 * import circular checkout↔supabase). Solo se llama en el insert real de la orden. */
export async function insertOrderItems(env, orderId, items) {
  const rows = (items || []).map((it) => ({
    order_id: orderId,
    kit_id: it.kit_id,
    quantity: it.quantity,
    unit_price_cents: it.unit_price_cents,
    sh_cents: it.sh_cents == null ? null : it.sh_cents
  }));
  if (!rows.length) return;
  const { status } = await pgrest(env, '/order_items', {
    method: 'POST', prefer: 'return=minimal', body: rows
  });
  if (status >= 300) throw new Error(`insertOrderItems failed (${status})`);
}

/* ---- PORT-6: audit trail (append-only). FAIL-SOFT: un fallo del audit NUNCA tumba la
   operación principal (pero se loguea para que un fallo sostenido sea visible). ---- */
export async function writeAudit(env, row) {
  try {
    const { status } = await pgrest(env, '/audit_events', { method: 'POST', prefer: 'return=minimal', body: row });
    if (status >= 300) console.warn('[audit] insert status', status);
  } catch (err) { console.warn('[audit] fail-soft:', err.message); }
}
