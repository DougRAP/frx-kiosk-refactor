# CLAUDE.md

Guidance for Claude Code when working in this repository. Refreshed 2026-09-22 against the actual
tree (the previous version described a much smaller, single-front app and is superseded).

## What this is

**Furniture-Rx / FurnitureRx** — a per-item furniture protection program ("Second Chance", *Powered
by RAP*) plus care kits and a Repair Membership. It is a **family of static front-ends** sharing
**one central Netlify Functions backend** (Stripe + Supabase + an Anthropic-powered assistant,
"Maya").

Five surfaces, each deployed as its **own Netlify site** but living in this one repo:

| Surface | Source | Deploy | Sells |
|---|---|---|---|
| **D2C** (main site) | `index.html` → `dist/` | root, `npm run build` | plans, kits, membership |
| **Kiosk** (in-store dealer) | `kiosk/` | own site, base `kiosk`, no build | subscription only; QR/email payment handoff |
| **Tech** (technician in-home) | `tech/` | own site, base `tech`, no build | care kits + Repair Membership (90-day trial via `source:'tech'`) |
| **Portal** (dealer/admin app) | `portal/` | own site, base `portal`, no build | authenticated back-office, no checkout |
| **testingApp** (QA wizards) | `testingApp/`, generated | static | nothing — manual QA scripts |

The kiosk/tech/portal folders are **self-contained and Doug-editable** (HTML + inline `<style>` +
one IIFE, no build). They reach the backend through the **`/api/*` seam** — a 200-rewrite in each
folder's `netlify.toml` pointing at the central backend, so the API can move hosts without touching
a front-end. Only the D2C goes through `scripts/build.mjs`.

**Git**: <https://github.com/DougRAP/frx-kiosk-refactor>, branch `main`. Current scope (Doug,
Sep-2026): styling changes to `kiosk/index.html` + the new plan T&C at `kiosk/terms/index.html`,
previewed on a separate Netlify site, then handed to Adrian (dev) to make it work end-to-end.

## Kiosk refactor, Sep-2026 (Doug) — decisions already made, do NOT change without asking Doug

Work lives in `kiosk/index.html` + `kiosk/terms/index.html` only (plus the same terms copied to
`terms/Furniture-Rx-Protection-Plan-Terms.html`). Previewed on its own Netlify site (base dir `kiosk`,
no build, publish `kiosk/`). It is a **front-end preview**: nothing server-side was changed.

**Decided and shipped** (see `git log` from `8509573` on for the detail of each):
- **Terms**: one T&C for all plans, form `FURNRX_SUBSCRIPTION_ALL_GS_2026`, plain HTML on the kiosk tokens,
  no JS. Served at `/terms/`. Legal text is verbatim — never edit wording without Doug.
- **Plan cards**: left = **Mattress & Bed Base $19.99/mo** (key `stain`), right = **Home Furnishings
  $24.99/mo** (key `stain-mech`). Internal keys unchanged on purpose. One Subscription covers every
  category of its card; the $5,000 retail limit controls risk (Doug rejected per-category pricing).
- **Card content**: "Covers …" line under the price, summary bullets, "Repair Safety Net included —
  learn more", "Compare coverage →" link. Removed: "Monthly plan" tag, "We repair first", "24/7 claim filing".
- **Size rule**: plan cards must not get taller than the original 877px (desktop). Currently 874px with
  the item lists closed. Drop optional lines before growing the cards.
- **"Compare coverage" popup**: 11 damage rows × 6 categories, reuses the `.terms-modal` shell. Phones:
  Mattress | Home Furnishings switch. Built from a summary of the T&C (2 footnotes + link to /terms/).
- **"What are you covering?" picker** replaced the Maya box on the cards: chips (≥1 always on, first one
  preselected) + optional `<details>` item checklists for Furniture (12 items) and Outdoor (9). **Never
  changes price.** State in `localStorage['furnfx_cover']`. Chip keys = server `PIECE_TYPES`.
