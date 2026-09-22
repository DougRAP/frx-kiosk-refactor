-- ============================================================================
-- Furniture-Rx · Subscription Portal — PORT-6 (audit) + PORT-7 (service requests)
-- Fecha: 2026-07-13
-- ============================================================================

BEGIN;

-- PORT-6: audit trail APPEND-ONLY. Cada export/acceso/cambio sensible deja una fila.
CREATE TABLE IF NOT EXISTS public.audit_events (
  id         uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid,
  actor_name text,
  actor_role text,
  category   text NOT NULL,
  action     text NOT NULL,
  target     text,
  details    text,
  org_id     uuid,
  CONSTRAINT audit_events_category_chk CHECK (category IN ('Change','Export','Access'))
);
ALTER TABLE public.audit_events OWNER TO postgres;
CREATE INDEX IF NOT EXISTS audit_events_at_idx  ON public.audit_events (at DESC);
CREATE INDEX IF NOT EXISTS audit_events_cat_idx ON public.audit_events (category);
COMMENT ON TABLE public.audit_events IS 'Append-only. Exports/accesos/cambios sensibles. Nunca UPDATE/DELETE (grants sin update/delete).';

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_events FROM anon;
-- APPEND-ONLY: service_role solo INSERT + SELECT (sin UPDATE/DELETE, ni para admin).
GRANT SELECT, INSERT ON public.audit_events TO service_role;

-- PORT-7: service requests (reseller → RAP). NO son claims. history embebido (jsonb).
CREATE TABLE IF NOT EXISTS public.service_requests (
  id              uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  org_id          uuid REFERENCES public.dealers(id) ON DELETE SET NULL,
  contract_number text NOT NULL,
  customer_name   text,
  contact         text,
  body            text NOT NULL,
  stage           integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'open',
  history         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_requests_status_chk CHECK (status IN ('open','closed')),
  CONSTRAINT service_requests_stage_chk  CHECK (stage BETWEEN 0 AND 5)
);
ALTER TABLE public.service_requests OWNER TO postgres;
CREATE INDEX IF NOT EXISTS service_requests_org_idx ON public.service_requests (org_id);
COMMENT ON TABLE public.service_requests IS 'Solicitudes reseller→RAP (NO claims). stage 0..4 + 5=cerrada; los claims viven en el sistema de RAP por contract#.';

ALTER TABLE public.service_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_requests FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.service_requests TO service_role;

COMMIT;
