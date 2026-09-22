/* ============================================================================
 * seed-dealers.mjs — DEAL-2: alta masiva de los dealers de la lista.
 * ----------------------------------------------------------------------------
 * Por cada dealer de la lista (xlsx o csv), de forma IDEMPOTENTE y SIN borrar nada:
 *   1) dealer            (idempotente por alpha_code, único en BD desde DEAL-1)
 *   2) referral code     ALPHA-XXXX, para el link ?ref=
 *   3) sales-mode link   /s/{code} permanente, el que va en su web y en el QR
 *   4) onboarding link   /stripeOnboarding/{code} durable, para conectar el banco
 *   5) login del portal  [alpha]@rapqa.com + contraseña aleatoria distinta por dealer
 *
 * Y deja dos artefactos LOCALES (nunca en git) para repartir:
 *   secrets/dealer-logins.csv     alpha, nombre, email, contraseña, los tres links
 *   secrets/dealer-handout.html   una tarjeta por dealer con su QR, para imprimir
 *
 * Uso (desde la raíz del repo, con .env que tenga SUPABASE_URL + SERVICE_ROLE_KEY):
 *   node tools/seed-dealers.mjs requests/dougAgo162026/Dealers.xlsx
 *   node tools/seed-dealers.mjs lista.csv --rotate     # rota la clave de los que YA existen
 *   node tools/seed-dealers.mjs lista.csv --dry        # no escribe nada, solo dice qué haría
 *
 * SIN --rotate no se toca la contraseña de un login que ya existe: correrlo dos
 * veces no deja a nadie fuera. Con --rotate se regenera (es lo que quiere el primer
 * pase, para que el dealer de demo deje de tener su clave de prueba).
 *
 * La contraseña NO se imprime en consola, solo se escribe en secrets/.
 * ==========================================================================*/

'use strict';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { newShortCode } from '../netlify/functions/_lib/shortcode.mjs';
import { ensureOnboardLink, onboardUrl } from '../netlify/functions/_lib/connect.mjs';

const KIOSK = 'https://kiosk.furniturerx.net';
const PORTAL = 'https://portal.furniturerx.net/';
const EMAIL_DOMAIN = 'rapqa.com';

/* ── Contraseña temporal ────────────────────────────────────────────────────
 * Sin `l I O 0 1`: William dicta estas claves por teléfono y esos cinco son la
 * causa habitual del "no me deja entrar". Quedan 58 símbolos, de sobra para una
 * temporal que además está detrás del rate limit de auth-login (20 / 15 min). */
export const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';

const pick = (set) => set[randomInt(set.length)];

export function genPassword(len = 8) {
  /* Una de cada clase por construcción (que ninguna salga sin dígito por azar) y
     el resto libre; después se baraja para no anclar la clase a una posición. */
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)];
  while (chars.length < len) chars.push(pick(PW_ALPHABET));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/* ── Identificadores derivados del alpha ───────────────────────────────────── */
export const slugFor = (alpha) => String(alpha).toLowerCase();
export const emailFor = (alpha) => slugFor(alpha) + '@' + EMAIL_DOMAIN;
export const rapIdFor = (alpha) => String(alpha).toUpperCase() + '-1001';

export function refCodeFor(alpha) {
  const S = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let sfx = '';
  for (let i = 0; i < 4; i++) sfx += pick(S);
  return String(alpha).toUpperCase() + '-' + sfx;
}

/* ── Lectura de la lista ────────────────────────────────────────────────────
 * Acepta el .xlsx tal cual llega (sin dependencias: un xlsx es un zip con XML)
 * o un .csv de dos columnas. Leer el xlsx directamente evita el paso manual de
 * convertirlo, que es justo donde se pierde un dealer sin que nadie lo note. */

const ALPHA_RE = /^[A-Z]{3}$/;

