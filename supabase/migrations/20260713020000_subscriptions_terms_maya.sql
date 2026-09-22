-- ============================================================================
-- Furniture-Rx · Subscription Portal — PORT-4: captura para la ficha del portal
-- Fecha: 2026-07-13
--
-- POR QUÉ
--   El Customer Record del portal (PORT-5) muestra la versión de T&C aceptada y el
--   resumen del chat de Maya. Hoy no se persisten. Se añaden como columnas de la
--   subscription; el checkout/webhook las llenan (terms_version server-side; maya_summary
--   opcional desde el chat). NO destructivo.
-- ============================================================================

BEGIN;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS maya_summary  text;

COMMENT ON COLUMN public.subscriptions.terms_version IS 'Versión de T&C aceptada en la compra (server-stamped). La ficha del portal la muestra.';
COMMENT ON COLUMN public.subscriptions.maya_summary  IS 'Resumen del chat de Maya en el checkout (opcional). Lo muestra la ficha del portal.';

COMMIT;
