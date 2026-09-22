/* ============================================================================
 * /stripeOnboarding/:code — link DURABLE de onboarding de Stripe Connect (DEAL-5).
 * ----------------------------------------------------------------------------
 * Los Account Links de Connect caducan en minutos y son de un solo uso: es diseño
 * de Stripe, porque ese link abre el alta bancaria del dealer. Mandarlo por email
 * no funciona. Así que el link que viaja es NUESTRO y no caduca; el de Stripe se
 * acuña en el momento del click, recién nacido.
 *
 * EL GET NO CREA NADA, y eso es el corazón del diseño. Los filtros de correo
 * corporativo (Defender Safe Links, Proofpoint, Mimecast) abren TODOS los enlaces
 * de un mensaje al entregarlo, con un GET indistinguible del humano. Si el GET
 * creara la cuenta Express, cada email entregado crearía una cuenta fantasma, y
 * si ocurre antes del switch a live nacería en test y quedaría inservible. El GET
 * pinta una página con un botón; la cuenta nace en el POST. Un escáner sigue
 * enlaces, no aprieta botones.
 *
 * netlify.toml reescribe /stripeOnboarding/* → ?code=:splat (portal y raíz).
 * ==========================================================================*/

'use strict';

import { pgrest } from './_lib/supabase.mjs';
import { normalizeCode, ONBOARD_CODE_LEN } from './_lib/shortcode.mjs';
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { stripeApi } from './_lib/stripe.mjs';
import { portalLinkBase } from './_lib/portal.mjs';
import { ensureConnectAccount, isConnectComplete, isConnectRejected, onboardUrl } from './_lib/connect.mjs';

/* Stripe manda al refresh_url también cuando la cuenta está rechazada o la
 * plataforma perdió acceso, casos que regenerar NO arregla. Sin tope, eso es un
 * bucle: nuestra página acuña, Stripe rebota, y vuelta a empezar. */
const MAX_REFRESH = 3;
const enc = encodeURIComponent;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex'
};

function page(status, title, body) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>' + title + '</title>'
    + '<style>body{font-family:Inter,system-ui,Arial,sans-serif;max-width:460px;margin:12vh auto 0;padding:0 22px;'
    + 'color:#0e1418;line-height:1.6}h1{font-size:1.3rem;margin:0 0 12px}p{color:#4a5560;margin:0 0 16px}'
    + 'button{font:inherit;font-weight:600;background:#e8630a;color:#fff;border:0;border-radius:7px;'
    + 'padding:13px 22px;cursor:pointer}button:hover{background:#cf5709}small{color:#78828f}</style>'
    + '</head><body><h1>' + title + '</h1>' + body + '</body></html>';
  return new Response(html, { status, headers: HEADERS });
}

/* UNA sola página para todos los finales no accionables: code inexistente,
 * caducado, desactivado a mano, o de una cuenta que ya terminó. Si dijeran cosas
 * distintas, cualquiera podría averiguar qué codes existen probando. Y nunca
 * nombra al dealer, que sería confirmar que ese dealer existe. */
const dead = () => page(404, 'This setup link is no longer active',
  '<p>If your payout setup is already complete, there is nothing more to do.</p>'
  + '<p>Otherwise, contact Furniture-Rx at <b>1-888-850-0057</b> and we will send you a new link.</p>');

const oops = () => page(502, 'Something went wrong',
  '<p>Please try again in a moment. If it keeps happening, contact Furniture-Rx at <b>1-888-850-0057</b>.</p>');

