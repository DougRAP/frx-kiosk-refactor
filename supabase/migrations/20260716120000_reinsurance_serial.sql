-- ============================================================================
-- Furniture-Rx · REIN-2 — serial por pago en la view de reinsurance
-- Fecha: 2026-07-16 · Fuente: reunión Doug 16-jul (DougPart1.srt 00:00-00:01):
--   "does the table include the master AND the serialized plan number? — yes"
--
-- El reporte mensual de Daniel necesita, además del master, el CONTRATO
-- SERIALIZADO del ciclo ({master}-NN). NN = número de pago de esa suscripción
-- para ese SKU (row_number por paid_at sobre el ledger), consistente con la
-- serialización opción B (los certificados formales siguen apagados).
--
-- CREATE OR REPLACE VIEW: la columna nueva va AL FINAL (regla de Postgres para
-- reemplazar sin drop). Sin cambios de datos; grants se conservan y se re-afirman.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_reinsurance_monthly AS
WITH numbered AS (
  SELECT l.*,
         row_number() OVER (
           PARTITION BY l.stripe_subscription_id, l.plan_sku
           ORDER BY l.paid_at, l.created_at
         ) AS payment_no
  FROM public.commission_ledger l
)
SELECT
  date_trunc('month', n.paid_at)::date AS month,
  n.org_id,
  d.name                                AS dealer_name,
  s.master_no,
  n.plan_sku,
  n.paid_at,
  n.reinsurance_amount_cents,
  CASE WHEN s.master_no IS NULL THEN NULL
       ELSE s.master_no || '-' || lpad(n.payment_no::text, 2, '0')
  END AS serial_no
FROM numbered n
LEFT JOIN public.dealers d ON d.id = n.org_id
LEFT JOIN LATERAL (
  SELECT master_no FROM public.subscriptions
  WHERE stripe_subscription_id = n.stripe_subscription_id AND master_no IS NOT NULL
  LIMIT 1
) s ON true
WHERE n.reinsurance_amount_cents > 0;

COMMENT ON VIEW public.v_reinsurance_monthly IS 'REIN-1/REIN-2: reporte mensual de underwriting para Daniel. Incluye master_no Y serial_no ({master}-NN, NN = nº de pago) como pidió Doug el 16-jul. Montos en centavos.';

REVOKE ALL ON public.v_reinsurance_monthly FROM anon, authenticated;
GRANT SELECT ON public.v_reinsurance_monthly TO service_role;

COMMIT;

-- VERIFICACIÓN: SELECT month, dealer_name, master_no, serial_no, reinsurance_amount_cents
--               FROM public.v_reinsurance_monthly ORDER BY paid_at;
