-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Paso 2 — Atribución del SALES ASSOCIATE a nivel de suscripción (kiosk)
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Contexto: el kiosk in-store captura el nº de sales associate (associate#). Hoy ese dato viaja en
-- lead.payload.sales_associate pero NO llega a `subscriptions` → para conciliar comisiones había que
-- abrir el JSON del lead. Esta migración agrega la columna; el webhook (stripe-webhook.mjs) la copia
-- desde lead.payload al crear la fila de protección — mismo patrón que ya usa para sales_order_number
-- y los campos de recibo (BE-1).
--
-- Aditiva y NO destructiva: columna nullable, IF NOT EXISTS → idempotente y compatible con el código
-- viejo (que simplemente no la escribía). Las filas previas quedan NULL (backfill opcional, abajo).
-- NO requiere GRANTs nuevos: los grants a nivel-tabla sobre `public.subscriptions` (authenticated /
-- service_role) ya cubren cualquier columna nueva; la RLS existente aplica sin cambios.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS sales_associate text;

COMMENT ON COLUMN public.subscriptions.sales_associate
  IS 'ID del sales associate que hizo la venta en el kiosk (copiado de lead.payload.sales_associate por el webhook). Para conciliar comisiones. dealer_id (columna aparte) lo resolverá el matching por order#+zip (BE-1b).';

-- Índice parcial para reportes "ventas / comisiones por associate" (solo filas atribuidas).
CREATE INDEX IF NOT EXISTS subscriptions_sales_associate_idx
  ON public.subscriptions (sales_associate)
  WHERE sales_associate IS NOT NULL;

-- ── Backfill OPCIONAL de filas previas (best-effort por user_id; las subscriptions no guardan lead_id).
--    Seguro para datos de prueba; en prod, si un usuario tuviera varios leads con associates distintos,
--    revisá antes. Descomentá para correr:
-- UPDATE public.subscriptions s
--   SET sales_associate = l.payload->>'sales_associate'
--   FROM public.leads l
--   WHERE s.user_id = l.user_id
--     AND s.sales_associate IS NULL
--     AND (l.payload->>'sales_associate') IS NOT NULL;
