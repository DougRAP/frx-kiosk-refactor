/* Resources upload UX v1 — comportamiento en jsdom (loadPortal). Ago-11, consultoría UX.
 * Dropzone (validación), selección de dealers (chips + contador + select-all + buscador),
 * segmented Everyone/Specific, gating del botón y reset completo. Spec: misc/spec-resources-ux-v1.md. */
import { loadPortal, makeT, flush } from './helpers.mjs';

const t = makeT('resources-ui');

const ME = { user_id: 'u1', name: 'Admin', email: 'a@rap.com', role: 'admin', tier: 'admin', world: null, org_id: null, org_name: null, app_url: 'https://kiosk.furniturerx.net/' };
const RESELLERS = [{ org_id: 'd1', org_name: 'Acme Furniture' }, { org_id: 'd2', org_name: 'Bravo Home' }, { org_id: 'd3', org_name: 'Coastal Living' }];

const { window, document } = await loadPortal({
  session: { access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 },
  me: ME, resellers: RESELLERS,
  api: { 'portal-resources': () => ({ resources: [] }) }
});
const $ = (s) => document.querySelector(s);
window.show('resources');
await flush();

/* -- tabs (Parte B) -- */
t($('#res-panel-available').hidden === false && $('#res-panel-add').hidden === true, 'tabs: default = Available (Add oculto)');
window.showResTab('add');
t($('#res-panel-add').hidden === false && $('#res-panel-available').hidden === true && $('#restab-add').classList.contains('on'), 'tabs: Add → panel visible + tab activo');
window.showResTab('available');
t($('#res-panel-available').hidden === false && $('#restab-available').classList.contains('on'), 'tabs: volver a Available');
window.showResTab('add');   /* el resto de asserts operan sobre el form del tab Add */

/* -- chips + estado inicial -- */
t(document.querySelectorAll('.dealer-chip').length === 3, 'dealers renderizados como 3 chips');
t($('#res-upload-btn').disabled === true, 'Upload nace disabled');

/* -- tipo manda el contenido + gating -- */
$('#res-title').value = 'Demo'; window.refreshResUploadBtn();
t($('#res-upload-btn').disabled === true, 'título pero sin contenido → disabled');
$('#res-type').value = 'product_overview'; window.onResTypeChange();
t($('#res-file-wrap').hidden === true && $('#res-link-wrap').hidden === false, 'tipo video → link visible, dropzone oculta');
$('#res-link').value = 'https://youtu.be/x'; window.refreshResUploadBtn();
t($('#res-upload-btn').disabled === false, 'título + link + Everyone → enabled');

/* -- segmented + contador -- */
const some = document.querySelector('input[name="res-target"][value="some"]'); some.checked = true; window.toggleResTargets();
t($('#res-some').hidden === false && $('#res-all-note').hidden === true, 'Specific → panel visible, nota "all" oculta');
t($('#res-seg-some').classList.contains('on') && !$('#res-seg-all').classList.contains('on'), 'segmented marca Specific');
t($('#res-upload-btn').disabled === true, 'Specific sin dealer → disabled');
const cbs = document.querySelectorAll('.res-dealer-cb');
cbs[0].checked = true; cbs[0].dispatchEvent(new window.Event('change'));
t(/1 of 3 selected/.test($('#res-count').textContent), 'contador → 1 of 3');
t(cbs[0].closest('.dealer-chip').classList.contains('on'), 'el chip marcado se pinta (.on)');
t($('#res-upload-btn').disabled === false, 'Specific con 1 dealer → enabled');

/* -- select all / clear -- */
window.resSelectAll();
t(/3 of 3 selected/.test($('#res-count').textContent), 'Select all → 3 of 3');
window.resClearDealers();
t(/0 of 3 selected/.test($('#res-count').textContent) && $('#res-upload-btn').disabled === true, 'Clear → 0 of 3 + disabled');

/* -- buscador -- */
$('#res-search').value = 'bra'; window.resSearch();
const vis = Array.prototype.slice.call(document.querySelectorAll('.dealer-chip')).filter(function (c) { return !c.hidden; });
t(vis.length === 1 && /Bravo/.test(vis[0].textContent), 'buscador filtra a Bravo');
$('#res-search').value = ''; window.resSearch();
t(Array.prototype.slice.call(document.querySelectorAll('.dealer-chip')).filter(function (c) { return !c.hidden; }).length === 3, 'buscador vacío → vuelven los 3');

/* -- validación de archivo (dropzone), caps por tipo (Parte A) -- */
$('#res-type').value = 'sell_sheet'; window.onResTypeChange();
window.handleResFile(new window.File([new Uint8Array(21 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }));
t($('#res-drop-err').hidden === false && $('#res-drop').classList.contains('error') && /20 MB/.test($('#res-drop-err').textContent), 'PDF > 20MB → error con el límite (20)');
window.handleResFile(new window.File([new Uint8Array(5 * 1024 * 1024)], 'ok.pdf', { type: 'application/pdf' }));
t($('#res-drop-file').hidden === false && $('#res-drop').hidden === true, 'PDF 5MB → válido (antes fallaba con el cap de 4MB)');
window.clearResFile();
window.handleResFile(new window.File([new Uint8Array(12 * 1024 * 1024)], 'big.png', { type: 'image/png' }));
t($('#res-drop').classList.contains('error') && /10 MB/.test($('#res-drop-err').textContent), 'imagen > 10MB → error con el límite (10)');
window.handleResFile(new window.File([new Uint8Array(1000)], 'bad.txt', { type: 'text/plain' }));
t($('#res-drop').classList.contains('error'), 'tipo inválido → error');

/* -- reset completo tras subir (no hereda audiencia) -- */
window.clearResFile();
$('#res-title').value = 'x'; some.checked = true; window.toggleResTargets();
cbs[0].checked = true; cbs[0].dispatchEvent(new window.Event('change'));
window.resetResForm();
t($('#res-title').value === '' && document.querySelector('input[name="res-target"][value="all"]').checked === true, 'reset: título vacío + vuelve a Everyone');
t($('#res-count').textContent.indexOf('0 of') === 0 && $('#res-some').hidden === true, 'reset: dealers limpios + panel oculto');

t.done();
