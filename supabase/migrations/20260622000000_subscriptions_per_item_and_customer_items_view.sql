-- ============================================================================
-- Furniture-Rx · subscriptions grano-por-item + vista unificada de compras
-- Proyecto: jmfndyvwylmqjkngyzxi (FurnitureRX)
-- Fecha: 2026-06-22
--
-- POR QUÉ
--   El webhook guardaba UNA fila por suscripción de Stripe (leía items[0]), así que
--   una compra multi-cobertura (stain + stain-mech) se COLAPSABA a una fila y la
--   membership bundled (gratis con plan) no se guardaba. Pasamos el grano a UNA fila
--   por COBERTURA (= item de Stripe) y guardamos la membership (incluso $0). Además
--   creamos una vista que une suscripciones + kits para ver "todo lo de un cliente".
--
-- CÓMO APLICAR
--   Pegar en el SQL Editor de Supabase (corre como postgres) o `supabase db push`.
--   Aplicar ANTES de desplegar el webhook nuevo (el código escribe la columna nueva
--   y depende de que el UNIQUE viejo ya no exista).
-- ============================================================================

BEGIN;

-- 1) Grano por item de Stripe + auditoría del price cobrado.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_subscription_item_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id             text;

-- 2) Swap de unicidad: ya NO 1 fila por subscription, sino 1 por item.
--    El nombre del constraint está confirmado en el schema actual.
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_stripe_subscription_id_key;

-- Índice (no único) para agrupar/buscar la subscription completa (cancel/lookup).
CREATE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_idx
  ON public.subscriptions (stripe_subscription_id);

-- Nueva clave de idempotencia: el item de Stripe (si_...). La membership (bundled $0 o
-- standalone $19.99) es un item real → también tiene su si_.... Parcial → permite filas legacy NULL.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_sub_item_uq
  ON public.subscriptions (stripe_subscription_item_id)
  WHERE stripe_subscription_item_id IS NOT NULL;

COMMENT ON COLUMN public.subscriptions.stripe_subscription_item_id
  IS 'Stripe subscription item (si_...). Idempotencia por cobertura/ítem (incluida la membership $0).';

COMMIT;

-- ============================================================================
-- 3) Vista unificada: TODO lo que un cliente compró o tiene suscrito.
--    SELECT * FROM public.v_customer_items WHERE email = lower('cliente@email.com');
--    security_invoker → respeta la RLS base (subscriptions_select_own / orders_select_own).
-- ============================================================================
CREATE OR REPLACE VIEW public.v_customer_items WITH (security_invoker = on) AS
  -- Recurrentes: protección (stain/stain_mech) + membership (bundled $0 o standalone).
  SELECT
    p.email                                   AS email,
    s.user_id                                 AS user_id,
    s.kind::text                              AS item_type,
    CASE s.kind
      WHEN 'membership' THEN 'Repair Membership'
      WHEN 'protection' THEN CASE s.tier
                               WHEN 'stain_mech' THEN 'Stain + Mechanical'
                               WHEN 'stain'      THEN 'Stain Protection'
                               ELSE 'Protection'
                             END
    END                                       AS label,
    COALESCE(s.tier::text, '')                AS tier_or_sku,
    s.monthly_cents                           AS amount_cents,
    (s.monthly_cents = 0)                     AS is_free,
    'monthly'::text                           AS cadence,
    s.status::text                            AS status,
    s.stripe_subscription_id                  AS stripe_ref,
    s.created_at                              AS created_at
  FROM public.subscriptions s
  JOIN public.profiles p ON p.id = s.user_id

  UNION ALL

  -- One-time: care kits (una fila por línea de orden).
  SELECT
    o.email                                   AS email,
    o.user_id                                 AS user_id,
    'care_kit'::text                          AS item_type,
    ck.name                                   AS label,
    ck.sku                                    AS tier_or_sku,
    oi.unit_price_cents * oi.quantity         AS amount_cents,
    false                                     AS is_free,
    'one_time'::text                          AS cadence,
    o.status::text                            AS status,
    o.stripe_payment_intent_id               AS stripe_ref,
    o.created_at                              AS created_at
  FROM public.order_items oi
  JOIN public.orders     o  ON o.id  = oi.order_id
  JOIN public.care_kits  ck ON ck.id = oi.kit_id;

COMMENT ON VIEW public.v_customer_items
  IS 'Lista unificada por cliente: subscriptions recurrentes + kits one-time. Consultar por email o user_id.';

-- Grants explícitos (regla del proyecto: toda vista nueva en public).
REVOKE ALL  ON public.v_customer_items FROM anon;
GRANT SELECT ON public.v_customer_items TO authenticated;
GRANT SELECT ON public.v_customer_items TO service_role;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   \d public.subscriptions                       -- columna + índice único parcial presentes
--   SELECT * FROM public.v_customer_items WHERE email = lower('cliente@email.com');
-- ============================================================================
