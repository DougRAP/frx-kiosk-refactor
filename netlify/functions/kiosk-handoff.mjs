/* ============================================================================
 * /.netlify/functions/kiosk-handoff   (single-QR: recibo + pago en el teléfono)
 * ----------------------------------------------------------------------------
 * POST (create): el KIOSK arma la venta → crea un handoff efímero → { token, summary, expires_at }.
 *   El kiosk pinta el QR = <su-origin>/?h=<token> (token OPACO, sin PII) y polea el GET.
 * POST { action:'attach', token, receipt_path }: el TELÉFONO ya subió el recibo (a /upload-receipt)
 *   → lo ata al handoff.
 * GET ?h=<token>[&has_preview=1]: estado UNIFICADO — lo polea el kiosk (y el teléfono lo usa para el
 *   summary). Devuelve { status, summary, receipt_preview_url?, done?, expired? }. UN poll cubre
 *   recibo + pago. Fail-soft en el chequeo de pago (como checkout-status). Rate-limit por acción.
 * ==========================================================================*/

'use strict';

import { validateCheckout, RECEIPT_PATH_RE } from './_lib/validate.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { signHandoffToken, verifyHandoffToken } from './_lib/token.mjs';
import { insertHandoff, getHandoff, updateHandoff, purgeExpiredHandoffs, signStorageUrl } from './_lib/supabase.mjs';
import { getStripe } from './_lib/stripe.mjs';

const MAX_BODY_BYTES = 4096;

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...(headers || {}) } });
}

/* Resumen para pintar en el teléfono/kiosk. total = MENSUAL (planes + membership); los kits
 * (one-time) los cobra Stripe en la 1ª factura. Sin PII sensible (solo primer nombre).
 * MEM-7 (14-ago): la membership del carrito es SIEMPRE la de pago ($19.99); la incluida con el
 * plan es un entitlement, no viaja en el carrito, así que el total del teléfono espeja Stripe. */
function summarize(fields) {
  const membershipCents = fields.membership ? 1999 : 0;
  const plansTotal = (fields.plans || []).reduce((s, p) => s + (p.monthly_cents || 0) * p.count, 0);
  return {
    first_name: (fields.full_name || '').trim().split(/\s+/)[0] || '',
    lines: (fields.plans || []).map((p) => ({ cov: p.cov, count: p.count, monthly_cents: p.monthly_cents })),
    membership: !!fields.membership,
    total_cents: plansTotal + membershipCents,
    mode: fields.kitsOnly ? 'kit' : 'plan'
  };
}

const isExpired = (row) => !row || (row.expires_at && new Date(row.expires_at).getTime() < Date.now());

async function readJson(req) {
  const ctype = req.headers.get('content-type') || '';
  if (!ctype.includes('application/json')) return { err: json(415, { error: 'unsupported_media_type' }) };
  let raw;
  try { raw = await req.text(); } catch { return { err: json(400, { error: 'unreadable_body' }) }; }
  if (raw.length > MAX_BODY_BYTES) return { err: json(400, { error: 'body_too_large' }) };
  try { return { body: JSON.parse(raw) }; } catch { return { err: json(400, { error: 'invalid_json' }) }; }
}

