-- SUB-2: el sync del ciclo de vida desde Stripe (customer.subscription.*) necesita
-- 'past_due' (impago) en el enum. Valores actuales: active/paused/canceled/pending.
-- PG >= 12 permite ADD VALUE dentro de una transacción si el valor no se usa en la misma.
ALTER TYPE public.subscription_status ADD VALUE IF NOT EXISTS 'past_due';
