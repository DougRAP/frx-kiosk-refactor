/* ============================================================================
 * GET /.netlify/functions/portal-plans — PORT-12a (Pricing & Plans DISPLAY-ONLY).
 * Doug 15-jul: "Just show it for now, we can add control later." Lee el catálogo
 * CANÓNICO del server (_lib/validate.mjs PRICE_CENTS) — jamás otro hardcode en el
 * front. Sin edición: los precios siguen Dev-controlled ("pricing just stays the
 * way it is, we'll just control that dev wise").
 * ==========================================================================*/

'use strict';

import { requirePortalUser, PortalError } from './_lib/portal.mjs';
import { PRICE_CENTS } from './_lib/validate.mjs';

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const env = process.env;

  try {
    const ctx = await requirePortalUser(req, env);
    if (!ctx.scope) return json(403, { error: 'not_portal_user' });
  } catch (err) {
    if (err instanceof PortalError) return json(err.status, { error: err.code });
    console.error('[portal-plans] auth:', err.message);
    return json(500, { error: 'auth_error' });
  }

  /* Los 2 sabores canónicos (Doug: "there are only two flavors of plans"). SKU = tier
   * server-side; el type/categoría NO es llave (PORT-15: plans are all in one). */
  const plans = [
    {
      sku: 'stain', label: 'Protection (Stain)', monthly_cents: PRICE_CENTS['stain'],
      covers: 'Stains — all categories (Furniture, Outdoor, Adjustable, Rugs)'
    },
    {
      sku: 'stain_mech', label: 'Protection+ (Stain + Structure)', monthly_cents: PRICE_CENTS['stain-mech'],
      covers: 'Stains + structural/mechanical — all categories'
    }
  ];
  return json(200, { plans, editable: false });
}
