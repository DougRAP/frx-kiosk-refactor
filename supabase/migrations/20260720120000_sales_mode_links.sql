-- ============================================================================
-- Furniture-Rx · KIOSK-22 — Sales-mode URL + QR
-- Fecha: 2026-07-20 · Fuente: email Doug 18-jul #1+#2 (vender sin login) + notes-jul20 §1+2.
--
-- Un link permanente por dealer abre el kiosk en modo venta SIN login. El code es
-- la credencial de distribución (va en /s/{code} y en el QR); el resolver acuña un
-- handoff one-time (120s) por visita → NO hay bearer estático en la URL. Regenerar
-- o deshabilitar desde Dealer Admin.
--
-- NO DESTRUCTIVO: solo ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- Tablas server-only (runtime por Functions con service_role; el browser no accede).
-- ============================================================================

BEGIN;

-- 1) La sesión de kiosk sabe si nació en sales-mode → el badge OCULTA el link Dashboard
--    (Doug: "dashboard access... not sales mode").
ALTER TABLE public.kiosk_sessions
  ADD COLUMN IF NOT EXISTS sales_mode boolean NOT NULL DEFAULT false;

-- 2) Links de sales-mode por dealer.
CREATE TABLE IF NOT EXISTS public.sales_mode_links (
  id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  org_id      uuid NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  org_name    text,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid,                       -- portal user (admin) que lo generó
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sales_mode_links OWNER TO postgres;
CREATE INDEX IF NOT EXISTS sales_mode_links_org_idx  ON public.sales_mode_links (org_id);
CREATE INDEX IF NOT EXISTS sales_mode_links_code_idx ON public.sales_mode_links (code);
COMMENT ON TABLE public.sales_mode_links IS 'KIOSK-22: link permanente por dealer que abre el kiosk en modo venta sin login. /s/{code} → handoff one-time (sales_mode) → kiosk. Regenerar/deshabilitar desde Dealer Admin.';

-- 3) RLS + GRANTs explícitos. Runtime por Functions (service_role); browser sin acceso.
ALTER TABLE public.sales_mode_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_mode_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sales_mode_links TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   \d public.sales_mode_links
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='kiosk_sessions' AND column_name='sales_mode';
-- ============================================================================
