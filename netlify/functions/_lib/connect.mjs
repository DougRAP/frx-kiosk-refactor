/* ============================================================================
 * _lib/connect.mjs — la cuenta Stripe Connect del dealer y su link de onboarding.
 * ----------------------------------------------------------------------------
 * Un solo sitio para "asegurar la cuenta Express", porque hay DOS caminos que la
 * crean: el resolver público /stripeOnboarding/:code (DEAL-5) y el botón admin de
 * Dealer Admin. Si cada uno tuviera su copia, la primera corrección que alguien
 * olvide propagar estaría en el código que maneja datos bancarios.
 * ==========================================================================*/

'use strict';

import { pgrest } from './supabase.mjs';
import { stripeApi, stripeLivemode } from './stripe.mjs';
import { newCode, ONBOARD_CODE_LEN } from './shortcode.mjs';

const enc = encodeURIComponent;

/* Operativa = puede RECIBIR transferencias, que es para lo único que existe esta
 * cuenta. NUNCA charges_enabled: se crea pidiendo solo la capability `transfers`,
 * así que ese flag puede no activarse jamás y sería una señal que no llega nunca. */
export const isConnectComplete = (a) => !!a
  && a.capabilities && a.capabilities.transfers === 'active'
  && a.payouts_enabled === true
  && !(a.requirements && Array.isArray(a.requirements.currently_due) && a.requirements.currently_due.length);

/* Rechazada: acuñar otro Account Link devuelve al dealer al mismo muro. */
export const isConnectRejected = (a) => !!a && a.requirements
  && typeof a.requirements.disabled_reason === 'string'
  && a.requirements.disabled_reason.startsWith('rejected.');

/* Asegura la cuenta Express del dealer EN EL MODO ACTUAL de la plataforma.
 * `dealer` necesita { id, name, stripe_account_id, stripe_account_livemode }. */
export async function ensureConnectAccount(env, dealer) {
  const wantLive = stripeLivemode(env);
  let acctId = dealer.stripe_account_id || null;
  let acct = null;

  /* Guard de modo: un acct_ del otro universo no existe para esta clave, así que ni
   * se le pregunta a Stripe. El id no lleva marca de modo, por eso hay que
   * recordarlo. NULL = no lo sabemos, y entonces sí se pregunta: la auto-reparación
   * de abajo resuelve el caso sin dejar a nadie fuera. */
  if (acctId && dealer.stripe_account_livemode != null && dealer.stripe_account_livemode !== wantLive) {
    acctId = null;
  }

  if (acctId) {
    const got = await stripeApi(env, 'GET', '/accounts/' + enc(acctId));
    if (got.status === 200 && got.data) {
      acct = got.data;
    } else if (got.status === 404 && got.data && got.data.error && got.data.error.code === 'resource_missing') {
      /* Auto-reparación: la cuenta guardada no existe en este modo. Antes era un 502
       * permanente sin ninguna rama que volviera a crearla. */
      console.warn('[connect] acct guardado no existe en este modo, se recrea');
      acctId = null;
    } else {
      return { error: true };
    }
  }

  if (!acctId) {
    /* Idempotency-Key por dealer: dos peticiones a la vez (doble clic, o el escáner
     * de correo y la persona) devuelven LA MISMA cuenta en vez de crear dos. */
    const created = await stripeApi(env, 'POST', '/accounts', {
      type: 'express',
      country: 'US',
      'capabilities[transfers][requested]': 'true',
      'metadata[org_id]': dealer.id,
      'metadata[org_name]': dealer.name || ''
    }, { 'Idempotency-Key': 'connect-acct-' + dealer.id });
    if (created.status >= 300 || !created.data || !created.data.id) return { error: true };
    acctId = created.data.id;
    acct = created.data;

    /* Reclamo atómico (patrón SEC-2b): la guarda va en el FILTRO, así Postgres la
     * evalúa bajo el lock de la fila. Vacío = otro ganó, y se usa SU id. */
    const claim = await pgrest(env, `/dealers?id=eq.${enc(dealer.id)}&stripe_account_id=is.null`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { stripe_account_id: acctId, stripe_account_livemode: wantLive }
    });
    const won = claim.status < 300 && Array.isArray(claim.data) && claim.data.length > 0;
    if (!won) {
      const again = await pgrest(env, `/dealers?id=eq.${enc(dealer.id)}&select=stripe_account_id&limit=1`);
      const winner = again.status < 300 && Array.isArray(again.data) && again.data[0] && again.data[0].stripe_account_id;
      if (winner && winner !== acctId) { acctId = winner; acct = null; }
    }
  }

  return { acctId, acct };
}

/* Ventana del link, materializada AL CREAR. 0 o vacío = no caduca, que es el
 * default a propósito: un 404 en un link ya repartido es una llamada telefónica
 * garantizada, y el dealer que tarda es justo el que más lo necesita. */
export function onboardExpiry(env, now = Date.now()) {
  const days = Number.parseInt((env && env.STRIPE_ONBOARD_TTL_DAYS) || '', 10);
  return Number.isFinite(days) && days > 0 ? new Date(now + days * 86400000).toISOString() : null;
}

/* El link durable del dealer: reutiliza el activo o acuña uno. La BD garantiza que
 * solo haya uno vivo por dealer (índice único parcial). */
export async function ensureOnboardLink(env, dealer, createdBy = null) {
  const found = await pgrest(env,
    `/connect_onboard_links?org_id=eq.${enc(dealer.id)}&active=is.true&select=code,expires_at&limit=1`);
  const row = found.status < 300 && Array.isArray(found.data) && found.data[0];
  if (row && row.code && !(row.expires_at && Date.parse(row.expires_at) < Date.now())) return row.code;

  const code = newCode(ONBOARD_CODE_LEN);
  const ins = await pgrest(env, '/connect_onboard_links', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      code, org_id: dealer.id, org_name: dealer.name || null,
      active: true, expires_at: onboardExpiry(env), created_by: createdBy
    }
  });
  if (ins.status >= 300) return null;
  return code;
}

export const onboardUrl = (base, code) => base + 'stripeOnboarding/' + code;
