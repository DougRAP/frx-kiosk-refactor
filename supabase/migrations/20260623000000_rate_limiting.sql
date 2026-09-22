-- ============================================================================
-- Furniture-Rx · rate-limiting de las Functions públicas (BE-2)
-- Proyecto: jmfndyvwylmqjkngyzxi (FurnitureRX)
-- Fecha: 2026-06-23
--
-- POR QUÉ
--   create-checkout-session, create-lead y chat (LLM Opus) son públicas, sin
--   auth y con efectos costosos, hoy SIN límite de frecuencia → spam de leads,
--   ruido en Stripe y, sobre todo, abuso de costo en el chat. Este contador
--   atómico por (función, IP) en Postgres da el rate-limit que falta, compartido
--   entre las N instancias serverless (un contador in-memory NO sería fiable).
--   El helper _lib/ratelimit.mjs lo invoca vía PostgREST RPC (service_role).
--
-- CÓMO APLICAR
--   Pegar en el SQL Editor de Supabase (corre como postgres) o `supabase db push`.
--   Idempotente (IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================================

BEGIN;

-- Tabla: UNA fila por key `prefix:hash(ip)`, reescrita in-place (no crece por hit,
-- solo por IP distinta; la propia función purga filas viejas oportunamente).
CREATE TABLE IF NOT EXISTS public.rate_limits (
  bucket_key   text        PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  hits         bigint      NOT NULL DEFAULT 0
);

-- RLS on + solo service_role (la función corre como service_role / SECURITY DEFINER).
-- anon/authenticated nunca tocan esta tabla (no es Data API).
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits FROM anon, authenticated;
GRANT  ALL ON public.rate_limits TO service_role;

COMMENT ON TABLE public.rate_limits
  IS 'Contador de rate-limit por (función, hash de IP). Lo gestiona rate_limit_hit(); no es Data API.';

COMMIT;

-- ============================================================================
-- Función atómica de conteo. Ventana fija con auto-reset:
--   - INSERT ... ON CONFLICT DO UPDATE ... RETURNING → atómico (lock de fila).
--   - window_start se mueve SOLO en el reset (no en cada hit) → no es sliding.
--   - retry_after = CEIL(window_start + ventana - now()), mínimo 1s.
-- SECURITY DEFINER + search_path endurecido (patrón del repo, ver enforce_piece_limit).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rate_limit_hit(p_key text, p_limit int, p_window_seconds int)
RETURNS TABLE(allowed boolean, hits bigint, retry_after int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now    timestamptz := now();
  v_window interval     := make_interval(secs => p_window_seconds);
  v_start  timestamptz;
  v_hits   bigint;
BEGIN
  -- Purga oportunista (~1% de las llamadas): suelta buckets de más de 1 día. Sin pg_cron.
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limits WHERE window_start < v_now - interval '1 day';
  END IF;

  INSERT INTO public.rate_limits AS r (bucket_key, window_start, hits)
       VALUES (p_key, v_now, 1)
  ON CONFLICT (bucket_key) DO UPDATE
       SET hits         = CASE WHEN v_now - r.window_start >= v_window THEN 1     ELSE r.hits + 1 END,
           window_start = CASE WHEN v_now - r.window_start >= v_window THEN v_now ELSE r.window_start END
   RETURNING r.hits, r.window_start INTO v_hits, v_start;

  RETURN QUERY
    SELECT (v_hits <= p_limit),
           v_hits,
           GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_start + v_window - v_now)))::int);
END;
$$;

REVOKE ALL     ON FUNCTION public.rate_limit_hit(text, int, int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rate_limit_hit(text, int, int) TO service_role;

COMMENT ON FUNCTION public.rate_limit_hit(text, int, int)
  IS 'Rate-limit por ventana fija atómica. Devuelve allowed/hits/retry_after. Solo service_role.';

-- ============================================================================
-- VERIFICACIÓN (correr aparte)
--   SELECT * FROM public.rate_limit_hit('t:demo', 3, 60);  -- repetir: la 4ª → allowed=false
--   SELECT * FROM public.rate_limits WHERE bucket_key = 't:demo';
-- ============================================================================
