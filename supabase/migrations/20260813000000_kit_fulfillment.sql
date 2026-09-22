-- ============================================================================
-- Furniture-Rx · KIT-2 — Kit fulfillment (despacho manual de care kits)
-- Fecha: 2026-08-13 · Spec: misc/spec-kit-orders.md
-- Fuente: revisiones/KitOrdersMeeting.vtt + DougKitsAgo082026.srt + KitOrdersAgo132026.srt
--
-- Doug fue explícito: NO hay base nueva. "Don't you capture kit sales anyway? … All you got to
-- do is add a field that shows the shipping information. That's it." / "all you got to do is add
-- a shipping confirmation to the database and you're good to go."
--
-- NO DESTRUCTIVA: solo ADD COLUMN IF NOT EXISTS. Sin REVOKE: cambiar la postura de grants de
-- tablas preexistentes es otra decisión (y otro test); aquí solo añadimos.
-- ============================================================================

BEGIN;

-- 1) order_items — el despacho es POR LÍNEA, no por orden.
--    "you would show one row by type of kit… in manual mode it's three different packages":
--    cada tipo de kit viaja en su propio paquete, con su propio número de referencia. Un estado
--    a nivel orden mentiría en cuanto una compra tenga 2 kits (uno enviado y otro no).
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS fulfillment_status    text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS shipping_confirmation text,
  ADD COLUMN IF NOT EXISTS shipped_at            timestamptz,
  ADD COLUMN IF NOT EXISTS sh_cents              integer;

-- CHECK (no enum): el repo ya usa text+CHECK en gift_codes.status y resources.resource_type;
-- y ampliar estados mañana es una migración de 2 líneas, no un ALTER TYPE. ADD CONSTRAINT no
-- soporta IF NOT EXISTS → guard idempotente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_order_items_fulfillment_status'
      AND conrelid = 'public.order_items'::regclass
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT ck_order_items_fulfillment_status
      CHECK (fulfillment_status IN ('pending', 'shipped'));
  END IF;
END $$;

-- 2) orders — SNAPSHOT de la dirección de envío al crear la orden (KIT-3).
--    Hoy la dirección vive dentro del payload del lead. Snapshot a propósito: si el cliente edita
--    su perfil en 2027, la etiqueta que se imprimió en 2026 no debe cambiar.
--    Una sola columna de dirección porque el checkout la captura como texto libre (256), no
--    estructurada: partirla en city/state sería parseo lossy de texto humano.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS ship_to_name    text,
  ADD COLUMN IF NOT EXISTS ship_to_phone   text,
  ADD COLUMN IF NOT EXISTS ship_to_address text,
  ADD COLUMN IF NOT EXISTS ship_to_zip     text;

-- 3) Índices. Las FK no crean índice en Postgres; el parcial mantiene indexado SOLO el backlog
--    pendiente (que se drena), así que se queda diminuto aunque order_items crezca.
CREATE INDEX IF NOT EXISTS ix_order_items_order_id ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS ix_order_items_pending  ON public.order_items (order_id) WHERE fulfillment_status = 'pending';
CREATE INDEX IF NOT EXISTS ix_orders_created_at    ON public.orders (created_at DESC);

-- 4) Grants explícitos (regla de la casa: Supabase retira el grant implícito).
--    El backend escribe con service_role; el browser NUNCA toca estas tablas (no tiene key).
GRANT SELECT, INSERT, UPDATE ON public.orders      TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.order_items TO service_role;

COMMENT ON COLUMN public.order_items.fulfillment_status IS
  'KIT-5: despacho manual del kit, pending → shipped. Por línea (cada kit es un paquete).';
COMMENT ON COLUMN public.order_items.shipping_confirmation IS
  'KIT-4: reference number tecleado a mano por la oficina ("the shipping number they get from UPS or whatever").';
COMMENT ON COLUMN public.order_items.sh_cents IS
  'Shipping & handling de la línea. NULL hasta que exista el dato (el $13.50 de Doug es una instrucción contable, ver KIT-8).';
COMMENT ON COLUMN public.orders.ship_to_address IS
  'KIT-3: snapshot de la dirección de envío copiada del lead al crear la orden (texto libre).';

COMMIT;

-- ============================================================================
-- Verificación:
--   SELECT column_name, data_type, column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name IN ('orders','order_items')
--      AND (column_name LIKE 'ship%' OR column_name IN ('fulfillment_status','sh_cents'));
--   -- si PostgREST devuelve 400 "column does not exist": NOTIFY pgrst, 'reload schema';
-- ============================================================================
