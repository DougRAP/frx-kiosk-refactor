/* ============================================================================
 * POST /.netlify/functions/chat
 * ----------------------------------------------------------------------------
 * "Maya" — the Furniture-Rx chat assistant, powered by Claude.
 *
 * The browser sends the running conversation ({ messages: [{role, content}] }).
 * We prepend a grounded system prompt (real plan data + guardrails) and run a
 * short tool-use loop so Claude can:
 *   - quote_estimate  → deterministic 10%-of-retail custom quote (code, not the LLM)
 *   - save_quote_lead → persist the quote intake to Supabase /leads for agent callback
 * Returns { reply } (and { lead_id } when a quote lead was saved).
 *
 * Key comes ONLY from env (ANTHROPIC_API_KEY). With no key we return
 * { error:'no_key' } so the browser keeps its canned fallback — local dev and
 * previews still work without a key.
 * ==========================================================================*/

'use strict';

import Anthropic from '@anthropic-ai/sdk';
import { pgrest } from './_lib/supabase.mjs';
import { clean, EMAIL_RE, canonicalEmail } from './_lib/validate.mjs';   // misma normalización del order#/email que el checkout
import { checkRate, clientIp } from './_lib/ratelimit.mjs';
import { sizeCoverage } from './_lib/coverage-policy.mjs';   // sizing del modelo — SOLO dólares ($5k/plan; piezas ilimitadas, Doug 06-jul)

const MAX_BODY_BYTES = 16384;
const MODEL = 'claude-haiku-4-5-20251001';   // Maya = coverage assistant + Q&A → modelo barato (Doug 25-jun: 'mostly summarizing'). Era opus.
const MAX_TURNS = 32;              // QA-5 (BUG-05 Jakob): 16 = ~8 turnos reales; cada digresión (2 msgs) expulsaba datos ya dados
const QUOTE_RATE = 0.10;           // custom quote = 10% of total retail (to be verified by an agent)
const CUSTOM_COVERAGE_CAP = 200000;

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });
}

