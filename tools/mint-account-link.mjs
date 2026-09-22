/* Throwaway: mint a no-login dashboard link (account.html?t=<token>) to smoke-test
 * "Customers can see their receipt and coverage" (account-view.mjs / account.html).
 *
 * The token is HMAC-signed with DASHBOARD_LINK_SECRET, so it MUST be the SAME secret the
 * target backend uses: prod secret for the prod URL, or your netlify dev env for localhost.
 * If prod says "This link isn't valid or has expired", the secret used here != the backend's.
 *
 * Usage (PowerShell):
 *   $env:DASHBOARD_LINK_SECRET = (netlify env:get DASHBOARD_LINK_SECRET)   # if the repo is linked
 *   node tools/mint-account-link.mjs customer@example.com
 *   node tools/mint-account-link.mjs customer@example.com http://localhost:8888 1
 *
 * Args: <email> [siteUrl=https://furniturerx.netlify.app] [ttlDays=1]
 * The URL is printed to STDOUT; diagnostics go to STDERR.
 */
import { signAccountToken, verifyAccountToken } from '../netlify/functions/_lib/token.mjs';

const email = process.argv[2];
const site = (process.argv[3] || 'https://furniturerx.netlify.app').replace(/\/+$/, '');
const ttlDays = Number(process.argv[4] || 1);
const secret = process.env.DASHBOARD_LINK_SECRET;

if (!email) { console.error('usage: node tools/mint-account-link.mjs <email> [siteUrl] [ttlDays]'); process.exit(1); }
if (!secret) { console.error('missing DASHBOARD_LINK_SECRET  (PowerShell: $env:DASHBOARD_LINK_SECRET = (netlify env:get DASHBOARD_LINK_SECRET))'); process.exit(1); }

const token = signAccountToken(email, secret, ttlDays);
const check = verifyAccountToken(token, secret);   // round-trip with the SAME secret

console.error('[diag] secret length : ' + secret.length + (secret.length < 12 ? '   <-- suspiciously short/empty: env:get probably returned garbage' : ''));
console.error('[diag] secret preview: ' + secret.slice(0, 2) + '...' + secret.slice(-2) + '   (should have NO quotes/spaces)');
console.error('[diag] round-trip     : ' + (check ? 'OK  email=' + check.email + '  exp=' + new Date(check.exp * 1000).toISOString() : 'FAILED (token/secret internally inconsistent)'));
console.error('[diag] reminder       : prod rejects the link ONLY if its DASHBOARD_LINK_SECRET differs from the one above.');

console.log(`${site}/account.html?t=${token}`);
