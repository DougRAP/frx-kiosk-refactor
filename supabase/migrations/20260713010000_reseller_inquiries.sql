-- ============================================================================
-- Furniture-Rx · Subscription Portal — PORT-13: reseller inquiries ("become a reseller")
-- Fecha: 2026-07-13
--
-- POR QUÉ
--   El landing del portal tiene el ÚNICO write sin auth (§5.15): el formulario "become a
--   reseller". El `world` es OBLIGATORIO — "an untagged lead surfaces in neither and is
--   silently lost". El POST público entra por la Function `portal-inquiries` con service_role
--   + rate-limit; el browser NO toca esta tabla directo (por eso `anon` sin acceso).
--
-- CÓMO APLICAR: SQL Editor de Supabase o `supabase db push`.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.reseller_inquiries (
  id               uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  name             text NOT NULL,
  email            text NOT NULL,
  phone            text,
  world            text NOT NULL,
  status           text NOT NULL DEFAULT 'New',
  converted_org_id uuid REFERENCES public.dealers(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reseller_inquiries_world_chk  CHECK (world IN ('retailer','technician')),
  CONSTRAINT reseller_inquiries_status_chk CHECK (status IN ('New','Contacted','Converted'))
);

ALTER TABLE public.reseller_inquiries OWNER TO postgres;

CREATE INDEX IF NOT EXISTS reseller_inquiries_world_status_idx ON public.reseller_inquiries (world, status);
CREATE INDEX IF NOT EXISTS reseller_inquiries_created_idx      ON public.reseller_inquiries (created_at DESC);

COMMENT ON TABLE public.reseller_inquiries IS 'Leads del formulario "become a reseller" del landing del portal. world OBLIGATORIO (routing admin por mundo).';

-- RLS + grants: solo service_role (todo el acceso pasa por la Function `portal-inquiries`).
ALTER TABLE public.reseller_inquiries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reseller_inquiries FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reseller_inquiries TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
--   SELECT grantee, string_agg(privilege_type,', ' ORDER BY privilege_type) privs
--     FROM information_schema.role_table_grants
--     WHERE table_schema='public' AND table_name='reseller_inquiries'
--       AND grantee IN ('anon','authenticated','service_role')
--     GROUP BY grantee ORDER BY grantee;
-- ============================================================================