/* Grounded system prompt — Claude must price ONLY from these numbers. */
const SYSTEM = `You are Maya, a warm, concise sales assistant for FurnitureRx, a monthly furniture protection program "Powered by RAP". Introduce yourself as "Maya, your sales assistant" when a conversation starts. You help visitors protect a recent furniture purchase, understand the plans, and start a custom quote. Keep replies short (1–4 sentences), friendly, and never pushy.

PLANS (these are the ONLY prices/terms you may state — never invent others):
- Coverage tiers:
  • "Stain protection" — stains, including pet & common household stains.
  • "Stain + Structure" — stains plus rips, burns, and mechanical & electrical issues.
- Terms:
  • Monthly (the plan we sell today): $9.99/mo (Stain) or $19.99/mo (Stain + Structure). Unlimited pieces — the only limit is $5,000 total coverage per plan. Cancel, pause, upgrade, or downgrade anytime.
  • Prepaid 1-Year and 3-Year plans also exist. Their exact price and coverage are shown on the plan cards on the site — do NOT quote yearly prices (they're being finalized and checkout currently processes the monthly plan). If someone asks about yearly, point them to the plan cards on the page.

REPAIR SAFETY NET — the membership (MAYA-9, from the page's FAQ; you MAY explain this):
- Every FurnitureRx protection plan includes the Repair Safety Net at no extra cost for the item you're covering: if damage isn't covered by the plan, we still coordinate the repair — we schedule the technician and order the parts — and the customer pays member rates for the parts and tech fees. It is a managed repair service, NOT insurance and NOT extra coverage.
- The paid membership ($19.99/mo, cancel anytime) is the same service for furniture the customer ALREADY owns: used pieces, hand-me-downs, or things bought online (like Facebook Marketplace). It covers everything in the house — no receipt needed, not tied to specific furniture.
- The difference in one line: the subscription protects the new item you're buying; the membership is repair help for everything else you own.
- Never promise a repair outcome or a timeline. For the fine print, point to "See membership details" in the membership section of the page.

CUSTOM QUOTE (for orders over $10,000 of retail value — more than 2 plans' worth):
- Gather, step by step: how many pieces, the retail value of each piece, and the piece types. Every piece must be a coverable furniture or home-furnishing item (sofa, sectional, recliner, dining, bed, accent/occasional furniture, lighting, rugs & textiles, décor, outdoor/patio). If something isn't a coverable furnishing, say so.
- Once you have the count and a retail value for each piece, call the quote_estimate tool to compute the figure — do NOT do the math yourself.
- Present the result as a PRELIMINARY estimate that a RAP agent will verify by phone. Custom coverage goes up to $200,000.
- Then ask for a phone number so an agent can call to confirm, and (optionally) an email. When you have a phone number, call save_quote_lead to record the request.

SALES ASSISTANT (the main flow — protecting a recent furniture purchase; walk them through it like it's their first time):
- You are guiding a first-time buyer. Be direct and efficient: gather the details in short grouped steps (never re-ask anything they already gave you, and never turn it into a one-by-one interrogation):
  (1) "Let's start with your first and last name." — it fills their checkout card. customer_name is a PERSON'S NAME, never a number: if they answer with an order number here, that is NOT their name — keep the name empty and ask again;
  (2) the sales order number, "What's the total amount on your sales order?" (including tax & delivery), how many items are on the sales order, and what kind of furniture it is (e.g. sofa, sectional, bed, dining set — a short list is fine, no need to itemize);
  (3) the address where the furniture will be delivered, including state and ZIP code, plus their expected delivery date, or the date on the sales order if they don't know it.
- When you have the order total and item count, call the size_coverage tool — pass EVERYTHING you collected so far: name, sales order number, furniture types, delivery address, ZIP and delivery date (as YYYY-MM-DD). It decides how many $5,000 plans are needed — do NOT compute the plan count yourself, and never quote a price. What you collect fills their checkout card, so when they get there it is mostly filled out.
- CONTACT comes LAST, only after the sizing is confirmed (value first, then data — never open the conversation asking for contact info): "Last thing, so your plan and receipts reach you: what's the best email and phone for you?" When they answer, call size_coverage ONCE more with ALL fields (now including customer_email and customer_phone) so their checkout card updates — the sizing will not change.
- REQUIRED-DATA GUARD: the sales order number, the order total, and the furniture type are all needed for us to actually service a claim. If size_coverage comes back with a "guard" note listing missing fields, ask ONE more time, plainly, for each missing item. If the customer still can't or won't provide it, you MAY continue — but warn them once, kindly: "Heads up — without your {sales order number / furniture type}, servicing a claim could be delayed or declined. Our team confirms the details from the receipt you upload." Never hard-block them; the uploaded receipt plus a human review are the final check.
- Then confirm in plain words (e.g. "Got it — 2 plans covering up to $10,000, which fits your $8,200 order. I've filled it into your cart; review before checkout."). If size_coverage returns needs_review, gently note a RAP agent will confirm the details.
- ROAD SIGNS (always, right after confirming the sizing): tell them plainly what comes next. Say something like "Great, you're all set", then remind them: don't forget to add a photo of your sales receipt to ensure you have coverage (or upload the receipt file), check the box confirming your information is accurate, and the next step is to tap the Checkout button on your plan card to finish the purchase.
- The TIER ($9.99 Stain / $19.99 Stain + Structure) is fixed by which card the visitor came from — never change it. Don't ask them to itemize every piece; the uploaded sales receipt is the record — the total, item count, and the general furniture type are what we capture.

GUARDRAILS:
- Only discuss Furniture-Rx plans, coverage, and quotes. Politely decline anything else.
- You do NOT interpret what is or isn't covered. If asked whether something specific would be covered, what's excluded, or how a claim would turn out, never improvise or speculate — answer along the lines of: "I can't comment on the specifics of what's covered — I'm here to help you check out. Please read the plan's terms and conditions, the link is right below." The tier descriptions above are the only coverage wording you may repeat.
- Never take payment or card details in chat, and never promise approval — the quote is an estimate pending agent verification.
- Do not give legal or financial advice.
- If you are unsure or a question is outside these facts, say you'll connect them with a RAP agent rather than guessing.`;

/* ── TECH mode (call Doug 10-jul): la MISMA Maya, en el front tech. Un técnico acaba de
 * reparar en casa del cliente; aquí solo se venden care kits y la Repair Membership.
 * Q&A puro: SIN guion de captura, SIN sizing, SIN precios de planes de protección. ── */
