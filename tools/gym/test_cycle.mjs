// Ciclo completo sin navegador: física wasm real + recorder.js real + MatchRules real + gym_core.js real +
// rlcoach real en Pyodide. Solo game.js (render/entrada) y los bots RLBot están sustituidos por modelos mínimos.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPhysics, TICK } from './sim.mjs';
import { carControl, GOAL_HW, GOAL_H } from './match_sim.mjs';
import { startWorker } from './run_worker_node.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(import.meta.url);
const G = req(path.join(ROOT, 'gym_rules.js'));
const Core = req(path.join(ROOT, 'gym_core.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'webbots/manifest.json'), 'utf8'));
let n = 0; const ok = (m) => { n++; console.log('ok -', m); };

const M = await loadPhysics();
const humanId = M.addCar(0);
const sim = { timeScale: 1, paused: false, lockInput: false, noGoal: false, holdKickoff: false };
const hooks = { controls: null, frame: null, resetBall: null, tick: null, kickoff: null, record: null };
const ctl = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
let goalTimer = 0, clockMs = 0;

// ---- Bots falsos con la MISMA API que bots.js (cars/status/set/info/reset/takeover/release)
const BOT_SKILL = { aim: 1, noise: 0 };
const fb = { roster: [], pool: [], loan: null, resets: 0, setCalls: 0, idleOpp: false };
const Bots = {
  info: () => manifest.bots,
  set(spec) {
    fb.setCalls++;
    fb.roster = [];
    const mk = (name, team) => {
      let e = fb.pool.find((p) => p.team === team && !p.used);
      if (!e) { e = { id: M.addCar(team), team, used: false }; fb.pool.push(e); }
      e.used = true; fb.roster.push({ bot: name, team, id: e.id, role: 'defender', ctl: null });
    };
    fb.pool.forEach((p) => { p.used = false; });
    (spec.blue || []).forEach((b) => mk(b, 0)); (spec.orange || []).forEach((b) => mk(b, 1));
    fb.roster.filter((r) => r.team === 1)[0] && (fb.roster.filter((r) => r.team === 1)[0].role = 'attacker');
  },
  status: () => fb.roster.map((e, i) => ({ index: i + 1, bot: e.bot, team: e.team ? 'orange' : 'blue', ok: true })),
  cars: () => fb.roster.map((e, i) => ({ index: i + 1, id: e.id, bot: e.bot, team: e.team, rank: manifest.bots[e.bot].rank, ok: true, ctl: e.ctl })),
  reset() { fb.resets++; },
  takeover: async (name, cb) => { fb.loan = { name, cb }; return name; },
  release() { fb.loan = null; },
};

// ---- Modelo mínimo de game.js: bucle de física, hooks, detección de gol y kickoff (con el guard holdKickoff)
const RS = {
  Module: M, carId: humanId, sim, hooks, ctl, isGoalPause: () => goalTimer > 0,
  kickoff() { kickoff(); }, showToast() {}, getState: () => ({}),
};
function kickoff() { if (sim.holdKickoff) return; M.resetBall(); M.setCarState(humanId, 0, -2560, 100, 0, 0, 0); if (hooks.kickoff) hooks.kickoff(); }
function checkBall(dt) {
  if (goalTimer > 0) { goalTimer -= dt; if (goalTimer <= 0) kickoff(); return; }
  const b = M.getBallState().pos;
  if (Math.abs(b.y) > 5035 && Math.abs(b.x) < GOAL_HW && b.z < GOAL_H) goalTimer = 1.6;
}
let humanSkill = { aim: 0.1, noise: 0.9 }, humanRole = 'attacker', acc = 0;
const botTeamOf = () => fb.roster;
function realFrame(dt) {      // dt en segundos reales
  clockMs += dt * 1000;
  if (!sim.paused) acc += dt * sim.timeScale;
  // controles del jugador (modelo de readControls) -> hook de gym (demo) -> física
  const ball = M.getBallState();
  const c = carControl(M, humanId, 0, humanRole, ball, null, humanSkill);
  Object.assign(ctl, c);
  if (sim.lockInput) Object.assign(ctl, { throttle: 0, steer: 0, boost: false });
  if (hooks.controls) hooks.controls(ctl, dt);
  M.setCarControls(humanId, ctl.throttle, ctl.steer, ctl.pitch, ctl.yaw, ctl.roll, ctl.jump, ctl.boost, ctl.handbrake);
  fb.roster.forEach((e) => {
    const k = fb.idleOpp && e.team === 1 ? null : carControl(M, e.id, e.team, e.role, ball, null, BOT_SKILL);
    e.ctl = k;
    if (k) M.setCarControls(e.id, k.throttle, k.steer, k.pitch, k.yaw, k.roll, k.jump, k.boost, k.handbrake);
    else M.setCarControls(e.id, 0, 0, 0, 0, 0, false, false, false);
  });
  let ticks = 0;
  while (acc >= TICK && ticks < 8) { M.step(1); if (hooks.tick) hooks.tick(); if (hooks.record) hooks.record(); acc -= TICK; ticks++; }
  checkBall(dt);
  core.frame(clockMs);
}

// ---- Entorno del núcleo
const pending = [];
const later = (fn, ms) => { pending.push({ at: clockMs + ms, fn }); };
const pump = () => { for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= clockMs) pending.splice(i, 1)[0].fn(); };
const views = []; let lastVm = null; const cds = [];
const ui = { render: (v) => { lastVm = v; views.push(v.phase); }, hud() {}, countdown: (c) => cds.push(c) };
const worker = await startWorker();
console.log('pyodide ready:', (await worker.init()).ok);
let rid = 0;
const analyzer = { init: async () => ({}), analyze: (doc) => worker.req(++rid, { op: 'analyze', doc }), evaluate: (error, attempt) => worker.req(++rid, { op: 'evaluate', error, attempt }) };
const memory = { saved: null, replay: null };
const store = { load: () => memory.saved, save: (o) => { memory.saved = JSON.parse(JSON.stringify(o)); }, saveReplay: (d) => { memory.replay = d; }, loadReplay: async () => memory.replay };

// recorder.js real
const g = globalThis; g.window = g; g.addEventListener = () => {}; g.RS = RS; g.Bots = Bots; g.__mpCarId2 = null;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'recorder.js'), 'utf8'), { filename: 'recorder.js' });
console.log = ((orig) => (...a) => { if (!String(a[0]).startsWith('[Recorder]')) orig(...a); })(console.log);

