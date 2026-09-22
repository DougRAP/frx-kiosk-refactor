-- ============================================================================
-- Furniture-Rx · Categorías de piece_type (ampliación del enum)
-- Proyecto: jmfndyvwylmqjkngyzxi (FurnitureRX)
-- Fecha: 2026-06-19
--
-- POR QUÉ
--   El front (index.html → TYPES) usa categorías nuevas
--   (furniture/outdoor/adjbed/mattress/rugs/lighting), pero el enum `piece_type`
--   de la BD solo tiene sofa/sectional/recliner/dining/bed/other. Por eso
--   `insertCoveredPieces` FALLA tras el pago en TODO checkout con plan (PostgREST 400
--   por valor de enum inválido). Ampliamos el enum con las 6 categorías.
--
-- NOTA SOBRE care_kits (NO se siembra aquí)
--   La tabla `care_kits` YA estaba sembrada con los SKUs canónicos
--   (CARE-WOOD-001, CARE-FABRIC-001, CARE-LEATHER-001). El front usa esos SKUs.
--   Precio acordado = $49.99 (4999) parejo para los tres; se ajusta con un UPDATE
--   aparte (NO en esta migración):
--     UPDATE public.care_kits SET price_cents = 4999
--     WHERE sku IN ('CARE-WOOD-001','CARE-FABRIC-001','CARE-LEATHER-001');
--
-- CÓMO APLICAR
--   `supabase db push` (tras `supabase migration repair --status applied 20260526000000`
--   para registrar la migración vieja sin re-ejecutarla), o pegar en el SQL Editor.
--   NOTA: `ALTER TYPE ... ADD VALUE` NO puede ejecutarse dentro de una transacción
--   si el valor se usa en la MISMA transacción. Por eso los ADD VALUE van sueltos
--   (auto-commit), sin BEGIN/COMMIT.
-- ============================================================================

-- Ampliar el enum piece_type con las categorías del front (idempotente).
ALTER TYPE public.piece_type ADD VALUE IF NOT EXISTS 'furniture';
ALTER TYPE public.piece_type ADD VALUE IF NOT EXISTS 'outdoor';
ALTER TYPE public.piece_type ADD VALUE IF NOT EXISTS 'adjbed';
ALTER TYPE public.piece_type ADD VALUE IF NOT EXISTS 'mattress';
ALTER TYPE public.piece_type ADD VALUE IF NOT EXISTS 'rugs';
ALTER TYPE public.piece_type ADD VALUE IF NOT EXISTS 'lighting';

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   SELECT unnest(enum_range(NULL::public.piece_type));        -- debe incluir las 6 nuevas
--   SELECT sku, name, price_cents, active FROM public.care_kits ORDER BY sku;
-- ============================================================================
