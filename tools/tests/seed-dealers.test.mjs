/* ============================================================================
 * DEAL-2 — alta masiva de los 25 dealers. Unit de las piezas PURAS del script:
 * el parseo de la lista (xlsx/csv), el slug, el referral y el generador de
 * contraseñas. La parte de red (PostgREST + GoTrue) no se toca aquí: el script
 * es idempotente y se verifica corriéndolo dos veces contra la BD.
 * ==========================================================================*/
import { makeT } from './helpers.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { parseDealers, slugFor, refCodeFor, genPassword, emailFor, rapIdFor, loginsCsv, handoutHtml, PW_ALPHABET } from '../seed-dealers.mjs';

const t = makeT('seed-dealers');

/* ── El parseo de la lista ─────────────────────────────────────────────────── */
{
  const csv = 'BLS,Baileys Furniture Outlet, Inc\nMWD,"Miller Waldrop Furniture & Décor"\n\nbad-row-sin-alpha\n';
  const rows = parseDealers(Buffer.from(csv, 'utf8'), 'lista.csv');
  t(rows.length === 2, 'csv: se queda con las filas que tienen alpha válido');
  t(rows[0].alpha === 'BLS' && rows[0].name === 'Baileys Furniture Outlet, Inc', 'csv: la coma del nombre legal no parte la fila');
  t(rows[1].name === 'Miller Waldrop Furniture & Décor', 'csv: respeta comillas y acentos');
}
{
  const rows = parseDealers(Buffer.from('alpha,name\nAFA,Adams\n', 'utf8'), 'x.csv');
  t(rows.length === 1 && rows[0].alpha === 'AFA', 'csv: descarta la cabecera si la trae');
}
{
  let threw = false;
  try { parseDealers(Buffer.from('nada util\n', 'utf8'), 'x.csv'); } catch { threw = true; }
  t(threw, 'lista vacía → error explícito (no sembrar cero dealers en silencio)');
}

/* El xlsx real de la lista, si está presente en el working copy. */
{
  const XLSX = 'requests/dougAgo162026/Dealers.xlsx';
  if (existsSync(XLSX)) {
    const rows = parseDealers(readFileSync(XLSX), XLSX);
    t(rows.length === 25, 'xlsx: lee los 25 dealers de la lista real');
    t(rows.every((r) => /^[A-Z]{3}$/.test(r.alpha)), 'xlsx: todos los alpha son 3 mayúsculas');
    t(new Set(rows.map((r) => r.alpha)).size === 25, 'xlsx: no hay alpha repetido');
    t(rows.some((r) => r.alpha === 'MWD' && /Décor/.test(r.name)), 'xlsx: los acentos sobreviven');
    t(rows.every((r) => r.name && r.name.length > 2), 'xlsx: ningún dealer sin nombre');
  } else {
    t(true, 'xlsx: no está en el working copy, se salta (la lista no se versiona)');
  }
}

/* ── slug y referral ───────────────────────────────────────────────────────── */
{
  t(slugFor('BLS') === 'bls', 'slug: deriva del alpha (único en BD desde DEAL-1)');
  const codes = new Set(['AFA', 'AFD', 'ASE'].map(slugFor));
  t(codes.size === 3, 'slug: un alpha distinto nunca colisiona con otro');
}
{
  const c = refCodeFor('BLS');
  t(/^BLS-[A-Z0-9]{4}$/.test(c), 'referral: formato ALPHA-XXXX (' + c + ')');
  const many = new Set(Array.from({ length: 200 }, () => refCodeFor('BLS')));
  t(many.size > 190, 'referral: el sufijo es aleatorio de verdad');
}

/* ── La contraseña temporal ────────────────────────────────────────────────── */
{
  const pw = genPassword();
  t(pw.length === 8, 'password: 8 caracteres');
  t(/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw), 'password: mezcla mayúscula, minúscula y dígito (' + pw + ')');
}
{
  t(!/[lIO01]/.test(PW_ALPHABET), 'password: fuera los caracteres que se confunden al dictarlos (l I O 0 1)');
  const all = Array.from({ length: 400 }, () => genPassword()).join('');
  t(!/[lIO01]/.test(all), 'password: 400 contraseñas y ninguna trae un carácter ambiguo');
}
{
  const many = new Set(Array.from({ length: 500 }, () => genPassword()));
  t(many.size === 500, 'password: 500 generadas, 500 distintas (una por dealer, nunca compartida)');
}
{
  /* Las 3 clases se garantizan por construcción; comprobamos que eso no fija posiciones. */
  const firsts = new Set(Array.from({ length: 300 }, () => genPassword()[0]));
  t(firsts.size > 12, 'password: la clase de carácter no queda anclada a una posición fija');
}

