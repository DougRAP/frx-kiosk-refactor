-- ============================================================================
-- Furniture-Rx · Hardening de seguridad + captura de recibo (CHK-3)
-- Proyecto: jmfndyvwylmqjkngyzxi (FurnitureRX)
-- Fecha: 2026-05-26
--
-- POR QUÉ EXISTE ESTE SCRIPT
-- --------------------------
-- El esquema inicial (creado UI-first) dejó `GRANT ALL ... TO anon` en TODAS las
-- tablas y `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon`, y CERO RLS.
-- Como la anon key es PÚBLICA (viaja en el JS del navegador), hoy cualquiera puede
--   DELETE FROM profiles;   SELECT * FROM orders;   UPDATE subscriptions ...
-- sobre datos de TODOS los clientes. Eso NO es lo que Doug autorizó: él habló de
-- LECTURA laxa ("no pasa nada si lo ven"), no de escritura/borrado anónimo.
--
-- CÓMO LEERLO (se puede aplicar por fases — es idempotente y transaccional)
--   FASE 0  CHK-3: columnas del recibo en subscriptions.
--   FASE 1  CRÍTICA / no negociable: cerrar el acceso anónimo total.
--   FASE 2  Grants explícitos por rol y verbo (reglas del equipo).
--   FASE 3  RLS + policies por auth.uid().  <-- si Doug exige "modo demo sin RLS",
--           comenta SOLO la FASE 3; las fases 0-2 ya dejan la base segura.
--   FASE 4  Endurecer la función trigger (silencia el Security Advisor).
--
-- MODELO DE ACCESO (patrón correcto de checkout con Stripe)
--   · El navegador anónimo NO escribe subscriptions/orders/profiles (manipularía
--     precios y datos ajenos). Esas escrituras las hace una Edge/Netlify Function
--     con la service_role key, tras confirmar el pago en Stripe.
--   · anon            -> leer catálogo (care_kits activos, dealers) + INSERT leads.
--   · authenticated   -> leer SUS filas (RLS por auth.uid()); editar su profile.
--   · service_role    -> ALL (las Functions hacen el trabajo operacional).
--
-- CÓMO APLICAR
--   Opción A (UI-first, recomendado para Daniel): pegar TODO en el SQL Editor de
--            Supabase y ejecutar. Se corre como `postgres` (owner), así que los
--            ALTER DEFAULT PRIVILEGES FOR ROLE postgres funcionan.
--   Opción B (CLI): supabase db push   (este archivo ya está en supabase/migrations/)
--
-- Cómo revertir RLS si algo se traba en el demo:
--   ALTER TABLE public.<t> DISABLE ROW LEVEL SECURITY;
-- ============================================================================

BEGIN;

-- ============================================================================
-- FASE 0 · CHK-3 — Capturar nº de orden de venta + ZIP + fecha del recibo
-- ----------------------------------------------------------------------------
-- El carrito ya pide order# + ZIP + fecha (campos #cart-order/#cart-zip/#cart-date).
-- Con (order# + ZIP) se identifica al dealer (~90% match) sin preguntar. El dato es
-- de UN recibo por alta, así que vive en la suscripción. dealer_id guarda el match.
-- ============================================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS sales_order_number text,
  ADD COLUMN IF NOT EXISTS receipt_zip         text,
  ADD COLUMN IF NOT EXISTS purchased_on        date,
  ADD COLUMN IF NOT EXISTS dealer_id           uuid;

-- FK al dealer identificado (no rompe la suscripción si se borra el dealer).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_dealer_id_fkey'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_dealer_id_fkey
      FOREIGN KEY (dealer_id) REFERENCES public.dealers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Índice para resolver el dealer por (orden + zip) en la Function de matching.
CREATE INDEX IF NOT EXISTS subscriptions_order_zip_idx
  ON public.subscriptions (sales_order_number, receipt_zip);

COMMENT ON COLUMN public.subscriptions.sales_order_number IS 'Nº de orden de venta del recibo del dealer (CHK-3).';
COMMENT ON COLUMN public.subscriptions.receipt_zip         IS 'ZIP del recibo; con el order# identifica al dealer (~90%).';
COMMENT ON COLUMN public.subscriptions.purchased_on        IS 'Fecha de compra que figura en el recibo.';
COMMENT ON COLUMN public.subscriptions.dealer_id           IS 'Dealer resuelto a partir de order#+ZIP (lo llena una Function).';

-- ============================================================================
-- FASE 1 · CRÍTICA — cerrar el acceso anónimo/total (no negociable)
-- ----------------------------------------------------------------------------
-- 1a. Cortar los DEFAULT PRIVILEGES que harían nacer abierta cada tabla futura.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;

-- 1b. Quitar TODOS los privilegios actuales de anon y authenticated. Los volvemos
--     a otorgar, mínimos y por verbo, en la FASE 2.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- ============================================================================
-- FASE 2 · Grants explícitos por rol y verbo (table-level gate)
-- ----------------------------------------------------------------------------
-- service_role: operacional (Edge/Netlify Functions). RLS no le aplica.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- anon (navegador sin login): SOLO catálogo público + alta de leads.
GRANT SELECT ON public.care_kits TO anon;   -- mostrar kits + precio sin login
GRANT SELECT ON public.dealers   TO anon;   -- nombre/slug para páginas custom (quítalo si lo arma el server)
GRANT INSERT ON public.leads     TO anon;   -- "email your build" / chat = lead-gen anónimo

-- authenticated (cliente logueado): lee lo suyo; las mutaciones sensibles van por Function.
GRANT SELECT, INSERT, UPDATE ON public.profiles       TO authenticated;  -- su propio perfil
GRANT SELECT                 ON public.subscriptions  TO authenticated;  -- pause/downgrade -> Function
GRANT SELECT                 ON public.covered_pieces TO authenticated;
GRANT SELECT                 ON public.claims         TO authenticated;  -- "file a claim" -> five star (service_role)
GRANT SELECT                 ON public.orders         TO authenticated;
GRANT SELECT                 ON public.order_items    TO authenticated;
GRANT SELECT                 ON public.care_kits      TO authenticated;
GRANT SELECT                 ON public.dealers        TO authenticated;
GRANT SELECT, INSERT         ON public.leads          TO authenticated;
GRANT SELECT, INSERT         ON public.referrals      TO authenticated;

-- ============================================================================
-- FASE 3 · RLS + policies (row-level gate)  ← comenta esta fase para "modo demo sin RLS"
-- ----------------------------------------------------------------------------
-- Con GRANT (fase 2) + RLS, el cliente solo ve/edita SUS filas. service_role pasa
-- por encima de RLS por diseño, así que las Functions siguen pudiendo todo.
-- ============================================================================

-- profiles: cada quien su propia fila (id = auth.users.id = auth.uid())
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- subscriptions: el cliente ve las suyas (mutaciones por service_role)
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_select_own ON public.subscriptions;
CREATE POLICY subscriptions_select_own ON public.subscriptions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- covered_pieces: visibles si la suscripción es del usuario
ALTER TABLE public.covered_pieces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS covered_pieces_select_own ON public.covered_pieces;
CREATE POLICY covered_pieces_select_own ON public.covered_pieces
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.subscriptions s
            WHERE s.id = covered_pieces.subscription_id AND s.user_id = auth.uid())
  );

