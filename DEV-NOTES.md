# Dev review notes — FurnitureRx (read before go-live)

_Last updated: 2026-06-17. Audience: the developer who finishes/ships this project._
_Architecture, the cart system, env vars, and every place pricing lives are documented in
`CLAUDE.md` — read that first. This note is the punch list of what's still OPEN and what needs
a human/business decision._

---

## ✅ RESOLVED — monthly checkout contract reconciled (was the go-live blocker)

**The HTTP 400 (`invalid_counts`) on every real submit is fixed.** The front-end and back-end now
agree on the payload for the monthly happy path. (Applied the recommended minimal fix from
Decision 1 below.)

- Browser (`index.html` → `startCheckout()`) posts `{cov, term, type, count, …}` where `type` is
  one of `furniture/outdoor/adjbed/mattress/rugs/lighting` and `count` = number of plans (1–2).
- Server (`netlify/functions/_lib/validate.mjs` → `validateCheckout`) now **accepts that contract**:
  `PIECE_TYPES` was switched to the front's 6 categories, the server synthesizes
  `counts = { [type]: count }` (feeds `lead.payload.pieces` → `covered_pieces`), and `count` is
  capped at `MAX_PLANS = 2`. **Yearly is rejected server-side** (`term !== 'monthly'` →
  `term_not_supported`) instead of silently charging monthly.
- Stripe (`create-checkout-session.mjs`) now sends `quantity = count` (was hardcoded `1`).

**Still pending (post-launch):** yearly → Stripe wiring needs new price-ID env vars + the
yearly-pricing reconciliation in Decision 2 below. The monthly path is launch-ready.

---

## Decisions needed (business/product — code is ready once you choose)

**1. Checkout contract + piece vocabulary.**
Pick the canonical piece-type vocabulary and how plans map to Stripe.
- _Recommended (smallest, fixes monthly now):_ adopt the front-end's 6 home-furnishing categories
  as canonical (replace `PIECE_TYPES` in `validate.mjs:14`); server derives `counts` from `type`;
  Stripe `quantity = count`. Yearly stays display-only until Decision 2.
- Alternative: build a real per-piece picker in the cart drawer that emits a `counts` map (more UI).

**2. Canonical yearly pricing (sources disagree, and 3yr is modeled differently).**

| Source | 1yr stain / mech | 3yr stain / mech | Caps |
|---|---|---|---|
| `index.html` `PLANS` (~L1580) | $129.99 / $259.99 | $249.99 / $449.99 (flat per plan) | 1yr $7.5k · 3yr $10k |
| `chat.mjs` SYSTEM (L44–46) | $109.99 / $219.99 | $79.99 / $99.99 **per piece** | up to 6 pc · $15k (3yr) |
| `validate.mjs` `PRICE_CENTS` (L11) | _monthly only_ | _monthly only_ | server-canonical |

Monthly ($9.99 / $19.99) is consistent everywhere. **Decide the canonical yearly numbers + cap
model + whether 3yr is flat or per-piece**, then make ALL of these agree: `index.html` `PLANS` +
any hardcoded markup/FAQ strings, `chat.mjs`, and (if yearly goes live) `validate.mjs` +
`_lib/stripe.mjs` + new Stripe price-ID env vars. Note the winner in `CLAUDE.md`.

**3. Single-plan vs multi-plan checkout.**
Today the drawer/Stripe rings only the hero's current line, never a stain+mech combo.
- _Recommended now:_ keep single-plan, but make the drawer copy explicitly say it covers the
  selected plan only (honest stopgap, no spend).
- Later: true multi-line — POST the full cart, validate each line, build Stripe `line_items[]`.

**4. (optional, brand) Tagline.** `<title>` is already retailer-stealth-compliant. Open question
is only whether to keep "You're still in control" or realign to the "second chance / you still
have options" framing. Pure messaging call.

---

## Done in this polish pass (no decision needed)
See git history / `CLAUDE.md` for detail. Highlights:
- Cart rebuilt as a single-source-of-truth, device-local (`localStorage`) system; hero stepper and
  the two `#compare` cards live-sync the same cart line; Save/Checkout CTAs on each card.
- Removed the old `#plans` section; folded its feature lists into the `#compare` cards, the legal
  fine print under the grid + a condensed copy in the checkout drawer; repointed nav/footer anchors.
- Cart badge now sums total plans (not distinct lines).
- Fixed: dropdown z-index trapped under reveals; duplicate trust banner → slim dashboard lead-in;
  in-cart line visibility; meta-description grammar.

## Known non-blockers (decide if worth doing)
- Multi-line checkout (Decision 3). Yearly→Stripe wiring (Decision 2). These can ship post-launch
  if launch is monthly-only.

