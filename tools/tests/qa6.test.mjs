/* ============================================================================
 * QA-6 (BUG-03 de Jakob) — ventana de elegibilidad ENFORZADA y parametrizada.
 * Decisión Doug 27-jul: "Use 60 days". El campo fecha (kiosk = delivery/coverage
 * start) acepta [hoy - ELIGIBILITY_WINDOW_DAYS, hoy + DELIVERY_HORIZON_DAYS]:
 * el horizonte a futuro existe porque una venta en mostrador puede tener entrega
 * programada. Copy unificado: mueren "last 2 months" y "30 calendar days".
 * ==========================================================================*/
import { makeT, src } from './helpers.mjs';
import { validateCheckout } from '../../netlify/functions/_lib/validate.mjs';

const t = makeT('qa6');

const daysFromNow = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const BASE = {
  email: 'a@b.co', full_name: 'Jane Doe', phone: '5551234567',
  address: '1 Main St, Logan UT', plans: [], kits: [{ sku: 'CARE-WOOD-001', quantity: 1 }]
};

/* ── server: rango con default 60/90 (±1 día de holgura anti-flake de TZ) ── */
{
  delete process.env.ELIGIBILITY_WINDOW_DAYS;
  delete process.env.DELIVERY_HORIZON_DAYS;
  t(validateCheckout({ ...BASE, date: daysFromNow(0) }).ok === true, 'fecha: hoy pasa');
  t(validateCheckout({ ...BASE, date: daysFromNow(-59) }).ok === true, 'fecha: hace 59 días pasa (dentro de la ventana de 60)');
  let r = validateCheckout({ ...BASE, date: daysFromNow(-61) });
  t(!r.ok && r.error === 'date_out_of_range', 'fecha: hace 61 días → date_out_of_range (Doug: 60 days)');
  r = validateCheckout({ ...BASE, date: '1899-01-01' });
  t(!r.ok && r.error === 'date_out_of_range', 'fecha: 1899 → date_out_of_range (el caso literal de Jakob)');
  t(validateCheckout({ ...BASE, date: daysFromNow(89) }).ok === true, 'fecha: entrega programada +89 días pasa (horizonte 90)');
  r = validateCheckout({ ...BASE, date: daysFromNow(91) });
  t(!r.ok && r.error === 'date_out_of_range', 'fecha: +91 días → date_out_of_range');
  r = validateCheckout({ ...BASE, date: '2099-12-31' });
  t(!r.ok && r.error === 'date_out_of_range', 'fecha: 2099 → date_out_of_range');
  t(validateCheckout({ ...BASE }).ok === true, 'fecha: ausente sigue siendo opcional (kit-only)');
  r = validateCheckout({ ...BASE, date: '07/20/2026' });
  t(!r.ok && r.error === 'invalid_date', 'fecha: malformada sigue siendo invalid_date (forma antes que rango)');
}

/* ── server: parametrizable por env (cambiar la ventana = 1 env var, sin código) ── */
{
  process.env.ELIGIBILITY_WINDOW_DAYS = '30';
  let r = validateCheckout({ ...BASE, date: daysFromNow(-45) });
  t(!r.ok && r.error === 'date_out_of_range', 'env: con ELIGIBILITY_WINDOW_DAYS=30, hace 45 días → rechazada');
  delete process.env.ELIGIBILITY_WINDOW_DAYS;
  t(validateCheckout({ ...BASE, date: daysFromNow(-45) }).ok === true, 'env: sin override vuelve al default 60 → hace 45 días pasa');
  process.env.DELIVERY_HORIZON_DAYS = '10';
  r = validateCheckout({ ...BASE, date: daysFromNow(15) });
  t(!r.ok && r.error === 'date_out_of_range', 'env: con DELIVERY_HORIZON_DAYS=10, +15 días → rechazada');
  delete process.env.DELIVERY_HORIZON_DAYS;
}

/* ── fronts: const + min/max en el input + copy unificado a 60 días ── */
for (const f of ['index.html', 'kiosk/index.html', 'tech/index.html']) {
  const html = src(f);
  t(/var ELIG_DAYS = 60/.test(html) && /var HORIZON_DAYS = 90/.test(html), `qa6 ${f}: consts ELIG_DAYS/HORIZON_DAYS`);
  t(/qa6DateWindow/.test(html) && /el\.min = iso\(min\)/.test(html) && /el\.max = iso\(max\)/.test(html), `qa6 ${f}: min/max del input de fecha fijados al boot`);
  t(!/last 2 months/.test(html), `qa6 ${f}: murió "last 2 months"`);
  t(!/30 calendar days/.test(html), `qa6 ${f}: murió "30 calendar days"`);
  t(/last 60 days/.test(html), `qa6 ${f}: el copy dice 60 días`);
}

t.done();
