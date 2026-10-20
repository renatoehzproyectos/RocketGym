/**
 * Multijugador P2P (PeerJS) — host autoridad, guest terminal.
 * Bucles propios de red/render + debug en pantalla.
 */
(function () {
  'use strict';

  const PEER_OPTS = {
    debug: 2,
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ],
    },
  };

  let peer = null;
  let conn = null;
  let role = null;
  let roomId = null;
  let remoteControls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
  let netState = null;
  let pktIn = 0;
  let pktOut = 0;
  let lastPktInAt = 0;
  let netTimer = null;
  let rafId = 0;
  let linked = false;
  let simulates = false; // true = este cliente corre la física (autoridad)
  function setSim(v) { simulates = !!v; window.__mpSimulates = simulates; }
  let username = localStorage.getItem('rp-username') || '';
  let isPublicRoom = false;
  let myCountry = null;
  let myCountryCode = null;
  let remoteName = 'Rival';
  window.__mpGetRemote = function () { return { name: remoteName, role: role, linked: linked }; };   // lo lee nametags.js

  let _q0 = null, _q1 = null;
  const _p0 = { x: 0, y: 0, z: 0 };
  const _p1 = { x: 0, y: 0, z: 0 };
  const _pb = { x: 0, y: 0, z: 0 };
  const _camPos = [0, 0, 0];
  const _camFwd = [1, 0, 0];
  const _camBall = [0, 0, 0];
  let _lastCamT = 0;

  function dbg(msg) {
    const el = document.getElementById('mp-debug');
    if (el) {
      const lines = [
        msg,
        'role=' + (role || '-') + ' sim=' + simulates + ' linked=' + linked,
        'user=' + (username || '-') + ' pub=' + isPublicRoom,
        'pktIn=' + pktIn + ' pktOut=' + pktOut,
      ];
      el.textContent = lines.join('\n');
    }
    console.log('[mp]', msg);
  }

  function ensureQuats(THREE) {
    if (!_q0 && THREE) {
      _q0 = new THREE.Quaternion();
      _q1 = new THREE.Quaternion();
    }
  }

  function closeMenu() {
    const m = document.getElementById('start-menu');
    if (m) m.remove();
  }

  function ensureHud() {
    if (!document.getElementById('mp-top-bar')) {
      const bar = document.createElement('div');
      bar.id = 'mp-top-bar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:90;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:rgba(6,12,22,.92);border-bottom:1px solid rgba(140,200,255,.25);font:600 14px system-ui,sans-serif;color:#e8f0f8;';
      document.body.appendChild(bar);
    }
    if (!document.getElementById('mp-debug')) {
      const d = document.createElement('div');
      d.id = 'mp-debug';
      d.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:90;max-width:min(420px,92vw);padding:8px 12px;background:rgba(0,0,0,.82);color:#8f8;font:12px ui-monospace,monospace;border-radius:4px;pointer-events:none;white-space:pre-wrap;line-height:1.35;border:1px solid rgba(100,200,120,.35);display:none;';
      d.textContent = 'mp: idle';
      document.body.appendChild(d);
    }
  }

  function showTopBar(html, copyCode) {
    ensureHud();
    const bar = document.getElementById('mp-top-bar');
    bar.innerHTML = html;
    if (copyCode != null) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Copiar';
      btn.style.cssText = 'padding:4px 12px;border:1px solid rgba(140,200,255,.45);border-radius:4px;background:rgba(20,40,70,.9);color:#cde;font:600 12px system-ui;cursor:pointer;';
      btn.onclick = () => {
        navigator.clipboard?.writeText(String(copyCode)).then(() => {
          btn.textContent = '¡Copiado!';
          setTimeout(() => { btn.textContent = 'Copiar'; }, 1200);
        }).catch(() => {});
      };
      bar.appendChild(btn);
    }
  }

  function setTopStatus(text) {
    const st = document.querySelector('#mp-top-bar [data-mp-status]');
    if (st) st.textContent = text;
  }

  function waitRS() {
    return new Promise((resolve) => {
      if (window.RS) return resolve(window.RS);
      window.addEventListener('rs-ready', () => resolve(window.RS), { once: true });
    });
  }

  function rot9FromCar(cs) {
    if (!cs || !cs.rot) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const r = cs.rot;
    if (typeof r.get === 'function') {
      const o = new Array(9);
      for (let i = 0; i < 9; i++) o[i] = r.get(i);
      return o;
    }
    if (Array.isArray(r)) return r.slice(0, 9);
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  function createMesh2(rs) {
    if (!rs || rs.carMesh2 || !rs.carMesh || !rs.scene) return;
    // Esperar a que el GLB del Fennec haya cargado hijos; si no, el clon sale vacío.
    let childCount = 0;
    rs.carMesh.traverse(function () { childCount++; });
    if (childCount < 3) {
      dbg('mesh2 wait model children=' + childCount);
      return;
    }
    try {
      const mesh2 = rs.carMesh.clone(true);
      mesh2.name = 'carMesh2';
      mesh2.traverse(function (o) {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          if (o.material.color) o.material.color.setHex(0x2a6fd6);
          o.material.transparent = true;
          o.material.opacity = 0.5;
          o.material.depthWrite = false;
        }
      });
      rs.scene.add(mesh2);
      rs.carMesh2 = mesh2;
      dbg('mesh2 created children=' + childCount);
    } catch (e) {
      dbg('mesh2 clone fail: ' + e.message);
    }
  }

  function ensureSecondCar(rs) {
    if (!rs || !rs.Module) return null;
    if (rs.carId2 == null) {
      try {
        const id = rs.Module.addCar(1);
        rs.Module.setCarPose(id, 0, 2560, 100, Math.PI, 0, 0, 0);
        try { rs.Module.setCarBoost(id, 100); } catch (e) {}
        rs.carId2 = id;
        window.__mpCarId2 = id;
        dbg('carId2=' + id);
      } catch (e) {
        dbg('addCar fail: ' + e.message);
        return null;
      }
    }
    createMesh2(rs);
    return rs.carId2;
  }

  // Formato mínimo: ['c', thr100, str100, pitch100, yaw100, roll100, jump, boost, hb]
  function packControlsMsg(ctl) {
    const t = ctl ? (+ctl.throttle || 0) : 0;
    const s = ctl ? (+ctl.steer || 0) : 0;
    const p = ctl ? (+ctl.pitch || 0) : 0;
    const y = ctl ? (+ctl.yaw || 0) : 0;
    const r = ctl ? (+ctl.roll || 0) : 0;
    return [
      'c',
      Math.round(t * 100),
      Math.round(s * 100),
      Math.round(p * 100),
      Math.round(y * 100),
      Math.round(r * 100),
      ctl && ctl.jump ? 1 : 0,
      ctl && ctl.boost ? 1 : 0,
      ctl && ctl.handbrake ? 1 : 0,
    ];
  }

  function unpackControlsMsg(data) {
    // Array corto ['c', ...]
    if (Array.isArray(data) && data[0] === 'c') {
      return {
        throttle: (+data[1] || 0) / 100,
        steer: (+data[2] || 0) / 100,
        pitch: (+data[3] || 0) / 100,
        yaw: (+data[4] || 0) / 100,
        roll: (+data[5] || 0) / 100,
        jump: !!data[6],
        boost: !!data[7],
        handbrake: !!data[8],
      };
    }
    // Objeto legacy
    if (data && typeof data === 'object') {
      if (Array.isArray(data.c)) {
        const a = data.c;
        return {
          throttle: +a[0] || 0, steer: +a[1] || 0, pitch: +a[2] || 0, yaw: +a[3] || 0, roll: +a[4] || 0,
          jump: !!a[5], boost: !!a[6], handbrake: !!a[7],
        };
      }
      if (data.type === 'controls') {
        return {
          throttle: +data.throttle || 0,
          steer: +data.steer || 0,
          pitch: +data.pitch || 0,
          yaw: +data.yaw || 0,
          roll: +data.roll || 0,
          jump: !!data.jump,
          boost: !!data.boost,
          handbrake: !!data.handbrake,
        };
      }
    }
    return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
  }

  function packState(rs) {
    try {
      const s = rs.getState();
      if (!s || !s.carPos || !s.ballPos) return null;
      ensureSecondCar(rs);

      let c1 = [0, 2560, 17, 0, 0, 0, 0, 1];
      let r1 = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
      if (rs.carId2 != null) {
        const cs = rs.Module.getCarState(rs.carId2);
        if (cs && cs.pos) {
          c1 = [cs.pos.x, cs.pos.y, cs.pos.z, cs.vel.x, cs.vel.y, cs.vel.z, cs.boost || 0, cs.isOnGround ? 1 : 0];
          r1 = rot9FromCar(cs);
        }
      }

      const r0src = s.carRot;
      const r0 = r0src && r0src.length
        ? [r0src[0], r0src[1], r0src[2], r0src[3], r0src[4], r0src[5], r0src[6], r0src[7], r0src[8]]
        : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const v0 = s.carVel || { x: 0, y: 0, z: 0 };
      const bv = s.ballVel || { x: 0, y: 0, z: 0 };

      return {
        t: performance.now(),
        b: [s.ballPos.x, s.ballPos.y, s.ballPos.z, bv.x || 0, bv.y || 0, bv.z || 0],
        c0: [s.carPos.x, s.carPos.y, s.carPos.z, v0.x || 0, v0.y || 0, v0.z || 0, s.boost || 0, s.isOnGround ? 1 : 0],
        r0: r0,
        c1: c1,
        r1: r1,
      };
    } catch (e) {
      dbg('packState err: ' + e.message);
      return null;
    }
  }

  function applyMeshes(rs, data) {
    if (!data || !rs) return;
    ensureQuats(rs.THREE);
    if (!_q0) return;
    if (!rs.carMesh2) createMesh2(rs);

    if (data.b && rs.ball) {
      rs.rsToThreeInto(data.b[0], data.b[1], data.b[2], _pb);
      rs.ball.position.set(_pb.x, _pb.y, _pb.z);
    }
    if (data.c0 && rs.carMesh) {
      rs.rsToThreeInto(data.c0[0], data.c0[1], data.c0[2], _p0);
      rs.carMesh.position.set(_p0.x, _p0.y, _p0.z);
      if (data.r0 && rs.rsRotToThreeQuat) {
        rs.rsRotToThreeQuat(data.r0, _q0);
        rs.carMesh.quaternion.copy(_q0);
      }
    }
    if (data.c1 && rs.carMesh2) {
      rs.rsToThreeInto(data.c1[0], data.c1[1], data.c1[2], _p1);
      rs.carMesh2.position.set(_p1.x, _p1.y, _p1.z);
      if (data.r1 && rs.rsRotToThreeQuat) {
        rs.rsRotToThreeQuat(data.r1, _q1);
        rs.carMesh2.quaternion.copy(_q1);
      }
    }
  }

  function applyCamera(rs, data) {
    if (!data || !rs.updateCamera) return;
    let mine, rot;
    mine = role === 'host' ? data.c0 : data.c1;
    rot = role === 'host' ? data.r0 : data.r1;
    if (!mine || !rot) return;
    const now = performance.now();
    const dt = _lastCamT ? Math.min(0.05, (now - _lastCamT) / 1000) : 0.016;
    _lastCamT = now;
    _camPos[0] = mine[0]; _camPos[1] = mine[1]; _camPos[2] = mine[2];
    _camFwd[0] = rot[0]; _camFwd[1] = rot[1]; _camFwd[2] = rot[2];
    _camBall[0] = data.b ? data.b[0] : 0;
    _camBall[1] = data.b ? data.b[1] : 0;
    _camBall[2] = data.b ? data.b[2] : 0;
    rs.updateCamera(rs.camera, _camPos, _camFwd, rot[8] || 0, _camBall, !!mine[7], dt);
  }

  // Estado completo desde la física local (cuando este cliente tiene la autoridad pero dibuja mp).
  function buildLocalState(rs) {
    const M = rs.Module;
    if (rs.carId2 == null) return null;
    const b = M.getBallState(), a = M.getCarState(rs.carId), c = M.getCarState(rs.carId2);
    if (!b || !a || !c) return null;
    return {
      b: [b.pos.x, b.pos.y, b.pos.z],
      c0: [a.pos.x, a.pos.y, a.pos.z, 0, 0, 0, 0, a.isOnGround ? 1 : 0], r0: rot9FromCar(a),
      c1: [c.pos.x, c.pos.y, c.pos.z, 0, 0, 0, 0, c.isOnGround ? 1 : 0], r1: rot9FromCar(c),
    };
  }

  // ---- Traspaso de autoridad (host oculto -> visitante simula; el host vuelve -> la recupera) ----
  function takeSnap(rs) {
    const M = rs.Module;
    ensureSecondCar(rs);
    const b = M.getBallState();
    const cars = [rs.carId, rs.carId2].map(function (id) {
      const cs = M.getCarState(id), r = rot9FromCar(cs);
      return [cs.pos.x, cs.pos.y, cs.pos.z, cs.vel.x, cs.vel.y, cs.vel.z, cs.boost || 0, Math.atan2(r[1], r[0])];
    });
    return { b: [b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z], c: cars };
  }

  function applySnap(rs, snap) {
    const M = rs.Module;
    ensureSecondCar(rs);
    if (!snap) {
      // Sin snapshot (p. ej. el host se colgó): reconstruir posiciones desde el último estado de red.
      if (!netState) return;
      snap = {
        b: [netState.b[0], netState.b[1], netState.b[2], 0, 0, 0],
        c: [
          [netState.c0[0], netState.c0[1], netState.c0[2], 0, 0, 0, 100, Math.atan2(netState.r0[1], netState.r0[0])],
          [netState.c1[0], netState.c1[1], netState.c1[2], 0, 0, 0, 100, Math.atan2(netState.r1[1], netState.r1[0])],
        ],
      };
    }
    try {
      M.setBallState(snap.b[0], snap.b[1], snap.b[2], snap.b[3], snap.b[4], snap.b[5]);
      [rs.carId, rs.carId2].forEach(function (id, i) {
        const c = snap.c[i];
        M.setCarPose(id, c[0], c[1], c[2], c[7], c[3], c[4], c[5]);
        try { M.setCarBoost(id, c[6]); } catch (e) {}
      });
    } catch (e) { dbg('applySnap err: ' + e.message); }
  }

  function becomeAuthority(rs, snap, why) {
    applySnap(rs, snap);
    remoteControls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
    window.__mpRemoteControls = remoteControls;
    lastPktInAt = performance.now();
    setSim(true);
    setTopStatus(role === 'host' ? 'Volviste a ser host' : 'Ahora tú llevas la partida (' + why + ')');
    dbg('AUTHORITY -> me (' + role + ') ' + why);
  }

  function handOver(rs) {
    if (!linked || !simulates || !conn) return;
    const snap = takeSnap(rs);
    setSim(false);
    safeSend({ type: 'auth', owner: role === 'host' ? 'guest' : 'host', snap: snap });
    dbg('AUTHORITY -> other');
  }

  function onVisibility() {
    const rs = window.RS;
    if (!rs || !linked) return;
    if (document.hidden) {
      handOver(rs);
    } else if (role === 'host' && !simulates) {
      safeSend({ type: 'reclaim' });
    }
  }

  function safeSend(msg) {
    if (!conn || !linked) return false;
    try {
      // Siempre JSON string: PeerJS a veces rompe arrays/objetos con binarypack
      const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
      conn.send(payload);
      pktOut++;
      return true;
    } catch (e) {
      dbg('send fail: ' + e.message);
      return false;
    }
  }

  function normalizeIncoming(data) {
    if (data == null) return null;
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch (e) { return null; }
    }
    // A veces llega como objeto array-like {0:'c',1:98,...}
    if (typeof data === 'object' && !Array.isArray(data) && data[0] === 'c') {
      const a = [];
      for (let i = 0; i < 9; i++) a.push(data[i]);
      return a;
    }
    if (typeof data === 'object' && !Array.isArray(data) && data[0] === 's') {
      const a = [];
      for (let i = 0; i < 40; i++) {
        if (data[i] === undefined) break;
        a.push(data[i]);
      }
      return a;
    }
    return data;
  }

  function onData(raw) {
    const data = normalizeIncoming(raw);
    if (data == null) return;

    // Controles compactos: ['c', thr100, str100, ...]
    if (Array.isArray(data) && data[0] === 'c') {
      if (simulates) {
        remoteControls = unpackControlsMsg(data);
        window.__mpRemoteControls = remoteControls;
        pktIn++;
        lastPktInAt = performance.now();
      }
      return;
    }

    // Estado compacto: ['s', ...]
    if (Array.isArray(data) && data[0] === 's') {
      if (!simulates) {
        netState = unpackStateArr(data);
        if (netState) {
          pktIn++;
          lastPktInAt = performance.now();
        }
      }
      return;
    }

    if (typeof data !== 'object' || Array.isArray(data)) return;

    if (data.type === 'auth') {
      const rs = window.RS;
      if (!rs) return;
      if (data.owner === role) becomeAuthority(rs, data.snap, role === 'host' ? 'vuelta' : 'host oculto');
      else setSim(false);
    } else if (data.type === 'reclaim') {
      if (simulates && window.RS) handOver(window.RS);
    } else if (data.type === 'controls' && simulates) {
      remoteControls = unpackControlsMsg(data);
      window.__mpRemoteControls = remoteControls;
      pktIn++;
      lastPktInAt = performance.now();
    } else if (data.type === 'state' && !simulates) {
      if (data.s) {
        netState = data.s;
        pktIn++;
        lastPktInAt = performance.now();
      }
    } else if (data.type === 'hello') {
      setTopStatus(role === 'host' ? 'Visitante conectado' : 'Conectado');
      if (data.name) remoteName = String(data.name).slice(0, 20);
      dbg('hello from ' + (data.role || '?') + ' name=' + remoteName);
      // Reply with our name
      safeSend({ type: 'hello', role: role, name: username });
    }
  }

  function unpackStateArr(a) {
    // ['s', bx,by,bz, c0x,c0y,c0z,c0g, r0*9, c1x,c1y,c1z,c1g, r1*9]
    if (!a || a.length < 30) return null;
    let i = 1;
    const b = [a[i++], a[i++], a[i++], 0, 0, 0];
    const c0 = [a[i++], a[i++], a[i++], 0, 0, 0, 0, a[i++]];
    const r0 = [];
    for (let k = 0; k < 9; k++) r0.push(a[i++]);
    const c1 = [a[i++], a[i++], a[i++], 0, 0, 0, 0, a[i++]];
    const r1 = [];
    for (let k = 0; k < 9; k++) r1.push(a[i++]);
    return { t: performance.now(), b: b, c0: c0, r0: r0, c1: c1, r1: r1 };
  }

  function packStateArr(rs) {
    try {
      const s = rs.getState();
      if (!s || !s.carPos || !s.ballPos) return null;
      ensureSecondCar(rs);
      let c1x = 0, c1y = 2560, c1z = 100, c1g = 1;
      let r1 = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
      if (rs.carId2 != null) {
        const cs = rs.Module.getCarState(rs.carId2);
        if (cs && cs.pos) {
          c1x = cs.pos.x; c1y = cs.pos.y; c1z = cs.pos.z;
          c1g = cs.isOnGround ? 1 : 0;
          r1 = rot9FromCar(cs);
        }
      }
      const r0src = s.carRot;
      const r0 = r0src && r0src.length
        ? [r0src[0], r0src[1], r0src[2], r0src[3], r0src[4], r0src[5], r0src[6], r0src[7], r0src[8]]
        : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const out = ['s',
        Math.round(s.ballPos.x), Math.round(s.ballPos.y), Math.round(s.ballPos.z),
        Math.round(s.carPos.x), Math.round(s.carPos.y), Math.round(s.carPos.z), s.isOnGround ? 1 : 0,
      ];
      for (let k = 0; k < 9; k++) out.push(+Number(r0[k]).toFixed(3));
      out.push(Math.round(c1x), Math.round(c1y), Math.round(c1z), c1g);
      for (let k = 0; k < 9; k++) out.push(+Number(r1[k]).toFixed(3));
      return out;
    } catch (e) {
      return null;
    }
  }

  function installRenderHook(rs) {
    if (!rs || !rs.hooks || rs.hooks.__mpRender) return;
    rs.hooks.__mpRender = true;

    let lastCtlSend = 0;

    function otherCarId() { return role === 'host' ? rs.carId2 : rs.carId; }

    function mpControls(ctl) {
      if (!linked || !conn) return;
      if (!simulates) {
        // Sin autoridad: enviar mis controles a quien simula
        const now = performance.now();
        if (now - lastCtlSend >= 16) {
          lastCtlSend = now;
          safeSend(packControlsMsg(ctl));
        }
      }
    }

    function mpFrame() {
      if (role === 'host' && simulates) {
        // Host con autoridad: game.js dibuja todo salvo el auto del visitante
        if (rs.carId2 != null) {
          ensureSecondCar(rs);
          try {
            ensureQuats(rs.THREE);
            const cs = rs.Module.getCarState(rs.carId2);
            if (cs && cs.pos && rs.carMesh2 && _q1) {
              rs.rsToThreeInto(cs.pos.x, cs.pos.y, cs.pos.z, _p1);
              rs.carMesh2.position.set(_p1.x, _p1.y, _p1.z);
              if (rs.rsRotToThreeQuat) {
                rs.rsRotToThreeQuat(rot9FromCar(cs), _q1);
                rs.carMesh2.quaternion.copy(_q1);
              }
            }
          } catch (e) { /* ignore */ }
        }
        return;
      }
      // Resto de casos: dibujar desde la física local (visitante con autoridad) o desde la red
      try {
        const st = simulates ? buildLocalState(rs) : netState;
        if (st) { applyMeshes(rs, st); applyCamera(rs, st); }
      } catch (e) { dbg('apply err: ' + e.message); }
    }

    // Se encadenan las funciones de RS.hooks.controls / RS.hooks.frame con accesores
    // para que se ejecuten DESPUÉS de las de multijugador en vez de reemplazarlas.
    let userControls = rs.hooks.controls || null;
    let userFrame = rs.hooks.frame || null;
    Object.defineProperty(rs.hooks, 'controls', {
      configurable: true, enumerable: true,
      get() { return function (ctl, dt) { if (userControls) userControls(ctl, dt); mpControls(ctl); }; },
      set(fn) { userControls = fn; },
    });
    Object.defineProperty(rs.hooks, 'frame', {
      configurable: true, enumerable: true,
      get() { return function (dt, state) { if (userFrame) userFrame(dt, state); mpFrame(); }; },
      set(fn) { userFrame = fn; },
    });
  }

  function startLoops() {
    stopLoops();

    waitRS().then(function (rs) {
      installRenderHook(rs);
      ensureSecondCar(rs);
    });

    netTimer = setInterval(function () {
      const rs = window.RS;
      if (!rs || !linked || !conn) return;

      if (simulates) {
        ensureSecondCar(rs);
        if (lastPktInAt && performance.now() - lastPktInAt > 600) {
          remoteControls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
          window.__mpRemoteControls = remoteControls;
        }
        const oid = role === 'host' ? rs.carId2 : rs.carId;
        if (oid != null) {
          const rc = remoteControls;
          try {
            rs.Module.setCarControls(oid, rc.throttle, rc.steer, rc.pitch, rc.yaw, rc.roll, !!rc.jump, !!rc.boost, !!rc.handbrake);
          } catch (e) { /* ignore */ }
        }
        const packed = packStateArr(rs);
        if (packed) safeSend(packed);
        dbg(role + '(AUTH) out=' + pktOut + ' in=' + pktIn + ' thr=' + remoteControls.throttle.toFixed(2));
      } else {
        // Sin autoridad: controles (en cero si mi pestaña está oculta, para no dejar teclas pegadas)
        safeSend(document.hidden ? packControlsMsg(null) : packControlsMsg(rs.ctl));
        // Watchdog: el host dejó de enviar sin avisar (se colgó) y yo estoy visible -> tomo la partida
        const age = lastPktInAt ? performance.now() - lastPktInAt : 0;
        if (role === 'guest' && !document.hidden && netState && age > 2500) {
          becomeAuthority(rs, null, 'host sin respuesta');
        }
        dbg(role + ' out=' + pktOut + ' in=' + pktIn + ' age=' + Math.round(age));
      }

    }, 20);
  }

  function stopLoops() {
    if (netTimer) { clearInterval(netTimer); netTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function wireConnection(c) {
    conn = c;
    linked = false;

    function markOpen() {
      if (linked) return;
      linked = true;
      dbg('DATA CHANNEL OPEN role=' + role);
      safeSend({ type: 'hello', role: role, name: username });
      closeMenu();
      if (role === 'host') {
        setTopStatus('Visitante conectado — ¡a jugar!');
      } else {
        showTopBar('<span>Conectado al host · ' + (username || '') + '</span><span data-mp-status>· jugando</span>');
      }
      waitRS().then(function (rs) {
        ensureSecondCar(rs);
        setTimeout(function () { createMesh2(rs); }, 1500);
        setTimeout(function () { createMesh2(rs); }, 4000);
        startLoops();
      });
    }

    c.on('data', onData);
    c.on('open', markOpen);
    if (c.open) markOpen();

    c.on('close', function () {
      linked = false;
      stopLoops();
      setTopStatus('Conexión cerrada');
      dbg('connection closed');
      conn = null;
    });
    c.on('error', function (err) {
      dbg('conn error: ' + (err.type || err.message || err));
      setTopStatus('Error de conexión');
    });
  }

  function makeRoomCode() {
    return String(10000 + Math.floor(Math.random() * 90000));
  }

  function peerIdFromCode(code) {
    return 'rp' + String(code).replace(/\D/g, '').slice(0, 5);
  }

  function startHost() {
    role = 'host';
    setSim(true);
    window.__mpRole = 'host';
    const code = makeRoomCode();
    roomId = code;
    closeMenu();
    ensureHud();
    const roomType = isPublicRoom ? 'Pública' : 'Privada';
    showTopBar(
      '<span style="opacity:.75">' + roomType + '</span>' +
      '<span style="font:700 22px ui-monospace,monospace;letter-spacing:.2em;color:#7dffc8">' + code + '</span>' +
      '<span style="opacity:.75">' + (username || '') + '</span>' +
      '<span data-mp-status style="opacity:.85">Creando sala…</span>',
      code
    );
    dbg('starting host code=' + code + ' public=' + isPublicRoom + ' user=' + username);

    waitRS().then(function (rs) {
      ensureSecondCar(rs);
      setTimeout(function () { createMesh2(rs); }, 2000);
    });

    function tryHost(attempt) {
      const useCode = attempt === 0 ? code : makeRoomCode();
      if (attempt > 0) {
        roomId = useCode;
        showTopBar(
          '<span style="opacity:.75">Código</span>' +
          '<span style="font:700 22px ui-monospace,monospace;letter-spacing:.2em;color:#7dffc8">' + useCode + '</span>' +
          '<span data-mp-status>Reintentando…</span>',
          useCode
        );
      }
      if (peer) { try { peer.destroy(); } catch (_) {} }
      const pid = peerIdFromCode(useCode);
      dbg('peer id=' + pid + ' attempt=' + attempt);
      peer = new Peer(pid, PEER_OPTS);
      peer.on('open', function (id) {
        dbg('host peer open: ' + id);
        setTopStatus('Esperando visitante…');
      });
      peer.on('connection', function (c) {
        dbg('incoming connection');
        if (conn) { try { c.close(); } catch (_) {} return; }
        wireConnection(c);
      });
      peer.on('error', function (err) {
        dbg('host peer error: ' + (err.type || err.message));
        if (err && err.type === 'unavailable-id' && attempt < 6) {
          tryHost(attempt + 1);
          return;
        }
        setTopStatus('Error: ' + (err.type || err.message));
      });
    }
    tryHost(0);
  }

  function startGuest(code) {
    code = String(code || '').replace(/\D/g, '').slice(0, 5);
    if (code.length !== 5) {
      alert('Código de 5 dígitos');
      return;
    }
    role = 'guest';
    setSim(false);
    window.__mpRole = 'guest';
    ensureHud();
    showTopBar(
      '<span>Conectando a </span>' +
      '<span style="font:700 18px ui-monospace,monospace;letter-spacing:.15em">' + code + '</span>' +
      '<span data-mp-status>…</span>'
    );
    dbg('guest connecting to ' + code);

    waitRS().then(function (rs) {
      ensureSecondCar(rs);
      setTimeout(function () { createMesh2(rs); }, 2000);
    });

    if (peer) { try { peer.destroy(); } catch (_) {} }
    peer = new Peer(PEER_OPTS);
    peer.on('open', function (myId) {
      dbg('guest peer open: ' + myId + ' -> ' + peerIdFromCode(code));
      const c = peer.connect(peerIdFromCode(code), { reliable: true, serialization: 'json' });
      wireConnection(c);
    });
    peer.on('error', function (err) {
      dbg('guest peer error: ' + (err.type || err.message));
      setTopStatus('Error: ' + (err.type || err.message));
    });
  }

  function ensureUsername(cb) {
    if (username && username.trim().length >= 2) {
      if (cb) cb();
      return;
    }
    const name = prompt('Elige un nombre de usuario (se guardará permanentemente):', username || '');
    if (name && name.trim().length >= 2) {
      username = name.trim().slice(0, 20);
      localStorage.setItem('rp-username', username);
      if (cb) cb();
    } else {
      alert('Necesitas un nombre de al menos 2 caracteres.');
    }
  }

  function fetchCountry(cb) {
    if (myCountry) { if (cb) cb(); return; }
    fetch('https://ipapi.co/json/')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        myCountry = j.country_name || j.country || '??';
        myCountryCode = (j.country_code || '').toUpperCase();
        if (cb) cb();
      })
      .catch(function () {
        myCountry = '??';
        myCountryCode = '';
        if (cb) cb();
      });
  }

  function countryFlag(code) {
    if (!code || code.length !== 2) return '🏳️';
    return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
  }

  function closeMatchPanel() {
    const p = document.getElementById('mp-match-panel');
    if (p) p.remove();
  }

  function openMatchPanel() {
    closeMatchPanel();
    ensureUsername(function () {
      fetchCountry(function () {
        const panel = document.createElement('div');
        panel.id = 'mp-match-panel';
        panel.innerHTML =
          '<div class="mmp-card">' +
          '  <div class="mmp-head"><h2>Multijugador</h2><button type="button" class="mmp-close" aria-label="Cerrar">×</button></div>' +
          '  <div class="mmp-body">' +
          '    <div class="mmp-user">' +
          '      <input id="mmp-username" type="text" maxlength="20" value="' + (username || '').replace(/"/g, '&quot;') + '" placeholder="Nombre de usuario" />' +
          '      <button type="button" id="mmp-save-user">Guardar</button>' +
          '    </div>' +
          '    <div class="mmp-sec">' +
          '      <div class="mmp-sec-title">Crear partida</div>' +
          '      <div class="mmp-actions">' +
          '        <button type="button" class="primary" id="mmp-create-public">Pública</button>' +
          '        <button type="button" id="mmp-create-private">Privada</button>' +
          '      </div>' +
          '    </div>' +
          '    <div class="mmp-sec">' +
          '      <div class="mmp-sec-title">Partidas públicas en curso</div>' +
          '      <ul class="mmp-list" id="mmp-list"><li class="mmp-empty">Buscando partidas…</li></ul>' +
          '      <button type="button" id="mmp-refresh" style="margin-top:6px;width:100%">Actualizar lista</button>' +
          '    </div>' +
          '    <div class="mmp-sec">' +
          '      <div class="mmp-sec-title">Unirse con código (privada)</div>' +
          '      <div class="mmp-code-row">' +
          '        <input id="mmp-code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" placeholder="CÓDIGO" autocomplete="off" />' +
          '        <button type="button" id="mmp-join-code">Unirse</button>' +
          '      </div>' +
          '    </div>' +
          '  </div>' +
          '</div>';
        document.body.appendChild(panel);

        panel.querySelector('.mmp-close').onclick = closeMatchPanel;
        panel.addEventListener('click', function (e) { if (e.target === panel) closeMatchPanel(); });

        panel.querySelector('#mmp-save-user').onclick = function () {
          const v = panel.querySelector('#mmp-username').value.trim().slice(0, 20);
          if (v.length >= 2) {
            username = v;
            localStorage.setItem('rp-username', username);
            alert('Nombre guardado: ' + username);
          } else {
            alert('Mínimo 2 caracteres.');
          }
        };

        panel.querySelector('#mmp-create-public').onclick = function () {
          isPublicRoom = true;
          closeMatchPanel();
          startHost();
        };
        panel.querySelector('#mmp-create-private').onclick = function () {
          isPublicRoom = false;
          closeMatchPanel();
          startHost();
        };

        panel.querySelector('#mmp-join-code').onclick = function () {
          const code = panel.querySelector('#mmp-code').value;
          closeMatchPanel();
          startGuest(code);
        };
        panel.querySelector('#mmp-code').addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            closeMatchPanel();
            startGuest(panel.querySelector('#mmp-code').value);
          }
        });

        panel.querySelector('#mmp-refresh').onclick = function () {
          refreshPublicList(panel.querySelector('#mmp-list'));
        };

        refreshPublicList(panel.querySelector('#mmp-list'));
      });
    });
  }

  // Lista de partidas públicas: sin servidor de descubrimiento real se muestra vacío
  // (las privadas usan código; las públicas generan código visible en la barra superior).
  function refreshPublicList(ul) {
    if (!ul) return;
    ul.innerHTML = '<li class="mmp-empty">No hay servidor de listado de partidas.<br>Las públicas muestran el código en la barra superior: compártelo.<br>Usa el campo de código para unirte (pública o privada).</li>';
  }

  function bindUI() {
    ensureHud();
    const matchBtn = document.getElementById('mp-match-button');
    if (matchBtn) matchBtn.addEventListener('click', function () { openMatchPanel(); });
    document.addEventListener('visibilitychange', onVisibility);
    dbg('ui bound, Peer=' + (typeof Peer !== 'undefined' ? 'ok' : 'MISSING') + ', user=' + (username || '(none)'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUI);
  } else {
    bindUI();
  }
})();
