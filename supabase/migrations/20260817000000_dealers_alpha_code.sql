-- ============================================================================
-- Furniture-Rx · DEAL-1 (UW-1) — `dealers.alpha_code`: el código de 3 letras
-- Fecha: 2026-08-17
--
-- POR QUÉ
--   El reporte de underwriting identifica a cada dealer por un código de 3 letras
--   (AFA, BLS, SCH…). Hoy ese código vive solo por convención dentro de `rap_id`
--   ('BLS-1001'): la columna es nullable, no tiene UNIQUE y no tiene formato
--   garantizado, así que el reporte depende de un `split_part(rap_id,'-',1)` que
--   se rompe en silencio con el primer rap_id que no siga la convención.
--   Al ser la llave con la que se remite a la reaseguradora, necesita garantías
--   de la base de datos, no de una convención de nombres.
--
-- NO DESTRUCTIVO: ADD COLUMN IF NOT EXISTS + índice + un UPDATE que solo rellena
--   filas con `alpha_code IS NULL`. `rap_id` se conserva intacto (sigue siendo el
--   ID visible del dealer en el portal); esta columna lo complementa, no lo sustituye.
--
-- CÓMO APLICAR: `supabase db push` o pegar en el SQL Editor.
-- ============================================================================

BEGIN;

-- 1) La columna. Nullable a propósito: un dealer puede existir antes de que la
--    reaseguradora le asigne su alpha (alta en portal → código días después).
ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS alpha_code text;

-- 2) Formato: exactamente 3 mayúsculas ASCII. NULL pasa (CHECK NULL = desconocido
--    = no viola), que es justo lo que queremos para el dealer aún sin código.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dealers_alpha_code_chk') THEN
    ALTER TABLE public.dealers
      ADD CONSTRAINT dealers_alpha_code_chk CHECK (alpha_code IS NULL OR alpha_code ~ '^[A-Z]{3}$');
  END IF;
END $$;

-- 3) Backfill desde la convención vigente ('BLS-1001' → 'BLS'). Solo toca filas
--    sin código y con un rap_id que YA cumple el formato; el resto se queda NULL
--    para que se cargue a mano y no se inventen códigos.
UPDATE public.dealers
   SET alpha_code = split_part(rap_id, '-', 1)
 WHERE alpha_code IS NULL
   AND rap_id ~ '^[A-Z]{3}-';

-- 4) Unicidad: un alpha identifica a UN dealer en el reporte. Se crea DESPUÉS del
--    backfill a propósito — si dos dealers comparten prefijo, esta línea falla y
--    revierte la transacción entera en vez de dejar datos ambiguos en producción.
--    Los NULL no colisionan entre sí en un índice único de Postgres.
CREATE UNIQUE INDEX IF NOT EXISTS dealers_alpha_code_uidx
  ON public.dealers (alpha_code);

COMMENT ON COLUMN public.dealers.alpha_code IS
  'Código de 3 letras con el que la reaseguradora identifica al dealer (DEAL-1/UW-1). Fuente de verdad del reporte de underwriting; rap_id queda como ID visible del portal.';

COMMIT;

-- ============================================================================
-- VERIFICAR después de aplicar
--
--   -- la columna, su CHECK y su índice existen
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'dealers' AND column_name = 'alpha_code';
--   SELECT conname FROM pg_constraint WHERE conname = 'dealers_alpha_code_chk';
--   SELECT indexname FROM pg_indexes WHERE indexname = 'dealers_alpha_code_uidx';
--
--   -- qué quedó cargado y a quién le falta
--   SELECT name, rap_id, alpha_code FROM public.dealers ORDER BY alpha_code NULLS LAST;
--
-- SI EL PUSH FALLA en el paso 4 (duplicate key), el diagnóstico es:
--   SELECT split_part(rap_id,'-',1) AS alpha, count(*), array_agg(name)
--     FROM public.dealers WHERE rap_id ~ '^[A-Z]{3}-'
--    GROUP BY 1 HAVING count(*) > 1;
-- ============================================================================
