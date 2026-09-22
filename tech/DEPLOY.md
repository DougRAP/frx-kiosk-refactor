# Deploy — FurnitureRx TECH version

El front del técnico en casa del cliente: **care kits + Repair Membership** (sin protection
plans). Carpeta estática y autocontenida, mismo patrón que `kiosk/`.

## Pasos (una vez)

1. Netlify → **Add new site → Import from Git** (este mismo repo).
2. Build settings: **Base directory `tech`**, build command vacío, **Publish directory `.`**.
3. Domain management → el dominio del tech (p. ej. `tech.furniturerx.net`).
4. **Backend central**: añadir el origin del site tech (p. ej. `https://tech.furniturerx.net`)
   a la env `ALLOWED_ORIGINS` del site principal → el checkout devuelve success/cancel al
   front tech y el `/p/<code>` teclea el mismo dominio.
5. Nada más: `/api/*` y `/p/*` se proxean al backend central vía `netlify.toml` (un solo
   webhook de Stripe, un solo set de secretos).

## Qué tiene de especial este front

- `source:'tech'` viaja en el checkout → el server activa **trial de 90 días** en la Repair
  Membership (TECH-2a; solo membership sin planes: un source forjado no regala nada más).
- **Technician ID** (pre-asignado, "so you get credit") y **Work order number** (o referencia
  interna en ventas solo-kit) son SIEMPRE visibles y el server los exige (`kiosk:true`).
- Maya corre en modo TECH (`context:'tech'`): Q&A de kits/membership, sin guion de captura.
- Ways to pay: pay on this device / QR / email (sin el handoff de recibo: aquí no hay recibos).

## Actualizaciones

Editar `tech/index.html` directamente (Doug puede). El espejo `dist/tech/` se mantiene con
`Copy-Item tech\index.html dist\tech\index.html` (gate estático lo vigila), igual que el kiosk.
