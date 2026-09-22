/* Genera un link de dashboard SIN login para un email.
 * Uso:  node scripts/account-link.mjs <email> [baseUrl] [ttlDays]
 * Ej.:  node scripts/account-link.mjs cliente@email.com http://localhost:8888
 *       node scripts/account-link.mjs cliente@email.com https://furniturerx.net 90
 * Carga DASHBOARD_LINK_SECRET desde .env (o del entorno). No imprime el secret. */
import { readFileSync } from 'node:fs';
import { signAccountToken } from '../netlify/functions/_lib/token.mjs';

(function loadDotEnv() {
  try {
    const txt = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin .env → se usa el entorno */ }
})();

const email = process.argv[2];
const baseUrl = (process.argv[3] || 'http://localhost:8888').replace(/\/$/, '');
const ttl = Number(process.argv[4]) || 90;

if (!email) { console.error('Uso: node scripts/account-link.mjs <email> [baseUrl] [ttlDays]'); process.exit(1); }
const secret = process.env.DASHBOARD_LINK_SECRET;
if (!secret) { console.error('Falta DASHBOARD_LINK_SECRET (ponlo en .env o en el entorno).'); process.exit(1); }

const token = signAccountToken(email, secret, ttl);
console.log(`${baseUrl}/account.html?t=${token}`);
