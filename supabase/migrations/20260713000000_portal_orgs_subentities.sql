-- ============================================================================
-- Furniture-Rx · Subscription Portal (email Doug 11-jul) — PORT-2: modelo de datos
-- Proyecto: FurnitureRX (mismo que clientes/kiosk/tech)
-- Fecha: 2026-07-13
--
-- POR QUÉ
--   El portal (misc/compendio-doug-11jul.html) es una app sobre la familia FurnitureRx.
--   Charla de Doug: "the important thing is, it's all the data elements … how to think about
--   the data". Esta migración fija ESE modelo, sin tocar el flujo de clientes (AUTH-2) ni
--   el checkout. `subscriptions.dealer_id` YA existe (20260526) → aquí NO se duplica.
--
-- NO DESTRUCTIVO: solo ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS. Las subs
--   actuales son test data (Adrian 13-jul) → sin backfill delicado.
--
-- CÓMO APLICAR: pegar en el SQL Editor de Supabase (corre como postgres) o `supabase db push`.
-- ============================================================================

BEGIN;

-- 1) `dealers` pasa de {id,name,slug} a ORG completa de AMBOS mundos (retailer/technician).
--    Se conserva el NOMBRE físico `dealers` para no romper las FKs que ya la referencian
--    (profiles.dealer_id, subscriptions.dealer_id); el API la expone como `org_id` neutral.
ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS world             text NOT NULL DEFAULT 'retailer',
  ADD COLUMN IF NOT EXISTS rap_id            text,
  ADD COLUMN IF NOT EXISTS frx_account_id    text,
  ADD COLUMN IF NOT EXISTS hq_address        text,
  ADD COLUMN IF NOT EXISTS key_contacts      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS selling_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dashboard_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS access_start      date,
  ADD COLUMN IF NOT EXISTS access_end        date;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dealers_world_chk') THEN
    ALTER TABLE public.dealers
      ADD CONSTRAINT dealers_world_chk CHECK (world IN ('retailer','technician'));
  END IF;
END $$;

COMMENT ON COLUMN public.dealers.world IS 'retailer (Dealer→Store) | technician (Company→Technician). El API relabela por world.';

-- 2) `sub_entities`: la sub-unidad con login. Stores (world retailer) y technicians (world
--    technician) viven en la MISMA tabla (API-CONTRACT §8.1). `login_user_id` es opcional
--    (se setea al invitar). Un `org_id` (dealers) la posee.
CREATE TABLE IF NOT EXISTS public.sub_entities (
  id            uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  world         text NOT NULL,
  name          text NOT NULL,
  location      text,
  login_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'invited',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sub_entities_world_chk  CHECK (world IN ('retailer','technician')),
  CONSTRAINT sub_entities_status_chk CHECK (status IN ('active','invited','disabled'))
);

ALTER TABLE public.sub_entities OWNER TO postgres;

CREATE INDEX IF NOT EXISTS sub_entities_org_idx   ON public.sub_entities (org_id);
CREATE INDEX IF NOT EXISTS sub_entities_login_idx ON public.sub_entities (login_user_id) WHERE login_user_id IS NOT NULL;

COMMENT ON TABLE public.sub_entities IS 'Store (retailer) o Technician (technician) con login opcional. Cuelga de una org (dealers).';

-- 3) Enlazar `subscriptions` a la sub-unidad y (a futuro) al associate gestionado.
--    `dealer_id` (= org) YA existe. `sales_associate` (texto libre) se queda; el id es para
--    la futura lista gestionada (pregunta 9 a Doug), nullable, sin romper nada.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS sub_entity_id       uuid REFERENCES public.sub_entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sales_associate_id  uuid;

CREATE INDEX IF NOT EXISTS subscriptions_sub_entity_idx ON public.subscriptions (sub_entity_id) WHERE sub_entity_id IS NOT NULL;

-- 4) RLS + GRANTs explícitos (regla de la cuenta: Data API). El portal lee vía Functions con
--    service_role (el browser NO tiene key Supabase), así que a `authenticated` NO le hace falta
--    grant directo; RLS queda como defensa en profundidad. `anon` sin acceso.
ALTER TABLE public.sub_entities ENABLE ROW LEVEL SECURITY;

-- El login vinculado puede leer su propia sub-entidad (defensa en profundidad; el runtime va por service_role).
DROP POLICY IF EXISTS "sub_entities_select_own" ON public.sub_entities;
CREATE POLICY "sub_entities_select_own" ON public.sub_entities
  FOR SELECT TO authenticated USING (login_user_id = auth.uid());

REVOKE ALL ON public.sub_entities FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sub_entities TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   \d public.dealers            -- columnas world, rap_id, selling_enabled, access_*
--   \d public.sub_entities       -- tabla + FKs + checks + RLS
--   \d public.subscriptions      -- sub_entity_id, sales_associate_id
--   SELECT grantee, table_name, string_agg(privilege_type,', ' ORDER BY privilege_type) privs
--     FROM information_schema.role_table_grants
--     WHERE table_schema='public' AND table_name='sub_entities'
--       AND grantee IN ('anon','authenticated','service_role')
--     GROUP BY grantee, table_name ORDER BY grantee;
-- ============================================================================