function decodeXml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* Descomprime un zip leyendo su central directory (lo que hace cualquier unzip). */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('el archivo no es un .xlsx válido (no se encontró el índice del zip)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    out[name] = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function xlsxRows(buf) {
  const files = unzip(buf);
  const ssXml = files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml'].toString('utf8') : '';
  const shared = (ssXml.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) =>
    decodeXml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((x) => x.replace(/<[^>]*>/g, '')).join('')));

  const sheetKey = Object.keys(files).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetKey) throw new Error('el .xlsx no tiene ninguna hoja');
  const sheet = files[sheetKey].toString('utf8');

  const rows = [];
  for (const row of sheet.match(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g) || []) {
    const vals = [];
    for (const c of row.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const type = (c.match(/\st="([^"]+)"/) || [])[1];
      const inline = (c.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = inline !== undefined ? inline : v;
      if (val === undefined) continue;
      if (type === 's') val = shared[Number(val)] || '';
      val = decodeXml(String(val)).trim();
      if (val) vals.push(val);
    }
    /* La columna del alpha se busca por su forma, no por su letra: si mañana la
       lista llega con una columna más a la izquierda, sigue funcionando. */
    const ai = vals.findIndex((v) => ALPHA_RE.test(v));
    if (ai < 0) continue;
    const name = vals.slice(ai + 1).find((v) => v.length > 2);
    if (name) rows.push({ alpha: vals[ai], name });
  }
  return rows;
}

function csvRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(',');
    if (i < 0) continue;
    const alpha = line.slice(0, i).trim().replace(/^"|"$/g, '');
    if (!ALPHA_RE.test(alpha)) continue;          // descarta cabecera y basura
    const name = line.slice(i + 1).trim().replace(/^"|"$/g, '').trim();
    if (name) rows.push({ alpha, name });
  }
  return rows;
}

export function parseDealers(buf, filename) {
  const rows = /\.xlsx$/i.test(filename || '') ? xlsxRows(buf) : csvRows(buf.toString('utf8'));
  if (!rows.length) throw new Error('la lista no tiene ninguna fila con un alpha de 3 letras: ' + filename);
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.alpha)) throw new Error('alpha repetido en la lista: ' + r.alpha);
    seen.add(r.alpha);
  }
  return rows;
}

/* ── Artefactos para repartir ──────────────────────────────────────────────── */

/* Neutraliza fórmulas al abrir el CSV en Excel (mismo criterio que SEC-3c). */
const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
};

