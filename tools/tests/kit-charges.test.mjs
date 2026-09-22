/* BE-5 (reunión 14-ago) — kitCharges es el ÚNICO punto de verdad de los cargos one-time de los
 * kits: S&H $11 POR KIT ("average shipping daily is 10.97… you would just add eleven dollars")
 * y sales tax flat 6% base kit-only ("Yes. You're going to use a flat 6%"). Suscripciones NO
 * ("we eat the 6%") y membership sin tax. Knobs por env = flip sin código si Doug cambia de
 * criterio (N1/N2 del mini-backlog 14-ago). */
import { readFileSync } from 'node:fs';
import { makeT } from './helpers.mjs';
import { kitCharges } from '../../netlify/functions/_lib/checkout.mjs';

const t = makeT('kit-charges');

const KIT = (q, cents = 4999) => ({ quantity: q, unit_price_cents: cents });

/* Defaults: $11 por kit, 6% del retail. */
{
  const { shCents, taxCents } = kitCharges([KIT(1)], {});
  t(shCents === 1100, 'default: 1 kit → S&H $11.00');
  t(taxCents === 300, 'default: tax = 6% del kit solo (49.99 → 3.00 redondeado)');
}
{
  const { shCents, taxCents } = kitCharges([KIT(2), KIT(1)], {});
  t(shCents === 3300, 'por kit: 3 unidades → $33.00 (N1: POR KIT, no por orden)');
  t(taxCents === Math.round(4999 * 3 * 0.06), 'tax sobre el retail total de kits');
}
{
  t(kitCharges([], {}).shCents === 0 && kitCharges([], {}).taxCents === 0, 'sin kits → sin cargos (planes/membership jamás los llevan)');
  t(kitCharges(null, {}).shCents === 0, 'null-safe');
}

/* Knobs reversibles (el "si Doug dice otra cosa" es un flip de env, cero código). */
{
  const { shCents } = kitCharges([KIT(2), KIT(1)], { KIT_SH_PER_ORDER: 'true' });
  t(shCents === 1100, 'KIT_SH_PER_ORDER=true → $11 por ORDEN completa');
  const { shCents: sh2 } = kitCharges([KIT(1)], { KIT_SH_CENTS: '1350' });
  t(sh2 === 1350, 'KIT_SH_CENTS cambia el monto sin código');
  const { taxCents } = kitCharges([KIT(1)], { KIT_TAX_BASE: 'kit_sh' });
  t(taxCents === Math.round((4999 + 1100) * 0.06), 'KIT_TAX_BASE=kit_sh → base kit + S&H (la conservadora)');
}

/* El checkout empuja las DOS líneas one-time y solo con kits. */
{
  const c = readFileSync('netlify/functions/_lib/checkout.mjs', 'utf8');
  t(/Shipping & handling/.test(c) && /Sales tax \(6%\)/.test(c), 'checkout: líneas visibles S&H + Sales tax en Stripe');
  t(/kitCharges\(fields\.kits, env\)/.test(c), 'checkout: los montos salen del helper, nadie más calcula');
}

/* El webhook persiste sh_cents por item con el MISMO helper (la columna dejó de ser huérfana). */
{
  const w = readFileSync('netlify/functions/stripe-webhook.mjs', 'utf8');
  t(/kitCharges/.test(w) && /sh_cents/.test(w), 'webhook: sh_cents se escribe al crear la orden (fin del hallazgo del audit)');
  const s = readFileSync('netlify/functions/_lib/supabase.mjs', 'utf8');
  t(/sh_cents: it\.sh_cents == null \? null : it\.sh_cents/.test(s), 'insertOrderItems: persiste sh_cents sin import circular');
}

/* Los 3 fronts espejan el display (patrón ELIG_DAYS: el server sigue siendo canónico). */
for (const f of ['kiosk/index.html', 'tech/index.html', 'index.html']) {
  const s = readFileSync(f, 'utf8');
  t(/var KIT_SH = 11\.00/.test(s) && /var KIT_TAX_RATE = 0\.06/.test(s), `${f}: consts espejo del S&H + tax`);
  t(/kitsShTotal/.test(s) && /kitsTaxTotal/.test(s), `${f}: el total one-time del drawer incluye S&H + tax`);
  t(/shipping &amp; handling per kit and 6% sales tax/.test(s), `${f}: la nota del drawer explica los cargos`);
}

t.done();
