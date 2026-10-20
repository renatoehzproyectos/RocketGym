// Núcleo del gimnasio (sin DOM): orquesta partido -> derrota -> análisis -> reconstrucción -> práctica ->
// demostración -> evaluación -> revancha. Todo lo externo entra por `env` para poder probarlo en Node con la
// física real (tools/gym/test_cycle.mjs):
//   env.RS        window.RS de game.js (Module, carId, sim, hooks, isGoalPause, kickoff)
//   env.Bots      window.Bots de bots.js (set, status, cars, info, reset, takeover, release)
//   env.Recorder  window.Recorder de recorder.js
//   env.analyzer  {init(), analyze(doc), evaluate(error, attemptDoc)} -> Promise  (rlcoach en Pyodide)
//   env.ui        {render(vm), hud(hud), countdown(n)}
//   env.store     {load(), save(obj), saveReplay(doc), loadReplay()}
(function (root) {
  'use strict';
  const G = root.GymRules || require('./gym_rules.js');
  const TICK = 1 / 120;
  const SPEEDS = [0.25, 0.5, 0.75, 1];
  const COUNTDOWN_MS = 3000;
  const END_DELAY_MS = 1700;          // deja ver el gol final antes de congelar
  // Saque simétrico: el azul ocupa y<0, el naranja es el espejo (x,y) -> (-x,-y).
  const SPOTS = [[-2048, -2560], [2048, -2560], [0, -4608]];

  function create(env) {
    const { RS, Bots, Recorder, analyzer, ui } = env;
    const store = env.store || { load: () => null, save() {}, saveReplay() {}, loadReplay: async () => null };
    const now = env.now || (() => Date.now());
    const later = env.setTimeout || setTimeout;
    const M = () => RS.Module;

    const st = {
      phase: 'menu', ladder: null, selection: { rank: 1, mode: '1v1' }, progress: null,
      rules: null, doc: null, lastResult: null, outcome: null, analysis: null, review: null,
      speed: 0.5, cd: null, wasGp: false, error: null, hooked: false, demoCtl: null, busy: null, hudAt: 0,
    };

    // ------------------------------------------------------------------ vista
    function vm() {
      const r = st.rules, p = st.progress;
      const eff = p ? G.effectiveRank(p.selectedRank, p.bestBeatenRank) : st.selection.rank;
      const rv = st.review;
      return {
        phase: st.phase, error: st.error, busy: st.busy,
        menu: { ranks: st.ladder ? G.availableRanks(st.ladder).map((i) => ({ idx: i, name: G.RANKS[i], bots: st.ladder.filter((b) => b.rankIdx === i).map((b) => b.name) })) : [],
          modes: Object.keys(G.MODES), selection: st.selection, canResume: !!(st.saved && st.saved.review) },
        hud: r ? { score: r.score.slice(), clock: r.clock, overtime: r.phase === 'overtime', state: r.state, size: p ? p.size : 1,
          opponents: p ? G.opponentTeam(st.ladder, p.level, p.size) : [] } : null,
        result: st.lastResult,
        review: rv && {
          idx: rv.idx, total: st.analysis.errors.length, error: st.analysis.errors[rv.idx], mode: rv.mode, speed: st.speed, speeds: SPEEDS,
          attempts: rv.attempts, evaluation: rv.evaluation, fixed: rv.fixed.length, demo: demoInfo(eff), demoSeen: rv.demoSeen,
        },
        rematch: p && p.lostTo ? { opponents: p.lostTo.opponents, level: p.level, rank: G.RANKS[st.ladder[p.level].rankIdx], fixed: rv ? rv.fixed.length : 0, total: st.analysis ? st.analysis.errors.length : 0 } : null,
        progress: p ? { mode: p.mode, level: p.level, bot: st.ladder[p.level].name, rank: G.RANKS[st.ladder[p.level].rankIdx], effRank: G.RANKS[eff] } : null,
      };
    }
    const render = () => ui.render(vm());
    function demoInfo(effRank) {
      const name = G.demoBotFor(st.ladder, effRank);
      if (!name) return { available: false, reason: 'top_rank' };
      return { available: true, bot: name, rank: G.RANKS[st.ladder.find((b) => b.name === name).rankIdx], loading: st.busy === 'demo_loading' };
    }

    // ------------------------------------------------------------------ hooks del juego
    function install() {
      if (st.hooked) return; st.hooked = true;
      const h = RS.hooks, pt = h.tick, pk = h.kickoff, pc = h.controls, pr = h.resetBall;
      h.tick = () => { if (pt) pt(); onTick(); };
      h.kickoff = () => { if (pk) pk(); onKickoff(); };
      h.controls = (ctl, dt) => { if (pc) pc(ctl, dt); onControls(ctl); };
      h.resetBall = () => { if (st.phase === 'match' || st.phase === 'review') return; if (pr) pr(); else M().resetBall(); };  // la R no vale en partido/práctica
    }

    const carIdFor = (pid) => {
      if (pid === 'human') return RS.carId;
      const n = +String(pid).replace('bot-', '');
      const c = Bots.cars().find((x) => x.index === n);
      return c ? c.id : null;
    };
    const idle = (id) => M().setCarControls(id, 0, 0, 0, 0, 0, false, false, false);
    const releaseDemo = () => { if (Bots.release) Bots.release(); st.demoReady = null; st.demoCtl = null; };

    function placeKickoff() {
      M().resetBall();
      const n = [0, 0];
      const cars = [{ id: RS.carId, team: 0 }].concat(Bots.cars().map((c) => ({ id: c.id, team: c.team ? 1 : 0 })));
      cars.forEach((c) => {
        if (c.id == null) return;
        const s = SPOTS[n[c.team]++ % SPOTS.length], sg = c.team ? -1 : 1;
        M().setCarPose(c.id, s[0] * sg, s[1] * sg, 17, c.team ? -Math.PI / 2 : Math.PI / 2, 0, 0, 0);
        M().setCarBoost(c.id, 33.3);
        idle(c.id);
      });
    }

    function onKickoff() {
      if (st.phase !== 'match' || !st.rules || st.rules.state === 'ended') return;
      placeKickoff();
      if (st.rules.state === 'goal') st.rules.afterGoal(); else st.rules.startCountdown();
      beginCountdown();
    }

    function onControls(ctl) {
      const rv = st.review;
      if (st.phase === 'review' && rv && rv.mode === 'demo' && st.demoCtl) {
        const c = st.demoCtl;
        ctl.throttle = c[0]; ctl.steer = c[1]; ctl.pitch = c[2]; ctl.yaw = c[3]; ctl.roll = c[4];
        ctl.jump = !!c[5]; ctl.boost = !!c[6]; ctl.handbrake = !!c[7];
      }
    }

    function ballTeamScored() { return M().getBallState().pos.y > 0 ? 0 : 1; }   // el azul ataca +Y

    function onTick() {
      if (st.phase === 'match') matchTick();
      else if (st.phase === 'review' && st.review && (st.review.mode === 'attempt' || st.review.mode === 'demo')) practiceTick();
    }

    // ------------------------------------------------------------------ partido
    function beginCountdown() {
      RS.sim.paused = true; RS.sim.timeScale = 1;
      st.cd = { endsAt: now() + COUNTDOWN_MS, shown: 4 };
      ui.countdown(3);
    }
    function frame(nowMs) {     // lo llama la UI (rAF) o la prueba, DESPUÉS de la física del frame
      const t = nowMs == null ? now() : nowMs;
      if (st.pendingRestore) {
        st.pendingRestore = false;
        if (st.phase === 'review' && st.review) { restoreScenario(); st.review.mode = 'ready'; render(); }
      }
      if (st.cd) {
        const left = Math.ceil((st.cd.endsAt - t) / 1000);
        if (t >= st.cd.endsAt) {
          st.cd = null; ui.countdown(0);
          if (st.phase === 'match' && st.rules) { st.wasGp = RS.isGoalPause(); st.rules.startPlay(); RS.sim.paused = false; }
        } else if (left !== st.cd.shown) { st.cd.shown = left; ui.countdown(left); }
      }
      if (st.rules && t - st.hudAt > 200) { st.hudAt = t; ui.hud(vm().hud); }
    }

    function matchTick() {
      const r = st.rules; if (!r) return;
      r.tick(TICK);
      const gp = RS.isGoalPause();
      if (gp && !st.wasGp && r.state === 'playing') {
        r.goal(ballTeamScored());
        if (r.state === 'ended') onMatchEnded();
      }
      st.wasGp = gp;
      if (r.state === 'ended' && st.phase === 'match' && !st.endingScheduled) onMatchEnded();   // fin por tiempo
    }

    function onMatchEnded() {
      if (st.endingScheduled) return;
      st.endingScheduled = true;
      RS.sim.holdKickoff = true;                // el estado 'ended' manda: ni el saque automático reabre el partido
      RS.sim.noGoal = true;                     // y la pelota quieta en la red no vuelve a contar como gol
      later(finishMatch, END_DELAY_MS);
    }

    async function finishMatch() {
      RS.sim.paused = true;
      const rules = st.rules, p = st.progress;
      let doc = Recorder.stop();
      if (doc) {
        doc.score = { blue: rules.score[0], orange: rules.score[1] };        // la fuente de verdad es el estado del partido
        if (doc.events && doc.events.goals) doc.events.goals = doc.events.goals.slice(0, rules.goals.length);
        doc.meta.overtime = rules.phase === 'overtime';
        doc.meta.gym = { mode: p.mode, level: p.level, reason: rules.result.reason };
      }
      st.doc = doc;
      if (doc) { try { store.saveReplay(doc); } catch (e) { /* sin IndexedDB: se sigue */ } }
      const res = rules.result;
      const applied = G.applyResult(st.ladder, p, res, 0);
      st.progress = applied.next;
      st.lastResult = { outcome: applied.outcome, result: res, score: res.score.slice(), bot: st.ladder[p.level].name,
        unlocked: applied.outcome === 'advance' ? st.ladder[applied.next.level].name : null };
      persist();
      if (applied.outcome === 'lost') {
        st.phase = 'analyzing'; st.busy = 'analyzing'; render();
        await runAnalysis();
      } else { st.phase = 'result'; render(); }
    }

    async function runAnalysis() {
      let out;
      try { out = st.doc ? await analyzer.analyze(st.doc) : { ok: false, error: 'no_recording' }; }
      catch (e) { out = { ok: false, error: String(e) }; }
      st.busy = null;
      if (!out || !out.ok || !out.errors.length) {
        st.error = (out && out.error) || 'no_errors'; st.phase = 'result'; st.analysis = null; render(); return;
      }
      st.analysis = out; st.error = null;
      persist();
      enterReview(0, []);
    }

    // ------------------------------------------------------------------ roster
    async function ensureRoster(opponents, mates, timeoutMs) {
      const want = JSON.stringify([mates, opponents]);
      if (st.rosterKey !== want) {
        Bots.set({ blue: mates, orange: opponents });
        st.rosterKey = want;
      }
      const t0 = now();
      for (;;) {
        const s = Bots.status();
        if (s.length === mates.length + opponents.length && s.every((x) => x.ok === true)) return true;
        if (s.some((x) => x.ok === false)) throw new Error('bot_failed');
        if (now() - t0 > (timeoutMs || 90000)) throw new Error('bot_timeout');
        await new Promise((r) => later(r, env.pollMs || 150));
      }
    }

    async function startMatch(rosterOverride) {
      install();
      const p = st.progress;
      const opponents = rosterOverride ? rosterOverride.opponents : G.opponentTeam(st.ladder, p.level, p.size);
      const mates = rosterOverride ? rosterOverride.teammates : G.teammates(st.ladder, p.selectedRank, p.size);
      st.phase = 'loading'; st.busy = 'bots'; st.error = null; render();
      try { await ensureRoster(opponents, mates); }
      catch (e) { st.phase = 'menu'; st.busy = null; st.error = String(e.message || e); render(); return false; }
      st.busy = null;
      st.review = null; st.analysis = null; st.lastResult = null; st.endingScheduled = false;
      releaseDemo();
      st.rules = new G.MatchRules({ size: p.size });
      st.phase = 'match';
      RS.sim.holdKickoff = false; RS.sim.noGoal = false; RS.sim.timeScale = 1; RS.sim.lockInput = false;
      placeKickoff();
      Recorder.start({ playerName: 'You', hz: 30, maxSeconds: 1500, force: true });
      st.rules.startCountdown(); beginCountdown();
      persist(); render();
      return true;
    }

    // ------------------------------------------------------------------ revisión
    function enterReview(idx, fixed) {
      st.phase = 'review';
      st.review = Object.assign(st.review || {}, { idx, mode: 'ready', attempts: 0, evaluation: null, fixed: fixed || (st.review ? st.review.fixed : []), demoSeen: false, attemptT: 0, goalAgainst: false });
      RS.sim.noGoal = false; RS.sim.holdKickoff = true; RS.sim.lockInput = false;
      restoreScenario();
      preloadDemo();
      persist(); render();
    }
    const scenario = () => st.analysis.errors[st.review.idx].scenario;

    // Reconstruye el estado justo antes del error con lo que el simulador SÍ puede fijar: pelota (pos+vel),
    // cada auto (pos, yaw, vel, boost). No puede fijar giro de pelota ni cabeceo/alabeo/giro/flip del auto.
    function restoreScenario() {
      const sc = scenario();
      RS.sim.paused = true; RS.sim.timeScale = 1;
      M().setBallState(sc.ball.p[0], sc.ball.p[1], sc.ball.p[2], sc.ball.v[0], sc.ball.v[1], sc.ball.v[2]);
      sc.cars.forEach((c) => {
        const id = carIdFor(c.id); if (id == null) return;
        M().setCarPose(id, c.p[0], c.p[1], c.p[2], c.yaw, c.v[0], c.v[1], c.v[2]);
        M().setCarBoost(id, c.boost);
        idle(id);
      });
      Bots.reset && Bots.reset();           // bots con la cabeza limpia, sin rutinas viejas
      st.demoCtl = null;
      st.review.attemptT = 0; st.review.goalAgainst = false; st.wasGp = RS.isGoalPause();
      if (st.review.mode !== 'ready') st.review.mode = 'ready';
    }

    function setSpeed(s) {
      if (SPEEDS.indexOf(s) < 0) return;
      st.speed = s; persist();
      if (st.review && (st.review.mode === 'attempt' || st.review.mode === 'demo')) RS.sim.timeScale = s;
      render();
    }

    function beginAttempt() {
      const rv = st.review;
      restoreScenario();
      rv.mode = 'attempt'; rv.attempts++; rv.evaluation = null;
      Recorder.start({ playerName: 'You', hz: 30, maxSeconds: 60, force: true });
      RS.sim.timeScale = st.speed; RS.sim.paused = false;
      render();
    }

    function practiceTick() {
      const rv = st.review, sc = scenario();
      rv.attemptT += TICK;
      const gp = RS.isGoalPause();
      if (gp && !st.wasGp) {
        const against = ballTeamScored() !== 0;     // gol hacia el arco azul = gol en contra del jugador
        if (rv.mode === 'attempt') { rv.goalAgainst = against; rv.goalFor = !against; endAttempt(); }
        else endDemo();
      } else if (rv.attemptT >= sc.window_s) {
        if (rv.mode === 'attempt') endAttempt(); else endDemo();
      }
      st.wasGp = gp;
    }

    async function endAttempt() {
      const rv = st.review; if (rv.mode !== 'attempt') return;
      rv.mode = 'evaluating'; RS.sim.paused = true; render();
      const doc = Recorder.stop();
      let ev;
      if (!doc) ev = { corrected: false, score: 0, reasons: ['attempt_too_short'], metrics: {} };
      else {
        doc.outcome = { goal_against: !!rv.goalAgainst, goal_for: !!rv.goalFor };
        try { ev = await analyzer.evaluate(st.analysis.errors[rv.idx], doc); } catch (e) { ev = { corrected: false, score: 0, reasons: ['evaluator_failed'], metrics: {}, error: String(e) }; }
        if (ev && ev.ok === false) ev = { corrected: false, score: 0, reasons: ['evaluator_failed'], metrics: {}, error: ev.error };
      }
      rv.evaluation = ev; rv.mode = 'result';
      render();
    }

    // Demostración: un bot de EXACTAMENTE un rango disponible por encima conduce el auto del jugador.
    async function preloadDemo() {
      const p = st.progress, eff = G.effectiveRank(p.selectedRank, p.bestBeatenRank);
      const name = G.demoBotFor(st.ladder, eff);
      if (!name || !Bots.takeover) return;
      st.busy = 'demo_loading'; render();
      try { await Bots.takeover(name, (c) => { st.demoCtl = c; }); st.demoReady = name; } catch (e) { st.demoReady = null; }
      st.busy = null; render();
    }
    async function startDemo() {
      const rv = st.review;
      if (!st.demoReady) { await preloadDemo(); if (!st.demoReady) return false; }
      restoreScenario();
      rv.mode = 'demo'; rv.demoSeen = true;
      RS.sim.timeScale = st.speed; RS.sim.paused = false;
      render(); return true;
    }
    function endDemo() {
      const rv = st.review; if (rv.mode !== 'demo') return;
      RS.sim.paused = true; st.demoCtl = null;
      // game.js termina los ticks restantes del frame aunque esté en pausa: la restauración se hace al final del
      // frame (gym.frame), para que el control vuelva al jugador EXACTAMENTE en el punto de partida.
      rv.mode = 'restoring'; st.pendingRestore = true;
    }

    function nextError() {
      const rv = st.review;
      if (rv.evaluation && rv.evaluation.corrected && rv.fixed.indexOf(rv.idx) < 0) rv.fixed.push(rv.idx);
      if (rv.idx + 1 < st.analysis.errors.length) enterReview(rv.idx + 1, rv.fixed);
      else finishReview();
    }
    function finishReview() {
      releaseDemo();
      RS.sim.paused = true;
      st.phase = 'rematch'; persist(); render();
    }

    // ------------------------------------------------------------------ persistencia
    function persist() {
      try {
        store.save({ selection: st.selection, progress: st.progress, speed: st.speed,
          review: st.review && st.analysis ? { idx: st.review.idx, fixed: st.review.fixed, analysis: st.analysis } : null });
      } catch (e) { /* almacenamiento lleno/bloqueado: no es fatal */ }
    }

    // ------------------------------------------------------------------ acciones (las dispara la UI)
    async function act(name, a) {
      a = a || {};
      switch (name) {
        case 'select': Object.assign(st.selection, a); render(); return;
        case 'start': {
          st.progress = G.newProgress(st.ladder, st.selection.mode, st.selection.rank);
          return startMatch();
        }
        case 'resume': {
          const sv = st.saved; if (!sv || !sv.review) return;
          st.progress = sv.progress; st.analysis = sv.review.analysis;
          st.phase = 'loading'; st.busy = 'bots'; render();
          const lt = st.progress.lostTo;
          try { await ensureRoster(lt.opponents, lt.teammates); } catch (e) { st.phase = 'menu'; st.busy = null; st.error = String(e.message || e); render(); return; }
          st.busy = null; st.review = { fixed: sv.review.fixed || [] };
          install(); return enterReview(Math.min(sv.review.idx, st.analysis.errors.length - 1), sv.review.fixed || []);
        }
        case 'next_match': return startMatch();
        case 'speed': return setSpeed(a.value);
        case 'go': return beginAttempt();
        case 'retry': { if (st.review.mode === 'attempt') { Recorder.stop(); } restoreScenario(); st.review.mode = 'ready'; render(); return; }
        case 'finish_attempt': return endAttempt();
        case 'demo': return startDemo();
        case 'stop_demo': return endDemo();
        case 'next': return nextError();
        case 'skip': return nextError();
        case 'rematch': { const lt = st.progress.lostTo; st.analysis = null; st.review = null; return startMatch({ opponents: lt.opponents, teammates: lt.teammates }); }
        case 'menu': st.phase = 'menu'; RS.sim.paused = false; RS.sim.holdKickoff = false; releaseDemo(); render(); return;
        default: return;
      }
    }

    function open(manifestBots) {
      st.ladder = G.buildLadder(manifestBots);
      st.saved = store.load();
      if (st.saved && st.saved.selection) Object.assign(st.selection, st.saved.selection);
      if (st.saved && st.saved.speed) st.speed = st.saved.speed;
      if (G.availableRanks(st.ladder).indexOf(st.selection.rank) < 0) st.selection.rank = G.availableRanks(st.ladder)[0];
      st.phase = 'menu'; install(); render();
      if (analyzer.init) analyzer.init().catch(() => {});     // calienta Pyodide mientras el jugador elige
    }

    return { open, act, frame, vm, state: st, _internals: { restoreScenario, placeKickoff, carIdFor, matchTick, practiceTick } };
  }

  const api = { create, SPEEDS, SPOTS, TICK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GymCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
