-- ============================================================================
-- GIFT-1 — gift_codes: registro/atribución de los gift coupon codes.
-- Una compra de regalo (Checkout mode:payment con metadata.intent='gift') = una
-- fila; el webhook emite el promotion code de Stripe (100% × months) y guarda
-- aquí su id. stripe_payment_intent UNIQUE = idempotencia de los reintentos del
-- webhook (INSERT primero; 409 = reentrada). code UNIQUE espeja el promotion
-- code emitido. status: created → redeemed (marcado fail-soft al canjear) /
-- expired (housekeeping futuro; la EXPIRACIÓN real la enforza Stripe a 90 días).
--
-- Tabla SERVER-ONLY: la tocan create-gift-checkout y stripe-webhook con
-- service_role; el browser JAMÁS la ve. Por eso RLS ON sin policies + REVOKE a
-- anon/authenticated (regla de la casa: grants explícitos de la Data API,
-- enforcement Supabase 2026 — sin GRANT la tabla es invisible a /rest/v1/).
-- ============================================================================

-- 1. Tabla
CREATE TABLE public.gift_codes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   TEXT UNIQUE,
  buyer_email            TEXT,
  tier                   TEXT,
  months                 INT,
  price_cents            INT,
  stripe_promo_id        TEXT,
  stripe_payment_intent  TEXT UNIQUE,
  status                 TEXT DEFAULT 'created' CHECK (status IN ('created', 'redeemed', 'expired')),
  redeemed_by_email      TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  redeemed_at            TIMESTAMPTZ
);

COMMENT ON TABLE public.gift_codes IS
  'GIFT-1: gift coupon codes (one row per gift purchase; promo code lives in Stripe).';

-- 2. RLS ON, sin policies: NADIE entra por la Data API salvo service_role
ALTER TABLE public.gift_codes ENABLE ROW LEVEL SECURITY;

-- 3. GRANTs explícitos de la Data API (obligatorios: enforcement Supabase 2026)
GRANT SELECT, INSERT, UPDATE ON public.gift_codes TO service_role;
REVOKE ALL ON public.gift_codes FROM anon, authenticated;
