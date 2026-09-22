/* TECH-1 (call Doug 10-jul) — backend de la tech version:
 * (a) TRIAL 90d de la Repair Membership cuando la compra viene del front tech
 *     (TECH-2a, decisión Adrian: el hero de Doug promete "first 3 months free"
 *     y el copy no promete lo que el sistema no cobra). Enum server-side; un
 *     source forjado JAMÁS regala planes (solo aplica a membership sin planes).
 * (b) Maya en modo TECH: Q&A de kits/membership, SIN guion de captura ni
 *     sizing/retail; "everything in your house" es respuesta válida. */
import { makeT } from './helpers.mjs';
import { trialDaysFor } from '../../netlify/functions/_lib/checkout.mjs';
import { chatMode } from '../../netlify/functions/chat.mjs';
import { validateCheckout } from '../../netlify/functions/_lib/validate.mjs';

const t = makeT('tech');

/* ── validateCheckout: los requisitos estrictos del kiosk (KIOSK-1: associate/order/date)
   son SEMÁNTICA DE PLANES (coverage-start + dealer match). Hallazgo del smoke local 10-jul:
   el tech (kiosk:true, sin planes, sin fecha visible) moría con 400 date_required — y el
   propio KIOSK no podía vender un kit suelto por la misma regla. El tech exige Technician
   ID + Work order SIEMPRE vía source:'tech' ("you're gonna need both"). ── */
const BASE = {
  email: 'a@b.co', full_name: 'Tech Customer', phone: '5551234567',
  address: '1 Repair Rd, Logan UT', plans: [], kits: [{ sku: 'CARE-WOOD-001', quantity: 1 }]
};
{
  const r = validateCheckout({ ...BASE, kiosk: true, source: 'tech', membership: true, associate: 'T-4471', order: 'WO-88012' });
  t(r.ok === true, 'validate: tech (membership+kit, SIN fecha) YA pasa — el 400 date_required murió');
}
{
  const r = validateCheckout({ ...BASE, kiosk: true, source: 'tech', associate: '', order: 'WO-1' });
  t(!r.ok && r.error === 'invalid_associate', 'validate: tech SIN Technician ID → 400 (so you get credit)');
}
{
  const r = validateCheckout({ ...BASE, kiosk: true, source: 'tech', associate: 'T-1', order: '' });
  t(!r.ok && r.error === 'order_required', 'validate: tech SIN work order/referencia → 400 (you\'re gonna need both)');
}
{
  const r = validateCheckout({ ...BASE, kiosk: true });
  t(r.ok === true, 'validate: KIOSK kit-only (campos ocultos) ya NO muere — bug latente arreglado');
}
{
  const r = validateCheckout({
    ...BASE, kiosk: true, receipt_path: 'receipts/2026/07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg',
    plans: [{ cov: 'stain', term: 'monthly', type: 'furniture', count: 1 }],
    associate: '4471', order: '100482'
  });
  t(!r.ok && r.error === 'date_required', 'validate: el kiosk CON plan sigue exigiendo la fecha (KIOSK-1 intacto)');
}

/* ── trialDaysFor: el enum y sus fronteras ── */
{
  t(trialDaysFor('tech', { membership: true, hasPlans: false }) === 90,
    'trial: tech + membership sin planes → 90 días (la promo del hero de Doug)');
  t(trialDaysFor('tech', { membership: true, hasPlans: true }) === 0,
    'trial: con PLANES en el carrito NO hay trial (un source forjado no regala planes)');
  t(trialDaysFor('tech', { membership: false, hasPlans: false }) === 0,
    'trial: sin membership no hay nada que regalar');
  t(trialDaysFor(undefined, { membership: true, hasPlans: false }) === 0,
    'trial: sin source → cobro normal desde el mes 1 (kiosk/D2C intactos)');
  t(trialDaysFor('https://evil.example', { membership: true, hasPlans: false }) === 0,
    'trial: source desconocido se IGNORA (enum, jamás valores del cliente)');
}

/* ── chatMode: la personalidad TECH de Maya ── */
{
  const tech = chatMode('tech');
  const main = chatMode(undefined);
  t(tech.tools.length === 0, 'maya-tech: SIN tools (no hay sizing ni custom quote en el tech)');
  t(/first 3 months/.test(tech.system) && /\$19\.99/.test(tech.system),
    'maya-tech: puede decir la promo (3 meses free) y el precio real de la membership');
  t(/everything in your house/.test(tech.system),
    'maya-tech: "everything in your house" es respuesta válida (Doug 10-jul)');
  t(!/sales order number/.test(tech.system) && !/retail/.test(tech.system),
    'maya-tech: cero guion de captura, cero retail');
  t(/Never take payment/.test(tech.system), 'maya-tech: guardrail de pagos presente');
  t(/SALES ASSISTANT/.test(main.system) && main.tools.length === 3,
    'maya-main: el modo default queda EXACTAMENTE como estaba (SYSTEM + 3 tools)');
}

t.done();
