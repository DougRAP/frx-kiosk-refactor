/* MEM-7 (server) — reunión 14-ago: "we're going to activate a repair membership for EVERY
 * subscription… at no additional charge". La incluida es un ENTITLEMENT computado (plan activo ⇒
 * Repair Safety Net activa, _lib/account.mjs); la DE PAGO ("Cover your used furniture") vale
 * SIEMPRE $19.99 — la matemática del upsell de Doug ($8 + $8 = $16/cliente) exige precio
 * completo. Este archivo reemplaza a los tiers MEM-6 (Arquitectura B, call 06-jul), que MURIÓ. */
import { readFileSync } from 'node:fs';
import { makeT } from './helpers.mjs';
import { pickMembershipPrice } from '../../netlify/functions/_lib/stripe.mjs';

const t = makeT('membership-tiers');

const ENV = {
  STRIPE_PRICE_MEMBERSHIP: 'price_full',
  STRIPE_PRICE_MEMBERSHIP_FREE: 'price_free',
  STRIPE_PRICE_MEMBERSHIP_HALF: 'price_half'
};

/* La de pago es SIEMPRE full, lleve lo que lleve el carrito. */
t(pickMembershipPrice(ENV) === 'price_full', 'MEM-7: la membership de pago vale siempre price_full');

/* Los prices FREE/HALF ya no se usan para VENDER (quedan solo como legacy del webhook). */
{
  const stripe = readFileSync('netlify/functions/_lib/stripe.mjs', 'utf8');
  t(!/priceForMembershipFree|priceForMembershipHalf/.test(stripe),
    'MEM-7: murieron los helpers de venta FREE/HALF');
  const checkout = readFileSync('netlify/functions/_lib/checkout.mjs', 'utf8');
  t(checkout.includes('pickMembershipPrice(env)'),
    'checkout.mjs: la membership se cotiza a precio completo, sin composición del carrito');
  t(!/hasStainMech|hasStain\b/.test(checkout),
    'checkout.mjs: fuera la lógica de tiers por composición');
}

/* El webhook SIGUE reconociendo FREE y HALF (suscripciones legacy) — cierre del bug F1:
 * una HALF de $9.99 se cobraba y jamás se registraba. */
{
  const w = readFileSync('netlify/functions/stripe-webhook.mjs', 'utf8');
  t(/STRIPE_PRICE_MEMBERSHIP_HALF/.test(w), 'webhook: reconoce el price HALF legacy (fix F1)');
  t(/STRIPE_PRICE_MEMBERSHIP_FREE/.test(w), 'webhook: sigue reconociendo el price FREE legacy');
  t(/\? 999/.test(w), 'webhook: el fallback defensivo de la HALF registra 999, no 0');
}

/* El entitlement computado vive en account.mjs y NO crea filas. */
{
  const a = readFileSync('netlify/functions/_lib/account.mjs', 'utf8');
  t(/repair_safety_net/.test(a), 'account: expone repair_safety_net (entitlement computado)');
  t(/'included'/.test(a) && /'membership'/.test(a), 'account: distingue included (por plan) vs membership real');
}

/* Copys: ningún front vende ya el 50% ni los "free for N months" (contradicción del audit F6). */
{
  for (const f of ['kiosk/index.html', 'tech/index.html', 'index.html']) {
    const s = readFileSync(f, 'utf8');
    t(!/50% off with your Stain plan/.test(s), `${f}: murió el label del 50%`);
    t(!/MEMBERSHIP_HALF/.test(s), `${f}: murió la const MEMBERSHIP_HALF del drawer`);
  }
  t(!/included free for (6|12) months/.test(readFileSync('index.html', 'utf8')),
    'D2C: murieron los "free for 6/12 months" (nunca existieron en el backend)');
  t(/Repair Safety Net included/.test(readFileSync('kiosk/index.html', 'utf8')),
    'kiosk: la card Stain dice "included" (alineada con la regla de Doug)');
}

/* KIOSK-27: la línea de membership del drawer renderiza como las de planes/kits (el selector del
 * reset la incluye: sin bullet ni sangría del navegador) y su meta distingue el producto de pago. */
{
  const RESET = /#cart-plans-list, #cart-kits-list, #cart-membership-list\{list-style:none/;
  t(RESET.test(readFileSync('kiosk/index.html', 'utf8')), 'KIOSK-27: reset de lista incluye la membership (kiosk)');
  t(RESET.test(readFileSync('tech/index.html', 'utf8')), 'KIOSK-27: reset de lista incluye la membership (tech)');
  t(RESET.test(readFileSync('packages/core/styles/core.css', 'utf8')), 'KIOSK-27: reset en core.css (el build lo inyecta al D2C)');
  for (const f of ['kiosk/index.html', 'tech/index.html', 'index.html']) {
    t(/For furniture you already own/.test(readFileSync(f, 'utf8')), `${f}: el meta de la línea nombra el mueble usado`);
  }
}

/* Espejos server del pricing: email del carrito y resumen del handoff, siempre $19.99. */
{
  const e = readFileSync('netlify/functions/email-cart.mjs', 'utf8');
  t(!/MEMBERSHIP_HALF_CENTS/.test(e) && !/50% off/.test(e), 'email-cart: sin tiers ni label del 50%');
  const h = readFileSync('netlify/functions/kiosk-handoff.mjs', 'utf8');
  t(/fields\.membership \? 1999 : 0/.test(h), 'kiosk-handoff: el resumen del teléfono cobra siempre 1999');
}

t.done();
