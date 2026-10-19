// Bots de RLBot dentro del juego. Sin UI: se manejan por consola o URL.
//   Bots.set({blue:['Kamael'], orange:['Nexto','Necto']})   // tú siempre eres azul (2v2: blue 1, orange 2 -> 2v3, etc.)
//   Bots.add('Nexto', 'orange'); Bots.clear(); Bots.list(); Bots.status()
//   URL: ?blue=Kamael&orange=Nexto,Necto   (bridge: ?bridge=ws://127.0.0.1:8765)
// Todos los bots corren en el navegador (Pyodide); no hace falta instalar nada.
(function () {
  const params = new URLSearchParams(location.search);
  const URL_BRIDGE = params.get('bridge') || 'ws://127.0.0.1:8765';
  const SPOTS = [[-2048, -2560], [2048, -2560], [-256, -3840], [256, -3840], [0, -4608]];
  let RS = null, manifest = null, webW = [], ws = null, catalog = [], ready = false, ticks = 0, resyncT = 0, setupId = 0;
  const pool = [];          // {id, team, mesh}
  let roster = [];          // [{bot, team, poolIdx, ok}]
  const log = (...a) => console.log('[Bots]', ...a);
  const toast = (m, s) => { try { RS && RS.showToast(m, s || 2.5); } catch (e) {} };

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try { ws = new WebSocket(URL_BRIDGE); } catch (e) { return; }
    ws.onopen = () => { log('puente conectado'); if (hasBridge()) resync(); };
    ws.onclose = () => { ready = false; };
    ws.onerror = () => { log('No se pudo conectar al puente (' + URL_BRIDGE + '). Ejecuta tools/botbridge/bridge.py'); toast('Puente de bots no encontrado', 3); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'catalog') { catalog = m.bots; }
      else if (m.t === 'ready') {
        m.results.forEach(r => {
          const e = roster[r.index - 1]; if (e) e.ok = r.ok;
          if (!r.ok) { log('Falló ' + (r.bot || '#' + r.index) + ': ' + r.err); toast('Bot falló: ' + (r.bot || '') + ' (ver consola)', 4); }
        });
        ready = true; RS.kickoff();
      } else if (m.t === 'ctl') {
        for (const k in m.c) applyCtl(+k, m.c[k]);
      }
    };
  }

  function makeMesh(team) {
    const mesh = RS.carMesh.clone(true);
    mesh.traverse(o => {
      if (o.isMesh && o.material) {
        o.material = o.material.clone();
        if (o.material.color) o.material.color.setHex(team ? 0xff9a3c : 0x3c8cff);
      }
    });
    RS.scene.add(mesh);
    return mesh;
  }
  function takeCar(team) {
    let i = pool.findIndex(p => p.team === team && !p.used);
    if (i < 0) {
      const id = RS.Module.addCar(team);
      pool.push({ id, team, mesh: makeMesh(team), used: false });
      i = pool.length - 1;
    }
    pool[i].used = true; return i;
  }

  function stopWeb() { webW.forEach(w => w.worker.terminate()); webW = []; }
  const hasBridge = () => roster.some(e => e.mode === 'bridge');
  function resync() {
    clearTimeout(resyncT);
    resyncT = setTimeout(() => {
      ready = false; stopWeb();
      pool.forEach(p => { p.used = false; });
      roster.forEach(e => { e.poolIdx = takeCar(e.team); e.ok = null; });
      const cars = [{ index: 0, team: 0, bot: null, label: 'Jugador' }].concat(
        roster.map((e, i) => ({ index: i + 1, team: e.team, bot: e.mode === 'bridge' ? e.bot : null, label: e.bot })));
      place();
      startWeb(cars);
      if (hasBridge()) {
        if (!ws || ws.readyState !== 1) connect();       // onopen vuelve a llamar a resync
        else ws.send(JSON.stringify({ t: 'setup', cars }));
      }
    }, 60);
  }
  const CHAT_TEXT = { Custom_Toxic_GitGut: 'Git gud.', Custom_Toxic_DeAlloc: 'De-allocate yourself.', Custom_Excuses_Lag: 'Lag!',
    Custom_Useful_Bumping: 'Bumping is useful.', Compliments_Thanks: 'Thanks!', Compliments_WhatASave: 'What a save!',
    Compliments_NiceBlock: 'Nice block!', Reactions_Wow: 'Wow!', Reactions_CloseOne: 'Close one!', Reactions_Okay: 'Okay.',
    Apologies_Sorry: 'Sorry!', Information_TakeTheShot: 'Take the shot!' };
  const chatText = (id) => CHAT_TEXT[id] || String(id).replace(/^[A-Za-z]+_/, '').replace(/_/g, ' ');
  function startWeb(cars) {
    if (!manifest) return;
    const types = {};
    roster.forEach((e, i) => { if (e.mode === 'web') (types[e.bot] = types[e.bot] || []).push(i + 1); });
    const names = cars.map((c, i) => c.label || ('Jugador ' + (i + 1)));
    const uniq = {}; const nm = names.map(n => { uniq[n] = (uniq[n] || 0) + 1; return uniq[n] > 1 ? n + ' (' + uniq[n] + ')' : n; });
    Object.keys(types).forEach(type => {
      const b = manifest.bots[type];
      const worker = new Worker('webbots/botworker.js');
      const w = { type, worker, ready: false, busy: false, indices: types[type] };
      webW.push(w);
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.t === 'ready') {
          w.ready = m.ok; w.indices.forEach(i => { roster[i - 1].ok = m.ok; });
          if (m.ok) { log(type + ' listo (Pyodide)'); RS.kickoff(); }
          else { log('Falló ' + type + ': ' + m.err); toast('Bot falló: ' + type + ' (ver consola)', 4); }
        } else if (m.t === 'ctl') {
          w.busy = false;
          if (m.err) log(type + ': ' + m.err);
          for (const k in m.c) applyCtl(+k, m.c[k]);
          if (m.chat) m.chat.forEach(([i, id]) => { const e = roster[i - 1]; toast((e ? e.bot : 'Bot') + ': ' + chatText(id), 2.5); });
        }
      };
      log('Cargando ' + type + ' (primera vez tarda unos segundos)…'); toast('Cargando ' + type + '…', 3);
      worker.postMessage({ t: 'init', base: new URL('.', location.href).href,
        files: manifest.py.concat(b.files),
        numpy: b.numpy, spec: { dir: b.dir, pythonFile: b.pythonFile, names: nm, teams: cars.map(c => c.team), indices: w.indices } });
    });
  }
  function applyCtl(index, c) {
    const e = roster[index - 1]; if (!e) return;
    e.last = c;   // último control aplicado (lo lee Bots.cars() para el recorder)
    RS.Module.setCarControls(pool[e.poolIdx].id, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
  }

  function place() {
    const n = [0, 0];
    roster.forEach(e => {
      const p = pool[e.poolIdx], k = n[e.team]++ % SPOTS.length, s = SPOTS[k], sg = e.team ? -1 : 1;
      RS.Module.setCarPose(p.id, s[0] * sg, s[1] * sg, 17, e.team ? -Math.PI / 2 : Math.PI / 2, 0, 0, 0);
      RS.Module.setCarBoost(p.id, 33.3);
      RS.Module.setCarControls(p.id, 0, 0, 0, 0, 0, false, false, false);
    });
  }

  function vec9(r) { const o = []; for (let i = 0; i < 9; i++) o.push(r.get(i)); return o; }
  function carJson(id) {
    const c = RS.Module.getCarState(id);
    return { p: [c.pos.x, c.pos.y, c.pos.z], v: [c.vel.x, c.vel.y, c.vel.z], w: [c.angVel.x, c.angVel.y, c.angVel.z],
      r: vec9(c.rot), b: c.boost, g: c.isOnGround ? 1 : 0, j: c.hasJumped ? 1 : 0, d: (c.hasDoubleJumped || c.hasFlipped) ? 1 : 0, s: c.isSupersonic ? 1 : 0 };
  }
  function sendState() {
    const b = RS.Module.getBallState();
    const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    const kick = Math.abs(b.pos.x) < 5 && Math.abs(b.pos.y) < 5 && sp < 2;
    const cars = [carJson(RS.carId)];
    roster.forEach(e => cars.push(carJson(pool[e.poolIdx].id)));
    const st = { t: 'state', time: ticks / 120, active: !RS.isGoalPause(), kick,
      ball: { p: [b.pos.x, b.pos.y, b.pos.z], v: [b.vel.x, b.vel.y, b.vel.z], w: [b.angVel.x, b.angVel.y, b.angVel.z] }, cars };
    if (ready && ws && ws.readyState === 1 && hasBridge()) ws.send(JSON.stringify(st));
    webW.forEach(w => { if (w.ready && !w.busy) { w.busy = true; w.worker.postMessage({ t: 'state', s: st }); } });
  }

  function init() {
    RS.hooks.tick = () => {
      ticks++;
      pool.forEach(p => {
        if (p.used) { const c = RS.Module.getCarState(p.id); if (c && c.pos) RS.containCar(p.id, c.pos); }
        else RS.Module.setCarPose(p.id, 0, 30000, 3000, 0, 0, 0, 0);   // coches sin usar: aparcados fuera
      });
      if (roster.length && ticks % 2 === 0) sendState();
    };
    RS.hooks.kickoff = place;
    const q = RS.THREE.Quaternion ? new RS.THREE.Quaternion() : null, pv = { x: 0, y: 0, z: 0 };
    (function draw() {
      requestAnimationFrame(draw);
      pool.forEach(p => {
        p.mesh.visible = p.used;
        if (!p.used) return;
        const c = RS.Module.getCarState(p.id); if (!c) return;
        RS.rsToThreeInto(c.pos.x, c.pos.y, c.pos.z, pv);
        p.mesh.position.set(pv.x, pv.y, pv.z);
        RS.rsRotToThreeQuat(vec9(c.rot), q); p.mesh.quaternion.copy(q);
      });
    })();
    const cfg = (k) => (params.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
    if (cfg('blue').length || cfg('orange').length) api.set({ blue: cfg('blue'), orange: cfg('orange') });
  }

  const teamOf = (t) => (t === 1 || t === 'orange' || t === 'naranja') ? 1 : 0;
  const api = {
    add(bot, team) {
      const web = manifest && Object.keys(manifest.bots).find(n => n.toLowerCase() === String(bot).toLowerCase());
      if (!web) { log(bot + ' no está disponible. Usa Bots.list()'); toast(bot + ': no disponible', 3); return false; }
      roster.push({ bot: web, team: teamOf(team), poolIdx: -1, ok: null, mode: 'web' });
      resync(); return true;
    },
    set(spec) {
      roster = [];
      (spec.blue || []).forEach(b => api.add(b, 0));
      (spec.orange || []).forEach(b => api.add(b, 1));
      resync();
    },
    clear() { roster = []; ready = false; stopWeb(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'stop' })); pool.forEach(p => { p.used = false; }); },
    list() { return manifest ? Object.keys(manifest.bots) : []; },
    // Solo lectura: autos de los bots ya colocados en el mundo (lo usa recorder.js).
    cars() {
      return roster.map((e, i) => {
        const p = e.poolIdx >= 0 ? pool[e.poolIdx] : null, m = manifest && manifest.bots[e.bot];
        return { index: i + 1, id: p ? p.id : null, bot: e.bot, team: e.team, rank: (m && m.rank) || null, ok: e.ok, ctl: e.last || null };
      });
    },
    status() { return roster.map((e, i) => ({ index: i + 1, bot: e.bot, team: e.team ? 'orange' : 'blue', ok: e.ok })); },
  };
  window.Bots = api;

  function start() {
    RS = window.RS;
    fetch('webbots/manifest.json').then(r => r.json()).then(m => { manifest = m; }).catch(() => {}).finally(init);
  }
  if (window.RS) start(); else window.addEventListener('rs-ready', start, { once: true });
})();
