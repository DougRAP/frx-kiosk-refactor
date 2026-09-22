/* ============================================================================
 * _lib/stats.mjs — PORT-16 (reunión 16-jul): agregados del dashboard/sales stats.
 * PURO (testeable sin BD; ver portal4.test.mjs). portal-stats.mjs trae las filas
 * scoped (readOrgScope) y esto solo CALCULA — cero números inventados: todo sale
 * de subscriptions, commission_ledger y sub_entities reales.
 * Dashboard = snapshot del MES (Doug: "one month snapshot"); Sales Stats deja
 * elegir el periodo (mock: Since inception / This year / This month / Today).
 * ==========================================================================*/

'use strict';

/* Inicio del periodo en ms UTC. 'all' (since inception) → null = sin corte. */
export function periodStart(period, nowMs) {
  const d = new Date(nowMs);
  if (period === 'today') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (period === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1);
  return null;
}

const cancelled = (s) => !!s.canceled_at || s.status === 'canceled' || s.status === 'cancelled';

export function computeStats({ subs = [], ledger = [], entities = [], nowMs = 0, period = 'month', fromMs = null, toMs = null } = {}) {
  /* PORT-19D: custom range del mock — from/to explícitos ganan al periodo nombrado */
  const start = (fromMs != null) ? fromMs : periodStart(period, nowMs);
  const end = (toMs != null) ? toMs : null;
  const inPeriod = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) && (start == null || t >= start) && (end == null || t < end);
  };

  const active = subs.filter((s) => !cancelled(s));
  const monthlyValue = active.reduce((a, s) => a + (s.monthly_cents | 0), 0);
  const newInPeriod = subs.filter((s) => inPeriod(s.started_at)).length;
  const cancelsInPeriod = subs.filter((s) => cancelled(s) && inPeriod(s.canceled_at || s.started_at)).length;
  const totalCancelled = subs.filter(cancelled).length;
  const cancelRate = subs.length ? Math.round((totalCancelled / subs.length) * 1000) / 10 : 0;
  const unique = new Set(subs.map((s) => s.user_id).filter(Boolean)).size;

  /* PORT-19D: delta del cancel rate en pts vs el estado ANTES del periodo (mock "▲ 0.3 pts").
   * Se recalcula la tasa con solo las subs/cancels previas al corte; sin corte → 0. */
  let cancelRateDelta = 0;
  if (start != null) {
    const before = subs.filter((s) => {
      const t = Date.parse(s.started_at || '');
      return Number.isFinite(t) && t < start;
    });
    const cancBefore = before.filter((s) => {
      if (!cancelled(s)) return false;
      const t = Date.parse(s.canceled_at || s.started_at || '');
      return Number.isFinite(t) && t < start;
    }).length;
    const prevRate = before.length ? Math.round((cancBefore / before.length) * 1000) / 10 : 0;
    cancelRateDelta = Math.round((cancelRate - prevRate) * 10) / 10;
  }

  const led = ledger.filter((l) => inPeriod(l.paid_at));
  const cash = led.reduce((a, l) => a + (l.stripe_amount_cents | 0), 0);
  const rein = led.reduce((a, l) => a + (l.reinsurance_amount_cents | 0), 0);

  const entName = {};
  for (const e of entities) entName[e.id] = e.name;
  const group = (keyOf, label) => {
    const m = new Map();
    for (const s of subs) {
      const k = keyOf(s);
      if (!m.has(k)) m.set(k, { active: 0, news: 0, cancels: 0 });
      const g = m.get(k);
      if (!cancelled(s)) g.active++;
      if (inPeriod(s.started_at)) g.news++;
      if (cancelled(s) && inPeriod(s.canceled_at || s.started_at)) g.cancels++;
    }
    return Array.from(m, ([k, g]) => ({ ...label(k), ...g })).sort((a, b) => b.active - a.active);
  };
  const byLocation = group((s) => s.sub_entity_id || null,
    (k) => ({ id: k, name: k ? (entName[k] || String(k).slice(0, 8)) : 'Unassigned' }));
  const byAssociate = group((s) => s.sales_associate || null, (k) => ({ assoc: k || '—' }));

  /* PORT-19D: Deposits por location (mock) — ledger→sub via stripe_subscription_id.
   * Pago sin sub conocida → Unassigned (id null); data real, cero prorrateo inventado. */
  const subLoc = {};
  for (const s of subs) if (s.stripe_subscription_id) subLoc[s.stripe_subscription_id] = s.sub_entity_id || null;
  const depByLoc = new Map();
  for (const l of led) {
    const k = (l.stripe_subscription_id in subLoc) ? subLoc[l.stripe_subscription_id] : null;
    depByLoc.set(k, (depByLoc.get(k) || 0) + (l.stripe_amount_cents | 0));
  }
  for (const loc of byLocation) loc.deposits_cents = depByLoc.get(loc.id) || 0;

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const recent = subs.slice()
    .sort((a, b) => Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0))
    .slice(0, 8)
    .map((s) => {
      const t = Date.parse(s.started_at || '');
      const d = new Date(t);
      return {
        date: String(s.started_at || '').slice(0, 10),
        date_short: Number.isFinite(t) ? (MON[d.getUTCMonth()] + ' ' + d.getUTCDate()) : '—',  // mock "Jul 12"
        contract: s.master_no || '—',
        associate: s.sales_associate || '—',
        cancelled: cancelled(s)
      };
    });

  return {
    period,
    active: active.length,
    unique,
    new_in_period: newInPeriod,
    cancels_in_period: cancelsInPeriod,
    cancel_rate: cancelRate,
    cancel_rate_delta_pts: cancelRateDelta,
    monthly_value_cents: monthlyValue,
    next_month_cents: monthlyValue,
    next_year_cents: monthlyValue * 12,
    commission_cash_cents: cash,
    commission_rein_cents: rein,
    by_location: byLocation,
    by_associate: byAssociate,
    recent
  };
}
