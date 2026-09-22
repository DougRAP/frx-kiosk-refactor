/* ============================================================================
 * GET /.netlify/functions/portal-stats?org_id&period — PORT-16 (reunión 16-jul).
 * Agregados REALES para Dashboard ("one month snapshot") y Sales Stats (periodo
 * del mock: all|year|month|today). Scoped por readOrgScope: org/sub SIEMPRE su
 * org; admin filtra o ve all. El cálculo vive en _lib/stats.mjs (puro).
 * ==========================================================================*/

'use strict';

import { requirePortalUser, readOrgScope, excludedOrgIds, rollupExclusion, PortalError } from './_lib/portal.mjs';
import { computeStats } from './_lib/stats.mjs';
import { pgrest } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

const PERIODS = ['all', 'year', 'month', 'today', 'range'];

/* PORT-19D: fecha YYYY-MM-DD → ms UTC (medianoche). Inválida → null. */
function dayMs(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(t) ? t : null;
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  let rs, period, fromMs = null, toMs = null;
  try {
    const ctx = await requirePortalUser(req, env);
    if (!ctx.scope) return json(403, { error: 'not_portal_user' });
    const url = new URL(req.url);
    rs = readOrgScope(ctx.scope, url.searchParams.get('org_id'));
    period = url.searchParams.get('period');
    if (!PERIODS.includes(period)) period = 'month';
    if (period === 'range') {
      /* PORT-19D: custom range del mock. to es INCLUSIVO → +1 día (corte exclusivo). */
      fromMs = dayMs(url.searchParams.get('from'));
      const t = dayMs(url.searchParams.get('to'));
      toMs = t != null ? t + 86400000 : null;
      if (fromMs == null && toMs == null) period = 'month';   // range sin fechas → snapshot del mes
    }
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-stats] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  /* PORT-21: en "All", fuera los dealers con include_in_rollups=false */
  const excl = rs.all ? await excludedOrgIds(env) : [];
  const orgFilter = rs.all ? rollupExclusion('dealer_id', excl) : `&dealer_id=eq.${encodeURIComponent(rs.orgId)}`;
  const orgFilterLedger = rs.all ? rollupExclusion('org_id', excl) : `&org_id=eq.${encodeURIComponent(rs.orgId)}`;
  try {
    const [subsQ, ledQ, entQ] = await Promise.all([
      pgrest(env, '/subscriptions?kind=eq.protection'
        + '&select=user_id,status,started_at,canceled_at,monthly_cents,sub_entity_id,sales_associate,master_no,stripe_subscription_id'
        + `&order=started_at.desc&limit=20000${orgFilter}`),   // PORT-21: Max rows del proyecto=20k; volúmenes de dealer grande
      pgrest(env, `/commission_ledger?select=stripe_amount_cents,reinsurance_amount_cents,paid_at,stripe_subscription_id&limit=20000${orgFilterLedger}`),
      pgrest(env, `/sub_entities?select=id,name&limit=500${orgFilterLedger}`)
    ]);
    if (subsQ.status >= 300) return json(502, { error: 'upstream' });
    const stats = computeStats({
      subs: Array.isArray(subsQ.data) ? subsQ.data : [],
      ledger: (ledQ.status < 300 && Array.isArray(ledQ.data)) ? ledQ.data : [],
      entities: (entQ.status < 300 && Array.isArray(entQ.data)) ? entQ.data : [],
      nowMs: Date.now(),
      period, fromMs, toMs
    });
    return json(200, stats);
  } catch (err) {
    console.error('[portal-stats] pgrest:', err.message);
    return json(502, { error: 'upstream' });
  }
}
