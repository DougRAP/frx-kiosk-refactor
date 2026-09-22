/* ============================================================================
 * GET /.netlify/functions/referral-validate?code=XXX — PORT-9 (UX del cart).
 * Feedback en vivo del referral code en los 3 fronts: { valid, org_name? }.
 * PÚBLICO y de solo lectura. La verdad de la atribución NO es esta respuesta:
 * el checkout re-resuelve server-side (resolveAttribution) al crear el lead.
 * Dealer apagado/fuera de ventana → valid:false (decisión 15-jul: el código se
 * ignora; la venta seguiría igual).
 * ==========================================================================*/

'use strict';

import { normalizeReferralCode, referralAttribution } from './_lib/referral.mjs';
import { pgrest } from './_lib/supabase.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  const code = normalizeReferralCode(new URL(req.url).searchParams.get('code'));
  if (!code) return json(200, { valid: false });

  try {
    const r = await pgrest(env, `/referral_codes?code=eq.${encodeURIComponent(code)}&select=code,org_id,active&limit=1`);
    const codeRow = (r.status < 300 && Array.isArray(r.data) && r.data[0]) || null;
    if (!codeRow) return json(200, { valid: false });
    const d = await pgrest(env, `/dealers?id=eq.${encodeURIComponent(codeRow.org_id)}&select=id,name,selling_enabled,access_start,access_end&limit=1`);
    const dealerRow = (d.status < 300 && Array.isArray(d.data) && d.data[0]) || null;
    const attr = referralAttribution(codeRow, dealerRow, Date.now());
    if (!attr) return json(200, { valid: false });
    return json(200, { valid: true, org_name: (dealerRow && dealerRow.name) || null });
  } catch (err) {
    console.error('[referral-validate]', err.message);
    return json(200, { valid: false });   // fail-soft: la UX degrada, el checkout decide igual
  }
}
