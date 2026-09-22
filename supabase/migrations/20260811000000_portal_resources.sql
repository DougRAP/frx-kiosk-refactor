-- ============================================================================
-- Furniture-Rx · Portal Resources (upload admin + asignación por dealer)
-- Fuente: revisiones/ChangesBLS.srt 02:10–04:11 · spec: misc/spec-portal-resources.md
-- CÓMO APLICAR: SQL Editor de Supabase o `supabase db push`. Idempotente.
-- ============================================================================

BEGIN;

-- 1) Bucket PRIVADO para los archivos (mismo patrón que 20260625 receipts): public=false,
--    sin policy → solo service_role escribe/lee (el browser no tiene llave de Supabase).
INSERT INTO storage.buckets (id, name, public)
VALUES ('resources', 'resources', false)
ON CONFLICT (id) DO NOTHING;

-- 2) Catálogo de recursos. El archivo vive en Storage (storage_path) o es un link externo
--    (link_url, p.ej. video). Uno de los dos.
CREATE TABLE IF NOT EXISTS public.resources (
  id            uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  title         text NOT NULL,
  description   text,
  resource_type text NOT NULL CHECK (resource_type IN ('sell_sheet','selling_pos','product_overview','customer_info')),
  storage_path  text,
  link_url      text,
  mime_type     text,
  size_bytes    integer,
  all_dealers   boolean NOT NULL DEFAULT false,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_type_idx ON public.resources (resource_type);

-- 3) Asignación por dealer (solo se usa cuando all_dealers = false).
CREATE TABLE IF NOT EXISTS public.resource_dealers (
  resource_id uuid NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
  dealer_id   uuid NOT NULL REFERENCES public.dealers(id)   ON DELETE CASCADE,
  PRIMARY KEY (resource_id, dealer_id)
);
CREATE INDEX IF NOT EXISTS resource_dealers_dealer_idx ON public.resource_dealers (dealer_id);

-- 4) RLS + GRANTs explícitos. Runtime por Functions (service_role); browser sin acceso.
ALTER TABLE public.resources        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_dealers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.resources        FROM anon, authenticated;
REVOKE ALL ON public.resource_dealers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.resources        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.resource_dealers TO service_role;

COMMENT ON TABLE public.resources IS 'Portal Resources: material de venta (sell sheet, POS, video, customer info) subido por admin y asignado a todos o a dealers específicos (ChangesBLS.srt 11-ago).';

COMMIT;

-- ============================================================================
-- Verificación (correr aparte):
--   select id, public from storage.buckets where id='resources';   -- public=false
--   select grantee, privilege_type from information_schema.role_table_grants
--     where table_schema='public' and table_name in ('resources','resource_dealers')
--     order by table_name, grantee;
-- ============================================================================
