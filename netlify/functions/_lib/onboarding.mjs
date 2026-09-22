/* ============================================================================
 * _lib/onboarding.mjs — alta de cuenta post-compra (AUTH-2, Adrian 07-jul).
 * ----------------------------------------------------------------------------
 * La cuenta nace CON contraseña temporal (decisión de producto: el welcome
 * lleva UN link al dashboard + password temporal; el front fuerza el cambio en
 * el primer login vía user_metadata.must_change_password). Mandar la password
 * por email es aceptable AQUÍ porque es de un solo tramo: muere en el primer
 * login forzado, y el canal email ya es la raíz de confianza del flujo.
 * MAIL-1 (Doug 08-jul): un ÚNICO link "View my dashboard" (el login real).
 * El botón "View my coverage" (?t= de solo-vista) murió: dos vías de entrada
 * confundían al cliente en su primer contacto con la cuenta.
 * ==========================================================================*/

'use strict';

import { randomInt } from 'node:crypto';

/* Sin ambiguos (0/O, 1/l/I) — la password se TECLEA desde un email en el teléfono. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/* XXXX-XXXX-XXXX → 12 chars de 54 símbolos ≈ 69 bits (randomInt es CSPRNG y
 * uniforme). Los guiones son solo legibilidad; GoTrue los acepta sin problema. */
export function generateTempPassword() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

/* Email de bienvenida (reemplaza al invite de GoTrue para cuentas nuevas: así el
 * contenido no depende de plantillas de Supabase y puede llevar la password).
 * Nada de input del cliente entra al HTML: urls y password son server-generated. */
export function welcomeEmail({ accountUrl, tempPassword, email }) {
  /* MAIL-1b: el botón lleva el email del comprador en el FRAGMENTO (#welcome=…): nunca viaja
   * al server ni a logs. account.html lo usa para NO auto-entrar con una sesión ajena guardada,
   * prefillear el email y pedir la password temporal con el foco puesto. */
  const dashLink = accountUrl + '#welcome=' + encodeURIComponent(email || '');
  const subject = 'Your FurnitureRx account is ready';
  const html = '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0e1418">'
    + '<h2>Welcome to FurnitureRx</h2>'
    + '<p>Your payment went through and your protection is now active. Your account is ready, nothing else to fill out.</p>'
    + '<p><a href="' + dashLink + '" style="display:inline-block;background:#e8590c;color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none;font-weight:600">View my dashboard &rarr;</a></p>'
    + '<p>Sign in with your email and this temporary password:</p>'
    + '<p style="font-family:Consolas,Menlo,monospace;font-size:22px;letter-spacing:.08em;background:#f4f6f8;border:1px solid #e2e7ec;border-radius:6px;padding:12px 16px;text-align:center">' + tempPassword + '</p>'
    + '<p>You will be asked to choose your own password the first time you sign in.</p>'
    + '<p style="color:#667;font-size:13px">If you did not make this purchase, reply to this email and we will take a look.</p>'
    + '</div>';
  const text = 'Welcome to FurnitureRx\n\n'
    + 'Your payment went through and your protection is now active.\n\n'
    + 'View your dashboard: ' + accountUrl + '\n\n'
    + 'Sign in with your email and this temporary password:\n\n'
    + '  ' + tempPassword + '\n\n'
    + 'You will be asked to choose your own password the first time you sign in.\n\n'
    + 'If you did not make this purchase, reply to this email and we will take a look.';
  return { subject, html, text };
}