const TECH_SYSTEM = `You are Maya, a warm, concise sales assistant for FurnitureRx Tech. A technician just finished (or is finishing) a repair in the customer's home; this page sells two things only. Keep replies short (1–4 sentences), friendly, and never pushy. Introduce yourself as "Maya, your sales assistant" when a conversation starts.

FACTS (the ONLY offers/prices you may state — never invent others):
- Professional care kits: wood, fabric & upholstery, or leather — the same pro-grade products the technician carries. From $49.99, one-time purchase. Exact kit prices are on the cards on this page.
- Repair Membership: $19.99 per month, and the first 3 months are free. Member rates on repair labor and parts, priority repair coordination, and it covers everything in your house — every piece, new, old, or inherited; no receipt needed, not tied to specific furniture. Cancel anytime.
- If asked "what furniture does it cover?", "everything in your house" is a perfectly good and complete answer.

STYLE: answer questions plainly; do NOT run an intake script here — no sales order questions, no order totals, no itemizing furniture. The technician on site provides the Technician ID and the work order number at checkout.

GUARDRAILS:
- Only discuss FurnitureRx kits, the Repair Membership, and repairs. Politely decline anything else.
- You do NOT interpret what a repair outcome will be or promise specific repairs. For the fine print, point to "See membership details" on this page.
- Never take payment or card details in chat. Do not give legal or financial advice.
- If you are unsure, say you'll connect them with a RAP agent rather than guessing.`;

/* El front declara el modo (body.context). Enum: solo 'tech' cambia algo; cualquier otro
 * valor cae al modo default EXACTO de siempre. Named export → testeable por el harness. */
export function chatMode(context) {
  return context === 'tech'
    ? { system: TECH_SYSTEM, tools: [] }
    : { system: SYSTEM, tools: TOOLS };
}

const TOOLS = [
  {
    name: 'quote_estimate',
    description: 'Compute a preliminary custom-quote estimate (10% of total retail) for orders over $10,000 of retail value. Call this once you know the number of pieces and a retail value for each piece.',
    input_schema: {
      type: 'object',
      properties: {
        retail_values: {
          type: 'array',
          items: { type: 'number' },
          description: 'Retail value (USD) of each piece, one number per piece.'
        },
        piece_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Type of each piece (e.g. "sofa", "rug", "patio table"). Should align 1:1 with retail_values.'
        }
      },
      required: ['retail_values']
    }
  },
  {
    name: 'save_quote_lead',
    description: 'Save the custom-quote request so a RAP agent can call the customer back to verify. Call this only after you have a phone number.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Customer phone number for the agent callback.' },
        email: { type: 'string', description: 'Customer email, if provided.' },
        pieces: { type: 'integer', description: 'Number of pieces to cover.' },
        retail_values: { type: 'array', items: { type: 'number' } },
        piece_types: { type: 'array', items: { type: 'string' } },
        estimate: { type: 'number', description: 'The estimate from quote_estimate (USD).' }
      },
      required: ['phone']
    }
  },
  {
    name: 'size_coverage',
    description: 'Size a protection purchase from the sales order: decides how many $5,000 plans are needed from the order total (pieces are unlimited — the item count is recorded for the file but does not limit the plan). Call once you have the order total and item count; also pass the sales order number and furniture types when you have them (they are needed to service a claim — the tool flags any that are missing). The system computes the plan count — never compute it yourself.',
    input_schema: {
      type: 'object',
      properties: {
        sales_order_number: { type: 'string', description: 'The sales order number from the receipt.' },
        sales_order_total: { type: 'number', description: 'Order total in USD (incl. tax & delivery).' },
        item_count: { type: 'integer', description: 'How many items are on the sales order.' },
        furniture_types: { type: 'array', items: { type: 'string' }, description: 'The kinds of furniture on the order the customer described (e.g. ["sofa","bed"]). Needed so a claim can be serviced; capture what the customer says.' },
        customer_name: { type: 'string', description: "The customer's first and last name, as they gave it (fills their checkout card). A person's name, NEVER a number — do not put the sales order number here." },
        customer_email: { type: 'string', description: "The customer's email for the plan." },
        customer_phone: { type: 'string', description: "The customer's phone number for the plan." },
        delivery_address: { type: 'string', description: 'The address where the furniture will be delivered, as the customer said it (street, city, state).' },
        delivery_zip: { type: 'string', description: 'The ZIP code, extracted from the delivery address (5 digits, or ZIP+4).' },
        delivery_date: { type: 'string', description: 'The expected delivery date, or the date on the sales order if unknown, formatted YYYY-MM-DD.' },
        cov: { type: 'string', description: "Tier from the card the visitor came from: 'stain' or 'stain-mech'." }
      },
      required: ['sales_order_total', 'item_count']
    }
  }
];

