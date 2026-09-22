/* ============================================================================
 * SEC-1 — los sitios estáticos NUNCA sirven un .env  (spec: misc/spec-sec1-dotfiles.md)
 *
 * Hallazgo 1 de la auditoría 28-jul: kiosk/ y tech/ se publican con `publish = "."` y
 * contienen un .env con TODOS los secretos del backend (service_role, Stripe, Anthropic).
 * Hoy no están expuestos (no están en git y el deploy es desde Git), pero un `netlify deploy`
 * manual desde esas carpetas los publicaría en /.env.
 *
 * Este candado verifica la defensa que SÍ funciona aunque el archivo llegue al deploy:
 * una redirección FORZADA (force = true gana sobre el archivo estático) que responde 404.
 *
 * NO borra ni exige que los .env desaparezcan: quitarlos es un paso manual de Adrian
 * (regla del proyecto). Este test protege el camino de servicio, no el sistema de archivos.
 * ==========================================================================*/
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeT } from './helpers.mjs';

const t = makeT('sec1-dotfiles');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/* Mini-parser de bloques [[redirects]]: evita el falso positivo de un `includes()` suelto
 * (from y status podrían vivir en bloques DISTINTOS y el substring pasaría igual). */
function redirectBlocks(toml) {
  return toml.split(/\[\[redirects\]\]/).slice(1).map((chunk) => {
    const stop = chunk.search(/^\s*\[/m);                 // corta en la siguiente sección TOML
    const body = stop >= 0 ? chunk.slice(0, stop) : chunk;
    const get = (k) => {
      const m = body.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.+?)\\s*$', 'm'));
      return m ? m[1].replace(/^["']|["']$/g, '') : null;
    };
    return { from: get('from'), to: get('to'), status: get('status'), force: get('force') };
  });
}

/* Una regla protege `path` si lo captura, responde 404 y es forzada (gana al archivo). */
const blocks = (toml, path) => redirectBlocks(toml)
  .some((b) => b.from === path && b.status === '404' && b.force === 'true');

/* ---- AC1 + AC2: los 4 sitios bloquean /.env y sus variantes ---- */
const SITES = [
  ['netlify.toml', 'site principal (publish dist)'],
  ['kiosk/netlify.toml', 'kiosk (publish .)'],
  ['tech/netlify.toml', 'tech (publish .)'],
  ['portal/netlify.toml', 'portal (publish .)']
];
for (const [file, label] of SITES) {
  const toml = read(file);
  t(!!toml, `${label}: ${file} existe`);
  t(blocks(toml, '/.env'), `${label}: bloquea /.env con 404 forzado`);
  t(blocks(toml, '/.env*'), `${label}: bloquea /.env* (variantes .env.local/.production/.bak)`);
}

/* El site principal publica dist/, donde quedó residuo de un build viejo (dist/kiosk/.env). */
{
  const root = read('netlify.toml');
  t(blocks(root, '/kiosk/.env*'), 'site principal: bloquea /kiosk/.env* (residuo de dist)');
  t(blocks(root, '/tech/.env*'), 'site principal: bloquea /tech/.env* (residuo de dist)');
}

/* ---- AC3: no se rompió el contrato de deploy existente ---- */
{
  const root = redirectBlocks(read('netlify.toml'));
  const kiosk = redirectBlocks(read('kiosk/netlify.toml'));
  const api = (bs) => bs.find((b) => b.from === '/api/*');
  t(api(root) && api(root).to === '/.netlify/functions/:splat' && api(root).status === '200',
    'site principal: el proxy /api/* sigue intacto');
  t(kiosk.some((b) => b.from === '/p/*' && b.status === '200'),
    'kiosk: la URL corta /p/* sigue intacta');
  t(kiosk.some((b) => b.from === '/s/*' && b.status === '200'),
    'kiosk: la sales-mode URL /s/* sigue intacta');
  /* Las reglas de .env no pueden quedar DESPUÉS de un catch-all que las capture antes. */
  for (const [file, label] of SITES) {
    const bs = redirectBlocks(read(file));
    const firstEnv = bs.findIndex((b) => b.from === '/.env');
    const catchAll = bs.findIndex((b) => b.from === '/*');
    t(firstEnv >= 0 && (catchAll === -1 || firstEnv < catchAll),
      `${label}: la regla de .env precede a cualquier catch-all`);
  }
}

/* ---- AC4: el .env sigue fuera de git (capa 1, la que hoy nos salva) ---- */
{
  const gi = read('.gitignore');
  t(/^\.env\s*$/m.test(gi), '.gitignore cubre .env (y con ello kiosk/.env y tech/.env)');
  let tracked = '';
  try { tracked = execFileSync('git', ['ls-files'], { stdio: 'pipe' }).toString(); } catch { /* sin git: se omite */ }
  const leaked = tracked.split('\n').filter((f) => /(^|\/)\.env($|\.)/.test(f.trim()) && !f.includes('.env.example'));
  t(leaked.length === 0, `ningún .env versionado${leaked.length ? ' — FUGADO: ' + leaked.join(', ') : ''}`);
}

/* ---- AC5: el build avisa del residuo en dist/ (no falla, no borra) ---- */
{
  const build = read('scripts/build.mjs');
  t(/\.env/.test(build) && /warn/i.test(build), 'scripts/build.mjs avisa si dist/ contiene un .env');
}

t.done();
