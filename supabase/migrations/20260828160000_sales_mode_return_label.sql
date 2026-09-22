-- KIOSK-23b: configurable label for the return button (Adrian 28-aug). The
-- button also shows for customers arriving via the in-store tablet QR/bookmark
-- (same sales link), so "Back to <legal name>" read wrong: the text becomes
-- "Go to <return_label>" with org_name as fallback. Like return_url, it
-- travels through the handoff into the session.
-- NON-DESTRUCTIVE: only ADD COLUMN IF NOT EXISTS + idempotent UPDATE.

ALTER TABLE public.sales_mode_links ADD COLUMN IF NOT EXISTS return_label text;
ALTER TABLE public.kiosk_sessions   ADD COLUMN IF NOT EXISTS return_label text;

COMMENT ON COLUMN public.sales_mode_links.return_label IS
  'Destination-site name for the kiosk return button ("Go to <label>"); fallback: org_name (KIOSK-23b)';

-- Bailey''s seed (idempotent).
UPDATE public.sales_mode_links
   SET return_label = 'Bailey''s Platinum Protection'
 WHERE code = 'QPPZKM2G'
   AND (return_label IS NULL OR return_label = '');