function runQuoteEstimate(input) {
  const vals = Array.isArray(input?.retail_values)
    ? input.retail_values.filter((n) => typeof n === 'number' && isFinite(n) && n > 0)
    : [];
  if (!vals.length) {
    return { error: 'Need at least one retail value to estimate.' };
  }
  const totalRetail = vals.reduce((a, b) => a + b, 0);
  const estimate = Math.round(totalRetail * QUOTE_RATE);
  const coverage = Math.min(totalRetail, CUSTOM_COVERAGE_CAP);
  return {
    pieces: vals.length,
    total_retail: Math.round(totalRetail),
    estimate,                                  // 10% of retail, to be verified
    coverage_up_to: coverage,
    coverage_cap: CUSTOM_COVERAGE_CAP,
    note: 'Preliminary estimate (10% of customer-stated retail). A RAP agent verifies before anything is charged.'
  };
}

async function runSaveQuoteLead(env, input) {
  const row = {
    source: 'other',
    email: (typeof input?.email === 'string' && input.email.trim()) ? input.email.trim().toLowerCase() : null,
    payload: {
      intent: 'custom_quote',
      phone: input?.phone || null,
      pieces: input?.pieces ?? (Array.isArray(input?.retail_values) ? input.retail_values.length : null),
      retail_values: Array.isArray(input?.retail_values) ? input.retail_values : null,
      piece_types: Array.isArray(input?.piece_types) ? input.piece_types : null,
      estimate: typeof input?.estimate === 'number' ? input.estimate : null,
      status: 'awaiting_agent_callback'
    }
  };
  try {
    const { status, data } = await pgrest(env, '/leads', {
      method: 'POST', prefer: 'return=representation', body: row
    });
    if (status >= 300 || !Array.isArray(data) || !data[0]) {
      return { saved: false, error: `lead insert failed (${status})` };
    }
    return { saved: true, lead_id: data[0].id };
  } catch (err) {
    return { saved: false, error: err.message };
  }
}

/* Coverage Assistant: dimensiona la compra (cuántos planes de $5k) desde el sales order.
 * El SERVER decide (sizeCoverage, flag-driven en coverage-policy.mjs) — NUNCA el LLM.
 * Devuelve lo estructurado para que el front pre-llene la card. */
