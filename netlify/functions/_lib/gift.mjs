/* ============================================================================
 * _lib/gift.mjs — GIFT-1: catálogo y helpers de los gift coupon codes.
 * ----------------------------------------------------------------------------
 * Un member compra un regalo (mode:payment, pago único) y recibe por email un
 * código GIFT-XXXXXXXX; el amigo lo canjea en el campo "Add promotion code" de
 * Stripe Checkout (100% de descuento × GIFT_MONTHS meses sobre EL producto
 * regalado). El precio se calcula SIEMPRE server-side (meses × precio de lista):
 * el cliente jamás manda montos. Spec: misc/spec-dash-block-08jul.md §F1.
 *
 * Lo comparten create-gift-checkout (compra) y stripe-webhook (emisión del
 * promotion code + email + marcado de canje).
 * ==========================================================================*/

'use strict';

import { randomInt } from 'node:crypto';

/* Default de la call con Doug 06-jul; parametrizable (couponId/precio lo llevan
 * como argumento) sin tocar a los llamadores actuales. */
export const GIFT_MONTHS = 3;

/* Catálogo de lo regalable: CUALQUIER producto (decisión Adrian 08-jul). `cents`
 * espeja el precio de lista mensual (PRICE_CENTS / membership standalone) y
 * `priceEnv` apunta al price de Stripe del tier → de su .product sale el
 * applies_to del coupon (el descuento solo aplica al producto regalado). */
export const GIFT_TIERS = {
  'stain':      { cents: 999,  label: 'Stain Protection',                priceEnv: 'STRIPE_PRICE_STAIN' },
  'stain-mech': { cents: 1999, label: 'Stain + Structure Protection',    priceEnv: 'STRIPE_PRICE_STAIN_MECH' },
  'membership': { cents: 1999, label: 'Repair Safety Net membership',    priceEnv: 'STRIPE_PRICE_MEMBERSHIP' }
};

/* Sin ambiguos (0/O, 1/I/L) — el código se teclea en el checkout desde un email
 * o un listing de Marketplace. Mayúsculas: Stripe trata los promotion codes
 * case-insensitive, pero el código impreso debe verse UNO solo. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* 'GIFT-XXXXXXXX': 8 chars de 31 símbolos ≈ 39.6 bits (randomInt es CSPRNG y
 * uniforme) — suficiente con max_redemptions:1 + expiración 90d en Stripe. */
export function generateGiftCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `GIFT-${s}`;
}

/* Id FIJO del coupon en Stripe ('gift-stain-3mo', 'gift-membership-3mo'…):
 * un coupon por combinación tier×meses, create-if-missing en el webhook. Así
 * el dashboard de Stripe muestra UN coupon reutilizado y N promotion codes. */
export function couponId(tier, months) {
  return `gift-${tier}-${months}mo`;
}

/* Email al COMPRADOR con el código listo para reenviar. NUNCA lleva ids de
 * Stripe (promo/coupon/payment_intent): solo el código, qué regala, cómo se
 * canjea y cuándo vence. Nada de input del cliente entra al HTML crudo: code,
 * label, months y fecha son server-generated. */
export function giftEmail({ code, label, months, expiresAtEpoch, siteUrl }) {
  const site = (siteUrl || 'https://www.furniturerx.net').replace(/\/+$/, '');
  const expires = new Date(expiresAtEpoch * 1000)
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const subject = 'Your FurnitureRx gift code';
  const html = '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0e1418">'
    + '<h2>Your FurnitureRx gift is ready</h2>'
    + '<p>Thanks for your purchase. This code is good for ' + months + ' months of ' + label + ', on you.</p>'
    + '<p style="font-family:Consolas,Menlo,monospace;font-size:26px;letter-spacing:.12em;background:#f4f6f8;border:1px solid #e2e7ec;border-radius:6px;padding:14px 18px;text-align:center">' + code + '</p>'
    + '<p><strong>How to redeem it:</strong> go to <a href="' + site + '">' + site + '</a>, choose ' + label + ', and enter the code at checkout. The first ' + months + ' months are covered by your gift.</p>'
    + '<p>The code works once, for a new customer, and expires on <strong>' + expires + '</strong>.</p>'
    + '<p style="color:#667;font-size:13px">Forward this email to the person you are gifting, or paste the code into your listing. Whoever uses it first gets the gift.</p>'
    + '</div>';
  const text = 'Your FurnitureRx gift is ready\n\n'
    + 'Thanks for your purchase. This code is good for ' + months + ' months of ' + label + ', on you.\n\n'
    + '  ' + code + '\n\n'
    + 'How to redeem it: go to ' + site + ', choose ' + label + ', and enter the code at checkout. '
    + 'The first ' + months + ' months are covered by your gift.\n\n'
    + 'The code works once, for a new customer, and expires on ' + expires + '.\n\n'
    + 'Forward this email to the person you are gifting, or paste the code into your listing. '
    + 'Whoever uses it first gets the gift.';
  return { subject, html, text };
}
