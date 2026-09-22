-- ============================================================================
-- Furniture-Rx · DEAL-5 — Link durable de onboarding de Stripe Connect
-- Fecha: 2026-08-17
--
-- POR QUÉ
--   Los Account Links de Connect caducan en minutos y son de un solo uso: es
--   diseño de Stripe, porque ese link da acceso al alta bancaria del dealer, y
--   no hay parámetro para alargarlo. Mandarlo por email no funciona: cuando el
--   dealer abre el correo, el link lleva horas muerto.
--   La solución es un código NUESTRO, permanente, que al abrirse acuña el link
--   de Stripe en ese instante. Mismo patrón que /s/{code} del sales-mode.
--
-- TABLA APARTE de sales_mode_links A PROPÓSITO. Hay cinco consultas en el repo
--   que filtran esa tabla solo por org_id y active, sin distinguir tipo. Si los
--   dos tipos de código compartieran tabla: un código de onboarding pegado en
--   /s/ abriría una sesión de venta del kiosco, el portal podría mostrar el de
--   onboarding como link de ventas, y "regenerar link de ventas" apagaría de
--   paso el de onboarding del dealer. Cinco parches obligatorios contra cero.
--
-- NO DESTRUCTIVO: solo CREATE TABLE / ADD COLUMN IF NOT EXISTS.
-- Tabla server-only: la escriben las Functions con service_role, el browser no
--   la toca nunca (el resolver es público pero corre en el servidor).
--
-- CÓMO APLICAR: `supabase db push` o pegar en el SQL Editor.
-- ============================================================================

BEGIN;

-- 1) Los links.
CREATE TABLE IF NOT EXISTS public.connect_onboard_links (
  id           uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  org_id       uuid NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  org_name     text,
  active       boolean NOT NULL DEFAULT true,
  -- Materializada AL CREAR, nunca calculada al leer. Si la ventana se calculara
  -- en cada visita, subir la env var un día resucitaría de golpe todos los links
  -- caducados que hayan existido nunca, sin deploy y sin que nadie lo note.
  -- NULL = este link no caduca.
  expires_at   timestamptz,
  -- Sellada cuando Stripe confirma que la cuenta quedó operativa.
  completed_at timestamptz,
  opened_at    timestamptz,          -- primera vez que alguien lo abrió
  open_count   integer NOT NULL DEFAULT 0,
  created_by   uuid,                 -- portal user que lo generó (NULL = seed)
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.connect_onboard_links OWNER TO postgres;

CREATE INDEX IF NOT EXISTS connect_onboard_links_org_idx
  ON public.connect_onboard_links (org_id);

-- Un solo link vivo por dealer. Lo garantiza la BD y no la aplicación: regenerar
-- obliga a desactivar el anterior, así la superficie no crece sola con cada
-- regeneración dejando links viejos usables en correos antiguos.
CREATE UNIQUE INDEX IF NOT EXISTS connect_onboard_links_org_active_uidx
  ON public.connect_onboard_links (org_id) WHERE active;

COMMENT ON TABLE public.connect_onboard_links IS
  'DEAL-5: link permanente por dealer que acuña un Stripe Account Link EN EL CLICK (los de Stripe caducan en minutos y son one-time). Tabla separada de sales_mode_links: allí un code equivale a una sesión de venta del kiosco, aquí al alta bancaria del dealer.';
COMMENT ON COLUMN public.connect_onboard_links.expires_at IS
  'Materializada al crear el link desde STRIPE_ONBOARD_TTL_DAYS. NULL = no caduca. Cambiar la env var afecta solo a los links nuevos, que es la semántica que uno espera.';

-- 2) RLS + GRANTs explícitos (regla de la casa). Runtime por Functions con
--    service_role; anon y authenticated sin acceso. RLS activa sin políticas =
--    deny-all aunque un GRANT se colara después. Sin DELETE: append-only + flag.
ALTER TABLE public.connect_onboard_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connect_onboard_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.connect_onboard_links TO service_role;

-- 3) De qué MODO de Stripe es la cuenta guardada del dealer.
--    Test y live son universos separados en Stripe, pero Supabase tiene una sola
--    base: una prueba en local con sk_test escribe un acct_ de test en la misma
--    columna que usa producción. El acct_id no lleva ninguna marca de modo, así
--    que no se puede deducir por inspección; hay que recordarlo.
--    NULL = desconocido (fila anterior a esta migración). No se asume nada: se
--    intenta usar la cuenta y, si Stripe responde resource_missing, el resolver
--    la trata como inexistente y crea la del modo actual.
ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS stripe_account_livemode boolean;

COMMENT ON COLUMN public.dealers.stripe_account_livemode IS
  'true = la cuenta de stripe_account_id es de LIVE; false = de test; NULL = desconocido. Sin esto, un acct_ de test sobrevive al go-live y transferCommissions falla en silencio dejando las comisiones en recorded para siempre.';

COMMIT;

-- ============================================================================
-- VERIFICAR después de aplicar
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'dealers' AND column_name = 'stripe_account_livemode';
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'connect_onboard_links';
--
--   SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
--     FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'connect_onboard_links'
--      AND grantee IN ('anon','authenticated','service_role')
--    GROUP BY grantee;
--   -- esperado: solo service_role, con SELECT, INSERT, UPDATE
--
--   -- los links vivos, uno por dealer
--   SELECT d.alpha_code, d.name, l.code, l.expires_at, l.completed_at
--     FROM public.connect_onboard_links l
--     JOIN public.dealers d ON d.id = l.org_id
--    WHERE l.active ORDER BY d.alpha_code NULLS LAST;
-- ============================================================================