export function runSizeCoverage(input) {   // named export → testeable por el harness (G14); Netlify usa solo el default
  const order = (typeof input?.sales_order_number === 'string') ? input.sales_order_number.trim().slice(0, 64) : '';
  const totalDollars = Number(input?.sales_order_total);
  const items = Number(input?.item_count);
  const cov = (input?.cov === 'stain-mech' || input?.cov === 'stain') ? input.cov : null;
  const furnitureTypes = Array.isArray(input?.furniture_types)
    ? [...new Set(input.furniture_types
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim().slice(0, 40)))].slice(0, 12)          // dedupe + cap largo/nº (defensivo)
    : [];
  /* MAYA-8: los datos del guion completo (nombre, entrega) pasan SANITIZADOS al front para
   * llenar la card ("when you get here it's mostly filled out"). Formatos malos → null:
   * la card jamás recibe basura. NO entran al guard CA-4 (eso sigue siendo order# + tipo). */
  /* MAYA-8b: un "nombre" numérico (el SO disfrazado) se descarta — mejor card vacía que mentira.
   * Regla: al menos 2 letras y nunca más dígitos que letras. */
  const nameRaw = (typeof input?.customer_name === 'string') ? input.customer_name.trim().slice(0, 80) : '';
  const nameLetters = (nameRaw.match(/[A-Za-z]/g) || []).length;
  const nameDigits = (nameRaw.match(/\d/g) || []).length;
  const custName = (nameLetters >= 2 && nameDigits <= nameLetters) ? nameRaw : '';
  const emailRaw = (typeof input?.customer_email === 'string') ? canonicalEmail(input.customer_email) : '';
  const custEmail = (emailRaw && EMAIL_RE.test(emailRaw)) ? emailRaw : '';
  const phoneDigits = (typeof input?.customer_phone === 'string') ? input.customer_phone.replace(/\D/g, '') : '';
  const custPhone = (phoneDigits.length >= 7 && phoneDigits.length <= 15) ? phoneDigits : '';
  const delivAddr = (typeof input?.delivery_address === 'string') ? input.delivery_address.trim().slice(0, 200) : '';
  const zipRaw = (typeof input?.delivery_zip === 'string') ? input.delivery_zip.trim() : '';
  const delivZip = /^\d{5}(-\d{4})?$/.test(zipRaw) ? zipRaw : '';
  const dateRaw = (typeof input?.delivery_date === 'string') ? input.delivery_date.trim() : '';
  const delivDate = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : '';
  if (!isFinite(totalDollars) || totalDollars < 0) return { error: 'Need the order total as a positive number.' };
  const s = sizeCoverage(Math.round(totalDollars * 100), items);

  // CA-4 — required-data guard (Doug 29-jun): el nº de orden, el monto y el TIPO de mueble hacen falta
  // para poder servir un claim. El SERVER detecta lo que falta (determinista) y FUERZA needs_review; Maya
  // re-pregunta (loop) y, si el cliente no lo da, avisa y sigue (nunca hard-block). El ojo humano + el
  // recibo subido deciden al final. (El monto ya es requisito para dimensionar → arriba devuelve error.)
  const missing = [];
  if (!order) missing.push('sales_order_number');
  if (!furnitureTypes.length) missing.push('furniture_type');

  const out = {
    sales_order_number: order || null,
    sales_order_total: Math.round(totalDollars),
    item_count: (Number.isInteger(items) && items > 0) ? items : null,
    cov,
    furniture_types: furnitureTypes,
    customer_name: custName || null,
    customer_email: custEmail || null,
    customer_phone: custPhone || null,
    delivery_address: delivAddr || null,
    delivery_zip: delivZip || null,
    delivery_date: delivDate || null,
    recommended_plans: s.recommendedPlans,
    covered_up_to: Math.round(s.coveredCents / 100),
    binding: s.binding,                 // siempre 'dollars' (piezas ilimitadas, Doug 06-jul; clave conservada por compat)
    over_cap: s.overCap,
    needs_review: s.needsReview || missing.length > 0,   // faltante ⇒ SIEMPRE a revisión humana
    note: 'System-sized from order total + item count. Tier/price is set by the card, not here.'
  };
  if (missing.length) {
    out.missing = missing;
    out.guard = 'Missing required data (' + missing.join(', ') + '). Ask the customer once more for each; '
      + 'if they still can’t provide it, you may continue but warn that servicing a claim could be delayed '
      + 'or declined without it. Never block them — the uploaded receipt and a human review are the final check.';
  }
  return out;
}

/* Coverage Assistant — FILOSOFÍA DE DOUG ("store the English, decode later"): persiste la CONVERSACIÓN
 * COMPLETA + el summary estructurado como UN lead intent='coverage' por conversación. UPSERT por
 * conversation_id → sin duplicados; se refresca CADA turno → el último turno = el chat completo. El
 * transcript sale del historial CRUDO (body.messages), NO del truncado a 16 turnos que se manda al LLM.
 * El dashboard hace join subscriptions.sales_order_number → este lead. Fail-soft (nunca rompe el chat). */
/* Resumen LEGIBLE (determinista, sin LLM → sin alucinación ni costo) de la cobertura
 * dimensionada — la "narrativa" que el dashboard muestra junto al bloque numérico. Es el gist
 * de lo que el cliente le dijo a Maya; el transcript crudo queda guardado aparte para "decode later". */
export function coverageSummaryText(s) {   // named export → testeable por el harness (G14)
  const label = /mech/.test(String(s.cov || '')) ? 'Stain + Structure' : 'Stain';
  const fmt = (v) => '$' + Number(v || 0).toLocaleString('en-US');
  const n = Number(s.item_count);
  const pl = Number(s.recommended_plans);
  const parts = [];
  parts.push(`${label} coverage` + (s.sales_order_number ? ` for sales order ${s.sales_order_number}` : '') + '.');
  if (s.sales_order_total != null || s.item_count != null) {
    parts.push(`Sales order ${fmt(s.sales_order_total)}` + (s.item_count != null ? ` across ${n} item${n === 1 ? '' : 's'}` : '') + '.');
  }
  if (Array.isArray(s.furniture_types) && s.furniture_types.length) {
    parts.push('Items: ' + s.furniture_types.join(', ') + '.');   // lo que el cliente dijo (CA-3/DASH-6)
  }
  if (s.recommended_plans != null) {
    parts.push(`Sized to ${pl} plan${pl === 1 ? '' : 's'}` + (s.covered_up_to != null ? `, covering up to ${fmt(s.covered_up_to)}` : '') + '.');
  }
  if (s.needs_review) parts.push('Flagged for manual review.');
  return parts.join(' ').slice(0, 600);
}