/* ── Identidad del login ───────────────────────────────────────────────────── */
{
  t(emailFor('BLS') === 'bls@rapqa.com', 'login: [alpha]@rapqa.com en minúsculas');
  t(rapIdFor('bls') === 'BLS-1001', 'rap_id sintético en mayúsculas, coincide con el que ya tiene el dealer de demo');
}

/* ── Lo que se reparte: CSV y handout ──────────────────────────────────────── */
const SAMPLE = [
  { alpha: 'MWD', name: 'Miller Waldrop Furniture & Décor', email: 'mwd@rapqa.com', password: 'Xk7pQm2v', salesUrl: 'https://kiosk.furniturerx.net/s/A1B2C3D4', refUrl: 'https://kiosk.furniturerx.net/?ref=MWD-7K2M', onboardUrl: 'https://portal.furniturerx.net/stripeOnboarding/ACDEFGHJKMNPQRSTUVWXYZ23' },
  { alpha: 'BAB', name: "Babette's Furniture, Inc", email: 'bab@rapqa.com', password: null, salesUrl: 'https://kiosk.furniturerx.net/s/Z9Y8X7W6', refUrl: 'https://kiosk.furniturerx.net/?ref=BAB-3H5N', onboardUrl: '' }
];
{
  const csv = loginsCsv(SAMPLE);
  const lines = csv.trim().split('\n');
  t(lines.length === 3, 'csv: cabecera + una fila por dealer');
  t(/^alpha,dealer,email,password,sales_link,referral_link,stripe_onboarding_link$/.test(lines[0]), 'csv: cabecera legible para William');
  t(lines[1].includes('stripeOnboarding/ACDEFGHJKMNPQRSTUVWXYZ23'), 'csv: el link de onboarding viaja AQUÍ');
  t(lines[1].includes('"Miller Waldrop Furniture & Décor"'), 'csv: el nombre con & y acento va entrecomillado');
  t(lines[1].includes('"Xk7pQm2v"'), 'csv: la contraseña viaja aquí, que es su único sitio');
  t(lines[2].includes('(sin cambios)'), 'csv: el login que ya existía se marca en vez de mentir con una contraseña');
}
{
  const evil = [{ alpha: 'EVL', name: '=cmd|calc', email: 'evl@rapqa.com', password: 'Ab3cd4ef', salesUrl: 'u', refUrl: 'r' }];
  t(loginsCsv(evil).includes('"\'=cmd|calc"'), 'csv: un nombre que empieza por = no se ejecuta al abrirlo en Excel');
}
{
  const html = handoutHtml(SAMPLE, 'window.qrcode=function(){};');
  t((html.match(/<article class="card">/g) || []).length === 2, 'handout: una tarjeta por dealer');
  t(html.includes('data-url="https://kiosk.furniturerx.net/s/A1B2C3D4"'), 'handout: el QR apunta al sales link, no al ?ref=');
  t(html.includes('Xk7pQm2v'), 'handout: lleva la contraseña impresa (es lo que se entrega en mano)');
  t(html.includes('Babette&#039;s') || html.includes("Babette's"), 'handout: el apóstrofe del nombre no rompe el markup');
  t(html.includes('Furniture &amp; D'), 'handout: el & del nombre va escapado');
  t(html.includes('window.qrcode'), 'handout: la librería de QR va inline (archivo autónomo, sin red)');
  /* El handout se imprime y va a un showroom, y ya lleva la contraseña del portal
     resaltada. El link de onboarding abre el alta bancaria: las dos cosas juntas en
     un papel olvidado en la impresora son demasiado. Ese link vive solo en el CSV. */
  t(!html.includes('stripeOnboarding'), 'handout: el link de onboarding NO se imprime, solo el de ventas');
  t((html.match(/<article/g) || []).length === (html.match(/<\/article>/g) || []).length, 'handout: markup balanceado');
}
{
  /* Un nombre hostil no debe poder cerrar la tarjeta e inyectar markup. */
  const bad = [{ alpha: 'XSS', name: '</article><script>alert(1)</script>', email: 'x@rapqa.com', password: 'Ab3cd4ef', salesUrl: 'u', refUrl: 'r' }];
  const html = handoutHtml(bad, '');
  t(!html.includes('<script>alert(1)'), 'handout: el nombre se escapa (viene de un xlsx de terceros)');
  t((html.match(/<article class="card">/g) || []).length === 1, 'handout: sigue habiendo una sola tarjeta');
}

t.done();