const core = Core.create({ RS, Bots, Recorder: g.Recorder, analyzer, ui, store, now: () => clockMs, setTimeout: later, pollMs: 1 });

async function run(untilFn, maxFrames, label) {
  for (let i = 0; i < maxFrames; i++) {
    realFrame(1 / 60); pump();
    if (i % 30 === 0) await new Promise((r) => setImmediate(r));
    if (untilFn()) return i;
  }
  throw new Error('timeout esperando: ' + label + ' (fase ' + core.state.phase + ')');
}
const wait = async (fn, label) => { for (let i = 0; i < 4000 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn(), label); };

// ============================================================ 1) menú y selección
core.open(manifest.bots);
assert.equal(lastVm.phase, 'menu');
assert.deepEqual(lastVm.menu.modes, ['1v1', '2v2', '3v3']);
assert.deepEqual(lastVm.menu.ranks.map((r) => r.name), ['Silver', 'Gold', 'Platinum', 'Diamond', 'Grand Champion']);
ok('menu offers rank + 1v1/2v2/3v3');

// ============================================================ 2) forfeit REAL de punta a punta (rival inmóvil)
await core.act('select', { rank: 1, mode: '1v1' });
humanSkill = { aim: 1, noise: 0 }; fb.idleOpp = true;
await core.act('start');
assert.equal(core.state.phase, 'match'); assert.equal(Bots.cars().length, 1);
await run(() => core.state.rules && core.state.rules.state === 'playing', 600, 'cuenta atrás'); assert.ok(cds.includes(3) && cds.includes(0));
ok('3-2-1 countdown, then play');
await run(() => core.state.rules.state === 'ended', 60 * 60 * 6, 'fin por forfeit');
const r1 = core.state.rules.result;
assert.equal(r1.reason, 'forfeit'); assert.equal(r1.winner, 0); assert.ok(core.state.rules.frozen); assert.equal(sim.holdKickoff, true);
assert.equal(core.state.rules.score[0] - core.state.rules.score[1], 4);
ok(`forfeit fires as a match STATE at ${r1.score.join('-')} (not a UI message): frozen=${core.state.rules.frozen}`);
const frozenScore = core.state.rules.score.slice(), frozenClock = core.state.rules.clock;
await run(() => core.state.phase === 'result', 600, 'pantalla de resultado');
for (let i = 0; i < 600; i++) { realFrame(1 / 60); pump(); }       // 10 s más: el partido no puede reabrirse
assert.deepEqual(core.state.rules.score, frozenScore); assert.equal(core.state.rules.clock, frozenClock); assert.equal(core.state.rules.state, 'ended');
assert.equal(lastVm.result.outcome, 'advance'); assert.ok(lastVm.result.unlocked);
assert.ok(memory.replay && memory.replay.frames.length > 100);
assert.equal(memory.replay.score.blue, 4); assert.equal(memory.replay.events.goals.length, 4);
ok(`nothing reopens the match after forfeit; win -> unlocks stronger bot (${lastVm.result.unlocked}); replay saved with ${memory.replay.events.goals.length} goals`);

