/* MAYA-8 (Doug 08-jul) — runSizeCoverage captura los datos del guion completo de Maya
 * (nombre, dirección de entrega, ZIP, fecha) SANITIZADOS, sin tocar el guard CA-4.
 * "we're using an LLM to translate natural language into what would otherwise be data
 * points… stick that into the card… retranslate that out to the database". */
import { makeT, src } from './helpers.mjs';
import { runSizeCoverage } from '../../netlify/functions/chat.mjs';

const t = makeT('maya');

/* ── pass-through feliz: todo lo que Maya recogió llega al front, limpio ── */
{
  const r = runSizeCoverage({
    sales_order_number: '100777', sales_order_total: 4100, item_count: 3,
    furniture_types: ['sofa'], cov: 'stain',
    customer_name: '  Bob Miller ',
    delivery_address: ' 9 Oak St, Logan, UT 84321 ',
    delivery_zip: '84321',
    delivery_date: '2026-07-20'
  });
  t(r.customer_name === 'Bob Miller', 'MAYA-8: customer_name pasa TRIMMEADO');
  t(r.delivery_address === '9 Oak St, Logan, UT 84321', 'MAYA-8: delivery_address pasa trimmeada');
  t(r.delivery_zip === '84321', 'MAYA-8: ZIP válido pasa');
  t(r.delivery_date === '2026-07-20', 'MAYA-8: fecha ISO pasa (el input date de la card la acepta tal cual)');
  t(r.needs_review === false, 'CA-4: con order# + furniture_type completos NO se fuerza review (los campos nuevos no gatean)');
  t(r.recommended_plans === 1 && r.covered_up_to === 5000, 'sizing intacto: $4,100 → 1 plan de $5,000');
}

/* ── basura fuera: zip/fecha malformados jamás llegan a la card ── */
{
  const r = runSizeCoverage({
    sales_order_number: '1', sales_order_total: 4100, item_count: 3, furniture_types: ['sofa'],
    delivery_zip: 'ABC12', delivery_date: '07/20/2026'
  });
  t(r.delivery_zip === null, 'MAYA-8: ZIP malformado → null');
  t(r.delivery_date === null, 'MAYA-8: fecha no-ISO → null (la card no recibe basura)');
}
{
  const r = runSizeCoverage({ sales_order_total: 4100, item_count: 3, delivery_zip: '84321-1234' });
  t(r.delivery_zip === '84321-1234', 'MAYA-8: ZIP+4 también vale');
}

/* ── caps defensivos + CA-4 sin cambios de contrato ── */
{
  const r = runSizeCoverage({ sales_order_total: 4100, item_count: 3, customer_name: 'X'.repeat(300), delivery_address: 'Y'.repeat(500) });
  t(r.customer_name.length === 80, 'MAYA-8: nombre capado a 80');
  t(r.delivery_address.length === 200, 'MAYA-8: dirección capada a 200');
  t(Array.isArray(r.missing) && r.missing.includes('sales_order_number') && r.missing.includes('furniture_type')
    && !r.missing.includes('customer_name') && !r.missing.includes('delivery_address'),
    'CA-4 intacto: el guard sigue exigiendo SOLO order# y furniture_type');
  t(r.needs_review === true && typeof r.guard === 'string', 'CA-4 intacto: faltantes → needs_review + guard text');
}

/* ── MAYA-8b (Adrian 09-jul, bug del smoke): el SO jamás se disfraza de nombre ── */
{
  const r = runSizeCoverage({ sales_order_total: 4100, item_count: 3, customer_name: '100777' });
  t(r.customer_name === null, 'MAYA-8b: nombre numérico (el SO) → null, la card queda vacía antes que mentir');
}
{
  const r = runSizeCoverage({ sales_order_total: 4100, item_count: 3, customer_name: 'SO 100777' });
  t(r.customer_name === null, 'MAYA-8b: casi-solo-dígitos → null');
}
{
  const r = runSizeCoverage({ sales_order_total: 4100, item_count: 3, customer_name: 'John Smith 3rd' });
  t(r.customer_name === 'John Smith 3rd', 'MAYA-8b: un nombre real con algún dígito SÍ pasa');
}

