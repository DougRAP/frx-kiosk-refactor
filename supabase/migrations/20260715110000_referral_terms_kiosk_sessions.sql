-- ============================================================================
-- Furniture-Rx · PORT-9 + PORT-4b + PORT-10 — referral codes, plan_terms, kiosk sessions
-- Fecha: 2026-07-15 · Fuente: respuestas de Doug 15-jul (método A/B) + análisis §3/§10
--
-- Atribución A/B (Doug): A) venta desde kiosk con sesión (dealer del token),
-- B) referral code tecleado en el cart (kiosk/tech/D2C por igual). Hashed URL
-- descartado. Código de dealer apagado = inválido, la venta SIGUE (decisión 15-jul).
--
-- NO DESTRUCTIVO: solo CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ============================================================================

BEGIN;

-- 1) PORT-9: códigos por dealer. RAP los genera ("the dealer referral code that
--    we generate for the dealer"); el cliente los teclea en el cart.
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  org_id      uuid NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid,                       -- portal user (admin) que lo generó
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.referral_codes OWNER TO postgres;
CREATE INDEX IF NOT EXISTS referral_codes_org_idx ON public.referral_codes (org_id);
COMMENT ON TABLE public.referral_codes IS 'PORT-9: código de dealer para atribución método B. DISTINTO del refer-a-friend de clientes (tabla referrals). Código de dealer apagado = inválido (venta sigue).';

-- 2) Atribución en la subscription (dealer_id YA existe desde 20260526; esto añade el CÓMO)
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS attribution_source text,
  ADD COLUMN IF NOT EXISTS referral_code      text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_attribution_chk') THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_attribution_chk
      CHECK (attribution_source IS NULL OR attribution_source IN ('kiosk_session','referral_code'));
  END IF;
END $$;
COMMENT ON COLUMN public.subscriptions.attribution_source IS 'A/B de Doug 15-jul: kiosk_session (método A, dealer del token) | referral_code (método B). NULL = venta directa RAP (sin comisión).';

-- 3) PORT-4b: repositorio de T&Cs por SKU (y por dealer). org_id NULL = versión genérica.
--    Los docs específicos viven en el plan repository (Raps2026plans); doc_url apunta allí.
CREATE TABLE IF NOT EXISTS public.plan_terms (
  id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  org_id         uuid REFERENCES public.dealers(id) ON DELETE CASCADE,
  plan_sku       text NOT NULL,
  terms_version  text NOT NULL,
  doc_url        text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_terms_sku_chk CHECK (plan_sku IN ('stain','stain_mech'))
);
ALTER TABLE public.plan_terms OWNER TO postgres;
CREATE UNIQUE INDEX IF NOT EXISTS plan_terms_org_sku_uidx
  ON public.plan_terms (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), plan_sku);
COMMENT ON TABLE public.plan_terms IS 'PORT-4b: qué versión de T&C corresponde a (dealer, SKU) al primer pago. Fila org_id NULL = genérica ("Otherwise send the generic versions", Doug 15-jul).';

-- Seed de las genéricas (idempotente): la constante actual TERMS_VERSION pasa a ser estas filas.
INSERT INTO public.plan_terms (org_id, plan_sku, terms_version, doc_url)
SELECT NULL, 'stain', 'v2026-05', '/terms/'
WHERE NOT EXISTS (SELECT 1 FROM public.plan_terms WHERE org_id IS NULL AND plan_sku = 'stain');
INSERT INTO public.plan_terms (org_id, plan_sku, terms_version, doc_url)
SELECT NULL, 'stain_mech', 'v2026-05', '/terms/'
WHERE NOT EXISTS (SELECT 1 FROM public.plan_terms WHERE org_id IS NULL AND plan_sku = 'stain_mech');

-- 4) PORT-10 / PORT-9b: sesiones de kiosk. handoff = one-time (TTL corto, emitido por el
--    portal); session = la sesión viva del kiosk (TTL 12h). Solo se guarda el HASH del token.
CREATE TABLE IF NOT EXISTS public.kiosk_sessions (
  id              uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  kind            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  org_id          uuid NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  org_name        text,
  portal_user_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  redeemed_at     timestamptz,
  CONSTRAINT kiosk_sessions_kind_chk CHECK (kind IN ('handoff','session'))
);
ALTER TABLE public.kiosk_sessions OWNER TO postgres;
CREATE INDEX IF NOT EXISTS kiosk_sessions_exp_idx ON public.kiosk_sessions (expires_at);
COMMENT ON TABLE public.kiosk_sessions IS 'PORT-10: SSO portal→kiosk (handoff one-time → session 12h). El checkout deriva el dealer del token de sesión (método A), JAMÁS de un org_id del body.';

-- 5) PORT-4c (mitad repo): view para el sistema de Coms aparte (envío asíncrono del plan
--    con datos del cliente insertados). Todo lo que necesita, queryable con service_role.
CREATE OR REPLACE VIEW public.v_first_payment_terms AS
SELECT
  s.id                 AS subscription_id,
  s.master_no,
  s.tier::text         AS plan_sku,
  s.terms_version,
  COALESCE(pt.doc_url, gt.doc_url) AS doc_url,
  s.dealer_id          AS org_id,
  d.name               AS dealer_name,
  s.attribution_source,
  s.referral_code,
  s.started_at,
  p.email,
  p.full_name,
  p.phone
FROM public.subscriptions s
LEFT JOIN public.profiles p  ON p.id = s.user_id
LEFT JOIN public.dealers  d  ON d.id = s.dealer_id
LEFT JOIN public.plan_terms pt ON pt.org_id = s.dealer_id AND pt.plan_sku = s.tier::text AND pt.active
LEFT JOIN public.plan_terms gt ON gt.org_id IS NULL       AND gt.plan_sku = s.tier::text AND gt.active
WHERE s.kind = 'protection';

COMMENT ON VIEW public.v_first_payment_terms IS 'PORT-4c: insumo del sistema de Coms (proyecto aparte de Adrian, plantillas Thymeleaf). Qué T&C enviar a quién, con atribución.';

-- 6) RLS + GRANTs explícitos. Runtime por Functions (service_role); browser sin acceso.
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_terms     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kiosk_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.referral_codes        FROM anon, authenticated;
REVOKE ALL ON public.plan_terms            FROM anon, authenticated;
REVOKE ALL ON public.kiosk_sessions        FROM anon, authenticated;
REVOKE ALL ON public.v_first_payment_terms FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.referral_codes TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.plan_terms     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kiosk_sessions TO service_role;  -- DELETE: purga de sesiones vencidas (efímeras, patrón kiosk_handoffs)
GRANT SELECT ON public.v_first_payment_terms TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   SELECT plan_sku, terms_version, doc_url FROM public.plan_terms WHERE org_id IS NULL;  -- 2 genéricas
--   \d public.referral_codes; \d public.kiosk_sessions
--   SELECT attribution_source, referral_code FROM public.subscriptions LIMIT 1;
-- ============================================================================
