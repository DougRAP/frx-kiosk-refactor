# Deploy — FurnitureRx Subscription Portal (fase 1)

App autenticada standalone sobre la familia FurnitureRx. Estática (sin build), backend CENTRAL vía `/api/*`.

## Netlify (site propio)
1. Add new site → Import from Git (este repo).
2. Build settings: **Base directory** `portal`, **Build command** vacío, **Publish directory** `.`.
3. Domain management → `portal.furniturerx.net` (CNAME → el site del portal, mismo patrón que tech).

## Env del backend central (site principal `furniturerx`)
Añadir a **`ALLOWED_ORIGINS`** (preservando lo existente) los dos origins del portal, y redeploy:

```
https://furniturerx.netlify.app,https://kioskrx.netlify.app,https://techrepairrx.netlify.app,https://tech.furniturerx.net,https://portalrx.netlify.app,https://portal.furniturerx.net
```

No hace falta tocar los Redirect URLs de Supabase: el login del portal usa `/api/auth-login` (password grant server-side), no magic links.

## Migraciones a aplicar (SQL Editor de Supabase o `supabase db push`)
- `supabase/migrations/20260713000000_portal_orgs_subentities.sql` (PORT-2)
- `supabase/migrations/20260713010000_reseller_inquiries.sql` (PORT-13)

## Seed de logins de prueba (opcional, para verificar en vivo)
`node tools/seed-portal.mjs` con `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` en el entorno. Crea un admin,
un dealer(owner) y un store(sub) con su `app_metadata` + sus filas en `dealers`/`sub_entities`. Ver el
script para las credenciales sembradas.

## Qué está vivo en esta fase
Landing + login real + shell con el selector cross-world del admin + Dashboard con la identidad real de
`/api/me` + el endpoint público `/api/portal-inquiries`. Las screens de datos (Subscribers, Cust Record,
exports, Stripe, admin) muestran "coming soon" hasta que su endpoint exista (PORT-5 en adelante).
