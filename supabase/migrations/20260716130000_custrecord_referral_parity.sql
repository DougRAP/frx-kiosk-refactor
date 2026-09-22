-- ============================================================================
-- Furniture-Rx · PORT-19 B/C — paridad fina con el mock (gap-scan 16-jul)
--   1) subscriptions.internal_notes: adminfield del Customer Record del mock
--      (línea 452: "Internal notes · admin only"). Ya estaba en ADMIN_ONLY_FIELDS
--      del motor de scoping; ahora existe la columna. Solo admin la ve (el
--      mapper la omite para org/sub).
--   2) referral_codes.label: la columna "Campaign" del mock (línea 472,
--      "Spring email" / "VIP customers"). Opcional al generar el código.
-- NO DESTRUCTIVO: solo ADD COLUMN IF NOT EXISTS.
-- ============================================================================

BEGIN;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS internal_notes text;
COMMENT ON COLUMN public.subscriptions.internal_notes IS 'PORT-19B: notas internas de RAP sobre la suscripción. ADMIN-ONLY en el portal (omitAdminFields la quita del payload para org/sub).';

ALTER TABLE public.referral_codes
  ADD COLUMN IF NOT EXISTS label text;
COMMENT ON COLUMN public.referral_codes.label IS 'PORT-19C: etiqueta de campaña del mock ("Spring email"). Opcional, la pone el admin al generar.';

COMMIT;
