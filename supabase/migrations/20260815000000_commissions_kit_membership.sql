-- ============================================================================
-- Furniture-Rx · COMM-3 — comisiones de kit y membership (reunión 14-ago)
-- Fecha: 2026-08-15 · Fuente: AR 54:53-57:16 / TM 58:48-01:01:08 + decisiones
-- cerradas con Adrian (mini-backlog 14-ago: kit sin reinsurance = inferencia
-- documentada reversible por UPDATE; membership hereda el split, N4).
--
-- 1) CHECKs de plan_sku pasan de 2 a 4 SKUs ('stain','stain_mech','kit',
--    'membership'). Ampliar un CHECK no destruye datos (toda fila existente
--    satisface el set ampliado). Patrón DROP IF EXISTS + ADD del precedente
--    20260728120000_commission_claim.sql. El status_chk de 3 estados
--    ('recorded','transferring','transferred') NO se toca (SEC-2b).
-- 2) commission_ledger.stripe_subscription_id pierde el NOT NULL: la comisión
--    one-time del kit no tiene subscription (referencia = session.id cs_…
--    en stripe_invoice_id, que el UNIQUE (invoice, sku) sigue cubriendo).
-- 3) Seeds globales idempotentes: kit $10 todo cash (1000/0) y membership de
--    pago $6 (600/0, techo negociable $8 por override del dealer: "say six
--    and go up to eight"). El bonus beta de Bailey's se asentará como
--    override por org cuando Doug fije la cifra ($0.50 o $1).
--
-- NO DESTRUCTIVO: no elimina tablas, columnas ni datos; sin cambios de grants.
-- ============================================================================

BEGIN;

-- 1) CHECKs a 4 SKUs
ALTER TABLE public.commission_rates
  DROP CONSTRAINT IF EXISTS commission_rates_sku_chk;
ALTER TABLE public.commission_rates
  ADD CONSTRAINT commission_rates_sku_chk
  CHECK (plan_sku IN ('stain', 'stain_mech', 'kit', 'membership'));

ALTER TABLE public.commission_ledger
  DROP CONSTRAINT IF EXISTS commission_ledger_sku_chk;
ALTER TABLE public.commission_ledger
  ADD CONSTRAINT commission_ledger_sku_chk
  CHECK (plan_sku IN ('stain', 'stain_mech', 'kit', 'membership'));

-- 2) one-time del kit: sin subscription
ALTER TABLE public.commission_ledger
  ALTER COLUMN stripe_subscription_id DROP NOT NULL;

-- 3) Seeds globales (org_id NULL), idempotentes (patrón 20260715100000)
INSERT INTO public.commission_rates (org_id, plan_sku, stripe_amount_cents, reinsurance_amount_cents)
SELECT NULL, 'kit', 1000, 0
WHERE NOT EXISTS (SELECT 1 FROM public.commission_rates WHERE org_id IS NULL AND plan_sku = 'kit');
INSERT INTO public.commission_rates (org_id, plan_sku, stripe_amount_cents, reinsurance_amount_cents)
SELECT NULL, 'membership', 600, 0
WHERE NOT EXISTS (SELECT 1 FROM public.commission_rates WHERE org_id IS NULL AND plan_sku = 'membership');

COMMENT ON TABLE public.commission_rates IS 'Tasa de comisión por SKU. org_id NULL = global ($2 stain / $8 stain_mech / $10 kit / $6 membership de pago). Override por dealer con split stripe/reinsurance (COMM-3 14-ago; ej. bonus beta Bailey''s). Dev-controlled, sin UI (la pantalla es COMM-2).';

COMMIT;