- **Maya**: off the cards. Floating bubble kept (general Q&A). Checkout has "Anything else we should know?
  Tell Maya →" which opens a new coverage conversation seeded with the cart; chat sits above the checkout
  (z 130) and has its own ×.
- **Plans heading**: "Protect Your New Furniture or Mattress<br>*Starting at $19.99/Month*"; subheading
  `.compare-sub` "Cancel, pause or upgrade anytime." (Doug: restart in the T&C = pause; keep the wording).
  Below the cards: "Please read terms & conditions" → `/terms/`. The old eligibility fine print was removed.
- **Page**: all eyebrows / eyebrow-style labels removed; dashboard login moved to the header
  (`.nav-login`, "Log in" on phones); section spacing tightened (`--sp-section` 40–64px); mobile overflow
  fixed at 360–414px (grid `minmax(0,1fr)`).
- **Kept**: every Repair Safety Net / membership **$19.99** price (different product from the plans).

**For Adrian (not done — front-end only so far):**
- Server still charges $9.99 / $19.99 (`_lib/validate.mjs` `PRICE_CENTS`, Stripe price IDs). Kiosk shows
  $19.99 / $24.99. `GIFT_CENTS` in the kiosk is a display mirror only.
- Checkout `plans[]` now also sends `types` (all picked categories, + `lighting` when Lamps is checked) and
  `items` (per category). The server ignores them today; it still reads the single `type` (= first chip).
- Add the kiosk preview origin to `ALLOWED_ORIGINS` if checkout should work there. The kiosk proxies
  `/api/*` to the LIVE backend (`kiosk/netlify.toml`).

**Open, for the fine-tuning pass (ask Doug before doing):**
- Item lists: keep the checkbox checklist or switch to small chips (Doug unsure).
- Checkout fine print still says "within the last 60 days"; the new T&C say within 30 days of delivery.
- `#kits` Checkout button is cut off ~50px at 768px (tablet), pre-existing.
- 320px (2016 iPhone SE) still overflows (Save/Checkout pair, header) — Doug declined that fix.
- Plan cards order (Mattress left) vs heading order ("Furniture or Mattress") — offered, not decided.
- `tools/tests/static.test.mjs` crashes at the end reading `dist/kiosk/index.html` (pre-existing: the
  build stopped emitting it). All its assertions before that line pass.

**Workflow used**: edit → headless Chrome check (`playwright-core`, `channel:'chrome'`) at 1440/768/390/360
→ `npm run gate` (must be GREEN) + `node tools/tests/kiosk-dom.test.mjs` → commit → push (Netlify redeploys).
Plan with Doug first, no code until he agrees.

## Layout

```
index.html                     # D2C front-end (markup + <style> + one IIFE) — the build's only source
account.html                   # real customer account: login (AUTH-1/2) + tokenized ?t= view
dashboard.html                 # legacy URL → JS redirect to account.html (kept alive on purpose)
dashboard-demo.html            # static mock, NOT published by the build
terms/                         # combined protection-plan T&C → served at /terms/
packages/core/styles/core.css  # shared design system, injected inline at build time
kiosk/ tech/ portal/           # standalone fronts, each with its own netlify.toml + DEPLOY.md
testingApp/                    # generated QA wizards (d2c, kiosk, tech, portal)
scripts/build.mjs              # D2C build: inject core.css → dist/, copy account/dashboard/terms/kits
netlify/functions/             # ~48 functions + 20 _lib modules (esbuild bundler)
supabase/migrations/           # 33 migrations
tools/                         # test harness, gates, e2e, live smoke, seeds, generators
dist/                          # build output, gitignored, published by the main site — never edit
```

`.gitignore` also excludes `misc/` and `docs/` — specs referenced in code comments (e.g.
`misc/spec-sec1-dotfiles.md`) are **local-only**, so don't expect them in a clone.

## Build / run / verify

```bash
npm run build          # → dist/ (D2C). Re-run after editing index.html.
netlify dev            # local w/ Functions, serves dist/ on http://localhost:8888
npm test               # 42 node test files in tools/tests/ (jsdom + stubs), run isolated per file
npm run gate           # the regression gates G1–G22 — GREEN required
npm run test:e2e       # 10 playwright-core e2e scripts (kiosk, account, d2c, tech, subportal, …)
npm run smoke:live     # live smoke against the deployed sites (needs real env)
```