export function loginsCsv(rows) {
  const head = ['alpha', 'dealer', 'email', 'password', 'sales_link', 'referral_link', 'stripe_onboarding_link'];
  const body = rows.map((r) => [r.alpha, r.name, r.email, r.password || '(sin cambios)', r.salesUrl, r.refUrl, r.onboardUrl || ''].map(csvCell).join(','));
  return head.join(',') + '\n' + body.join('\n') + '\n';
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function handoutHtml(rows, qrLib) {
  const cards = rows.map((r) => `
  <article class="card">
    <div class="qr" data-url="${esc(r.salesUrl)}"></div>
    <div class="who"><h2>${esc(r.name)}</h2><p class="alpha">${esc(r.alpha)}</p></div>
    <dl>
      <dt>Portal</dt><dd>portal.furniturerx.net</dd>
      <dt>User</dt><dd><code>${esc(r.email)}</code></dd>
      <dt>Password</dt><dd><code class="pw">${esc(r.password || '(unchanged)')}</code></dd>
      <dt>Sales link</dt><dd><code>${esc(r.salesUrl)}</code></dd>
    </dl>
  </article>`).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Furniture-Rx dealer handout</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:#f6f7f9;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111}
  h1{font-size:19px;margin:0 0 4px}
  .lede{color:#555;margin:0 0 20px;max-width:60ch}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
  .card{background:#fff;border:1px solid #dfe3e8;border-left:4px solid #e8630a;border-radius:8px;padding:14px;display:grid;grid-template-columns:104px 1fr;gap:12px;align-items:start;break-inside:avoid}
  .qr{grid-row:span 2;width:104px;height:104px}
  .qr svg{width:100%;height:100%;display:block}
  .who h2{font-size:14px;margin:0;line-height:1.25}
  .alpha{margin:2px 0 0;font-weight:700;letter-spacing:.06em;color:#e8630a}
  dl{grid-column:2;margin:8px 0 0;display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:12px}
  dt{color:#666}
  dd{margin:0}
  code{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
  .pw{background:#fff4e8;padding:1px 4px;border-radius:3px;font-weight:700}
  @media print{body{background:#fff;padding:0}.lede,h1{display:none}.card{border-color:#bbb}}
</style></head>
<body>
<h1>Dealer handout</h1>
<p class="lede">One card per dealer: their sales QR, their portal login and their temporary password.
Hand each card to its dealer. The password is temporary and should be changed on first sign-in.</p>
<div class="grid">
${cards}
</div>
<script>${qrLib}</script>
<script>
(function () {
  /* Mismo render que el portal (PORT-28): SVG, sin red, imprimible. */
  function svg(text, px) {
    var qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    var n = qr.getModuleCount(), quiet = 4, total = n + quiet * 2;
    var cell = Math.max(2, Math.floor((px || 300) / total)), size = cell * total, rects = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c))
      rects += '<rect x="' + ((c + quiet) * cell) + '" y="' + ((r + quiet) * cell) + '" width="' + cell + '" height="' + cell + '"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
  }
  var boxes = document.querySelectorAll('.qr');
  for (var i = 0; i < boxes.length; i++) boxes[i].innerHTML = svg(boxes[i].getAttribute('data-url'), 300);
})();
</script>
</body></html>
`;
}

/* ── Ejecución ─────────────────────────────────────────────────────────────── */

function loadEnv() {
  const env = {};
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('FALTA .env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(2);
  }
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const rotate = args.includes('--rotate');
  const dry = args.includes('--dry');
  if (!file) {
    console.error('Uso: node tools/seed-dealers.mjs <lista.xlsx|lista.csv> [--rotate] [--dry]');
    process.exit(2);
  }

  const list = parseDealers(readFileSync(file), file);
  console.log(`seed-dealers — ${list.length} dealers en ${file}${dry ? '  (DRY RUN: no se escribe nada)' : ''}\n`);

  const env = loadEnv();
  const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
  const call = async (base, path, method = 'GET', body, prefer) => {
    const res = await fetch(env.SUPABASE_URL + base + path, {
      method, headers: { ...H, ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null; const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  };
  const db = (p, m, b, pr) => call('/rest/v1', p, m, b, pr);
  const gotrue = (p, m, b) => call('/auth/v1', p, m, b);
  const fail = (what, r) => { throw new Error(what + ' (' + r.status + '): ' + JSON.stringify(r.data).slice(0, 240)); };

  /* Los usuarios de GoTrue se listan una vez, no uno por dealer. */
  const users = new Map();
  if (!dry) {
    for (let page = 1; page <= 20; page++) {
      const r = await gotrue(`/admin/users?page=${page}&per_page=200`);
      const batch = (r.data && r.data.users) || [];
      for (const u of batch) users.set(String(u.email || '').toLowerCase(), u);
      if (batch.length < 200) break;
    }
  }

  const out = [];
  let created = 0, updated = 0;

  for (const { alpha, name } of list) {
    const slug = slugFor(alpha), email = emailFor(alpha);
    const line = { alpha, name, email, password: null, salesUrl: '', refUrl: '', onboardUrl: '' };
    const notes = [];

    if (dry) {
      const seen = (await db(`/dealers?alpha_code=eq.${alpha}&select=id,name&limit=1`)).data;
      console.log(`  ${alpha}  ${name.slice(0, 42).padEnd(42)} ${seen && seen[0] ? 'ya existe' : 'se crearía'}`);
      continue;
    }

    /* 1) dealer, idempotente por alpha */
    let org = (await db(`/dealers?alpha_code=eq.${alpha}&select=id,name&limit=1`)).data?.[0];
    if (!org) {
      const ins = await db('/dealers', 'POST', {
        name, slug, world: 'retailer', alpha_code: alpha,
        rap_id: rapIdFor(alpha), frx_account_id: 'FRX-' + rapIdFor(alpha),
        selling_enabled: true, dashboard_enabled: true
      }, 'return=representation');
      org = ins.data?.[0];
      if (!org) fail('alta del dealer ' + alpha, ins);
      created++; notes.push('dealer nuevo');
    } else {
      if (org.name !== name) {
        const up = await db(`/dealers?id=eq.${org.id}`, 'PATCH', { name });
        if (up.status >= 300) fail('rename de ' + alpha, up);
        notes.push('nombre actualizado');
      }
      updated++;
    }

    /* 2) referral code (?ref=) */
    let ref = (await db(`/referral_codes?org_id=eq.${org.id}&active=is.true&select=code&limit=1`)).data?.[0]?.code;
    if (!ref) {
      ref = refCodeFor(alpha);
      const r = await db('/referral_codes', 'POST', { code: ref, org_id: org.id, active: true, label: name }, 'return=minimal');
      if (r.status >= 300) fail('referral de ' + alpha, r);
      notes.push('referral');
    }

    /* 3) sales-mode link permanente (/s/{code}) */
    const smRow = (await db(`/sales_mode_links?org_id=eq.${org.id}&active=is.true&select=code,org_name&limit=1`)).data?.[0];
    let sm = smRow?.code;
    if (sm && smRow.org_name !== name) {
      /* org_name está DESNORMALIZADO aquí: sales-mode-redirect lo lee de esta fila
         para la sesión del kiosco, así que un rename del dealer tiene que llegar
         también a su link o el kiosco seguiría mostrando el nombre viejo. */
      const r = await db(`/sales_mode_links?code=eq.${encodeURIComponent(sm)}`, 'PATCH', { org_name: name });
      if (r.status >= 300) fail('rename del sales link de ' + alpha, r);
      notes.push('sales link renombrado');
    }
    if (!sm) {
      sm = newShortCode();
      const r = await db('/sales_mode_links', 'POST', { code: sm, org_id: org.id, org_name: name, active: true }, 'return=minimal');
      if (r.status >= 300) fail('sales link de ' + alpha, r);
      notes.push('sales link');
    }
    line.salesUrl = `${KIOSK}/s/${sm}`;
    line.refUrl = `${KIOSK}/?ref=${ref}`;

    /* 4) link durable de onboarding de Stripe (DEAL-5). Se siembra ya aunque el
       dealer aún no vaya a conectarse: el code es nuestro y no caduca, así que el
       mismo link vale hoy en test y mañana en live. Va al CSV, NUNCA al handout
       impreso: esa tarjeta ya lleva la contraseña del portal y el onboarding abre
       el alta bancaria. */
    const onb = await ensureOnboardLink(env, { id: org.id, name });
    if (onb) { line.onboardUrl = onboardUrl(PORTAL, onb); notes.push('onboarding link'); }
    else notes.push('SIN onboarding link');

    /* 5) login del portal */
    const appMeta = { portal_role: 'dealer', org_id: org.id, org_name: name, world: 'retailer' };
    const existing = users.get(email);
    if (!existing) {
      line.password = genPassword();
      const r = await gotrue('/admin/users', 'POST', { email, password: line.password, email_confirm: true, app_metadata: appMeta });
      if (r.status >= 300) fail('login de ' + alpha, r);
      notes.push('login nuevo');
    } else {
      const patch = { app_metadata: appMeta };
      if (rotate) { line.password = genPassword(); patch.password = line.password; }
      const r = await gotrue('/admin/users/' + existing.id, 'PUT', patch);
      if (r.status >= 300) fail('update del login de ' + alpha, r);
      notes.push(rotate ? 'login rotado' : 'login intacto');
    }

    out.push(line);
    console.log(`  ${alpha}  ${name.slice(0, 42).padEnd(42)} ${notes.join(' · ')}`);
  }

  if (dry) { console.log('\nDRY RUN: nada se escribió.'); return; }

  mkdirSync('secrets', { recursive: true });
  writeFileSync('secrets/dealer-logins.csv', loginsCsv(out), 'utf8');
  const qrLib = existsSync('portal/qrcode.min.js') ? readFileSync('portal/qrcode.min.js', 'utf8') : '';
  writeFileSync('secrets/dealer-handout.html', handoutHtml(out, qrLib), 'utf8');

  const withPw = out.filter((r) => r.password).length;
  console.log(`\n${out.length} dealers · ${created} nuevos · ${updated} ya existían · ${withPw} con contraseña nueva`);
  console.log('  secrets/dealer-logins.csv     (contraseñas y link de onboarding, AQUÍ y no en pantalla)');
  console.log('  secrets/dealer-handout.html   (abrir e imprimir: una tarjeta con QR por dealer)');
  if (!rotate && withPw < out.length) console.log('\n  Los logins que ya existían conservan su contraseña. Para regenerarlas: --rotate');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
}
