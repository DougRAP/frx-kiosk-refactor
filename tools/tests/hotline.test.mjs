/* PORT-31 (email Emmy 14-ago: "For the hotline number on Kiosk page, please use 888-850-0057.")
   La hotline de RESELLERS del portal estrena número propio; el 833-395-7824 queda como línea de
   CLIENTES (success screens del kiosk/tech y los terms). Este gate fija la separación para que
   ningún refactor vuelva a mezclar los dos números (era el hallazgo F8 del audit 14-ago). */
import { makeT, src } from './helpers.mjs';

const t = makeT('hotline');

const portal = src('portal/index.html');
t(/1-888-850-0057/.test(portal), 'portal: la hotline de resellers es 1-888-850-0057 (Emmy 14-ago)');
t(!/833-395-7824/.test(portal), 'portal: el número de clientes 833 ya no aparece en ninguna parte del portal');
const hot = portal.split('class="hotline"')[1].split('</div>')[0] + '</div>';
t(/1-888-850-0057/.test(hot), 'portal: el bloque .hotline del nav muestra el número nuevo');
const contact = portal.split('id="view-contact"')[1].split('</section>')[0];
t((contact.match(/1-888-850-0057/g) || []).length === 4, 'portal: las 4 contact cards usan el número de resellers');

/* La línea de clientes NO se toca: Doug 14-ago "I already have a number for furniture rx but
   it's mostly for customers, so we want to keep the hotline separate" [AR 35:28]. */
for (const f of ['kiosk/index.html', 'tech/index.html']) {
  const html = src(f);
  t(/tel:18333957824/.test(html) && /1-833-395-7824/.test(html), `${f}: success screen conserva la línea de clientes 833`);
  t(!/888-850-0057/.test(html), `${f}: el número de resellers no se filtra a un front de clientes`);
}
for (const f of ['kiosk/terms/index.html', 'tech/terms/index.html']) {
  t(/1-833-395-7824/.test(src(f)), `${f}: los terms conservan el contacto de clientes 833`);
}

/* PORT-29a (mismo lote): el marketing del D2C ya no afirma tope de renovación. Los terms legales
   SÍ conservan su "36-Month Maximum" hasta que Doug/William entreguen el wording (TC-1b). */
t(!/up to 36 months/i.test(src('index.html')), 'PORT-29a: el copy D2C no afirma "up to 36 months"');
t(!/up to 36 months/i.test(src('dist/index.html')), 'PORT-29a: dist espeja el copy sin tope');

/* Ago-16 · limpieza de copy pedida sobre capturas del portal. */
{
  const css = src('portal/assets/css/portal.css');
  t(!/\(headline is placeholder copy/.test(portal), 'copy: murió la nota de placeholder del headline del landing');
  const ref = portal.split('id="view-referrals"')[1].split('</section>')[0];
  const banner = ref.split('class="banner info"')[1].split('</div>')[0];
  t(/^<p>/.test(banner.replace(/^>/, '')), 'copy: el banner de Referral Codes es UN solo <p> (antes se partía en flex items)');
  t(!/<b>/.test(banner), 'copy: sin <b> intercalados que fragmentaban la lectura');
  t(/just contact us when you want a new code/.test(banner) && /When a customer uses your code, your store gets credit for the sale/.test(banner),
    'copy: el texto entregado va literal, con su <br> entre los dos bloques');
  t(/\.banner>p\{flex:1;margin:0\}/.test(css), 'copy: el <p> ocupa todo el banner (flex:1) y no descuadra el alto');
}

t.done();