/* ── MAYA-8b: email y teléfono capturados y validados server-side ── */
{
  const r = runSizeCoverage({ sales_order_total: 4100, item_count: 3, customer_email: ' Buyer@X.co ', customer_phone: '(555) 010-0199' });
  t(r.customer_email === 'buyer@x.co', 'MAYA-8b: email canonicalizado (lowercase+trim)');
  t(r.customer_phone === '5550100199', 'MAYA-8b: teléfono pasa como DÍGITOS (la máscara del front lo pinta)');
}
{
  const r = runSizeCoverage({ sales_order_total: 4100, item_count: 3, customer_email: 'nope', customer_phone: '555-123' });
  t(r.customer_email === null, 'MAYA-8b: email malformado → null');
  t(r.customer_phone === null, 'MAYA-8b: teléfono con <7 dígitos → null');
}

/* ── sin los campos nuevos (conversaciones viejas / LLM que no los mandó) → null, sin romper ── */
{
  const r = runSizeCoverage({ sales_order_number: '100482', sales_order_total: 8200, item_count: 3, furniture_types: ['sofa'] });
  t(r.customer_name === null && r.delivery_address === null && r.delivery_zip === null && r.delivery_date === null
    && r.customer_email === null && r.customer_phone === null,
    'MAYA-8: campos ausentes → null explícito (el front no vuelca nada)');
  t(r.recommended_plans === 2, 'sizing intacto: $8,200 → 2 planes');
}

/* ── QA-5 (BUG-05 de Jakob): Maya "olvidaba" porque MAX_TURNS=16 (~8 turnos reales)
   expulsaba del contexto los datos ya dados; el fix es doble: ventana más ancha +
   reinyectar lo YA capturado como preámbulo del system en cada request. ── */
{
  const { knownPreamble } = await import('../../netlify/functions/chat.mjs');
  const p = knownPreamble({
    customer_name: 'Bob Miller', sales_order_number: '100777', sales_order_total: 4100,
    item_count: 3, furniture_types: ['sofa', 'recliner'], cov: 'stain',
    delivery_address: '9 Oak St, Logan, UT', delivery_zip: '84321', delivery_date: '2026-07-20'
  });
  t(/ALREADY COLLECTED/.test(p) && /do not ask again/i.test(p), 'QA-5: preámbulo con la instrucción de no re-preguntar');
  t(/Bob Miller/.test(p) && /100777/.test(p) && /84321/.test(p) && /sofa, recliner/.test(p), 'QA-5: nombre + order# + zip + tipos presentes');
  t(knownPreamble(null) === '' && knownPreamble('x') === '' && knownPreamble({}) === '', 'QA-5: sin datos → preámbulo vacío (no ensucia el system)');
  const dirty = knownPreamble({ customer_name: 'A'.repeat(500), evil_key: 'ignored', furniture_types: [{ x: 1 }, 'sofa'], sales_order_total: 'NaN-ish' });
  t(!/evil_key|ignored/.test(dirty) && !/\[object/.test(dirty) && dirty.length < 400, 'QA-5: whitelist + caps (claves ajenas fuera, strings capados, sin [object])');

  const srcChat = src('netlify/functions/chat.mjs');
  t(/const MAX_TURNS = 32/.test(srcChat), 'QA-5: MAX_TURNS 16 → 32 (las digresiones ya no expulsan los datos)');
  t(/knownPreamble\(body\.known\)/.test(srcChat), 'QA-5: el handler reinyecta body.known al system');

  t(/b\.known = covKnown/.test(src('kiosk/index.html')) && /covKnown = d\.coverage/.test(src('kiosk/index.html')), 'QA-5: el kiosk guarda y manda el estado capturado');
  t(/b\.known = covKnown/.test(src('index.html')) && /covKnown = d\.coverage/.test(src('index.html')), 'QA-5: el d2c también (tech es Q&A sin captura, no aplica)');
}

t.done();
