/* Build del sitio estático: copia index.html + kit_assets a dist/ (lo que se publica).
 * Cross-platform (Node) → funciona igual en Windows local y en el CI de Netlify (Linux).
 * Solo crea/sobrescribe; no borra nada. */
import { mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync('dist', { recursive: true });

/* ── D2C desde fuente único + fronts STANDALONE ────────────────────────────────────────────────
 * index.html (d2c) + el design system compartido (packages/core/styles/core.css): renderVariant()
 * inyecta el CSS en el marcador del <style> (queda inline → sin request extra). d2c usa transform
 * identidad → dist/index.html BYTE-IDÉNTICO al original. El replacer del CSS es una función para no
 * interpretar `$` del CSS como patrón de reemplazo.
 * El KIOSK ya NO se genera aquí: es un front STANDALONE (kiosk.html en la raíz) que el build solo
 * COPIA — decisión 01-jul (3 fronts separados y editables por Doug, sin flag-soup). Divergirá del d2c
 * a propósito; trae su class="kiosk" horneada y el CSS ya inline. */
const SRC = readFileSync('index.html', 'utf8');
const coreCss = readFileSync('packages/core/styles/core.css', 'utf8');
function renderVariant(transform) {
  const withCss = SRC.replace('/*__CORE_CSS_INJECT__*/', () => coreCss);
  return transform ? transform(withCss) : withCss;
}

// d2c (raíz) — sin transform → idéntico al original
writeFileSync('dist/index.html', renderVariant());

// kiosk (KIOSK-1) — NO se emite a este dist/. Es un front AUTOCONTENIDO en /kiosk/ que deploya como SITE
// PROPIO (su propio netlify.toml + /api proxeado al backend central; ver kiosk/DEPLOY.md). Este dist (el
// site principal) sirve SOLO el d2c + las páginas de cuenta → el kiosk vive en UN solo lugar, sin duplicarse.
// La lib del QR (qrcode.min.js) es SOLO del kiosk (carga on-demand en modo kiosk) → tampoco va acá; ya vive
// en /kiosk/qrcode.min.js y el d2c nunca la pide.
copyFileSync('dashboard.html', 'dist/dashboard.html');   /* página de cuenta post-login */
copyFileSync('account.html', 'dist/account.html');       /* dashboard SIN login (token hasheado) — account-view.mjs */
mkdirSync('dist/terms', { recursive: true });            /* T&C combinado (TNC-1) servido como página propia en /terms/ */
copyFileSync('terms/Furniture-Rx-Protection-Plan-Terms.html', 'dist/terms/index.html');  /* link "read before you buy" abre /terms/ en pestaña nueva */
cpSync('kit_assets', 'dist/kit_assets', { recursive: true });
console.log('build: dist/index.html (d2c) + dist/dashboard.html + dist/account.html + dist/terms/index.html + dist/kit_assets ready · kiosk = deploy propio en /kiosk/');

/* SEC-1 (auditoría 28-jul): dist/ se publica TAL CUAL y este build nunca borra, así que un .env de un
 * build viejo puede seguir ahí sin que nadie lo vea. Solo AVISA (no falla, no borra: los borrados los
 * hace Adrian a mano). En el CI no imprime nada porque dist/ se construye limpio. La defensa que sirve
 * aunque el archivo llegue al deploy es la regla /.env de netlify.toml. Spec: misc/spec-sec1-dotfiles.md. */
const strayEnv = (dir) => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? strayEnv(join(dir, e.name)) : /^\.env/.test(e.name) ? [join(dir, e.name)] : []);
const stray = strayEnv('dist');
if (stray.length) console.warn(`build: AVISO SEC-1 — dist/ contiene ${stray.join(', ')} (residuo local; dist se publica tal cual). Netlify lo bloquea con la regla /.env, pero conviene quitarlo a mano.`);
