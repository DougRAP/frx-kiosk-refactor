-- ============================================================================
-- Furniture-Rx · UNLIM-1 — piezas ilimitadas (decisión Doug, call 06-jul-2026)
-- ----------------------------------------------------------------------------
-- Los planes dejan de estar limitados a "3 piezas por plan": el ÚNICO límite por
-- plan pasa a ser el tope de $5,000 de cobertura (sizing solo-dólares, ver
-- netlify/functions/_lib/coverage-policy.mjs). Por eso se elimina el enforcement
-- de piezas en BD:
--
--   * Trigger real: trg_piece_limit (BEFORE INSERT ON public.covered_pieces),
--     que ejecuta public.enforce_piece_limit() y aborta el insert nº 4 con
--     "A protection plan covers at most 3 pieces". Con piezas ilimitadas ese
--     trigger rompería el webhook de Stripe (insertCoveredPieces expande
--     count > 3 en filas individuales) — hay que quitarlo, no rodearlo.
--
-- El server conserva un cap defensivo alto anti-abuso (MAX_PIECES = 99 en
-- _lib/validate.mjs), que es control de entrada, NO límite de producto.
-- ============================================================================

-- El nombre del trigger en la BD real es trg_piece_limit (ver
-- misc/furniturerx-schema-actual.sql), no enforce_piece_limit (ese es el nombre
-- de la FUNCIÓN que ejecuta).
DROP TRIGGER IF EXISTS trg_piece_limit ON public.covered_pieces;

-- La función solo existía para servir a ese trigger; dejarla viva sería código
-- muerto que un audit futuro podría re-cablear por error.
DROP FUNCTION IF EXISTS public.enforce_piece_limit();
