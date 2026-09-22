-- ============================================================================
-- Furniture-Rx · foto del recibo en el checkout (BE-1)
-- Proyecto: jmfndyvwylmqjkngyzxi (FurnitureRX)
-- Fecha: 2026-06-25
--
-- POR QUÉ
--   Doug (24-jun) pidió capturar una FOTO del sales receipt en el checkout. La
--   imagen NO va en Postgres (anti-patrón: bloat/perf) → bucket PRIVADO de Supabase
--   Storage; la BD solo guarda la RUTA (receipt_path). El upload lo hace la Function
--   upload-receipt con service_role (el navegador NO tiene llave de Supabase).
--
-- CÓMO APLICAR
--   Pegar en el SQL Editor de Supabase (corre como postgres) o `supabase db push`.
--   Idempotente (ON CONFLICT / IF NOT EXISTS). Aplicar ANTES de desplegar el webhook
--   (que ya escribe subscriptions.receipt_path).
-- ============================================================================

BEGIN;

-- 1) Bucket PRIVADO para los recibos. public=false → sin URL pública; acceso solo por
--    service_role en el server (o por signed URLs futuras para staff de claims). PII por diseño.
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

-- 2) Sin políticas RLS sobre storage.objects para este bucket: sin policy permisiva,
--    anon/authenticated NO pueden leer ni escribir; service_role bypassa RLS (es quien sube).
--    Privado por ausencia de policy → no se añade nada a propósito.

-- 3) Ruta del recibo en la suscripción. La imagen vive en Storage; aquí solo el path
--    (bucket/yyyy/mm/uuid.jpg). El webhook lo copia desde leads.payload al confirmarse el pago.
--    Las columnas sales_order_number/receipt_zip/purchased_on/dealer_id ya existen (20260526).
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS receipt_path text;

-- La columna nueva hereda los grants de la tabla (SELECT→authenticated, ALL→service_role)
-- ya definidos en 20260526000000 (los GRANT son a nivel tabla) → no requiere GRANT nuevo.

COMMENT ON COLUMN public.subscriptions.receipt_path
  IS 'Ruta en Storage (bucket privado receipts) de la foto del sales receipt (BE-1). La imagen NO se guarda en la BD.';

COMMIT;

-- ============================================================================
-- Verificación (opcional):
--   select id, public from storage.buckets where id = 'receipts';   -- public debe ser false
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='subscriptions' and column_name='receipt_path';
-- ============================================================================
