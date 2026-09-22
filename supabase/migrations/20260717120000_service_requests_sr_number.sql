-- ============================================================================
-- PORT-24C (review Doug 17-jul): número serializado + categoría para service_requests.
--
-- POR QUÉ
--   Doug: "when you send a service request, you generate a number." Y el form del
--   Customer Record gana un menú de categorías (single-select, el último "Resolved"
--   cierra). Añadimos el número serializado (SR-#####, patrón de master_no), la
--   categoría y la marca de resolución. Las columnas previas (body, status, history,
--   stage) se conservan.
--
-- NO DESTRUCTIVO: solo ADD COLUMN IF NOT EXISTS + CREATE IF NOT EXISTS.
-- ============================================================================

BEGIN;

-- 1) columnas nuevas
ALTER TABLE public.service_requests
  ADD COLUMN IF NOT EXISTS sr_number   text,
  ADD COLUMN IF NOT EXISTS category    text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

COMMENT ON COLUMN public.service_requests.sr_number IS 'PORT-24C: número serializado SR-##### (next_sr_no).';
COMMENT ON COLUMN public.service_requests.category  IS 'PORT-24C: categoría del menú single-select del form.';

-- 2) secuencia + RPC del número (mismo patrón que master_no_seq/next_master_no)
CREATE SEQUENCE IF NOT EXISTS public.sr_no_seq START WITH 1001;

CREATE OR REPLACE FUNCTION public.next_sr_no()
  RETURNS text
  LANGUAGE sql
  VOLATILE
AS $$
  SELECT 'SR-' || lpad(nextval('public.sr_no_seq')::text, 5, '0');
$$;
ALTER FUNCTION public.next_sr_no() OWNER TO postgres;

GRANT EXECUTE ON FUNCTION public.next_sr_no() TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sr_no_seq TO service_role;

COMMIT;

-- Verificación:
--   SELECT public.next_sr_no();   -- → 'SR-01001', 'SR-01002', ...