// ============================================================ 3) derrota -> análisis -> revisión
fb.idleOpp = false; humanSkill = { aim: 0.1, noise: 0.9 };
await core.act('next_match');
let guard = 0;
while (true) {
  await run(() => ['analyzing', 'result', 'review'].includes(core.state.phase), 60 * 60 * 7, 'fin de partido');
  if (core.state.phase === 'result' && lastVm.result.outcome !== 'lost') { await core.act('next_match'); if (++guard > 6) throw new Error('el jugador no pierde'); continue; }
  break;
}
await wait(() => core.state.phase === 'review' || core.state.phase === 'result', 'análisis');
assert.equal(core.state.phase, 'review', 'esperaba revisión: ' + JSON.stringify(lastVm.error));
const A = core.state.analysis; assert.ok(A.errors.length >= 1);
const top = A.errors[0]; assert.equal(top.rank, 1);
for (let i = 1; i < A.errors.length; i++) assert.ok(A.errors[i - 1].impact >= A.errors[i].impact);
ok(`lost -> rlcoach found ${A.errors.length} errors; highest impact: ${top.kind} @ ${top.t}s (impact ${top.impact}) "${top.why}"`);

// ============================================================ 4) reconstrucción exacta
const sc = top.scenario;
const bs = M.getBallState();
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
[0, 1, 2].forEach((i) => { near([bs.pos.x, bs.pos.y, bs.pos.z][i], sc.ball.p[i], 0.5, 'ball.p'); near([bs.vel.x, bs.vel.y, bs.vel.z][i], sc.ball.v[i], 0.5, 'ball.v'); });
for (const c of sc.cars) {
  const id = core._internals.carIdFor(c.id), cs = M.getCarState(id);
  near(cs.pos.x, c.p[0], 0.5, c.id + '.x'); near(cs.pos.y, c.p[1], 0.5, c.id + '.y');
  near(cs.vel.x, c.v[0], 0.5, c.id + '.vx'); near(cs.vel.y, c.v[1], 0.5, c.id + '.vy');
  near(cs.boost, c.boost, 0.6, c.id + '.boost');
  const yaw = Math.atan2(cs.rot.get(1), cs.rot.get(0)); let d = Math.abs(yaw - c.yaw); d = Math.min(d, 2 * Math.PI - d);
  assert.ok(d < 0.02, `${c.id} yaw ${yaw} vs ${c.yaw}`);
}
assert.equal(sim.paused, true); assert.equal(lastVm.review.mode, 'ready');
ok(`state before the error restored exactly: ball + ${sc.cars.length} cars (pos, vel, yaw, boost) at t=${sc.t}s; player holds position while paused`);

// ============================================================ 5) velocidades de práctica
for (const s of [0.25, 0.5, 0.75, 1]) { await core.act('speed', { value: s }); assert.equal(lastVm.review.speed, s); }
await core.act('speed', { value: 0.3 }); assert.equal(lastVm.review.speed, 1);
ok('practice speeds 0.25x / 0.5x / 0.75x / 1x accepted; others rejected');

