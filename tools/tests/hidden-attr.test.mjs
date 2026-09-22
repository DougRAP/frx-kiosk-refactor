/* ============================================================================
 * Candado del atributo [hidden] — la cascada no puede dejar visible lo oculto.
 *
 * EL BUG QUE MOTIVA ESTE TEST (modal "Ship to" de Kit Orders, 13-ago):
 * `[hidden]{display:none}` vive en el UA stylesheet, que PIERDE contra cualquier
 * hoja de autor a igual especificidad. Así que `.btn{display:inline-flex}` (autor)
 * le ganaba, y TODO botón con el atributo hidden se veía siempre. En el modal
 * convivían Close+Cancel+Save y "Cancel" parecía muerto: sí corría, pero devolvía
 * a un modo lectura que ya se estaba mostrando. Afectaba a 8 botones del portal.
 *
 * Ya había pasado dos veces antes en este mismo repo (`.banner{display:flex}` y las
 * celdas th/td de Kit Orders), y las dos veces se arregló a mano DESPUÉS de verlo en
 * pantalla. Esto lo convierte en gate.
 *
 * POR QUÉ NO LO PILLAN LOS DEMÁS TESTS: el harness corre en jsdom, que no aplica
 * hojas de estilo externas ni resuelve la cascada. `el.hidden === true` pasa verde
 * mientras el usuario ve el botón. La única defensa posible es estática.
 *
 * QUÉ EXIGE: solo cruza las dos mitades reales del bug. Una clase entra en el
 * informe únicamente si (a) alguna regla de autor le fija `display` a algo distinto
 * de none y (b) el marcado la usa en un elemento que lleva el atributo hidden.
 * Una clase con display que nunca se usa con hidden NO se marca (cero ruido).
 * ==========================================================================*/
import { existsSync, readFileSync } from 'node:fs';
import { makeT } from './helpers.mjs';

const t = makeT('hidden-attr');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/* Los 4 fronts. El portal lleva su CSS en un archivo aparte; los otros lo tienen
   inline en <style>, así que la fuente de CSS se resuelve por front. */
const FRONTS = [
  { label: 'portal', html: 'portal/index.html', css: ['portal/assets/css/portal.css'] },
  { label: 'd2c', html: 'index.html', css: [] },
  { label: 'kiosk', html: 'kiosk/index.html', css: [] },
  { label: 'tech', html: 'tech/index.html', css: [] }
];

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/* CSS de un front = los archivos enlazados + todo bloque <style> del HTML. */
function cssOf(front) {
  let out = front.css.map(read).join('\n');
  const html = read(front.html);
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out += '\n' + m[1];
  return stripComments(out);
}

/* Clases cuyo `display` de autor puede tapar al [hidden] del UA stylesheet.
 *
 * El regex de bloque INTERNO (`[^{}]` a ambos lados) casa solo blocks de declaraciones:
 * las envolturas @media/@supports contienen llaves, así que quedan fuera solas y no hay
 * que parsear anidamiento a mano.
 *
 * Del selector solo interesa el SUJETO (el último compound): en `.kit-acts .btn` quien
 * recibe el display es `.btn`. Se descartan los pseudo-elementos (`::after` no se puede
 * ocultar por el hidden del elemento; si el elemento cae, el pseudo cae con él). */
function displayClasses(css) {
  const found = new Map();   // clase → selector que se lo fija (para el mensaje de error)
  for (const [, rawSel, decls] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const display = decls.match(/(?:^|;)\s*display\s*:\s*([^;!]+)/i);
    if (!display || display[1].trim().toLowerCase() === 'none') continue;
    for (const sel of rawSel.split(',')) {
      const subject = sel.trim().split(/[\s>+~]+/).pop() || '';
      if (/::/.test(subject)) continue;                       // pseudo-elemento
      const bare = subject.replace(/::?[\w-]+(\([^)]*\))?/g, '');   // fuera pseudo-clases
      if (/\[hidden\]/.test(subject)) continue;               // la propia regla de rescate
      for (const c of bare.matchAll(/\.([\w-]+)/g)) {
        if (!found.has(c[1])) found.set(c[1], sel.trim());
      }
    }
  }
  return found;
}

