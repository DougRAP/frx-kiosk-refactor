-- ============================================================================
-- Furniture-Rx · PORT-8a + REIN-1 — esquema de comisiones con split reinsurance
-- Fecha: 2026-07-15 · Fuente: respuestas de Doug 15-jul (email + llamada)
--
-- Modelo (canon 15-jul): comisión FIJA por SKU por pago mensual recibido
--   stain = $2.00 · stain_mech = $8.00 (el $6 del mock murió).
-- Split por dealer: parte a su Stripe (transfer real) y parte ASIGNADA a
-- reinsurance (solo registro; Daniel reporta a Zurich cada mes). Doug: "we just
-- need to ensure that the DB has that capability" + "add a field to that table
-- that says amount allocated to reinsurance".
--
-- NO DESTRUCTIVO: solo CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ============================================================================

BEGIN;

-- 1) Tasas: fila org_id NULL = default global; fila con org_id = override Dev-controlled.
CREATE TABLE IF NOT EXISTS public.commission_rates (
  id                        uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  org_id                    uuid REFERENCES public.dealers(id) ON DELETE CASCADE,
  plan_sku                  text NOT NULL,
  stripe_amount_cents       integer NOT NULL DEFAULT 0,
  reinsurance_amount_cents  integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rates_sku_chk CHECK (plan_sku IN ('stain','stain_mech')),
  CONSTRAINT commission_rates_amounts_chk CHECK (stripe_amount_cents >= 0 AND reinsurance_amount_cents >= 0)
);
ALTER TABLE public.commission_rates OWNER TO postgres;

-- UNIQUE con org_id NULL tratado como valor (portable, sin depender de NULLS NOT DISTINCT)
CREATE UNIQUE INDEX IF NOT EXISTS commission_rates_org_sku_uidx
  ON public.commission_rates (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), plan_sku);

COMMENT ON TABLE public.commission_rates IS 'Tasa de comisión por SKU. org_id NULL = global ($2/$8). Override por dealer con split stripe/reinsurance (llamada 15-jul, ej. Bailey''s 400/400). Dev-controlled, sin UI.';

-- Seed de los defaults globales (idempotente)
INSERT INTO public.commission_rates (org_id, plan_sku, stripe_amount_cents, reinsurance_amount_cents)
SELECT NULL, 'stain', 200, 0
WHERE NOT EXISTS (SELECT 1 FROM public.commission_rates WHERE org_id IS NULL AND plan_sku = 'stain');
INSERT INTO public.commission_rates (org_id, plan_sku, stripe_amount_cents, reinsurance_amount_cents)
SELECT NULL, 'stain_mech', 800, 0
WHERE NOT EXISTS (SELECT 1 FROM public.commission_rates WHERE org_id IS NULL AND plan_sku = 'stain_mech');

-- 2) Connect account del dealer (onboarding manual: Doug manda el account number)
ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS stripe_account_id text;
COMMENT ON COLUMN public.dealers.stripe_account_id IS 'Stripe Connect (Express) del dealer. NULL = aún no conectado → no hay transfers (solo se registraría al conectarlo).';

-- 3) Ledger APPEND-ONLY: una fila por (invoice, SKU). La verdad de reconciliación
--    y la fuente del reporte de reinsurance. El portal lee de AQUÍ (jamás revenue de RAP, §5.9).
CREATE TABLE IF NOT EXISTS public.commission_ledger (
  id                        uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  stripe_invoice_id         text NOT NULL,
  stripe_subscription_id    text NOT NULL,
  org_id                    uuid REFERENCES public.dealers(id) ON DELETE SET NULL,
  plan_sku                  text NOT NULL,
  qty                       integer NOT NULL DEFAULT 1,
  stripe_amount_cents       integer NOT NULL DEFAULT 0,   -- porción cash (qty incluida)
  reinsurance_amount_cents  integer NOT NULL DEFAULT 0,   -- porción reinsurance (REIN-1)
  transfer_id               text,                          -- tr_... cuando el transfer salió
  status                    text NOT NULL DEFAULT 'recorded',
  paid_at                   timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_ledger_sku_chk    CHECK (plan_sku IN ('stain','stain_mech')),
  CONSTRAINT commission_ledger_status_chk CHECK (status IN ('recorded','transferred')),
  CONSTRAINT commission_ledger_invoice_sku_uq UNIQUE (stripe_invoice_id, plan_sku)
);
ALTER TABLE public.commission_ledger OWNER TO postgres;

CREATE INDEX IF NOT EXISTS commission_ledger_org_idx  ON public.commission_ledger (org_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS commission_ledger_paid_idx ON public.commission_ledger (paid_at);

COMMENT ON TABLE public.commission_ledger IS 'Append-only. Una fila por (invoice, SKU): comisión del pago con su split. Idempotencia del webhook por el UNIQUE. status=transferred cuando salió el transfer Connect.';

-- 4) REIN-1: reporte mensual consultable por Daniel (contratos con pago en el mes + monto reinsurance)
CREATE OR REPLACE VIEW public.v_reinsurance_monthly AS
SELECT
  date_trunc('month', l.paid_at)::date AS month,
  l.org_id,
  d.name                                AS dealer_name,
  s.master_no,
  l.plan_sku,
  l.paid_at,
  l.reinsurance_amount_cents
FROM public.commission_ledger l
LEFT JOIN public.dealers d ON d.id = l.org_id
LEFT JOIN LATERAL (
  SELECT master_no FROM public.subscriptions
  WHERE stripe_subscription_id = l.stripe_subscription_id AND master_no IS NOT NULL
  LIMIT 1
) s ON true
WHERE l.reinsurance_amount_cents > 0;

COMMENT ON VIEW public.v_reinsurance_monthly IS 'REIN-1: lo que Daniel consulta cada mes para informar a Zurich. "It''s just a reporting function" (Doug, llamada 15-jul). Formato fino a coordinar con Daniel.';

-- 5) RLS + GRANTs explícitos (regla de la cuenta). Todo el runtime va por Functions
--    con service_role; browser sin acceso directo. Append-only: SIN grant de DELETE.
ALTER TABLE public.commission_rates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.commission_rates      FROM anon, authenticated;
REVOKE ALL ON public.commission_ledger     FROM anon, authenticated;
REVOKE ALL ON public.v_reinsurance_monthly FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.commission_rates  TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.commission_ledger TO service_role;   -- UPDATE solo para transfer_id/status
GRANT SELECT                 ON public.v_reinsurance_monthly TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   SELECT * FROM public.commission_rates WHERE org_id IS NULL;   -- 200/0 y 800/0
--   \d public.commission_ledger
--   SELECT grantee, table_name, string_agg(privilege_type,', ') FROM information_schema.role_table_grants
--     WHERE table_name IN ('commission_rates','commission_ledger') AND grantee IN ('anon','authenticated','service_role')
--     GROUP BY 1,2;
-- ============================================================================
