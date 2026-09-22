/* ============================================================================
 * CA-4 — required-data guard (Doug 29-jun). El SERVER (no el LLM) detecta datos faltantes
 * (nº de orden / tipo de mueble), FUERZA needs_review y emite `guard` para que Maya re-pregunte;
 * y el summary del dashboard incluye lo que el cliente dijo (CA-3/DASH-6). Corre solo (exit 1 si
 * falla) y lo invoca el harness como G14 en subproceso → sin acoplar gate.mjs al SDK de Anthropic.
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { runSizeCoverage, coverageSummaryText } from '../../netlify/functions/chat.mjs';

// 1) datos completos → sin faltantes, dimensiona planes
const full = runSizeCoverage({ sales_order_number: 'SO-123', sales_order_total: 8200, item_count: 3, furniture_types: ['sofa', 'bed'], cov: 'stain' });
assert.equal(full.missing, undefined, 'completo: no debería haber missing');
assert.equal(full.guard, undefined, 'completo: no debería haber guard');
assert.ok(full.recommended_plans >= 1, 'completo: debería dimensionar >=1 plan');

// 2) falta el nº de orden → guard + needs_review forzado por el server
const noOrder = runSizeCoverage({ sales_order_total: 8200, item_count: 3, furniture_types: ['sofa'] });
assert.ok(noOrder.missing?.includes('sales_order_number'), 'sin orden: missing debe incluir sales_order_number');
assert.equal(noOrder.needs_review, true, 'sin orden: needs_review forzado');
assert.ok(typeof noOrder.guard === 'string' && noOrder.guard.length > 0, 'sin orden: guard presente');

// 3) falta el tipo de mueble → guard + needs_review
const noType = runSizeCoverage({ sales_order_number: 'SO-9', sales_order_total: 8200, item_count: 3 });
assert.ok(noType.missing?.includes('furniture_type'), 'sin tipo: missing debe incluir furniture_type');
assert.equal(noType.needs_review, true, 'sin tipo: needs_review forzado');

// 4) el summary del dashboard incluye lo que el cliente dijo (CA-3/DASH-6)
const summary = coverageSummaryText(full);
assert.ok(summary.includes('sofa') && summary.includes('bed'), 'summary debe listar los muebles capturados');

// 5) furniture_types: dedupe + trim + descarta no-strings (input no confiable del LLM)
const dirty = runSizeCoverage({ sales_order_total: 100, item_count: 1, furniture_types: ['  sofa ', 'sofa', '', 42] });
assert.deepEqual(dirty.furniture_types, ['sofa'], 'furniture_types: dedupe + trim + drop no-strings');

// 6) NUNCA hard-block: aun con TODO faltante, devuelve el sizing (permitir continuar con advertencia)
const empty = runSizeCoverage({ sales_order_total: 3000, item_count: 1 });
assert.ok(empty.recommended_plans >= 1, 'sin orden ni tipo: igual dimensiona (no bloquea, solo advierte)');
assert.deepEqual(empty.missing, ['sales_order_number', 'furniture_type'], 'ambos faltantes listados');

console.log('CA-4 guard OK (6 checks)');
