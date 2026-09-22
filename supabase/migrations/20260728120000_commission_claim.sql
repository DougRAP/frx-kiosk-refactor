-- ============================================================================
-- Furniture-Rx · SEC-2b: reclamo atómico del transfer de comisión
-- Proyecto: jmfndyvwylmqjkngyzxi (FurnitureRX)
-- Fecha: 2026-07-28
--
-- POR QUÉ
--   Hallazgo 6 de la auditoría del 28-jul (CWE-362). El de-dup de los transfers de
--   Connect era por BÚSQUEDA (GET /v1/transfers?transfer_group=…) seguida de POST, sin
--   candado. Dos entregas concurrentes de invoice.paid (Stripe reintenta cuando una
--   ejecución tarda) leían la misma lista vacía y ambas creaban su transfer: la misma
--   comisión pagada dos veces. El guard `status=eq.recorded` del PATCH posterior evita
--   marcar la fila dos veces, pero eso ocurre DESPUÉS del POST: protege el registro,
--   no el dinero.
--
--   La corrección es un RECLAMO atómico: antes de tocar Stripe, la ejecución hace un
--   UPDATE condicional `... WHERE id = X AND status = 'recorded'`, que en Postgres se
--   evalúa bajo lock de fila. Solo una ejecución obtiene la fila; la otra no ve nada y
--   se salta. Esta migración es lo único que falta para que ese estado intermedio exista.
--
--   NO se toca la Idempotency-Key de Stripe: es por-intento a propósito desde la corrida
--   del 15-jul (una clave fija hacía que Stripe repitiera 24h un balance_insufficient y
--   dejaba la fila irrecuperable). Ver _lib/commissions.mjs:109-114.
--
-- IMPACTO EN LO EXISTENTE: ninguno.
--   - Las filas actuales son 'recorded' o 'transferred'; el CHECK nuevo las acepta.
--   - Ninguna vista (v_reinsurance_monthly, la serial de REIN-1) filtra por status.
--   - Ningún endpoint del portal filtra por status; portal-commissions solo suma importes.
--   - El front no muestra el status en ninguna pantalla.
--   El ledger sigue siendo APPEND-ONLY: no se concede DELETE, y esta migración no borra
--   ni una fila (el DROP CONSTRAINT es solo para poder recrear el CHECK ampliado).
--
-- ORDEN DE DESPLIEGUE
--   Aplicar ANTES de encender STRIPE_CONNECT_TRANSFERS. Si el código corriera sin esta
--   migración, el reclamo fallaría con 400 (violación del CHECK), la ejecución no se
--   consideraría dueña de la fila y NO se transferiría nada: el fallo va hacia el lado
--   seguro (de menos, nunca dos veces) y las filas quedan 'recorded' esperando.
--
-- CÓMO APLICAR
--   Pegar en el SQL Editor de Supabase (corre como postgres) o `supabase db push`.
--   Idempotente (IF NOT EXISTS / IF EXISTS).
-- ============================================================================

BEGIN;

-- 1) Estado intermedio: 'transferring' = una ejecución reclamó la fila y está creando
--    el transfer en Stripe. Es transitorio; termina en 'transferred' (éxito) o vuelve a
--    'recorded' (fallo → reintento posterior).
ALTER TABLE public.commission_ledger
  DROP CONSTRAINT IF EXISTS commission_ledger_status_chk;
ALTER TABLE public.commission_ledger
  ADD  CONSTRAINT commission_ledger_status_chk
  CHECK (status IN ('recorded','transferring','transferred'));

-- 2) Sello del reclamo: permite recuperar un reclamo HUÉRFANO (el proceso murió entre el
--    reclamo y el transfer). Pasados 15 minutos (CLAIM_TTL_MS en _lib/commissions.mjs) la
--    fila vuelve a ser elegible. El doble pago durante esa recuperación lo sigue evitando
--    la búsqueda por transfer_group: si el transfer llegó a crearse, se ADOPTA.
ALTER TABLE public.commission_ledger
  ADD COLUMN IF NOT EXISTS transfer_claimed_at timestamptz;

-- 3) Índice parcial para localizar reclamos huérfanos sin escanear el ledger entero
--    (lo usará también el barrido de PORT-8c cuando se implemente).
CREATE INDEX IF NOT EXISTS commission_ledger_claim_idx
  ON public.commission_ledger (transfer_claimed_at)
  WHERE status = 'transferring';

COMMENT ON COLUMN public.commission_ledger.transfer_claimed_at
  IS 'SEC-2b: instante en que una ejecución reclamó la fila para transferirla. Con status=transferring y este sello viejo (>15 min) la fila es un reclamo huérfano y se puede recuperar.';

COMMENT ON TABLE public.commission_ledger
  IS 'Append-only. Una fila por (invoice, SKU): comisión del pago con su split. Idempotencia del webhook por el UNIQUE. status: recorded → transferring (reclamada, SEC-2b) → transferred.';

-- 4) Data API: se REAFIRMAN los grants explícitos (la tabla no es Data API para anon ni
--    authenticated; solo el service_role la toca desde las Functions). Sin DELETE: append-only.
REVOKE ALL ON public.commission_ledger FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.commission_ledger TO service_role;   -- UPDATE solo para transfer_id/status/claim

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--
--   -- el CHECK admite los tres estados
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'public.commission_ledger'::regclass
--      AND conname  = 'commission_ledger_status_chk';
--
--   -- la columna del sello existe
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'commission_ledger'
--      AND column_name = 'transfer_claimed_at';
--
--   -- nada quedó atascado en el estado intermedio
--   SELECT id, stripe_invoice_id, plan_sku, status, transfer_claimed_at
--     FROM public.commission_ledger
--    WHERE status = 'transferring'
--    ORDER BY transfer_claimed_at;
--
--   -- grants
--   SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
--     FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'commission_ledger'
--      AND grantee IN ('anon','authenticated','service_role')
--    GROUP BY grantee;
-- ============================================================================