export default async function handler(req) {
  const env = process.env;
  const method = req.method;
  if (method !== 'GET' && method !== 'POST') return page(405, 'Method not allowed', '<p>This link only supports GET and POST.</p>');

  const url = new URL(req.url);
  const code = normalizeCode(url.searchParams.get('code'), ONBOARD_CODE_LEN);
  if (!code) return dead();

  /* Anti-enumeración. A diferencia de sales-mode, aquí NO se envuelve en un catch
   * que ignore el veredicto: allí bloquear corta una venta en curso y el premio de
   * adivinar es una atribución; aquí el premio es una cuenta bancaria. checkRate ya
   * degrada solo a un contador local si su backend no responde. */
  const rl = await checkRate(env, { prefix: 'connectonb', ip: clientIp(req), limit: 10, windowSec: 600 });
  if (!rl.allowed) return page(429, 'Too many requests', '<p>Please wait a moment and try again.</p>');
  const rlCode = await checkRate(env, { prefix: 'connectonb-c', subject: code, limit: 6, windowSec: 3600 });
  if (!rlCode.allowed) return page(429, 'Too many requests', '<p>Please wait a moment and try again.</p>');

  /* El link, con su dealer embebido en la misma consulta. */
  let link = null;
  try {
    const { status, data } = await pgrest(env,
      `/connect_onboard_links?code=eq.${enc(code)}&active=is.true&select=id,code,org_id,org_name,expires_at,completed_at,open_count,dealers(id,name,stripe_account_id,stripe_account_livemode)&limit=1`);
    if (status < 300 && Array.isArray(data) && data[0]) link = data[0];
  } catch (err) {
    console.error('[connect-onboard] lookup:', err.message);
    return oops();
  }
  if (!link) return dead();
  if (link.completed_at) return dead();
  if (link.expires_at && Date.parse(link.expires_at) < Date.now()) return dead();

  const dealer = link.dealers || null;
  if (!dealer) return dead();

  const base = portalLinkBase(req, env);
  const self = onboardUrl(base, code);

  /* ── GET: inerte. Solo cuenta la visita y ofrece el botón. ───────────────── */
  if (method === 'GET') {
    pgrest(env, `/connect_onboard_links?id=eq.${enc(link.id)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { open_count: (link.open_count || 0) + 1, opened_at: new Date().toISOString() }
    }).catch(() => { /* la telemetría no puede tumbar el flujo */ });

    const name = String(dealer.name || link.org_name || '').replace(/[<>&"]/g, '');
    return page(200, 'Set up payouts',
      '<p>Connect a bank account so Furniture-Rx can pay commissions to <b>' + name + '</b>.</p>'
      + '<form method="post" action=""><button type="submit">Continue to Stripe</button></form>'
      + '<p><small>You will be taken to Stripe\'s secure page. You can leave and come back to this same link '
      + 'at any time; nothing is lost.</small></p>');
  }

  /* ── POST: aquí sí se crea la cuenta y se acuña el link de Stripe. ───────── */
  const round = Math.min(parseInt(url.searchParams.get('r'), 10) || 0, 99);
  if (round >= MAX_REFRESH) {
    return page(409, 'Setup could not be completed',
      '<p>Stripe returned here several times without finishing. Please contact Furniture-Rx at '
      + '<b>1-888-850-0057</b> and we will sort it out with you.</p>');
  }

  const got = await ensureConnectAccount(env, dealer);
  if (got.error) return oops();

  if (isConnectRejected(got.acct)) {
    return page(409, 'Setup could not be completed',
      '<p>Stripe was unable to approve this account. Please contact Furniture-Rx at <b>1-888-850-0057</b>.</p>');
  }

  if (isConnectComplete(got.acct)) {
    /* Ya está operativa: se cierra el link en vez de devolver al dealer al
     * formulario bancario, que a estas alturas solo serviría para CAMBIAR la
     * cuenta de destino de los pagos. */
    await pgrest(env, `/connect_onboard_links?id=eq.${enc(link.id)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { completed_at: new Date().toISOString(), active: false }
    });
    return dead();
  }

  /* SIN Idempotency-Key a propósito: se quiere una URL nueva en cada visita. Con
   * una key fija, la segunda visita recibiría el link YA CONSUMIDO y el dealer
   * entraría en un bucle imposible de depurar. */
  const acctLink = await stripeApi(env, 'POST', '/account_links', {
    account: got.acctId,
    type: 'account_onboarding',
    /* Recoger de una vez todo lo que Stripe pedirá tarde o temprano, en vez de solo
     * lo mínimo: con 25 dealers a los que no queremos perseguir dos veces, es mejor
     * un formulario algo más largo que una segunda ronda meses después. */
    'collection_options[fields]': 'eventually_due',
    refresh_url: self + '?r=' + (round + 1),
    return_url: base + '?payouts=done'
  });
  if (acctLink.status >= 300 || !acctLink.data || !acctLink.data.url) {
    console.error('[connect-onboard] account_links', acctLink.status);
    return oops();
  }

  return new Response(null, {
    status: 302,
    headers: { Location: acctLink.data.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
  });
}
