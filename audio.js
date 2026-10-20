// Audio del juego (pack RocketLeague-Audio, dominio público). Capa de solo lectura sobre RS: no toca la física.
//   RLAudio.hit(intensidad 0..1, 'ball'|'wall')  · RLAudio.goal() · RLAudio.countdown(n) · RLAudio.ui(nombre) · RLAudio.play(nombre, {gain, rate, delay})
// Qué sonido es cuál se define en audio/manifest.json (generado por tools/audio/build_audio.py). ?audio=0 lo desactiva. Tecla M = silenciar.
(function () {
  'use strict';
  const NOOP = function () {};
  const api = { hit: NOOP, goal: NOOP, countdown: NOOP, ui: NOOP, play: NOOP };
  window.RLAudio = api;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || new URLSearchParams(location.search).get('audio') === '0') return;

  const LEVELS = [1, 0.55, 0.25, 0], ICONS = ['🔊', '🔉', '🔈', '🔇'];
  let lvl = 0; try { const s = parseInt(localStorage.getItem('rl_audio_lv'), 10); if (s >= 0 && s < LEVELS.length) lvl = s; } catch (e) { /* sin storage */ }
  let ctx = null, master = null, bus = null;
  const raw = {}, buf = {};            // raw: ArrayBuffer descargado · buf: AudioBuffer decodificado
  let manifest = null, btn = null;

  // ---------------------------------------------------------------- carga
  const fetching = fetch('audio/manifest.json').then((r) => r.json()).then((m) => {
    manifest = m;
    return Promise.all(Object.keys(m).map((k) => fetch('audio/' + m[k].file).then((r) => r.arrayBuffer()).then((ab) => { raw[k] = ab; })));
  }).catch((e) => console.warn('[audio] no se pudo cargar audio/:', e));

  const decode = (ab) => new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
  function decodeAll() {
    fetching.then(() => Promise.all(Object.keys(raw).map((k) => decode(raw[k]).then((b) => { buf[k] = b; delete raw[k]; }).catch((e) => console.warn('[audio] decode', k, e)))));
  }

  function ensure() {
    if (ctx) return;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain(); master.gain.value = LEVELS[lvl] * 0.9;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    bus = ctx.createGain(); bus.connect(master); master.connect(comp); comp.connect(ctx.destination);
    decodeAll();
  }
  function unlock() {
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (ctx.state === 'running') ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.removeEventListener(e, unlock, true));
  }
  ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.addEventListener(e, unlock, true));
  document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else ctx.resume(); });

  function setLevel(i) {
    lvl = i; try { localStorage.setItem('rl_audio_lv', String(i)); } catch (e) { /* sin storage */ }
    if (master) master.gain.setTargetAtTime(LEVELS[i] * 0.9, ctx.currentTime, 0.03);
    if (btn) btn.textContent = ICONS[i];
  }
  function buildButton() {
    btn = document.createElement('button'); btn.id = 'rl-snd'; btn.type = 'button'; btn.title = 'Sonido (M)'; btn.textContent = ICONS[lvl];
    btn.addEventListener('click', () => setLevel((lvl + 1) % LEVELS.length));
    document.body.appendChild(btn);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildButton); else buildButton();
  window.addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.repeat && !e.ctrlKey && !e.metaKey) setLevel(lvl === LEVELS.length - 1 ? 0 : LEVELS.length - 1); });

  // ---------------------------------------------------------------- reproducción
  function play(name, o) {
    if (!ctx || ctx.state !== 'running' || !buf[name]) return null;
    o = o || {};
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf[name]; if (o.rate) s.playbackRate.value = o.rate;
    g.gain.value = o.gain == null ? 1 : o.gain; s.connect(g); g.connect(bus);
    s.start(ctx.currentTime + (o.delay || 0));
    return s;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function mkLoop(name, startAt) {
    if (!buf[name]) return null;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf[name]; s.loop = true; g.gain.value = 0; s.connect(g); g.connect(bus);
    s.start(0, startAt == null ? Math.random() * buf[name].duration : startAt);
    return { s, g, gain: 0, rate: 1 };
  }
  function setLoop(l, gain, rate) {
    if (!l) return;
    if (Math.abs(gain - l.gain) > 0.004) { l.gain = gain; l.g.gain.setTargetAtTime(gain, ctx.currentTime, 0.06); }
    if (rate != null && Math.abs(rate - l.rate) > 0.004) { l.rate = rate; l.s.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.1); }
  }

  // ---------------------------------------------------------------- golpes / gol / cuenta atrás / UI
  const HIT = { soft: ['hit_soft_1', 'hit_soft_2'], med: ['hit_med_1', 'hit_med_2'], hard: ['hit_hard_1', 'hit_hard_2', 'hit_hard_3'] };
  let lastHit = 0, lastPick = '', swellUntil = 0;
  api.hit = function (intensity, kind) {
    const now = performance.now(); if (now - lastHit < 70) return; lastHit = now;
    const wall = kind === 'wall', k = clamp(intensity == null ? 0.5 : intensity, 0, 1);
    const group = HIT[k < 0.3 ? 'soft' : k < 0.65 || wall ? 'med' : 'hard'];
    let name; do { name = group[(Math.random() * group.length) | 0]; } while (name === lastPick && group.length > 1);
    lastPick = name;
    play(name, { gain: (0.3 + 0.7 * k) * (wall ? 0.8 : 1), rate: (wall ? 0.88 : 1) + Math.random() * 0.1 });
  };
  api.goal = function () { play('goal', { gain: 0.8 }); play('crowd_cheer', { gain: 0.7, delay: 0.12 }); swellUntil = performance.now() + 4500; };
  api.countdown = function (n) { if (n > 0) play('cd_tick', { gain: 0.7 }); else if (n === 0) play('cd_go', { gain: 0.8 }); };
  let lastUi = 0;
  api.ui = function (name) { const now = performance.now(); if (name === 'hover' && now - lastUi < 60) return; lastUi = now; play('ui_' + name, { gain: name === 'hover' ? 0.35 : 0.6 }); };
  api.play = play;

  const UI_SEL = '#start-menu button, #gym button, #cui-root button';
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest(UI_SEL); if (!b || b.disabled) return;
    api.ui(b.classList.contains('alt') || b.classList.contains('on') || b.classList.contains('cui-tab') ? 'click' : 'confirm');
  }, true);
  let hovered = null;
  if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
    document.addEventListener('mouseover', (e) => {
      const b = e.target.closest && e.target.closest(UI_SEL); if (b === hovered) return; hovered = b;
      if (b && !b.disabled) api.ui('hover');
    }, true);
  }

  // ---------------------------------------------------------------- motor, boost, derrape, salto/flip/aterrizaje (por frame)
  let eng = null, boostL = null, skidL = null, crowd = null;
  let prevJump = false, prevGround = true, prevVz = 0, airUsed = false, prevBoosting = false, lastLand = 0;
  (function frame() {
    requestAnimationFrame(frame);
    if (!ctx || ctx.state !== 'running') return;
    const RS = window.RS; if (!RS || !RS.getState) return;
    if (!eng && buf.engine_idle && buf.engine_mid && buf.engine_high) eng = [mkLoop('engine_idle'), mkLoop('engine_mid'), mkLoop('engine_high')];
    if (!boostL) boostL = mkLoop('boost_loop');
    if (!skidL) skidL = mkLoop('skid_loop');
    if (!crowd) crowd = mkLoop('crowd_loop');

    const gym = window.__gym, phase = gym && gym.state ? gym.state.phase : null;
    const live = !document.getElementById('start-menu') && (!gym || phase === 'match' || phase === 'review');
    const paused = !!(RS.sim && RS.sim.paused) || (RS.isGoalPause && RS.isGoalPause());
    const s = RS.getState(), c = RS.ctl || {}, v = s.carVel, speed = Math.hypot(v.x, v.y, v.z);
    const sp = Math.min(speed / 2300, 1), thr = Math.abs(c.throttle) || 0, ground = !!s.isOnGround;
    const infB = RS.getInfBoost && RS.getInfBoost();
    const boosting = live && !paused && !!c.boost && (infB || s.boost > 0.5);

    // motor: 3 capas (ralentí / medio / alto) mezcladas por RPM, con el tono subiendo con la velocidad
    let rpm = ground ? 0.12 + 0.68 * sp + 0.12 * thr : 0.2 + 0.5 * thr + 0.2 * sp;
    if (boosting) rpm += 0.12; rpm = clamp(rpm, 0, 1);
    const E = live ? 0.55 : 0;
    if (eng) {
      setLoop(eng[0], clamp(1 - rpm * 2.2, 0, 1) * E, 0.85 + 0.5 * rpm);
      setLoop(eng[1], clamp(1 - Math.abs(rpm - 0.45) * 2.6, 0, 1) * E, 0.75 + 0.7 * rpm);
      setLoop(eng[2], clamp((rpm - 0.35) * 2.2, 0, 1) * E, 0.8 + 0.55 * rpm);
    }
    setLoop(boostL, boosting ? 0.5 : 0, 1);
    if (boosting && !prevBoosting) play('boost_start', { gain: 0.5 });
    if (!boosting && prevBoosting && live) play('boost_end', { gain: 0.35 });
    prevBoosting = boosting;
    setLoop(skidL, live && !paused && c.handbrake && ground && speed > 350 ? Math.min(1, speed / 1500) * 0.5 : 0, 1);
    setLoop(crowd, live ? (performance.now() < swellUntil ? 0.5 : 0.2) : 0, 1);

    if (live && !paused) {
      const jump = !!c.jump;
      if (jump && !prevJump) {
        if (prevGround) { play('jump', { gain: 0.55 }); airUsed = false; }
        else if (!airUsed) { play('flip', { gain: 0.55 }); airUsed = true; }
      }
      prevJump = jump;
      const now = performance.now();
      if (ground && !prevGround && prevVz < -350 && now - lastLand > 200) { lastLand = now; play('land', { gain: clamp(-prevVz / 1800, 0.15, 1) * 0.7 }); }
      if (ground) airUsed = false;
    } else prevJump = !!c.jump;
    prevGround = ground; prevVz = v.z;
  })();
})();
