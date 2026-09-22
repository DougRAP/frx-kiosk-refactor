// Assembles testingApp wizards: engine-template.html + suite-<front>.mjs -> <out>/<front>/index.html
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// Sources live in tools/testingApp-build/; wizards are written to testingApp/<front>/index.html.
const OUT = path.resolve(here, '..', '..', 'testingApp');
const FRONTS = ['d2c', 'kiosk', 'tech', 'portal'];

function validateSuite(s, front) {
  const fail = (m) => { throw new Error(`[${front}] ${m}`); };
  if (!s.appId || !s.title || !s.version) fail('missing appId/title/version');
  if (!Array.isArray(s.envs) || !s.envs.length) fail('envs empty');
  s.envs.forEach((e) => { if (!e.id || !e.label || !e.base) fail('bad env entry'); });
  if (!Array.isArray(s.sections) || !s.sections.length) fail('sections empty');
  const ids = new Set();
  for (const sec of s.sections) {
    if (!sec.id || !sec.title || !Array.isArray(sec.cases) || !sec.cases.length) fail(`bad section ${sec.id}`);
    for (const c of sec.cases) {
      if (!c.id || !c.title || !c.expected || !Array.isArray(c.steps) || !c.steps.length) fail(`bad case ${c.id} in ${sec.id}`);
      if (!['happy', 'validation', 'access', 'edge'].includes(c.kind)) fail(`bad kind on ${c.id}`);
      if (ids.has(c.id)) fail(`duplicate case id ${c.id}`);
      ids.add(c.id);
    }
  }
  return ids.size;
}

const tpl = await readFile(path.join(here, 'engine-template.html'), 'utf8');
for (const front of FRONTS) {
  const mod = await import(pathToFileURL(path.join(here, `suite-${front}.mjs`)).href);
  const suite = mod.default;
  const n = validateSuite(suite, front);
  // </script> inside JSON would break the tag; escape defensively
  const json = JSON.stringify(suite).replace(/</g, '\\u003c');
  const html = tpl.replace('__PAGE_TITLE__', suite.title).replace('__APP_DATA__', json);
  await mkdir(path.join(OUT, front), { recursive: true });
  await writeFile(path.join(OUT, front, 'index.html'), html, 'utf8');
  console.log(`${front}: ${n} cases -> testingApp/${front}/index.html`);
}
