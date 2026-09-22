/* ============================================================================
 * POST /.netlify/functions/upload-receipt   (BE-1)
 * ----------------------------------------------------------------------------
 * Recibe la FOTO del sales receipt (binario crudo: image/jpeg|png|webp), la valida
 * y la sube a un bucket PRIVADO de Supabase Storage con service_role (el navegador
 * no tiene llave de Supabase). Devuelve { path } — un string opaco server-issued que
 * el checkout incluye en su payload (→ lead → webhook → subscriptions.receipt_path).
 *
 * Endpoint PÚBLICO (no hay sesión en el checkout, igual que create-lead/checkout):
 * defensas = rate-limit dedicado + tope de tamaño + validación por MAGIC BYTES (no se
 * confía en el Content-Type, falsificable) + key generada en server (sin path traversal).
 * El bucket es privado → la imagen queda inerte (nunca se sirve, sin ejecución).
 *
 * Sin dependencias: fetch/Web Crypto global (Node 18+). Credenciales solo por env.
 * ==========================================================================*/

'use strict';

import { randomUUID } from 'node:crypto';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { uploadToStorage } from './_lib/supabase.mjs';

const BUCKET = 'receipts';
const MAX_BYTES = 2 * 1024 * 1024;   // 2MB (el cliente ya comprime a ~400-800KB)

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });
}

/* Detecta el tipo por MAGIC BYTES (no por el Content-Type declarado). Solo imágenes. */
function sniff(b) {
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: 'webp', mime: 'image/webp' };
  return null;
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const env = process.env;
  const rl = await checkRate(env, { prefix: 'receipt', ip: clientIp(req), limit: 10, windowSec: 60 });
  if (!rl.allowed) return json(429, { error: 'rate_limited', retry_after: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });

  // Tope barato por Content-Length antes de materializar el cuerpo.
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) return json(413, { error: 'too_large' });

  let buf;
  try {
    buf = Buffer.from(await req.arrayBuffer());
  } catch {
    return json(400, { error: 'unreadable_body' });
  }
  if (!buf.length) return json(400, { error: 'empty' });
  if (buf.length > MAX_BYTES) return json(413, { error: 'too_large' });

  const kind = sniff(buf);
  if (!kind) return json(415, { error: 'invalid_image' });   // no es JPEG/PNG/WebP

  // Key generada en SERVER (nunca del cliente) → sin path traversal. Particionada por fecha.
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const objectPath = `${yyyy}/${mm}/${randomUUID()}.${kind.ext}`;

  try {
    const path = await uploadToStorage(env, BUCKET, objectPath, buf, kind.mime);
    return json(200, { path });   // ej. "receipts/2026/06/<uuid>.jpg"
  } catch (err) {
    console.error('[upload-receipt]', err.message);
    return json(502, { error: 'upload_failed' });
  }
}