/* Clases que el marcado usa sobre elementos que llevan el atributo hidden.
   `hidden` va suelto o como hidden=""/hidden="hidden"; aria-hidden y data-hidden NO cuentan. */
function hiddenClasses(html) {
  const found = new Map();   // clase → etiqueta de ejemplo
  for (const [, tag, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    if (!/(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)) continue;
    const cls = attrs.match(/\bclass\s*=\s*"([^"]*)"/i);
    if (!cls) continue;
    const id = attrs.match(/\bid\s*=\s*"([^"]*)"/i);
    for (const c of cls[1].trim().split(/\s+/)) {
      if (c && !found.has(c)) found.set(c, `<${tag}${id ? ' id="' + id[1] + '"' : ''}>`);
    }
  }
  return found;
}

/* ¿Existe el rescate? Vale la regla puntual (`.btn[hidden]{display:none}`) o un
   comodín global del tipo `[hidden]{display:none!important}`. */
function rescued(css, cls) {
  if (new RegExp(`\\[hidden\\][^{}]*\\{[^{}]*display\\s*:\\s*none`, 'i').test(css)
    && /(^|[\s,{}])\[hidden\]\s*\{[^{}]*display\s*:\s*none\s*!important/i.test(css)) return true;
  return new RegExp(`\\.${cls}\\b[^{},]*\\[hidden\\][^{},]*\\{[^{}]*display\\s*:\\s*none`, 'i').test(css)
    || new RegExp(`\\[hidden\\][^{},]*\\.${cls}\\b[^{},]*\\{[^{}]*display\\s*:\\s*none`, 'i').test(css);
}

let checked = 0;
for (const front of FRONTS) {
  const html = read(front.html);
  if (!html) { t(false, `${front.label}: no se encontró ${front.html}`); continue; }
  const css = cssOf(front);
  const display = displayClasses(css);
  const used = hiddenClasses(html);

  const risky = [...used.keys()].filter((c) => display.has(c));
  const broken = risky.filter((c) => !rescued(css, c));
  checked += risky.length;

  t(broken.length === 0, broken.length
    ? `${front.label}: ${broken.length} clase(s) con display de autor sobre elementos [hidden] y sin regla de rescate — `
      + broken.map((c) => `.${c} (por "${display.get(c)}", usada en ${used.get(c)}) → falta .${c}[hidden]{display:none}`).join(' | ')
    : `${front.label}: toda clase con display usada junto a [hidden] tiene su regla de rescate`
      + (risky.length ? ` (${risky.length}: ${risky.map((c) => '.' + c).join(', ')})` : ' (ninguna en riesgo)'));
}

/* El gate solo vale si de verdad está mirando algo: si un refactor deja de usar
   `hidden` sobre elementos con clase, esto avisa en vez de pasar verde en vacío. */
t(checked > 0, `el cruce encontró combinaciones reales que vigilar (${checked})`);

/* Regresión nombrada del bug original, para que el diff que la reintroduzca sea legible. */
{
  const css = cssOf(FRONTS[0]);
  t(rescued(css, 'btn'),
    'portal: .btn con atributo hidden sigue rescatado (modal Ship to: Close/Cancel/Save)');
  t(rescued(css, 'dz-file'),
    'portal: .dz-file sigue rescatado (chip de archivo del dropzone de Resources)');
  const html = read('portal/index.html');
  t(/id="kit-addr-cancel"[^>]*\shidden/.test(html) && /id="kit-addr-save"[^>]*\shidden/.test(html),
    'portal: Cancel y Save del modal Ship to nacen ocultos (modo lectura)');
}

t.done();