-- claims: visibles si la suscripción es del usuario (alta/gestión por service_role/SOAR)
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claims_select_own ON public.claims;
CREATE POLICY claims_select_own ON public.claims
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.subscriptions s
            WHERE s.id = claims.subscription_id AND s.user_id = auth.uid())
  );

-- orders: el cliente ve las suyas (las de invitado, user_id IS NULL, van por Function/email)
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_select_own ON public.orders;
CREATE POLICY orders_select_own ON public.orders
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- order_items: visibles si la orden es del usuario
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_items_select_own ON public.order_items;
CREATE POLICY order_items_select_own ON public.order_items
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.orders o
            WHERE o.id = order_items.order_id AND o.user_id = auth.uid())
  );

-- leads: cualquiera puede CREAR un lead; nadie anónimo los LEE.
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_insert_any  ON public.leads;
DROP POLICY IF EXISTS leads_select_own  ON public.leads;
CREATE POLICY leads_insert_any ON public.leads
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY leads_select_own ON public.leads
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- referrals: el referidor crea y ve los suyos
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS referrals_insert_own ON public.referrals;
DROP POLICY IF EXISTS referrals_select_own ON public.referrals;
CREATE POLICY referrals_insert_own ON public.referrals
  FOR INSERT TO authenticated WITH CHECK (referrer_id = auth.uid());
CREATE POLICY referrals_select_own ON public.referrals
  FOR SELECT TO authenticated USING (referrer_id = auth.uid());

-- care_kits: catálogo público — solo kits activos visibles (anon + authenticated)
ALTER TABLE public.care_kits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS care_kits_select_active ON public.care_kits;
CREATE POLICY care_kits_select_active ON public.care_kits
  FOR SELECT TO anon, authenticated USING (active = true);

-- dealers: catálogo público (nombre/slug)
ALTER TABLE public.dealers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dealers_select_all ON public.dealers;
CREATE POLICY dealers_select_all ON public.dealers
  FOR SELECT TO anon, authenticated USING (true);

-- ============================================================================
-- FASE 4 · Endurecer la función trigger (Security Advisor: search_path mutable)
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.enforce_piece_limit() SET search_path = public, pg_temp;
-- El trigger no se invoca por RPC: quitar EXECUTE a anon (no afecta su disparo).
REVOKE ALL ON FUNCTION public.enforce_piece_limit() FROM anon;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (correr APARTE, fuera de la transacción)
-- ----------------------------------------------------------------------------
-- 1) Grants por rol/tabla — anon NO debe tener nada salvo lo previsto:
--    SELECT grantee, table_name,
--           string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
--    FROM information_schema.role_table_grants
--    WHERE table_schema = 'public'
--      AND grantee IN ('anon','authenticated','service_role')
--    GROUP BY grantee, table_name ORDER BY table_name, grantee;
--
-- 2) RLS activo en todas las tablas:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname;
--
-- 3) El dashboard del Security Advisor de Supabase es la fuente de verdad final.
-- ============================================================================