## Front-end stubs added (Final-CTA "three paths") — need backend to transact
The Final CTA was rebuilt into three real paths (`#final`, the `#cart-panel` drawer, and a
new "How it works" popup). The UI is done; these are **front-end stubs** with cosmetic
confirmations (consistent with the pre-existing save-build + kit stubs) and need wiring:
- **Membership signup** ("Start membership" → drawer in membership mode, $19.99/mo): submit shows
  the success view but does **not** charge or persist. No membership Stripe price ID exists
  (`_lib/stripe.mjs` only maps stain / stain-mech). Needs a membership price + a checkout/lead path.
- **Add a care kit** ($49.99 one-time, in membership mode): a UI add-on only — no kit SKU/price on
  the server, not added to any real cart line, never sent to Stripe.
- **Email my cart to myself** (drawer secondary action): validates the email and shows a
  confirmation, but sends nothing. Wire to a `create-lead`-style Function to actually email the cart.
- Note: the cart is still single-plan (Decision 3); "email your cart" / membership+kit assume a
  multi-line cart that doesn't exist yet.
- **Membership T&C popup** (`#memterms-modal`): full Repair-Membership terms in a scrollable modal,
  opened by "See membership details" + the drawer's membership T&C link. ⚠️ Contains placeholders to
  fill before launch: `[Insert Date]`, `[Insert support email]`, `[Insert phone number]`,
  `[Insert mailing address or support URL]`. Protection-plan T&C links are separate and still
  `href="#"` (different product's terms — not yet supplied).
- Kit price is **$49.99** across the kit cards + the membership-mode add-on (display only; no SKU).

## Verification gates (keep green)
- `node --check netlify/functions/**/*.mjs` and `npm run build` (exit 0).
- Front-end has no committed test suite; a throwaway jsdom regression harness was used during dev
  (cart sync, persistence, CTAs, relocation, badge). It lived in the OS temp dir and is **not
  committed** — re-create equivalents if you want CI coverage. jsdom can't verify paint/layout;
  eyeball visual changes (checkout drawer, `#compare` cards, dashboard lead-in seam) in a browser.
- Edit **source `index.html`**, then `npm run build`. Never edit `dist/` by hand. No browser-side
  Supabase key — all DB writes go through Functions with the service_role key + server validation.

---

## Arquitectura: el "shape" standalone + contrato de extracción (2026-06)

El repo está organizado para crecer a **piezas standalone** sin romper el deploy. Tres tipos de pieza:
- **`packages/core` (`@furnfx/core`)** — núcleo reutilizable. Hoy: el design system (`styles/core.css`).
  Fase B: el JS compartido (carrito/checkout/pricing). Sin secretos, sin dominio hardcodeado.
- **`apps/*`** — front por variante/dominio (d2c, kiosk, …), generado por **build** desde una fuente única +
  el core. Hoy: d2c = `index.html` (raíz); kiosk = la misma fuente + `class="kiosk"` horneada → `dist/kiosk.html`.
  `apps/kiosk/netlify.toml` = template de deploy del kiosk como site propio.
- **`api/` (hoy `netlify/functions/`)** — backend, alcanzable por la costura **`/api/*`** (rewrite en `netlify.toml`).
  El front llama `/api/...`, nunca la ruta física → API relocatable cambiando el rewrite.

**Las costuras que dan los "límites" YA existen** (no hay que mover carpetas para tenerlas): (1) `/api/*`,
(2) el build de fuente única, (3) el paquete `@furnfx/core`. Lo que falta para extracción limpia es el **JS en
core (Fase B)**; por eso el orden es: Fase B primero, mudanza estructural (workspaces/`apps`/`api`) después.

**Sacar una variante a su propio repo** (cuando haga falta): mover `apps/<x>/` + cambiar la dependencia de
`@furnfx/core` (local → versión publicada) + su `netlify.toml` proxea `/api/*` al backend. Cero cambio de código.

## Harness de regresión — `tools/gate/` (formaliza los gates de arriba)

Refactor PURO = el `dist` no cambia de comportamiento. El oráculo es el **hash NORMALIZADO** (CRLF→LF, válido en
Windows local y en el CI Linux) de `dist/index.html` contra `tools/gate/baseline.d2c.sha256`.

```bash
npm run gate            # corre todos los gates; GREEN = sin regresión (exit 1 si algo falla)
npm run gate:baseline   # recaptura el baseline — SOLO al cambiar comportamiento a propósito (commit revisado)
```
Gates: G1 build · **G2 d2c === baseline (oráculo)** · G3 kiosk horneado · G4 CSS inyectado · G6 `node --check`
de las functions · G7 `netlify.toml` intacta · G8 copy-set de dist · **G13 paridad de pricing monthly** ·
**G14 guard CA-4** (`tools/gate/ca4.test.mjs` — el server exige nº orden / tipo de mueble). (G5/G9 de
workspaces se agregan en Fase B.)
**Regla de oro:** durante un refactor puro el diff de `baseline.d2c.sha256` debe ser **cero**; si G2 se pone
rojo, es una regresión a investigar — NO recapturar el baseline.