async function upsertCoverageLead(env, conversationId, rawMessages, reply, sized) {
  if (!conversationId) return;                              // sin id → chat general, no se persiste
  const turns = (Array.isArray(rawMessages) ? rawMessages : [])
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));        // cap defensivo por turno
  if (reply) turns.push({ role: 'assistant', content: String(reply).slice(0, 8000) });  // el reply de ESTE turno aún no está en rawMessages

  // read-merge-write: 1 lead por conversación; preserva el summary en turnos SIN sizing.
  let prior = {}, priorId = null;
  try {
    const { status, data } = await pgrest(
      env,
      `/leads?select=id,payload&payload->>conversation_id=eq.${encodeURIComponent(conversationId)}&limit=1`,
      { method: 'GET' }
    );
    if (status < 300 && Array.isArray(data) && data[0]) { prior = data[0].payload || {}; priorId = data[0].id; }
  } catch (e) { /* fail-soft: si el read falla, insertamos uno nuevo abajo */ }

  const payload = {
    ...prior,
    intent: 'coverage',
    conversation_id: conversationId,
    transcript: turns,                  // refrescado cada turno → el último = la conversación real completa
    turn_count: turns.length
  };
  if (sized) {                          // SOLO pisamos el summary cuando se dimensionó EN este turno
    payload.sales_order_number = clean(sized.sales_order_number, 64);   // misma normalización que el checkout → join exacto
    payload.sales_order_total = sized.sales_order_total;
    payload.item_count = sized.item_count;
    payload.furniture_types = Array.isArray(sized.furniture_types) ? sized.furniture_types : [];   // CA-4: tipo(s) capturado(s)
    payload.cov = sized.cov;
    payload.customer_name = sized.customer_name || null;          // MAYA-8: "store the English"
    payload.customer_email = sized.customer_email || null;
    payload.customer_phone = sized.customer_phone || null;
    payload.delivery_address = sized.delivery_address || null;
    payload.delivery_zip = sized.delivery_zip || null;
    payload.delivery_date = sized.delivery_date || null;
    payload.recommended_plans = sized.recommended_plans;
    payload.covered_up_to = sized.covered_up_to;
    payload.needs_review = sized.needs_review;
    payload.summary = coverageSummaryText(sized);   // resumen legible (determinista) para el dashboard
  }

  try {
    if (priorId) {
      await pgrest(env, `/leads?id=eq.${priorId}`, { method: 'PATCH', prefer: 'return=minimal', body: { payload } });
    } else {
      await pgrest(env, '/leads', { method: 'POST', prefer: 'return=minimal', body: { source: 'other', payload } });
    }
  } catch (e) {
    console.warn('[chat] upsertCoverageLead:', e.message);   // sin PII en el log
  }
}

/* QA-5 (BUG-05 de Jakob): preámbulo con lo YA capturado (el objeto `coverage` que el front
 * recibió de size_coverage y devuelve como body.known). Aunque el truncado de MAX_TURNS
 * expulse los turnos originales, el modelo sigue viendo los datos duros y no re-pregunta.
 * Whitelist + caps: nada del cliente entra al system sin sanitizar. */
const KNOWN_FIELDS = [
  ['customer_name', 'name'], ['sales_order_number', 'sales order #'], ['sales_order_total', 'order total $'],
  ['item_count', 'items'], ['furniture_types', 'furniture'], ['cov', 'plan tier'],
  ['delivery_address', 'delivery address'], ['delivery_zip', 'zip'], ['delivery_date', 'delivery date']
];
export function knownPreamble(known) {
  if (!known || typeof known !== 'object' || Array.isArray(known)) return '';
  const bits = [];
  for (const [key, label] of KNOWN_FIELDS) {
    const v = known[key];
    if (typeof v === 'string' && v.trim()) bits.push(`${label}: ${v.trim().slice(0, 120)}`);
    else if (typeof v === 'number' && Number.isFinite(v)) bits.push(`${label}: ${v}`);
    else if (Array.isArray(v)) {
      const items = v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 40)).slice(0, 8);
      if (items.length) bits.push(`${label}: ${items.join(', ')}`);
    }
  }
  if (!bits.length) return '';
  return '\n\nALREADY COLLECTED from this customer (do not ask again; reuse silently): ' + bits.join(' · ');
}

