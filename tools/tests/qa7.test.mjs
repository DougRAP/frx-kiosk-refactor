/* ============================================================================
 * QA-7 (BUG-02/06/07 de Jakob) — validaciones SUAVES de campos libres.
 * Filosofía (triage 25-jul): en un kiosk atendido un falso rechazo cuesta una
 * venta cerrada → server bloquea SOLO lo seguro (ZIP malformado, dígitos en el
 * nombre); lo demás son hints no bloqueantes en el front.
 * ==========================================================================*/
import { makeT, src } from './helpers.mjs';
import { validateCheckout } from '../../netlify/functions/_lib/validate.mjs';

const t = makeT('qa7');

const BASE = {
  email: 'a@b.co', full_name: 'Jane Doe', phone: '5551234567',
  address: '1 Main St, Logan UT', plans: [], kits: [{ sku: 'CARE-WOOD-001', quantity: 1 }]
};

/* ── ZIP (BUG-02): misma regex que Maya (chat.mjs) — muere la inconsistencia interna ── */
{
  t(validateCheckout({ ...BASE, zip: '84321' }).ok === true, 'zip: 5 dígitos pasa');
  t(validateCheckout({ ...BASE, zip: '84321-1234' }).ok === true, 'zip: ZIP+4 pasa');
  t(validateCheckout({ ...BASE }).ok === true, 'zip: ausente sigue siendo opcional (kit-only sin zip)');
  let r = validateCheckout({ ...BASE, zip: '1' });
  t(!r.ok && r.error === 'invalid_zip', 'zip: 1 dígito → invalid_zip (el hallazgo literal de Jakob)');
  r = validateCheckout({ ...BASE, zip: 'ABC12' });
  t(!r.ok && r.error === 'invalid_zip', 'zip: letras → invalid_zip (inputmode no bloquea paste)');
  r = validateCheckout({ ...BASE, zip: '123456789' });
  t(!r.ok && r.error === 'invalid_zip', 'zip: 9 dígitos sin guion → invalid_zip');
}

/* ── Nombre (BUG-06): SOLO dígitos bloquean; jamás blocklist ni "dos palabras" ── */
{
  let r = validateCheckout({ ...BASE, full_name: 'Jane D0e' });
  t(!r.ok && r.error === 'invalid_name', 'name: dígitos → invalid_name (typo con confianza)');
  r = validateCheckout({ ...BASE, full_name: '4471' });
  t(!r.ok && r.error === 'invalid_name', 'name: solo números (el caso de Jakob) → invalid_name');
  t(validateCheckout({ ...BASE, full_name: "Patrick O'Brien" }).ok === true, "name: O'Brien pasa (apóstrofo legítimo)");
  t(validateCheckout({ ...BASE, full_name: 'José Martínez-Ruiz' }).ok === true, 'name: acentos + guion pasan');
  t(validateCheckout({ ...BASE, full_name: 'Cher' }).ok === true, 'name: mononym pasa (una palabra NO bloquea — solo hint en el front)');
  r = validateCheckout({ ...BASE, full_name: 'X' });
  t(!r.ok && r.error === 'invalid_name', 'name: 1 solo carácter → invalid_name');
}

/* ── Address (BUG-07): el server NO endurece (by design, campo libre) ── */
{
  t(validateCheckout({ ...BASE, address: 'General Delivery' }).ok === true, 'address: texto libre sigue pasando (PO Box/APO/rural no se castigan)');
}

/* ── Front (los 3 checkouts): espejo del server + hints no bloqueantes ── */
for (const f of ['index.html', 'kiosk/index.html', 'tech/index.html']) {
  const html = src(f);
  t(/id="cart-zip"[^>]*pattern="\\d\{5\}\(-\\d\{4\}\)\?"/.test(html.replace(/\\/g, '\\\\')) || /pattern="\d\{5\}\(-\d\{4\}\)\?"/.test(html) || /id="cart-zip"[^>]*pattern=/.test(html), `qa7 ${f}: input ZIP con pattern`);
  t(/ZIP_OK_RE/.test(html) && /setFieldError\('cart-zip'/.test(html), `qa7 ${f}: submit valida el ZIP con mensaje propio (sin 400 crudo)`);
  t(/NAME_DIGITS_RE|\/\\d\/\.test\(name\)/.test(html) && /setFieldError\('cart-name'/.test(html), `qa7 ${f}: submit espeja el guard de dígitos del nombre`);
  t(/softHint/.test(html) && /only one name/i.test(html), `qa7 ${f}: hint NO bloqueante de nombre en una palabra`);
  t(/softHint\('cart-address'/.test(html), `qa7 ${f}: hint NO bloqueante de address débil`);
}

t.done();
