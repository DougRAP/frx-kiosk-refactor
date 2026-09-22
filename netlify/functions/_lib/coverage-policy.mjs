/* ============================================================================
 * _lib/coverage-policy.mjs — política de cobertura (SOLO-DÓLARES, Doug call 06-jul).
 *
 * MODELO: la cobertura se dimensiona en planes de $5,000 de retail. Si la orden es
 * mayor, se agregan planes — PREMIUM-MATCHED: la cobertura nunca excede lo que paga
 * el cliente (sin exposición no-tarifada, sin recorte/claw-back posterior).
 *
 * ✅ DECISIÓN CERRADA (Doug, call 06-jul-2026): PIEZAS ILIMITADAS. El límite de
 * "3 piezas por plan" desaparece; el ÚNICO límite por plan es el tope de $5,000 de
 * cobertura. El dilema DUAL-vs-solo-dólares que documentaba la versión anterior de
 * este header (artefactos con "up to 3 PIECES" vs la llamada del 25-jun) se resolvió
 * a favor de solo-dólares:
 *   recommendedPlans = max(1, ceil(totalCents / perPlanLimitCents)), topado por
 *   maxPlansPerOrder. `itemCount` se acepta y se devuelve como dato INFORMATIVO
 *   (sirve al guard CA-4 y al summary del dashboard) pero YA NO dimensiona.
 *   `binding` es SIEMPRE 'dollars' — la clave se conserva en la respuesta por
 *   compatibilidad con los consumidores existentes (chat.mjs / front / tests).
 *   ('Up to 3 covered claims per item' es un límite del lado de CLAIMS — no aquí.)
 * En BD, el trigger trg_piece_limit (enforce_piece_limit) se elimina en la
 * migración 20260706200000_unlimited_pieces.sql.
 *
 * FLAGS (ÚNICA fuente — cambiar AQUÍ):
 *   perPlanLimitCents  — cobertura $ por plan (centavos). $5,000 = 500000.
 *   maxPlansPerOrder   — tope de planes por sales order. 3 = $15,000.
 *   overLimitMode      — 'upsell' (DEFAULT) | 'cap' | 'review'.
 *
 * Default = Opción A (premium-matched, upsell hasta el tope, revisión humana arriba) —
 * más barata que "otorgar $15k y recortar" (sin claw-back, la causa #1 de disputas en seguros).
 *
 * Pura y testeable (sin DOM, sin red).
 * ==========================================================================*/

'use strict';

export const COVERAGE_POLICY = {
  perPlanLimitCents: 500000,   // $5,000 retail / plan
  maxPiecesPerPlan: null,      // PIEZAS ILIMITADAS (Doug 06-jul). Clave conservada por compat; siempre null.
  maxPlansPerOrder: 3,         // $15,000 / sales order
  overLimitMode: 'upsell'      // 'upsell' | 'cap' | 'review'
};

/* sizeCoverage(totalCentavos, nºItems, cfg) → dimensionamiento PREMIUM-MATCHED, solo por dólares.
 * recommendedPlans = max(1, ceil(total / $5k)), limitado por el tope de planes.
 * `itemCount` es informativo (no ata). `binding` es siempre 'dollars' (compat).
 * coveredCents nunca excede lo pagado. */
export function sizeCoverage(orderTotalCents, itemCount, cfg = COVERAGE_POLICY) {
  const per = cfg.perPlanLimitCents;
  const cap = cfg.maxPlansPerOrder;
  const total = Math.max(0, Math.round(Number(orderTotalCents) || 0));
  const pieces = Math.max(0, Math.floor(Number(itemCount) || 0));   // informativo — ya no dimensiona

  const byDollars = total === 0 ? 1 : Math.ceil(total / per);
  const idealPlans = Math.max(1, byDollars);               // solo los dólares mandan (Doug 06-jul)
  const recommendedPlans = Math.min(idealPlans, cap);      // limitado por el tope de planes
  const coveredCents = recommendedPlans * per;
  const overCap = idealPlans > cap;                        // ni con el máximo de planes alcanza

  return {
    mode: cfg.overLimitMode,
    orderTotalCents: total,
    itemCount: pieces,          // informativo (guard CA-4 / summary), no limita
    perPlanLimitCents: per,
    maxPiecesPerPlan: null,     // compat: piezas ilimitadas
    maxPlansPerOrder: cap,
    byDollars,                  // planes que piden los dólares (= idealPlans)
    byPieces: 1,                // compat: las piezas ya no piden planes
    binding: 'dollars',         // compat: el ÚNICO límite que ata es el de dólares
    idealPlans,                 // sin tope
    recommendedPlans,           // 1..cap, premium-matched
    coveredCents,               // = recommendedPlans × per
    uncoveredCents: Math.max(0, total - coveredCents),
    overCap,                    // orden supera lo que cubre el máximo de planes
    needsReview: overCap        // bandera para revisión humana
  };
}
