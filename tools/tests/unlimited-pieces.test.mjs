/* UNLIM-1 — piezas ilimitadas (decisión Doug, call 06-jul). El sizing es SOLO por
 * dólares: recommendedPlans = ceil(total / $5,000); el nº de ítems queda informativo
 * (ya no ata). El guard CA-4 (order# + furniture type) sigue intacto — es requisito
 * de servicio de claims, no un límite de piezas. También se asegura que el SYSTEM
 * de Maya ya no anuncie "Up to 3 pieces" ni dispare el custom quote por nº de piezas. */
import { makeT, src } from './helpers.mjs';
import { sizeCoverage, COVERAGE_POLICY } from '../../netlify/functions/_lib/coverage-policy.mjs';
import { runSizeCoverage } from '../../netlify/functions/chat.mjs';

const t = makeT('unlimited-pieces');

/* --- sizeCoverage: dimensiona por dólares, las piezas NO atan --- */
{
  const s = sizeCoverage(820000, 3);   // $8,200 con 3 ítems
  t(s.recommendedPlans === 2, 'sizeCoverage: $8,200 / 3 items → 2 planes (ceil por $5k)');
  t(s.binding === 'dollars', 'sizeCoverage: binding "dollars" con pocos ítems');
}
{
  const s = sizeCoverage(820000, 47);  // $8,200 con 47 ítems — antes las piezas pedían 16 planes
  t(s.recommendedPlans === 2, 'sizeCoverage: $8,200 / 47 items → SIGUE siendo 2 planes (piezas ya no atan)');
  t(s.binding === 'dollars', 'sizeCoverage: binding "dollars" aunque haya 47 ítems');
}
{
  const s = sizeCoverage(1200000, 5);  // $12,000
  t(s.recommendedPlans === 3, 'sizeCoverage: $12,000 → 3 planes');
  t(s.overCap === false, 'sizeCoverage: $12,000 cabe en el tope de 3 planes (sin overCap)');
}
{
  const s = sizeCoverage(40000, 1);    // $400
  t(s.recommendedPlans === 1, 'sizeCoverage: $400 → 1 plan (mínimo)');
  t(s.binding === 'dollars', 'sizeCoverage: binding "dollars" en el caso mínimo');
}
{
  const s = sizeCoverage(2000000, 2);  // $20,000 > 3 planes × $5k → revisión humana (conservado)
  t(s.overCap === true && s.needsReview === true, 'sizeCoverage: sobre el tope de planes → overCap + needsReview (se conserva)');
}
t(!COVERAGE_POLICY.maxPiecesPerPlan, 'policy: sin límite de piezas por plan (unlimited, Doug 06-jul)');

/* --- runSizeCoverage (chat.mjs): mismo sizing + el guard CA-4 sigue vivo --- */
{
  const r = runSizeCoverage({ sales_order_total: 8200, item_count: 47 });
  t(r.recommended_plans === 2, 'runSizeCoverage: $8,200 / 47 items → 2 planes');
  t(r.binding === 'dollars', 'runSizeCoverage: binding siempre "dollars" (clave conservada por compat)');
  t(r.item_count === 47, 'runSizeCoverage: item_count se conserva informativo');
  t(r.missing?.includes('sales_order_number') && r.missing?.includes('furniture_type'),
    'runSizeCoverage: guard CA-4 intacto — sigue marcando order# y furniture_type faltantes');
  t(r.needs_review === true, 'runSizeCoverage: faltantes → needs_review forzado (CA-4)');
}

/* --- SYSTEM de Maya: sin rastro del límite de 3 piezas ni del gatillo "6 pieces" --- */
{
  const chatSrc = src('netlify/functions/chat.mjs');
  t(!chatSrc.includes('Up to 3 pieces'), 'chat.mjs: el SYSTEM ya no dice "Up to 3 pieces"');
  t(!/MORE than 6 pieces|more than 6 pieces/.test(chatSrc), 'chat.mjs: el custom quote ya no se dispara por nº de piezas');
  t(chatSrc.includes('$5,000 total coverage'), 'chat.mjs: el tope de $5,000 por plan sigue enunciado');
}

t.done();
