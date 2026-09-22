/* ============================================================================
 * _lib/auth.mjs — autenticación de usuarios para Netlify Functions.
 *
 * `requireUser(req, env)` extrae el access_token del header `Authorization:
 * Bearer …`, lo valida llamando a `/auth/v1/user` de Supabase (endpoint nativo
 * de GoTrue que verifica firma + no-revocado + usuario no eliminado en una sola
 * llamada) y devuelve `{ userId, email }`. Lanza `AuthError(401, …)` si falla.
 *
 * Por qué no decodificamos el JWT a mano: no añade deps (`jose`/`jsonwebtoken`),
 * detecta usuarios eliminados (la firma seguiría siendo válida hasta que expire
 * el token), y el round-trip extra (~50-150ms) es despreciable en dashboards.
 * ==========================================================================*/

'use strict';

import { gotrue } from './supabase.mjs';
import { pendingChange } from './temppw.mjs';

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function requireUser(req, env) {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AuthError(401, 'missing_bearer');

  const { status, data } = await gotrue(env, '/user', { method: 'GET', bearer: token });
  if (status !== 200 || !data || !data.id) throw new AuthError(401, 'invalid_token');

  /* SEC-3a: el cambio obligatorio de la contraseña temporal se aplica AQUÍ, no solo en
   * account.html. Antes, con la temporal del welcome bastaba un curl a /api/auth-login
   * para sacar un token válido y usarlo contra estos endpoints sin ver nunca la pantalla.
   * 403 y no 401 a propósito: el token es válido, lo que falta es una acción del usuario;
   * un 401 haría que el cliente reintentara el login en bucle. La ÚNICA puerta que sigue
   * abierta es auth-set-password, que no pasa por aquí (hace proxy directo a GoTrue).
   * El dato es fresco (viene del GET /user de arriba), así que en cuanto el usuario
   * cambia la contraseña el MISMO token vuelve a servir. Spec: misc/spec-sec3a-temp-password.md. */
  if (pendingChange(data)) throw new AuthError(403, 'password_change_required');

  return { userId: data.id, email: data.email };
}
