/* ============================================================================
 * _lib/email.mjs — envío de email transaccional AGNÓSTICO de proveedor (KIOSK-1 Fase D).
 *
 * Interfaz única: sendEmail(env, { to, subject, html, text }) -> { ok, id?, error? }.
 * El proveedor se elige por env EMAIL_PROVIDER (default 'resend'); cambiarlo = una env var,
 * SIN tocar a los llamadores. Agregar otro = una función-driver nueva en el switch (KISS,
 * sin registry/plugin-framework). fetch directo, SIN SDK (como stripe/anthropic/gotrue).
 *
 * FAIL-SOFT: nunca lanza; ante cualquier fallo devuelve { ok:false, error } para que el
 * checkout NO se rompa (el caller cae al QR). NUNCA loguea html/url: el link de pago del
 * kiosk es sensible — solo se loguea { ok, status }.
 * ==========================================================================*/

'use strict';

const DEFAULT_TIMEOUT = 3000;

async function postJSON(url, headers, body, timeoutMs) {
  let timer;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ---- Drivers (un endpoint por proveedor; misma firma) -------------------- */

/* Remitente: FROM_EMAIL es el nombre CANÓNICO (agnóstico de proveedor); se acepta
   RESEND_FROM_EMAIL como alias porque ya se configuró así alguna vez (06-jul). */
export function fromEmail(env) { return env.FROM_EMAIL || env.RESEND_FROM_EMAIL; }

async function viaResend(env, msg, timeoutMs) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'resend_key_missing' };
  const res = await postJSON(
    'https://api.resend.com/emails',
    { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    { from: fromEmail(env), to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text },
    timeoutMs
  );
  if (!res.ok) return { ok: false, error: `resend_${res.status}` };
  let id = null;
  try { const d = await res.json(); id = d && d.id; } catch { /* id opcional */ }
  return { ok: true, id };
}

async function viaSendgrid(env, msg, timeoutMs) {
  if (!env.SENDGRID_API_KEY) return { ok: false, error: 'sendgrid_key_missing' };
  /* SendGrid exige text/plain ANTES de text/html en `content`. */
  const content = [];
  if (msg.text) content.push({ type: 'text/plain', value: msg.text });
  content.push({ type: 'text/html', value: msg.html });
  const res = await postJSON(
    'https://api.sendgrid.com/v3/mail/send',
    { Authorization: `Bearer ${env.SENDGRID_API_KEY}` },
    { personalizations: [{ to: [{ email: msg.to }] }], from: { email: fromEmail(env) }, subject: msg.subject, content },
    timeoutMs
  );
  if (!res.ok) return { ok: false, error: `sendgrid_${res.status}` };   // SendGrid responde 202
  return { ok: true, id: res.headers.get('x-message-id') || null };
}

/* ---- API pública --------------------------------------------------------- */

export async function sendEmail(env, { to, subject, html, text, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!to || !subject || !html || !fromEmail(env)) return { ok: false, error: 'email_args_missing' };
  const provider = (env.EMAIL_PROVIDER || 'resend').toLowerCase();
  try {
    switch (provider) {
      case 'resend':   return await viaResend(env, { to, subject, html, text }, timeoutMs);
      case 'sendgrid': return await viaSendgrid(env, { to, subject, html, text }, timeoutMs);
      default:         return { ok: false, error: 'email_provider_unset' };
    }
  } catch (e) {
    console.warn('[email] send failed:', e.message);   // nunca el html/url
    return { ok: false, error: 'send_exception' };
  }
}
