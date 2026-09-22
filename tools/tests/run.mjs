/* Runner del harness: corre cada *.test.mjs de tools/tests/ en subproceso (aislados
 * entre sí y del proceso padre) y falla ruidoso si alguno sale non-zero.
 * Uso: node tools/tests/run.mjs */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'tools/tests';
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
if (!files.length) { console.log('tools/tests: sin *.test.mjs todavía'); process.exit(0); }

let fails = 0;
for (const f of files) {
  const p = join(dir, f);
  console.log(`\n── ${p}`);
  try { process.stdout.write(execFileSync('node', [p], { stdio: 'pipe' }).toString()); }
  catch (e) {
    if (e.stdout) process.stdout.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
    fails++;
  }
}
console.log(`\n${fails ? `RED — ${fails} archivo(s) de test fallaron` : 'GREEN — harness completo en verde'}`);
process.exit(fails ? 1 : 0);
