/* AUTH-2 — helpers de alta post-compra: contraseña temporal + email de bienvenida.
 * La password se teclea desde un email en el teléfono → formato y alfabeto importan. */
import { makeT } from './helpers.mjs';
import { generateTempPassword, welcomeEmail } from '../../netlify/functions/_lib/onboarding.mjs';

const t = makeT('onboarding');

/* ── generateTempPassword ── */
{
  const samples = Array.from({ length: 200 }, generateTempPassword);
  t(samples.every((p) => /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/.test(p)),
    'temp-password: formato XXXX-XXXX-XXXX en 200 muestras');
  t(samples.every((p) => !/[0O1lI]/.test(p)),
    'temp-password: nunca caracteres ambiguos (0/O, 1/l/I) — se teclea desde un email');
  t(new Set(samples).size === samples.length, 'temp-password: 200 muestras, 200 distintas');
  t(samples.every((p) => p.length >= 8 && p.length <= 72),
    'temp-password: dentro de los límites PW_MIN/PW_MAX de auth-set-password');
}

/* ── welcomeEmail — MAIL-1 (Doug 08-jul): UN solo link, "View my dashboard" ──
   MAIL-1b (Adrian 09-jul): el botón lleva #welcome=<email> (FRAGMENTO: nunca viaja al server
   ni a logs) → account.html ignora sesiones ajenas guardadas, prefillea el email y pide la
   password temporal con foco puesto. */
{
  const pw = 'AbCd-EfGh-JkMn';
  const mail = welcomeEmail({
    accountUrl: 'https://site.test/account.html',
    tempPassword: pw,
    email: 'Buyer@X.co'
  });
  t(typeof mail.subject === 'string' && mail.subject.length > 0, 'welcome: subject presente');
  t(mail.html.includes(pw) && mail.text.includes(pw), 'welcome: la password temporal va en html Y text');
  t((mail.html.match(/<a /g) || []).length === 1, 'welcome MAIL-1: UN solo <a> en todo el html');
  t(/<a href="https:\/\/site\.test\/account\.html#welcome=Buyer%40X\.co"[^>]*>View my dashboard/.test(mail.html),
    'welcome MAIL-1b: el botón apunta al login con #welcome=<email> (prefill sin tocar el server)');
  t(!mail.html.includes('?t=') && !mail.text.includes('?t='), 'welcome MAIL-1: cero rastro del link ?t= legacy');
  t(!/View my coverage/.test(mail.html + mail.text), 'welcome MAIL-1: fuera "View my coverage" (la vía v1)');
  t(mail.text.includes('https://site.test/account.html'), 'welcome: la URL del dashboard va también en el text');
  t(mail.html.includes('first time you sign in'), 'welcome: avisa que el primer login exige cambiarla');
  t(/FurnitureRx/.test(mail.subject + mail.html) && !/Furniture-Rx/.test(mail.subject + mail.html),
    'welcome: naming FurnitureRx (sin guion, decisión 06-jul)');
}

t.done();