// ============================================================ 6) demostración del bot un rango arriba
const demo = lastVm.review.demo;
const effIdx = G.effectiveRank(core.state.progress.selectedRank, core.state.progress.bestBeatenRank);
assert.equal(demo.available, true); assert.equal(manifest.bots[demo.bot] && G.rankIndex(manifest.bots[demo.bot].rank), effIdx + 1);
ok(`demo bot = ${demo.bot} (${demo.rank}): exactly one available rank above effective rank ${G.RANKS[effIdx]}`);
await wait(() => fb.loan, 'takeover precargado');
await core.act('speed', { value: 1 });
const p0 = M.getCarState(humanId).pos; const startPos = { x: p0.x, y: p0.y };
const demoFrames = []; let sawDemo = false;
const demoDrive = () => { if (fb.loan && core.state.review.mode === 'demo') { const bb = M.getBallState(); const k = carControl(M, humanId, 0, 'defender', bb, null, BOT_SKILL); fb.loan.cb([k.throttle, k.steer, 0, 0, 0, k.jump ? 1 : 0, k.boost ? 1 : 0, k.handbrake ? 1 : 0]); } };
await core.act('demo'); assert.equal(core.state.review.mode, 'demo');
let maxMove = 0;
for (let i = 0; i < 60 * 30 && core.state.review.mode === 'demo'; i++) { demoDrive(); realFrame(1 / 60); pump(); sawDemo = true; const q = M.getCarState(humanId).pos; maxMove = Math.max(maxMove, Math.hypot(q.x - startPos.x, q.y - startPos.y)); }
demoFrames.push(maxMove);
assert.ok(sawDemo); assert.equal(core.state.review.mode, 'ready'); assert.equal(core.state.review.demoSeen, true);
assert.ok(demoFrames[0] > 50, 'el bot movió el auto del jugador (máx ' + Math.round(demoFrames[0]) + ' uu)');
const back = M.getCarState(humanId).pos; assert.ok(Math.hypot(back.x - startPos.x, back.y - startPos.y) < 1, 'control vuelve al jugador en el mismo punto de partida');
assert.ok(fb.resets >= 2);
ok('stronger bot drove the player car through the window; control returned to the player at the exact start state; bots reset');

// ============================================================ 7) intento del jugador + evaluación
await core.act('speed', { value: 0.5 });
const t0clock = clockMs;
await core.act('go'); assert.equal(core.state.review.mode, 'attempt'); assert.equal(sim.timeScale, 0.5); assert.equal(sim.paused, false);
await run(() => core.state.review.mode === 'result', 60 * 120, 'fin de intento');
const ev1 = lastVm.review.evaluation;
assert.equal(typeof ev1.corrected, 'boolean'); assert.ok(Array.isArray(ev1.reasons) && ev1.reasons.length);
ok(`attempt at 0.5x evaluated by rlcoach: corrected=${ev1.corrected}, reasons=${ev1.reasons.join(',')}, ${JSON.stringify(ev1.metrics)}`);
// reintento con una "buena" defensa (controlador defensivo) para comprobar que el evaluador distingue
humanSkill = { aim: 1, noise: 0 }; humanRole = 'defender';
await core.act('retry'); assert.equal(lastVm.review.mode, 'ready');
await core.act('go'); await run(() => core.state.review.mode === 'result', 60 * 120, 'segundo intento');
const ev2 = lastVm.review.evaluation; assert.equal(lastVm.review.attempts, 2);
ok(`retry from the same restored state, defender-style attempt: corrected=${ev2.corrected} (${ev2.reasons.join(',')})`);

// ============================================================ 8) siguiente error -> revancha contra quien venció
while (core.state.phase === 'review') {
  await core.act('next');
  if (core.state.phase === 'review') { assert.equal(lastVm.review.mode, 'ready'); }
}
assert.equal(core.state.phase, 'rematch');
const lostTo = core.state.progress.lostTo; assert.ok(lostTo && lostTo.opponents.length === 1);
assert.ok(memory.saved && memory.saved.progress.lostTo);
const setBefore = fb.setCalls, rosterBefore = JSON.stringify(Bots.cars().map((c) => [c.bot, c.team]));
humanSkill = { aim: 0.1, noise: 0.9 }; humanRole = 'attacker';
await core.act('rematch');
assert.equal(core.state.phase, 'match'); assert.equal(fb.setCalls, setBefore, 'misma plantilla: no se recargan los bots');
assert.equal(JSON.stringify(Bots.cars().map((c) => [c.bot, c.team])), rosterBefore);
assert.equal(core.state.rules.score.join(), '0,0');
ok(`all key errors visited -> rematch vs the same bot (${lostTo.opponents.join(', ')}); fresh match 0-0; cycle repeats`);

console.log(`\n${n} checks passed`);
process.exit(0);
