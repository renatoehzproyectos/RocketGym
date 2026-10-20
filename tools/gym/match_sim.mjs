// Partido headless con el wasm real, el recorder.js real y MatchRules real. Controladores simples (solo suelo).
// Sirve para generar grabaciones realistas para probar el análisis y para verificar la reconstrucción.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPhysics, TICK } from './sim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { MatchRules } = createRequire(import.meta.url)(path.join(ROOT, 'gym_rules.js'));
export const GOAL_HW = 892.755, GOAL_H = 642.775;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// kickoff estándar: el azul ocupa y<0; el naranja es el espejo (x,y) -> (-x,-y)
export const SPOTS = [[-2048, -2560], [2048, -2560], [0, -4608]];

export function carControl(M, id, team, role, ball, mates, skill) {
  const c = M.getCarState(id), r = [0, 1, 2].map((i) => c.rot.get(i));
  const fx = r[0], fy = r[1], px = c.pos.x, py = c.pos.y, sg = team ? -1 : 1;
  const goalY = 5120 * sg, ownY = -5120 * sg;
  let tx = ball.pos.x, ty = ball.pos.y, boost = true;
  const bx = ball.pos.x, by = ball.pos.y;
  if (role === 'defender') {
    const behind = (by - py) * sg > 300;      // la pelota está más cerca de la meta rival que yo: quedarse atrás
    const ballDeep = (by - ownY) * sg < 2600; // pelota en mi zona: salir a defender
    if (!ballDeep && !behind) { tx = bx * 0.4; ty = ownY * 0.8 + 0; boost = false; }
    else if (!ballDeep) { tx = bx * 0.4; ty = ownY * 0.8; boost = false; }
  }
  if (tx === bx && ty === by) {   // ir DETRÁS de la pelota respecto al arco rival y empujarla
    const gx = 0, gy = goalY, dx = gx - bx, dy = gy - by, d = Math.hypot(dx, dy) || 1;
    const off = clamp(Math.hypot(bx - px, by - py) * 0.5, 120, 600);
    tx = bx - (dx / d) * off * (skill.aim); ty = by - (dy / d) * off * (skill.aim);
  }
  const dx = tx - px, dy = ty - py, dist = Math.hypot(dx, dy) || 1;
  const cross = fx * dy - fy * dx, dot = fx * dx + fy * dy;
  const ang = Math.atan2(cross, dot);
  const steer = clamp(ang * 2.5, -1, 1);    // +steer gira antihorario (verificado contra el wasm)
  const speed = Math.hypot(c.vel.x, c.vel.y);
  const wantBoost = boost && Math.abs(ang) < 0.25 && dist > 500 && c.boost > 1 && speed < 2250;
  return { throttle: Math.abs(ang) > 1.8 ? -1 : 1, steer: skill.noise ? clamp(steer + (Math.random() - .5) * skill.noise, -1, 1) : steer,
    pitch: 0, yaw: 0, roll: 0, jump: false, boost: wantBoost, handbrake: Math.abs(ang) > 0.9 && speed > 600 };
}

export async function runMatch(opts) {
  opts = opts || {};
  const size = opts.size || 1, maxSeconds = opts.maxSeconds || 330;
  const M = opts.M || await loadPhysics();
  const rules = new MatchRules({ size, matchSeconds: opts.matchSeconds || 300, forfeitLead: 4 });
  const cars = [];   // {id, team, role, skill, kind}
  const humanId = M.addCar(0);
  cars.push({ id: humanId, team: 0, kind: 'human', role: 'attacker', skill: opts.playerSkill || { aim: 0.6, noise: 0.5 } });
  for (let i = 1; i < size; i++) cars.push({ id: M.addCar(0), team: 0, kind: 'bot', role: i === 1 ? 'defender' : 'attacker', skill: { aim: 1, noise: 0 } });
  for (let i = 0; i < size; i++) cars.push({ id: M.addCar(1), team: 1, kind: 'bot', role: i === 0 ? 'attacker' : 'defender', skill: opts.oppSkill || { aim: 1, noise: 0 } });

  const place = () => {
    M.resetBall();
    const n = [0, 0];
    cars.forEach((c) => {
      const s = SPOTS[n[c.team]++ % 3], sg = c.team ? -1 : 1;
      M.setCarPose(c.id, s[0] * sg, s[1] * sg, 17, c.team ? -Math.PI / 2 : Math.PI / 2, 0, 0, 0);
      M.setCarBoost(c.id, 33.3);
    });
  };
  place();

  // ---- recorder.js real, con un RS/Bots falsos mínimos
  let goalPause = 0, ctlOf = {};
  const hooks = { record: null };
  const ctlHuman = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
  const g = globalThis; g.window = g; g.addEventListener = () => {};
  g.RS = { Module: M, carId: humanId, ctl: ctlHuman, hooks, isGoalPause: () => goalPause > 0 };
  g.Bots = { cars: () => cars.filter((c) => c.kind === 'bot').map((c, i) => ({ index: i + 1, id: c.id, bot: 'SimBot', team: c.team, rank: 'Oro', ok: true, ctl: ctlOf[c.id] || null })) };
  g.__mpCarId2 = null;
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'recorder.js'), 'utf8'), { filename: 'recorder.js' });
  g.Recorder.start({ playerName: 'Player', hz: 30, force: true });

  rules.startCountdown(); rules.startPlay();
  let t = 0, goalFor = null;
  const events = [];
  while (t < maxSeconds && rules.state !== 'ended') {
    const ball = M.getBallState();
    for (const c of cars) {
      const ctl = carControl(M, c.id, c.team, c.role, ball, cars, c.skill);
      ctlOf[c.id] = ctl;
      if (c.kind === 'human') Object.assign(ctlHuman, ctl);
      M.setCarControls(c.id, ctl.throttle, ctl.steer, ctl.pitch, ctl.yaw, ctl.roll, ctl.jump, ctl.boost, ctl.handbrake);
    }
    M.step(1); t += TICK;
    if (hooks.record) hooks.record();
    if (goalPause > 0) {
      goalPause -= TICK;
      if (goalPause <= 0) { if (rules.state === 'goal') { rules.afterGoal(); rules.startPlay(); } place(); }
      continue;
    }
    rules.tick(TICK);
    const b = M.getBallState();
    if (Math.abs(b.pos.y) > 5035 && Math.abs(b.pos.x) < GOAL_HW && b.pos.z < GOAL_H) {
      goalPause = 1.6;                         // misma lógica que game.js checkBall
      rules.goal(b.pos.y > 0 ? 0 : 1);
      events.push({ t, team: b.pos.y > 0 ? 0 : 1 });
      if (rules.state === 'ended') { goalPause = 0; }
    } else if (Math.abs(b.pos.y) > 5300 || Math.abs(b.pos.x) > 4400 || b.pos.z > 2400) { place(); }
  }
  const doc = g.Recorder.stop();
  doc.meta.overtime = rules.phase === 'overtime';
  return { doc, rules, simSeconds: t, goals: events, M, cars };
}

if (process.argv[1] && process.argv[1].endsWith('match_sim.mjs')) {
  const size = +(process.argv[2] || 1), out = process.argv[3] || '/tmp/sim_match.prismas.json';
  const t0 = Date.now();
  const r = await runMatch({ size, maxSeconds: +(process.argv[4] || 330) });
  fs.writeFileSync(out, JSON.stringify(r.doc));
  console.log(`size=${size} state=${r.rules.state} result=${JSON.stringify(r.rules.result)} frames=${r.doc.frames.length} sim=${r.simSeconds.toFixed(0)}s wall=${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
}
