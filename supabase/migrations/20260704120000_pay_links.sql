-- ============================================================================
-- KIOSK-16 — pay_links: URL corta tecleable /p/CODIGO → 302 a Stripe Checkout.
-- El kiosk muestra el código bajo el QR como fallback manual (la URL de Stripe
-- es intecleable). Solo el backend (service_role) toca esta tabla; el redirect
-- corre en pay-redirect.mjs. expires_at se alinea con la expiración de la
-- Checkout Session (24 h). opened_at = primera apertura (señal para la espera).
-- ============================================================================

-- 1. Tabla
CREATE TABLE public.pay_links (
  code        TEXT PRIMARY KEY
              CHECK (code ~ '^[23456789ACDEFGHJKMNPQRSTUVWXYZ]{8}$'),
  stripe_url  TEXT NOT NULL,
  session_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  opened_at   TIMESTAMPTZ
);

COMMENT ON TABLE public.pay_links IS
  'KIOSK-16: short typeable codes for /p/<code> → 302 to Stripe Checkout (QR manual fallback).';

-- Purga oportunista de vencidos (mismo patrón que kiosk_handoffs)
CREATE INDEX pay_links_expires_idx ON public.pay_links (expires_at);

-- 2. RLS ON, sin policies: NADIE entra por la Data API salvo service_role
ALTER TABLE public.pay_links ENABLE ROW LEVEL SECURITY;

-- 3. (sin policies a propósito: no hay acceso de browser a esta tabla)

-- 4. GRANTs explícitos de la Data API (obligatorios: enforcement Supabase 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pay_links TO service_role;
REVOKE ALL ON public.pay_links FROM anon, authenticated;