export default async function handler(req) {
  const env = process.env;
  const secret = env.DASHBOARD_LINK_SECRET;
  const ip = clientIp(req);

  /* ---- GET: estado unificado (kiosk poll + teléfono summary) ---- */
  if (req.method === 'GET') {
    const rl = await checkRate(env, { prefix: 'handoff_status', ip, limit: 60, windowSec: 60 });
    if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

    const u = new URL(req.url);
    const v = verifyHandoffToken(u.searchParams.get('h') || '', secret);
    if (!v) return json(400, { error: 'invalid_token' });
    const hasPreview = u.searchParams.get('has_preview') === '1';

    let row;
    try { row = await getHandoff(env, v.id); } catch { return json(200, { status: 'pending' }); }   // fail-soft: el poll sigue
    if (isExpired(row)) return json(200, { expired: true });

    const out = { status: row.status, summary: row.summary || null };
    /* receipt_path crudo → el kiosk lo inyecta en el checkout NORMAL (modo solo-recibo). Solo al portador del token. */
    if (row.receipt_path) out.receipt_path = row.receipt_path;
    /* Preview del recibo (bucket PRIVADO) — firmar solo si el kiosk aún no lo pintó (perf). */
    if (row.receipt_path && !hasPreview) {
      out.receipt_preview_url = await signStorageUrl(env, 'receipts', row.receipt_path.replace(/^receipts\//, ''), 600);
    }
    /* Estado de pago (solo si ya hay sesión). Fail-soft como checkout-status. */
    if (row.stripe_session_id) {
      try {
        const s = await getStripe(env).checkout.sessions.retrieve(row.stripe_session_id);
        out.done = s.status === 'complete';
        out.expired = s.status === 'expired';
      } catch (err) { console.warn('[kiosk-handoff] stripe status', err.message); }
    }
    return json(200, out);
  }

  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const parsed = await readJson(req);
  if (parsed.err) return parsed.err;
  const body = parsed.body || {};

  /* ---- POST attach: el teléfono ata el recibo ya subido ---- */
  if (body.action === 'attach') {
    const rl = await checkRate(env, { prefix: 'handoff_attach', ip, limit: 20, windowSec: 60 });
    if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

    const v = verifyHandoffToken(body.token, secret);
    if (!v) return json(400, { error: 'invalid_token' });
    const receiptPath = typeof body.receipt_path === 'string' ? body.receipt_path : '';
    if (!RECEIPT_PATH_RE.test(receiptPath)) return json(400, { error: 'invalid_receipt_path' });

    let row;
    try { row = await getHandoff(env, v.id); } catch { return json(502, { error: 'handoff_failed' }); }
    if (isExpired(row)) return json(410, { error: 'expired' });
    if (row.status === 'session_created') return json(409, { error: 'already_completed' });   // no pisar una sesión ya creada

    try { await updateHandoff(env, v.id, { receipt_path: receiptPath, status: 'receipt_uploaded' }); }
    catch { return json(502, { error: 'handoff_failed' }); }
    return json(200, { ok: true, status: 'receipt_uploaded' });
  }

  /* ---- POST create ---- */
  const rl = await checkRate(env, { prefix: 'handoff', ip, limit: 10, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  if (!secret) { console.error('[kiosk-handoff] missing DASHBOARD_LINK_SECRET'); return json(500, { error: 'server_misconfigured' }); }

  /* Handoff SOLO-RECIBO (ayudante del formulario del kiosk): el cliente manda la foto del recibo desde su
     teléfono y el associate sigue el checkout NORMAL en la tablet (con la forma de pago que elija). NO validamos
     el carrito — este handoff es solo el portador del recibo; el checkout real (precios, lead, Stripe) lo hace la
     tablet vía create-checkout-session con el receipt_path que devolvemos en el status. */
  if (body.receipt_only === true) {
    const first = typeof body.first_name === 'string' ? (body.first_name.trim().split(/\s+/)[0] || '') : '';
    const summary = { mode: 'receipt', pay_on: 'tablet', first_name: first };
    let rid;
    try { rid = await insertHandoff(env, { config: { receipt_only: true }, summary }); }
    catch (err) { console.error('[kiosk-handoff] insert', err.message); return json(502, { error: 'handoff_failed' }); }
    if (Math.random() < 0.05) await purgeExpiredHandoffs(env);
    return json(200, { token: signHandoffToken(rid, secret, 15), summary, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  }

  /* Handoff COMPLETO (modo "todo en el teléfono"): el cliente sube el recibo Y paga en su teléfono. */
  const val = validateCheckout(body, { requireReceipt: false });   // el recibo llega después (del teléfono)
  if (!val.ok) return json(400, { error: val.error });
  const summary = { ...summarize(val.fields), pay_on: 'phone' };

  let id;
  try { id = await insertHandoff(env, { config: body, summary }); }   // guardamos el BODY crudo → se re-valida (con recibo) en complete
  catch (err) { console.error('[kiosk-handoff] insert', err.message); return json(502, { error: 'handoff_failed' }); }

  if (Math.random() < 0.05) await purgeExpiredHandoffs(env);   // purga oportunista de vencidos

  const token = signHandoffToken(id, secret, 15);
  return json(200, { token, summary, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
}
