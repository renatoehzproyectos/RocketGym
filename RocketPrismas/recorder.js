// Grabador de partidas para rlcoach. Sin UI, sin modos nuevos: solo una API de consola/código.
//
//   Bots.set({orange:['Nexto']})        // esperar a que el bot cargue (Bots.status()[0].ok === true)
//   Recorder.start()                    // empieza a grabar (jugador + bots)
//   ... jugar ...
//   Recorder.download()                 // para y baja  match-AAAAMMDD-HHMMSS.prismas.json
//
// Luego, con el rlcoach incluido:  python tools/analyze_match.py match-....prismas.json
// Formato: tools/rlcoach/docs/prismas_recording_format.md  (format "rlcoach.prismas.recording", v1)
//
// API: Recorder.start({hz=30, playerName='Player', maxSeconds=1800, force=false}) -> bool
//      Recorder.stop() -> doc | null     Recorder.download([nombre]) -> bool
//      Recorder.json() -> string | null  Recorder.last() -> doc | null     Recorder.status()
// No modifica la física ni el juego: solo lee el estado tras cada tick (HOOKS.record en game.js).
(function () {
  'use strict';
  const FORMAT = 'rlcoach.prismas.recording', VERSION = 1, SIM_HZ = 120;
  const TOUCH_DV = 120;      // uu/s: cambio de velocidad de la pelota para contar un golpe (solo atribuye goles)
  const TOUCH_DIST = 230;    // uu: radio pelota (91) + alcance del auto
  const RANK_EN = { plata: 'Silver', oro: 'Gold', platino: 'Platinum', diamante: 'Diamond',
    'gran campeón': 'Grand Champion', 'gran campeon': 'Grand Champion', campeón: 'Champion', campeon: 'Champion' };
  const log = (...a) => console.log('[Recorder]', ...a);

  let RS = null, rec = null, lastDoc = null;

  const r1 = (v) => Math.round(v * 10) / 10;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const v3 = (o) => [r1(o.x), r1(o.y), r1(o.z)];
  const w3 = (o) => [r3(o.x), r3(o.y), r3(o.z)];

  function rankEn(s) {
    if (!s) return null;
    return String(s).replace(/\*/g, '').split(/[–-]/)
      .map((p) => { const k = p.trim().toLowerCase(); return RANK_EN[k] || p.trim(); }).join('-');
  }

  // rot9 de RocketSim = [forward(3), right(3), up(3)]. rlcoach espera un cuaternión (x,y,z,w) de un marco
  // diestro con x=adelante, y=izquierda, z=arriba (así deriva yaw/pitch/roll), por eso left = up × forward.
  function quatFromRot9(m) {
    const fx = m[0], fy = m[1], fz = m[2], ux = m[6], uy = m[7], uz = m[8];
    const lx = uy * fz - uz * fy, ly = uz * fx - ux * fz, lz = ux * fy - uy * fx;
    const m00 = fx, m01 = lx, m02 = ux, m10 = fy, m11 = ly, m12 = uy, m20 = fz, m21 = lz, m22 = uz;
    const tr = m00 + m11 + m22;
    let x, y, z, w, s;
    if (tr > 0) { s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
    else if (m00 > m11 && m00 > m22) { s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
    else if (m11 > m22) { s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
    else { s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
    const n = Math.hypot(x, y, z, w) || 1;
    return [r5(x / n), r5(y / n), r5(z / n), r5(w / n)];
  }

  function inputsOf(c) {   // c: objeto {throttle,steer,pitch,yaw,roll,jump,boost,handbrake} o array de bots.js
    if (!c) return null;
    if (Array.isArray(c)) c = { throttle: c[0], steer: c[1], pitch: c[2], yaw: c[3], roll: c[4], jump: c[5], boost: c[6], handbrake: c[7] };
    return { throttle: r3(+c.throttle || 0), steer: r3(+c.steer || 0), pitch: r3(+c.pitch || 0), yaw: r3(+c.yaw || 0),
      roll: r3(+c.roll || 0), jump: !!c.jump, boost: !!c.boost, handbrake: !!c.handbrake };
  }

  function carRecord(cs, ctl) {
    const m = []; for (let i = 0; i < 9; i++) m.push(cs.rot.get(i));
    const o = { p: v3(cs.pos), v: v3(cs.vel), w: w3(cs.angVel), q: quatFromRot9(m), boost: r1(cs.boost),
      ground: !!cs.isOnGround, super: !!cs.isSupersonic };
    const inp = inputsOf(ctl); if (inp) o.in = inp;
    return o;
  }

  function sample(R) {
    const t = r3((R.tick - R.t0) / SIM_HZ);
    const b = RS.Module.getBallState();
    const bots = window.Bots && window.Bots.cars ? window.Bots.cars() : [];
    const cars = {}, pos = {};
    for (const pl of R.players) {
      let id = pl.carId, ctl = null;
      if (pl.kind === 'human') ctl = RS.ctl;
      else if (pl.kind === 'human2') ctl = window.__mpRemoteControls || null;
      else { const bc = bots.find((x) => x.index === pl.botIndex); ctl = bc ? bc.ctl : null; id = bc && bc.id != null ? bc.id : id; }
      if (id == null) continue;
      const cs = RS.Module.getCarState(id);
      if (!cs || !cs.pos) continue;
      cars[pl.id] = carRecord(cs, ctl);
      pos[pl.id] = cs.pos;
    }
    // Último que tocó la pelota (solo para atribuir goles; no se exportan toques: rlcoach los infiere).
    const bv = b.vel;
    if (R.prevBallV) {
      const dv = Math.hypot(bv.x - R.prevBallV[0], bv.y - R.prevBallV[1], bv.z - R.prevBallV[2]);
      if (dv > TOUCH_DV) {
        let best = null, bd = TOUCH_DIST;
        for (const id in pos) { const p = pos[id], d = Math.hypot(p.x - b.pos.x, p.y - b.pos.y, p.z - b.pos.z); if (d < bd) { bd = d; best = id; } }
        if (best) R.lastToucher = best;
      }
    }
    R.prevBallV = [bv.x, bv.y, bv.z];

    // Gol: flanco de subida de la pausa de gol del juego. Azul ataca +Y, naranja -Y.
    const paused = RS.isGoalPause();
    if (paused && !R.wasPaused) {
      const team = b.pos.y > 0 ? 0 : 1;
      R.goals.push({ t, team, player: R.lastToucher });
      if (team === 0) R.score.blue++; else R.score.orange++;
      R.lastToucher = null;
    }
    R.wasPaused = paused;

    R.frames.push({ t, ball: { p: v3(b.pos), v: v3(b.vel), w: w3(b.angVel) }, cars });
    return t;
  }

  function onTick() {
    const R = rec; if (!R || !R.active) return;
    R.tick++;
    if ((R.tick - R.t0) % R.every !== 0) return;
    try {
      const t = sample(R);
      if (t >= R.maxSeconds) { log('límite de ' + R.maxSeconds + ' s alcanzado; deteniendo'); stop(); }
    } catch (e) {
      if (++R.errors === 1) log('error al muestrear (se ignora):', e);
      if (R.errors > 20) { log('demasiados errores; deteniendo'); stop(); }
    }
  }

  function start(opts) {
    opts = opts || {};
    if (!RS) { log('el juego aún no está listo (RS)'); return false; }
    if (rec && rec.active) { log('ya se está grabando; usa Recorder.stop()'); return false; }
    const bots = window.Bots && window.Bots.cars ? window.Bots.cars() : [];
    if (!opts.force && bots.some((b) => b.id == null || b.ok !== true)) {
      log('hay bots cargando o fallidos (Bots.status()); espera a ok:true o usa {force:true}');
      return false;
    }
    const every = Math.max(1, Math.round(SIM_HZ / Math.min(Math.max(+opts.hz || 30, 5), SIM_HZ)));
    const players = [{ id: 'human', kind: 'human', carId: RS.carId, name: String(opts.playerName || 'Player'), team: 0, is_bot: false }];
    if (window.__mpCarId2 != null) players.push({ id: 'human2', kind: 'human2', carId: window.__mpCarId2, name: 'Player 2', team: 1, is_bot: false });
    const seen = {};
    bots.forEach((b) => {
      seen[b.bot] = (seen[b.bot] || 0) + 1;
      players.push({ id: 'bot-' + b.index, kind: 'bot', botIndex: b.index, carId: b.id, team: b.team ? 1 : 0, is_bot: true,
        name: seen[b.bot] > 1 ? b.bot + ' (' + seen[b.bot] + ')' : b.bot, bot: b.bot, bot_rank: rankEn(b.rank) });
    });
    rec = { active: true, every, hz: SIM_HZ / every, tick: 0, t0: 0, frames: [], goals: [], score: { blue: 0, orange: 0 },
      players, lastToucher: null, prevBallV: null, wasPaused: false, errors: 0, maxSeconds: +opts.maxSeconds || 1800,
      startedAt: new Date().toISOString() };
    RS.hooks.record = onTick;
    try { sample(rec); } catch (e) { log('no se pudo leer el estado inicial:', e); RS.hooks.record = null; rec = null; return false; }
    log('grabando a ' + rec.hz + ' Hz: ' + players.map((p) => p.name).join(', '));
    return true;
  }

  function build(R) {
    const last = R.frames[R.frames.length - 1];
    const per = [0, 0];
    R.players.forEach((p) => { per[p.team]++; });
    const hasBots = R.players.some((p) => p.is_bot);
    return {
      format: FORMAT, version: VERSION,
      meta: {
        map: 'DFHStadium', team_size: Math.max(1, per[0], per[1]), record_hz: R.hz,
        match_guid: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'prismas-' + Date.now(),
        duration: last ? last.t : 0, overtime: false, engine: 'rocketsim-web',
        playlist: hasBots ? 'prismas_vs_bots' : 'prismas_solo', started_at_utc: R.startedAt, source: 'RocketPrismas',
      },
      players: R.players.map((p) => {
        const o = { id: p.id, name: p.name, team: p.team, is_bot: p.is_bot };
        if (p.is_bot) { o.bot = p.bot; if (p.bot_rank) o.bot_rank = p.bot_rank; }
        return o;
      }),
      score: { blue: R.score.blue, orange: R.score.orange },
      events: { goals: R.goals },
      frames: R.frames,
    };
  }

  function stop() {
    const R = rec; if (!R) return null;
    if (R.active) {
      R.active = false;
      if (RS && RS.hooks.record === onTick) RS.hooks.record = null;
    }
    if (R.frames.length < 2) { log('grabación demasiado corta; descartada'); rec = null; return null; }
    lastDoc = build(R); rec = null;
    log('detenida: ' + lastDoc.frames.length + ' frames, ' + lastDoc.meta.duration + ' s, marcador ' + lastDoc.score.blue + '-' + lastDoc.score.orange);
    return lastDoc;
  }

  function json() { return lastDoc ? JSON.stringify(lastDoc) : null; }

  function download(name) {
    if (rec && rec.active) stop();
    const s = json(); if (!s) { log('no hay grabación para descargar'); return false; }
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    let fn = name || 'match-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
    if (!/\.prismas\.json$/i.test(fn)) fn += '.prismas.json';   // rlcoach identifica el formato por este sufijo
    const url = URL.createObjectURL(new Blob([s], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = fn; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    log('descargado ' + fn);
    return true;
  }

  function status() {
    return rec ? { recording: rec.active, seconds: rec.frames.length ? rec.frames[rec.frames.length - 1].t : 0, frames: rec.frames.length,
      hz: rec.hz, score: Object.assign({}, rec.score), players: rec.players.map((p) => p.name) }
      : { recording: false, hasRecording: !!lastDoc };
  }

  window.Recorder = { start, stop, download, json, last: () => lastDoc, status, _quatFromRot9: quatFromRot9 };

  function ready() { RS = window.RS; }
  if (window.RS) ready(); else window.addEventListener('rs-ready', ready, { once: true });
})();
