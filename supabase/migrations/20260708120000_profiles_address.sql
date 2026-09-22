-- Item 6 (Edit details): la dirección postal EDITABLE vive en profiles (antes solo en
-- lead.payload, de donde el dashboard la leía). _lib/account.mjs mantiene fallback al
-- último lead para cuentas viejas sin este campo.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS address text;
