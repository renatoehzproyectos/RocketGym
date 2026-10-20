// Humo de la capa de interfaz con jsdom: cada fase del view-model real se pinta sin excepciones y los botones disparan acciones.
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { JSDOM } = createRequire('/tmp/pyo/x.js')('jsdom');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'webbots/manifest.json')));
const dom = new JSDOM('<body><div id="start-menu"><button id="play-button"></button></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.Worker = function () { this.postMessage = () => {}; };
const calls = []; const hooks = {};
w.RS = { Module: {}, carId: 1, hooks, sim: {}, isGoalPause: () => false };
w.Bots = { info: () => manifest.bots, status: () => [], cars: () => [] };
w.Recorder = {};
w.requestAnimationFrame = () => 0;
for (const f of ['gym_rules.js', 'gym_core.js', 'gym_ui.js']) w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
await new Promise((r) => setTimeout(r, 50));
const btn = w.document.getElementById('gym-button'); assert.ok(btn, 'botón GYM en el menú de inicio');
btn.click(); assert.equal(w.document.getElementById('start-menu'), null);
const gym = w.document.getElementById('gym'); const core = w.__gym; assert.ok(gym && core);
const text = () => gym.textContent;
assert.match(text(), /Silver/); assert.match(text(), /1v1/); assert.match(text(), /3v3/); assert.match(text(), /PLAY/);
gym.querySelector('[data-key="mode"][data-val="3v3"]').click();
assert.equal(core.state.selection.mode, '3v3');
gym.querySelector('[data-key="rank"][data-val="3"]').click();
assert.equal(core.state.selection.rank, 3);
// fases sintéticas con la forma real del view-model
const G = w.GymRules, ladder = G.buildLadder(manifest.bots);
const err = { kind: 'out_of_position', t: 192.4, impact: 0.8, why: 'You were past the ball.', hint: 'Rotate back.', scenario: { error_offset_s: 2.2 } };
const base = { demo: { available: true, bot: 'Nexto', rank: 'Grand Champion', loading: false }, speeds: [0.25, 0.5, 0.75, 1], speed: 0.5, idx: 0, total: 3, fixed: 1, attempts: 0, error: err, evaluation: null };
const RV = (o) => Object.assign({}, base, o);
const sc = [
  ['match', { hud: { score: [1, 2], clock: 123, overtime: false, state: 'playing', size: 1, opponents: ['Aether'] } }, /Aether/],
  ['result', { result: { outcome: 'lost', result: { reason: 'forfeit' }, score: [0, 4], bot: 'Aether' } }, /DEFEAT/],
  ['result', { result: { outcome: 'advance', result: { reason: 'time' }, score: [3, 1], bot: 'Aether', unlocked: 'Isopod' } }, /Isopod/],
  ['review', { review: RV({ mode: 'ready' }) }, /WATCH GRAND CHAMPION BOT/],
  ['review', { review: RV({ mode: 'ready', demo: { available: false } }) }, /NO HIGHER RANK/],
  ['review', { review: RV({ mode: 'demo' }) }, /driving your car/],
  ['review', { review: RV({ mode: 'attempt' }) }, /Reproduce/],
  ['review', { review: RV({ mode: 'result', evaluation: { corrected: true, reasons: ['corrected'] } }) }, /corrected/],
  ['review', { review: RV({ mode: 'result', evaluation: { corrected: false, reasons: ['still_ahead_of_ball'] } }) }, /still past the ball/],
  ['rematch', { rematch: { opponents: ['Aether'], rank: 'Platinum', fixed: 2, total: 3 } }, /REMATCH/],
  ['analyzing', { busy: 'analyzing' }, /analysing/],
];
// reutilizamos el render real reemplazando solo el view-model
const ui = core.state; let n = 0;
for (const [phase, extra, re] of sc) {
  const vm = Object.assign({ phase, busy: null, error: null, menu: core.vm().menu, hud: null, result: null, review: null, rematch: null }, extra);
  w.__gymRender(vm);
  assert.match(text(), re, phase + ': ' + text().slice(0, 120)); n++;
}
gym.querySelector('[data-act="speed"]') && console.log('speed buttons present');
console.log(`ui ok: menu clicks + ${n} phases rendered`);
