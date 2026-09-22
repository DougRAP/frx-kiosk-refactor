/* ============================================================================
 * GET /.netlify/functions/get-my-account
 * ----------------------------------------------------------------------------
 * Devuelve el resumen de cuenta del usuario logueado para hidratar el dashboard:
 * email + array de suscripciones con sus piezas cubiertas. Una sola query a
 * PostgREST con embed (atómica → sin race window entre subscription y pieces).
 *
 * AUTH: Bearer del access_token de Supabase en el header Authorization. Se
 * valida vía requireUser → /auth/v1/user. Sin Bearer válido → 401.
 *
 * 🔒 IMPORTANTE: la query DEBE filtrar por id=eq.${userId}. service_role
 * BYPASSA RLS, así que un olvido del WHERE expondría TODA la BD. Si añades
 * lógica aquí, NO toques el filtro.
 * ==========================================================================*/

'use strict';

import { requireUser, AuthError } from './_lib/auth.mjs';
import { pgrest } from './_lib/supabase.mjs';

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private, must-revalidate',
      ...(extraHeaders || {})
    }
  });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });

  const env = process.env;

  let user;
  try {
    user = await requireUser(req, env);
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.code });
    console.error('[get-my-account] auth failed:', err.message);
    return json(500, { error: 'auth_error' });
  }

  /* Embed PostgREST: profile + subscriptions + covered_pieces en 1 round-trip.
   * La FK subscriptions.user_id → profiles.id y covered_pieces.subscription_id
   * permiten el embed declarativo. Atómico desde la BD. */
  const select = [
    'email',
    'subscriptions(' + [
      'kind', 'tier', 'status', 'monthly_cents', 'coverage_cap_cents',
      'started_at', 'current_period_end', 'stripe_subscription_id',
      'covered_pieces(piece_type,purchased_at)'
    ].join(',') + ')'
  ].join(',');

  let result;
  try {
    result = await pgrest(
      env,
      `/profiles?id=eq.${encodeURIComponent(user.userId)}&select=${encodeURIComponent(select)}`
    );
  } catch (err) {
    console.error('[get-my-account] pgrest failed:', err.message);
    return json(502, { error: 'upstream' });
  }

  if (result.status >= 300) {
    console.error('[get-my-account] pgrest status', result.status);
    return json(502, { error: 'upstream' });
  }

  /* Si el profile aún no existe (race con webhook), devolvemos el email del JWT
   * y subscriptions:[]. El frontend tratará esto como "setting up your coverage…"
   * y reintentará con backoff. */
  const row = Array.isArray(result.data) && result.data[0] ? result.data[0] : null;
  return json(200, {
    email: (row && row.email) || user.email,
    subscriptions: (row && Array.isArray(row.subscriptions)) ? row.subscriptions : []
  });
}
