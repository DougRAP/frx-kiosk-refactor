/* ============================================================================
 * _lib/ratelimit.mjs — rate-limiting de las Functions públicas (BE-2 + SEC-2).
 *
 * Backend = contador en Supabase vía la función SQL ATÓMICA `rate_limit_hit`
 * (ventana fija, UNA fila por key). Reusa `pgrest` → cero transporte nuevo, sin
 * dependencias, sin vendor.
 *
 * DEGRADADO LOCAL, no barra libre (SEC-2, hallazgo 2 de la auditoría 28-jul).
 * Hasta el 28-jul un fallo del backend (status≥300, forma inesperada, timeout o
 * red) devolvía `allowed:true` sin más: la disponibilidad del rate limit colgaba
 * de Supabase y un hipo suyo dejaba sin freno a auth-login, auth-otp y chat. Ahora
 * el fallo degrada a un contador EN MEMORIA del proceso, con el mismo `limit` y la
 * misma `windowSec`, y la respuesta se marca `degraded:true`.
 *   Por qué no fail-closed: `checkRate` habla con PostgREST y GoTrue es otro
 *   servicio; cerrar significaría que un hipo de PostgREST tumba TODOS los logins
 *   aunque GoTrue esté sano, y le regalaría a un atacante un DoS trivial.
 *   Limitación asumida: el contador local es por instancia Lambda → con N
 *   instancias calientes el techo es N×limit. Finito, frente al infinito de antes,
 *   y solo mientras el remoto está caído.
 *
 * KEY: por defecto hash(ip + RATE_LIMIT_SALT) — sin PII legible. Desde SEC-2 el
 * llamador puede pasar `subject` (p.ej. el email canónico) para contar por CUENTA
 * en vez de por IP: sin eso, credential stuffing desde muchas IPs no tocaba nunca
 * el límite. Los llamadores que solo pasan `ip` generan la MISMA key que antes.
 *
 * IP: `x-nf-client-connection-ip` (lo pone el edge de Netlify → no spoofeable).
 * `x-forwarded-for` SOLO como fallback de dev local (spoofeable); ese vector lo
 * cubre el bucket por cuenta, que no depende de la IP.
 * Spec: misc/spec-sec2-ratelimit.md.
 * ==========================================================================*/

'use strict';

import { createHash } from 'node:crypto';
import { pgrest } from './supabase.mjs';

export function clientIp(req) {
  const nf = req.headers.get('x-nf-client-connection-ip');
  if (nf) return nf;
  const xff = req.headers.get('x-forwarded-for') || '';
  return xff.split(',')[0].trim() || 'unknown';
}

function bucketKey(prefix, material, salt) {
  const h = createHash('sha256').update(material + (salt || '')).digest('hex').slice(0, 32);
  return `${prefix}:${h}`;
}

/* ── Contador local de respaldo ───────────────────────────────────────────────
 * Ventana fija, misma semántica que rate_limit_hit. Memoria acotada: al pasar el
 * cap se purgan las ventanas vencidas y, si aun así sigue lleno, se suelta el
 * mapa entero (se prefiere perder el estado a hacer crecer el proceso). */
export const LOCAL_MAX_KEYS = 5000;
const local = new Map();   // key → { start: ms, exp: ms, hits }

export function localBucketCount() { return local.size; }   // solo diagnóstico/tests

function localHit(key, limit, windowSec, now) {
  const winMs = Math.max(1, windowSec) * 1000;
  let e = local.get(key);
  if (!e || now >= e.exp) { e = { start: now, exp: now + winMs, hits: 0 }; local.set(key, e); }
  e.hits++;
  if (local.size > LOCAL_MAX_KEYS) {
    for (const [k, v] of local) if (now >= v.exp) local.delete(k);
    if (local.size > LOCAL_MAX_KEYS) { local.clear(); local.set(key, e); }
  }
  const allowed = e.hits <= limit;
  return { allowed, retryAfter: allowed ? 0 : Math.max(1, Math.ceil((e.exp - now) / 1000)), degraded: true };
}

/* El warn se estrangula a 1 por segundo: en un incidente el backend falla en CADA
 * request y el log se volvería inservible (y caro). Un fallo SOSTENIDO sigue
 * siendo visible, que es para lo que está. */
let lastWarn = 0;
function warnOnce(msg) {
  const now = Date.now();
  if (now - lastWarn < 1000) return;
  lastWarn = now;
  console.warn('[ratelimit] degradado a contador local:', msg);
}

/* Devuelve { allowed, retryAfter, degraded? }.
 * `subject` (opcional) cuenta por cuenta en vez de por IP; si no viene, se usa `ip`. */
export async function checkRate(env, { prefix, ip, subject, limit, windowSec, timeoutMs = 1500 }) {
  /* Espacios separados: el subject va prefijado para que la misma cadena usada como
   * IP y como sujeto no comparta bucket. La rama de `ip` queda BYTE A BYTE como antes. */
  const material = (subject !== undefined && subject !== null && subject !== '') ? 'u|' + subject : (ip || 'unknown');
  const key = bucketKey(prefix, material, env.RATE_LIMIT_SALT);
  const body = { p_key: key, p_limit: limit, p_window_seconds: windowSec };
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    const { status, data } = await Promise.race([
      pgrest(env, '/rpc/rate_limit_hit', { method: 'POST', body }),
      timeout
    ]);
    if (status >= 300 || !Array.isArray(data) || !data[0]) {
      warnOnce('status ' + status);
      return localHit(key, limit, windowSec, Date.now());
    }
    return { allowed: !!data[0].allowed, retryAfter: data[0].retry_after || 0 };
  } catch (e) {
    warnOnce(e.message);
    return localHit(key, limit, windowSec, Date.now());
  } finally {
    clearTimeout(timer);
  }
}
