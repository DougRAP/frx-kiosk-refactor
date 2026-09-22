-- ============================================================================
-- Furniture-Rx · Serialización (opción B): identidad YA, mecanismo por-ciclo DESPUÉS
-- Proyecto: jmfndyvwylmqjkngyzxi (FurnitureRX)
-- Fecha: 2026-07-01
--
-- POR QUÉ
--   El negocio (recap 29-jun, SUB-1) quiere un plan numerado por ciclo
--   `{master}-01..36`, claim# = el serial, master# → Zurich. Stripe/nuestro webhook
--   solo modelan la RELACIÓN DE FACTURACIÓN (1 suscripción que renueva; el webhook
--   escucha SOLO checkout.session.completed → nunca "nació el ciclo 2").
--
--   PRINCIPIO: lo único IRREVERSIBLE es la IDENTIDAD (el nº que se le da al cliente).
--   El MECANISMO por-ciclo se reconstruye desde las invoices de Stripe cuando se quiera.
--   → Esta migración fija la identidad (master_no) y DEJA LISTO (vacío) el mecanismo
--     (coverage_certificates). El listener de invoice.paid vive en el webhook detrás de
--     un flag APAGADO (SERIALIZATION_ENABLED) + el evento NO está suscrito en Stripe.
--
-- CÓMO APLICAR
--   Pegar en el SQL Editor de Supabase (corre como postgres) o `supabase db push`.
--   No destructivo: solo agrega columna/secuencia/función/tabla. Tras aplicar, PostgREST
--   recarga su cache de esquema (db push lo hace) → expone /rpc/next_master_no.
-- ============================================================================

BEGIN;

-- 1) Secuencia + función RPC que emite el próximo master# con formato fijo.
--    Formato: RX-##### (5 dígitos, crece si hace falta). El webhook la invoca vía
--    PostgREST (POST /rest/v1/rpc/next_master_no) UNA vez por compra con protección.
CREATE SEQUENCE IF NOT EXISTS public.master_no_seq START WITH 10001;

CREATE OR REPLACE FUNCTION public.next_master_no()
  RETURNS text
  LANGUAGE sql
  VOLATILE
AS $$
  SELECT 'RX-' || lpad(nextval('public.master_no_seq')::text, 5, '0');
$$;

ALTER FUNCTION public.next_master_no() OWNER TO postgres;

-- 2) master_no en subscriptions. NO es UNIQUE de columna: una compra multi-cobertura
--    (stain + stain_mech) tiene VARIAS filas (grano per-item) que COMPARTEN el master#.
--    La membership NO lleva master# (no es un plan asegurado serializado).
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS master_no text;

CREATE INDEX IF NOT EXISTS subscriptions_master_no_idx
  ON public.subscriptions (master_no)
  WHERE master_no IS NOT NULL;

COMMENT ON COLUMN public.subscriptions.master_no
  IS 'Nº de plan del cliente (RX-#####). Estable, compartido por las filas de una misma compra de Stripe. Ancla del serial por-ciclo {master_no}-NN.';

-- 3) coverage_certificates: el SERIAL por ciclo. Se llena SOLO cuando se encienda el
--    mecanismo (invoice.paid). Cuelga de la suscripción de Stripe (no de una fila-item
--    concreta) para no acoplarse al grano per-item. Los claims migrarán a colgar de aquí.
CREATE TABLE IF NOT EXISTS public.coverage_certificates (
  id                     uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id                uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL,
  master_no              text NOT NULL,
  sequence_no            integer NOT NULL,                 -- 01..36
  serial                 text NOT NULL,                    -- '{master_no}-NN' (= claim#)
  coverage_start         date,                             -- ⚠ regla waiting-period 30d PENDIENTE de Doug
  coverage_end           date,
  stripe_invoice_id      text,                             -- idempotencia por ciclo
  status                 text NOT NULL DEFAULT 'active',
  created_at             timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT coverage_certificates_status_chk CHECK (status IN ('active','expired','void'))
);

ALTER TABLE public.coverage_certificates OWNER TO postgres;

-- serial e invoice únicos (idempotencia del mecanismo cuando se encienda).
CREATE UNIQUE INDEX IF NOT EXISTS coverage_certificates_serial_uq
  ON public.coverage_certificates (serial);
CREATE UNIQUE INDEX IF NOT EXISTS coverage_certificates_invoice_uq
  ON public.coverage_certificates (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coverage_certificates_sub_idx
  ON public.coverage_certificates (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS coverage_certificates_user_idx
  ON public.coverage_certificates (user_id);

COMMENT ON TABLE public.coverage_certificates
  IS 'Serial de cobertura por ciclo de 30 días ({master_no}-NN). Vacía hasta encender SERIALIZATION_ENABLED. Fuente reconstruible desde invoices de Stripe.';

-- 4) RLS + grants (regla del proyecto: RLS on + grants explícitos; runtime va por service_role
--    que bypassa RLS, pero authenticated podrá leer lo suyo si algún día se consulta desde el browser).
ALTER TABLE public.coverage_certificates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "coverage_certificates_select_own" ON public.coverage_certificates
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.coverage_certificates FROM anon;
GRANT SELECT ON public.coverage_certificates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.coverage_certificates TO service_role;

-- La función RPC: ejecutable por service_role (la llama el webhook) y por postgres.
GRANT EXECUTE ON FUNCTION public.next_master_no() TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.master_no_seq TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   SELECT public.next_master_no();                       -- → 'RX-10001', 'RX-10002', ...
--   \d public.subscriptions                               -- columna master_no + índice parcial
--   \d public.coverage_certificates                       -- tabla + índices únicos + RLS
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'coverage_certificates';
-- ============================================================================
