-- KIOSK-23: return button from the kiosk to the dealer's site (Doug 28-aug-2026:
-- "can we add a home button ... that navs back to the Bailey's site only where
-- the subscription site is opened using the Bailey's subscription link").
-- return_url lives on the SALES LINK (per-dealer data, admin-set); it travels
-- through the handoff into the kiosk session. No value -> the kiosk renders
-- nothing and stays identical to today. The URL always comes from the DB,
-- never from a client query param (open redirect).
-- NON-DESTRUCTIVE: only ADD COLUMN IF NOT EXISTS + idempotent UPDATE.

ALTER TABLE public.sales_mode_links ADD COLUMN IF NOT EXISTS return_url text;
ALTER TABLE public.kiosk_sessions   ADD COLUMN IF NOT EXISTS return_url text;

COMMENT ON COLUMN public.sales_mode_links.return_url IS
  'https URL of the dealer''s site; the kiosk shows the return button only when set (KIOSK-23)';

-- Bailey''s seed (idempotent; 0 rows if the code does not exist in this environment).
UPDATE public.sales_mode_links
   SET return_url = 'https://www.baileysplatinumprotection.com'
 WHERE code = 'QPPZKM2G'
   AND (return_url IS NULL OR return_url = '');
