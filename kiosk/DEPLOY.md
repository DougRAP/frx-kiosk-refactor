# Furniture-Rx — Kiosk (in-store) · self-contained folder

The **kiosk** version for the in-store dealer / sales associate. It's a **self-contained static
front end**: everything it needs lives in this folder. It has **no** build, **no** npm, and runs
**no** functions of its own — the backend (Stripe, accounts, chat) is **central** and `/api/*` is
proxied to it (see `netlify.toml`). It sells **subscription only** (the dealer already has their
regular plan); it captures the **ASC sales order #**, **sales associate #**, and **delivery date**,
and hands off payment via **QR code / email**.

## Editing (Doug)
Open `index.html` and edit it directly — HTML + `<style>` + one IIFE, all inline. Kiosk mode is
baked in with `class="kiosk"` on the `<html>` element (no need for `?kiosk=1`). Save and you're
done; there is no build step.

```
kiosk/
  index.html          # the kiosk front end (editable)
  qrcode.min.js        # QR library (payment handoff)
  kit_assets/          # care-kit images
  terms/index.html     # T&C (the "/terms/" link opens this)
  netlify.toml         # publishes this folder + proxies /api/* to the central backend
  DEPLOY.md            # this file
```

## Deploy as its own site (separate from the D2C)
In Netlify: **Add new site → Import from Git** (this repo) →
- **Base directory:** `kiosk`
- **Build command:** *(empty)* — it's static
- **Publish directory:** `.`
- **Domain management:** add `kiosk.furniturerx.net` (or your kiosk domain).

> Live today at **kioskrx.netlify.app**. For the custom domain, point a **CNAME** record for the
> `kiosk` subdomain to **`kioskrx.netlify.app`** (the kiosk site — NOT the main site), then let
> Netlify provision HTTPS. A domain can belong to only one Netlify site, so remove it from any
> other site first.

## Backend config (once, on the CENTRAL site — not here)
1. `/api/*` proxy → backend: **CONFIRMED** pointing at `https://furniturerx.netlify.app/.netlify/functions/:splat`
   (verified: the function responds through the rewrite). Only change it if the backend moves hosts.
2. On the backend, add the **kiosk origin** to `ALLOWED_ORIGINS` (CSV) → otherwise the kiosk
   checkout returns to `SITE_URL` (the main site) instead of the kiosk. Minimum current value:
   `ALLOWED_ORIGINS = https://furniturerx.netlify.app,https://kioskrx.netlify.app`
   (add `https://kiosk.furniturerx.net` once the domain is live). Then **redeploy the main site**.
3. No secrets are needed in THIS folder. On the central backend, the **single-QR handoff** (the customer
   scans one QR and uploads the receipt + pays on their phone) reuses the existing `DASHBOARD_LINK_SECRET`
   to sign the opaque handoff token — confirm it's set. It also needs the migration
   `20260701130000_kiosk_handoffs.sql` applied and the endpoints `/api/kiosk-handoff` +
   `/api/kiosk-handoff-complete` deployed (both live in the central backend). The old on-tablet dropzone
   stays as a "Pay on this tablet" fallback.

## Status
This kiosk deploys **only** as its own site (`kioskrx.netlify.app`, and `kiosk.furniturerx.net`
once DNS is set). The main site no longer serves the kiosk — the old build "bridge"
(`dist/kiosk.html`) and the kiosk-subdomain rewrite in the root `netlify.toml` were removed, so the
kiosk now lives in exactly one place.

> This folder **replaces** the old `apps/kiosk/` seam (which assumed the monorepo build,
> `publish=dist`). `apps/kiosk/` is obsolete and can be deleted.
