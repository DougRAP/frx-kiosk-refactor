/* Hash NORMALIZADO: colapsa CRLF→LF (y quita BOM) antes de SHA256, para que el oráculo de
 * byte-identidad del dist sea idéntico en Windows (working tree CRLF) y en el CI Linux de Netlify
 * (LF). Sin esta normalización, el SHA256 crudo daría falso-rojo permanente cross-platform. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const norm = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n');
export const hashFile = (p) => createHash('sha256').update(norm(readFileSync(p, 'utf8'))).digest('hex');

// CLI: node norm-hash.mjs <archivo>  → imprime el hash normalizado (para capturar el baseline)
if (process.argv[2]) process.stdout.write(hashFile(process.argv[2]) + '\n');
