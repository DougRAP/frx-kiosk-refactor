-- ============================================================================
-- Furniture-Rx · kiosk single-QR handoff — store efímero del traspaso kiosk→teléfono
-- Fecha: 2026-07-01
--
-- POR QUÉ
--   El kiosk in-store reemplaza el dropzone de recibo por UN QR: el cliente escanea
--   y desde su teléfono (1) sube la foto del recibo y (2) paga; el kiosk se actualiza
--   solo y muestra el preview. Para eso el config del carrito viaja kiosk→teléfono
--   server-side (sin PII en la URL) y el kiosk polea el progreso por un token opaco.
--   Esta tabla es ese store: EFÍMERO (TTL 15min, purga oportunista), NO es tabla de
--   negocio — el lead/subscription reales se crean recién en el checkout. El token
--   HMAC (_lib/token.mjs) referencia la fila por `id`; no se guarda columna de token.
--
-- CÓMO APLICAR
--   Pegar en el SQL Editor de Supabase (corre como postgres) o `supabase db push`.
--   Idempotente (IF NOT EXISTS). Aditiva: no toca ninguna tabla existente.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.kiosk_handoffs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  config              jsonb       NOT NULL,                                  -- fields validados del carrito (receipt null al crear)
  summary             jsonb,                                                 -- {first_name, total_cents, lines[], mode} para teléfono/kiosk (sin PII sensible)
  receipt_path        text,                                                  -- seteado en attach (subida del teléfono)
  stripe_session_id   text,                                                  -- seteado en complete
  stripe_session_url  text,                                                  -- seteado en complete (idempotencia: 2º tap devuelve esta URL)
  status              text        NOT NULL DEFAULT 'pending',                -- pending → receipt_uploaded → session_created
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  CONSTRAINT kiosk_handoffs_status_chk CHECK (status IN ('pending', 'receipt_uploaded', 'session_created'))
);

-- RLS on + solo service_role (las Netlify Functions). anon/authenticated NUNCA la tocan
-- (no es Data API; el navegador no tiene key de Supabase). Patrón de rate_limits.
ALTER TABLE public.kiosk_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kiosk_handoffs FROM anon, authenticated;
GRANT  ALL ON public.kiosk_handoffs TO service_role;

-- Índice para la purga oportunista de expirados (barata; la corre el endpoint create).
CREATE INDEX IF NOT EXISTS kiosk_handoffs_expires_idx ON public.kiosk_handoffs (expires_at);

COMMENT ON TABLE public.kiosk_handoffs
  IS 'Store efímero del traspaso kiosk→teléfono (single-QR: recibo + pago). Token opaco HMAC referencia la fila por id. TTL 15min + purga oportunista. No es Data API ni tabla de negocio.';

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   SELECT to_regclass('public.kiosk_handoffs');                               -- no-null = creada
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'kiosk_handoffs';                                      -- solo service_role
--   -- anon/authenticated NO deben poder SELECT (RLS + REVOKE).
-- ============================================================================
