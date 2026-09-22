/* ============================================================================
 * _lib/temppw.mjs — estado de la contraseña TEMPORAL del onboarding (SEC-3a).
 *
 * Desde AUTH-2 (07-jul) la cuenta nace tras la compra con una contraseña temporal
 * que viaja en el welcome email y con `user_metadata.must_change_password:true`.
 * La auditoría del 28-jul (hallazgo 3, CWE-522 + CWE-620) encontró dos agujeros:
 * esa contraseña NO caducaba nunca (el correo queda en el buzón como credencial
 * permanente) y el cambio obligatorio lo aplicaba SOLO el front (con la temporal y
 * curl se sacaba un token y se usaba contra la API sin ver la pantalla).
 *
 * La regla vive AQUÍ y en un solo sitio; la consumen auth-login (no emite sesión con
 * una temporal caducada) y _lib/auth.mjs (403 mientras el cambio siga pendiente).
 * Sin estado, sin red, sin dependencias: solo lee el user que ya devuelve GoTrue.
 *
 * VENTANA: env `TEMP_PASSWORD_TTL_DAYS` (default 7), mismo patrón que la
 * ELIGIBILITY_WINDOW_DAYS de QA-6. `0` o un valor no numérico DESACTIVA la caducidad
 * — palanca de emergencia sin necesidad de desplegar.
 *
 * QUÉ FECHA SE MIRA: `user_metadata.temp_password_at` (lo sella el webhook al crear
 * la cuenta). Las cuentas creadas ANTES de SEC-3a no lo tienen → se cae a `created_at`,
 * que GoTrue siempre devuelve, para que la caducidad las cubra también. Si no hay
 * ninguna fecha legible NO se juzga: nunca se deja a nadie fuera por un dato ilegible.
 * Spec: misc/spec-sec3a-temp-password.md.
 * ==========================================================================*/

'use strict';

export const TEMP_TTL_DEFAULT_DAYS = 7;

/* ¿La cuenta tiene un cambio de contraseña pendiente? */
export function pendingChange(user) {
  return !!(user && user.user_metadata && user.user_metadata.must_change_password === true);
}

/* ¿Además ese cambio pendiente viene de una temporal ya vencida?
 * Solo puede ser true si hay cambio pendiente: una cuenta normal nunca se toca. */
export function tempPasswordExpired(user, env) {
  if (!pendingChange(user)) return false;

  const raw = (env && env.TEMP_PASSWORD_TTL_DAYS !== undefined && env.TEMP_PASSWORD_TTL_DAYS !== '')
    ? Number(env.TEMP_PASSWORD_TTL_DAYS) : TEMP_TTL_DEFAULT_DAYS;
  const days = Number.isFinite(raw) ? raw : 0;
  if (!(days > 0)) return false;   // desactivada a propósito

  const stamp = user.user_metadata.temp_password_at || user.created_at;
  const issued = Date.parse(stamp || '');
  if (!Number.isFinite(issued)) return false;   // sin fecha fiable → no juzgamos

  return Date.now() - issued > days * 86400000;
}