/* Accept only well-formed {role:'user'|'assistant', content:string} turns from the client. */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw.slice(-MAX_TURNS)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content.slice(0, 4000) : '';
    if (content) out.push({ role: m.role, content });
  }
  // Conversation must start with a user turn and be non-empty.
  while (out.length && out[0].role !== 'user') out.shift();
  return out.length ? out : null;
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const env = process.env;
  if (!env.ANTHROPIC_API_KEY) return json(200, { error: 'no_key' });   // browser keeps its fallback

  /* El endpoint MÁS caro de abusar (hasta 5 llamadas al modelo por request) → doble ventana por IP:
     ráfaga (10/min — Doug 02-jul 32:26: tope anti-bot de mensajes continuos en 10, era 5) +
     sostenida (60/h). Fail-open. */
  const ip = clientIp(req);
  const burst = await checkRate(env, { prefix: 'chat', ip, limit: 10, windowSec: 60 });
  if (!burst.allowed) return json(429, { error: 'rate_limited', retry_after: burst.retryAfter }, { 'Retry-After': String(burst.retryAfter) });
  const sustained = await checkRate(env, { prefix: 'chat-h', ip, limit: 60, windowSec: 3600 });
  if (!sustained.allowed) return json(429, { error: 'rate_limited', retry_after: sustained.retryAfter }, { 'Retry-After': String(sustained.retryAfter) });

  let raw;
  try { raw = await req.text(); } catch { return json(400, { error: 'unreadable_body' }); }
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'body_too_large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }

  const messages = sanitizeMessages(body.messages);
  if (!messages) return json(400, { error: 'invalid_messages' });

  // Coverage Assistant: id de conversación (lo manda el front SOLO en chats de cobertura). Valida formato
  // UUID-ish; si no viene / no es válido → no se persiste como lead de cobertura (= chat general de Maya).
  const convId = (typeof body.conversation_id === 'string' && /^[a-z0-9-]{8,64}$/i.test(body.conversation_id.trim()))
    ? body.conversation_id.trim() : null;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  /* TECH mode (10-jul): el front tech manda context:'tech' → Maya Q&A sin tools. Enum. */
  const mode = chatMode(typeof body.context === 'string' ? body.context : undefined);
  const system = mode.system + knownPreamble(body.known);   // QA-5: lo ya capturado sobrevive al truncado

  try {
    let leadId = null, coverage = null;
    // Manual tool loop — let Claude drive, run tools server-side, feed results back.
    for (let i = 0; i < 5; i++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,                     // haiku NO soporta output_config.effort (era de opus) → quitado; haiku ya es rápido
        system: system,
        ...(mode.tools.length ? { tools: mode.tools } : {}),
        messages
      });

      if (resp.stop_reason !== 'tool_use') {
        const reply = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        const out = reply || 'Sorry — could you say that another way?';
        await upsertCoverageLead(env, convId, body.messages, out, coverage);   // chat completo + summary (1 lead/conversación)
        return json(200, { reply: out, lead_id: leadId, coverage });
      }

      // Echo the assistant turn (incl. tool_use blocks), then answer each tool_use.
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        if (block.name === 'quote_estimate') {
          result = runQuoteEstimate(block.input);
        } else if (block.name === 'save_quote_lead') {
          result = await runSaveQuoteLead(env, block.input);
          if (result.saved && result.lead_id) leadId = result.lead_id;
        } else if (block.name === 'size_coverage') {
          result = runSizeCoverage(block.input);
          if (!result.error) coverage = result;               // → el front pre-llena la card; el guardado va al final (upsert por conversación)
        } else {
          result = { error: 'unknown_tool' };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result)
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    const out = 'Let me get a RAP agent to help with that — what’s the best number to reach you?';
    await upsertCoverageLead(env, convId, body.messages, out, coverage);
    return json(200, { reply: out, lead_id: leadId, coverage });
  } catch (err) {
    console.error('[chat] error:', err.message);
    return json(502, { error: 'chat_failed' });
  }
}