There **is** a real test suite and gate harness (the old CLAUDE.md claimed there wasn't).

### The gate harness — `tools/gate/gate.mjs`

The oracle for "pure refactor" is a **normalized hash** (CRLF→LF, so Windows == Linux CI) of
`dist/index.html` vs `tools/gate/baseline.d2c.sha256`.

- **G2 is the oracle**: during a pure refactor the baseline diff must be **zero**. If G2 goes red,
  that's a regression to investigate — **do not** recapture the baseline.
- `npm run gate:baseline` only when behavior changed **on purpose**, in a reviewed commit.
- Other gates encode invariants worth knowing before you edit: G1 build · G3 kiosk self-contained ·
  G4 core.css injected · G6 `node --check` all functions · G7 `netlify.toml` contract · G8 dist
  copy-set · **G13** monthly pricing parity · **G13b** Maya quotes no yearly price · **G14** CA-4
  required-data guard · G15 `sales_associate` attribution · G16 single-QR handoff · **G17** no site
  serves `.env` · **G18** rate limiter degrades without fail-open, limits per account · **G19**
  temp-password expiry enforced server-side · **G20** service-request ownership · **G21** CSV
  injection neutralized · **G22** commission transfer claimed atomically (no double pay).

Those SEC/G-gates came from security audits. Breaking one re-opens a real finding — treat a red
SEC gate as a security regression, not a flaky test.

## Front-end (`index.html`, and by inheritance the other fronts)

**Design system** — CSS custom properties, source of truth is `packages/core/styles/core.css`,
injected inline into `index.html` at the `/*__CORE_CSS_INJECT__*/` marker (no extra request).
Colors `--paper*`/`--ink*`/`--navy-deep`/`--orange`/`--gold`/`--scarlet`; type `--display` (Fraunces)
+ `--body` (Inter); spacing/animation via `clamp()` + `--t-*`/`--ease`. The **signature gesture is a
4px orange left rim** (`--rim`) — preserve it when restyling cards. Reuse tokens, don't hardcode.

Sections top → bottom: hero + configurator · `#compare` (the two cart-driven monthly plan cards,
legal fine print under the grid) · trust banner · dashboard lead-in · dashboard mock · `#faq` ·
`#kits` · `#membership` · `#refer` · `#final` · chat widget · cart drawer · footer.

### The cart system (most important front-end subsystem)

Single source of truth, device-local, drives the hero and both `#compare` cards:

- `savedItems[]` — lines keyed by **`cov + term`** (`type` is a mutable label, NOT identity).
  Helpers `findLine` / `cartCount` / `cartAdd` / `cartSet`; every mutator calls `persistCart()`.
- Care kits are a **separate** one-time-product cart (KIT-3), plus a membership line
  (`MEMBERSHIP_KEY`, `MEMBERSHIP_PRICE = 19.99`).
- **Hero stepper is LIVE** — `setCount()` writes the cart on every +/-. Editing a `#compare` card
  edits the same line and calls `reflectToHero()`, which switches the hero toggle to that card.
- **True zero**: an empty cart shows `0 plans · $0.00` (deliberate, chosen over a 1-plan preview).
- **`MAX_COUNT = 99`** (Doug 18-jun, CART-1.2 "buy any number"; was 2). The old
  ">cap → request a quote" path is **dormant**, not deleted. Server mirror is `MAX_PLANS = 99`.
- **Persistence**: `localStorage['furnfx_cart']`. `loadCart()` validates untrusted input (drops
  unknown cov/term, clamps count, recomputes price, dedupes). Cleared on Stripe return (`?paid=1`).
  `CART_KEY`/`KNOWN_COV` are assigned *above* the `loadCart()` call on purpose — `var` hoists the
  declaration, not the value (a hoisting bug was already fixed here; don't "tidy" them upward).
- Eligibility window mirrors: `ELIG_DAYS = 60` / `HORIZON_DAYS = 90`.

## Pricing — product rules; keep ALL sources in sync

**Monthly $9.99 (stain) / $19.99 (stain + structure)** is the only fully-wired tier and is
consistent everywhere. Gate **G13** enforces that parity. When touching ANY price, audit:

- `index.html` `PLANS` (display): monthly 9.99/19.99 ($5k limit), year1 129.99/259.99 ($7.5k),
  year3 249.99/449.99 ($10k) — plus hardcoded `$9.99`/`$19.99`/`$5,000` in markup and FAQ.
- `_lib/validate.mjs` `PRICE_CENTS` — **server canonical**: `stain: 999`, `stain-mech: 1999`.
  Header says do not duplicate; the server always recomputes, never trusts a client amount.
- Kit prices are **not** in code — recomputed server-side from `care_kits.price_cents`.
  `KIT_SKUS` = `CARE-WOOD-001` / `CARE-FABRIC-001` / `CARE-LEATHER-001`, `MAX_KIT_QTY = 20`.
- Stripe price IDs by env: `STRIPE_PRICE_STAIN`, `STRIPE_PRICE_STAIN_MECH`,
  `STRIPE_PRICE_MEMBERSHIP`, `STRIPE_PRICE_MEMBERSHIP_FREE`.
- `chat.mjs` SYSTEM: Maya may state **monthly only** (9.99/19.99, $5k). She stopped quoting yearly
  on 01-jul (the numbers had diverged and yearly isn't purchasable) — locked by **G13b**.

**Yearly is display-only.** The server rejects `term !== 'monthly'` with `term_not_supported`; no
yearly Stripe price is wired. Whether yearly stays display-only or is killed is still pending Doug.

**SKU-not-Type (Doug 15-jul, PORT-15)**: plans are ALL-IN-ONE across categories. The universal key
is the **Plan SKU** = server tier (`stain` | `stain_mech`), which drives pricing, **commission**
($2/$8 per payment received, split Stripe/reinsurance per dealer in `commission_rates`) and the
**T&C version** (`plan_terms`). `covered_pieces.type` is INFORMATIVE (receipt/merch data), never a
coverage or claims gate — in 5star the customer can claim any type. **Do not build restrictions on
`type`.** `PIECE_TYPES` (both sides) = `furniture/outdoor/adjbed/mattress/rugs/lighting`.
`MAX_PIECES = 99` — pieces are unlimited by product decision (Doug 06-jul); the cap is defensive.

## Backend (Netlify Functions)

All DB writes go through Functions using the Supabase **service_role** key with server-side
validation. The browser has **no** Supabase key — never re-add direct client writes.

Roughly grouped:

- **Checkout / payment**: `create-checkout-session`, `create-lead`, `create-gift-checkout`,
  `checkout-status`, `pay-redirect` (the typeable `/p/<code>` short link), `stripe-webhook`,
  `create-portal-session`, `get-billing`, `email-cart`, `upload-receipt`.
- **Customer account**: `account-me`, `account-view` (hashed-token `?t=` view), `get-my-account`,
  `auth-login`, `auth-otp`, `auth-set-password`, `update-profile`.
- **Kiosk / sales mode**: `kiosk-handoff`, `kiosk-handoff-complete` (single-QR receipt + phone
  payment), `sales-mode-redirect` (`/s/<code>`), `referral-validate`.
- **Portal** (~20 `portal-*`): subscribers, customer record, plans, plan-terms, commissions,
  reconciliation, exports, kit-orders, service-requests, resources, resellers, inquiries, audit,
  dealer status/admin/login-action, referral codes, stats, Stripe onboard,
  `stripe-onboarding-redirect` (the durable `/stripeOnboarding/<code>` link), `portal-app-handoff`,
  `portal-app-redeem`.
- **Assistant**: `chat.mjs` — Anthropic SDK, model **`claude-haiku-4-5-20251001`** (swapped from
  opus, Doug 25-jun "mostly summarizing"; haiku has no `effort`, so it was removed). Grounded system
  prompt + server-side tool loop: `quote_estimate` (deterministic 10%-of-retail, computed in code,
  not by the LLM) and `save_quote_lead`. `context:'tech'` → Q&A mode, no tools. No
  `ANTHROPIC_API_KEY` → `{error:'no_key'}` and the browser keeps its canned fallback.
- **`_lib/`** (20 modules): `validate` (single source of checkout validation + pricing), `stripe`,
  `supabase` (service_role PostgREST + GoTrue, no SDK), `auth`, `account`, `checkout`, `commissions`,
  `connect`, `coverage-policy`, `email`, `gift`, `onboarding`, `portal`, `ratelimit`, `referral`,
  `shortcode`, `stats`, `temppw`, `terms`, `token`.

### netlify.toml contract (root site)

Guarded by G7/G17 — read the comments before changing: `/api/*` → functions (the relocatable seam;
the Stripe webhook deliberately bypasses it to keep the raw signature intact) · `/login` and
`/dashboard` → `account.html` · `/p/*`, `/s/*`, `/stripeOnboarding/*` short links · forced 404 on
`/.env*` (SEC-1) · security headers incl. a CSP that allows only Google Fonts and Supabase Storage.

**Env vars** (Netlify, never in repo — see `.env.example`): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four
`STRIPE_PRICE_*`, `ANTHROPIC_API_KEY`, `DASHBOARD_LINK_SECRET`, `RATE_LIMIT_SALT`, `SITE_URL`,
**`ALLOWED_ORIGINS`** (CSV — every front's origin must be listed, or its checkout can't return to
itself; adding a new front means editing this). Optional windows: `ELIGIBILITY_WINDOW_DAYS` (60) +
`DELIVERY_HORIZON_DAYS` (90) gate the checkout `date` (`date_out_of_range`) and are mirrored by the
fronts' `ELIG_DAYS`/`HORIZON_DAYS` + input min/max + visible "60 days" copy — changing the window
means the env var **and** those consts. `TEMP_PASSWORD_TTL_DAYS` (7, SEC-3a) is how long the welcome
email's temp password works; `_lib/temppw.mjs` owns the rule, `auth-login` refuses past the window
(401 `temp_password_expired`) and `requireUser` returns 403 `password_change_required` while
`must_change_password` is set, so the mandatory change is server-enforced, not just `account.html`.
`auth-otp` is deliberately left open as the recovery path. `0` disables expiry without a deploy.

## Known gaps / WIP (don't "fix" these blindly)

- **Yearly is display-only** — rejected server-side; no Stripe price. Kill-or-keep pending Doug.
- **Checkout/drawer is effectively single-plan** — `validateCheckout` accepts a mixed
  `plans[] + kits[]` body, but the D2C drawer still rings the hero's current line rather than a
  true multi-line cart.
- **Header cart badge** counts distinct lines, not total plans.
- The `>MAX_COUNT → request a quote` path is dormant since the cap went to 99.
- Some front-end CTAs remain **stubs** (see `DEV-NOTES.md`): membership add-on flows, "email my
  cart", and the membership T&C modal still holding `[Insert …]` placeholders.
- `misc/`, `docs/` and `dist/` are gitignored, so comment references to specs in `misc/` won't
  resolve in a fresh clone.

`DEV-NOTES.md` is the punch list of open business decisions; it predates some of what shipped
(notably the caps and the test harness) — trust code and gates over it where they disagree.

## Conventions

- Dynamic text uses `textContent`/`createTextNode`, never `innerHTML` with dynamic/user input
  (the CSP relies on this).
- Edit **source** `index.html`, never `dist/index.html`; run `npm run build` after.
- The standalone fronts (`kiosk/`, `tech/`, `portal/`) are edited **directly** — no build, and they
  intentionally diverge from the D2C. Don't "unify" them into the build without a decision.
- Code comments are mixed English/Spanish by history. Match the file you're in.
- Before finishing any change: `npm run gate` (and `npm test` when touching functions or fronts).
