// Capa de interfaz del gimnasio: DOM, worker de análisis (rlcoach en Pyodide), almacenamiento y cableado con el juego.
// La lógica vive en gym_core.js; aquí solo se pinta el view-model y se reenvían las acciones.
(function () {
  'use strict';
  const KIND = {
    own_goal: ['Own goal', 'The ball went in off your touch.'],
    out_of_position: ['Out of position', 'You were past the ball when the attack came.'],
    bad_touch: ['Bad touch', 'Your touch gave the ball to the opponents.'],
    lost_challenge: ['Lost 50/50', 'You lost the challenge that started the attack.'],
    late_rotation: ['Late rotation', 'You never got to the ball in time.'],
    boost_starved: ['Out of boost', 'You went into the defence on empty.'],
    defensive_lapse: ['Defensive lapse', 'The last moment you could still change it.'],
  };
  const REASON = {
    goal_conceded: 'a goal was scored against you', still_ahead_of_ball: 'you were still past the ball',
    touch_toward_own_goal: 'your touch went toward your own goal', lost_challenge_again: 'you lost the 50/50 again',
    never_touched_ball: 'you never touched the ball', touch_gave_possession: 'your touch gave possession away',
    never_reached_ball: 'you never reached the ball', did_not_collect_boost: 'you did not pick up boost',
    attempt_too_short: 'the attempt was too short to judge', evaluator_failed: 'the evaluator failed, try again',
  };
  const END = { time: 'Full time', overtime: 'Overtime golden goal', forfeit: 'Forfeit (4-goal lead)' };
  const BUSY = { bots: 'Loading bots…', analyzing: 'RLCoach is analysing your match…', demo_loading: 'Loading the stronger bot…' };
  const ERR = { bot_timeout: 'The bots took too long to load.', bot_failed: 'A bot failed to load (see console).', no_recording: 'No recording was captured.', no_errors: 'No practiceable mistake found this time.' };

  const css = `
  #gym{position:fixed;inset:0;z-index:60;pointer-events:none;font:600 14px system-ui,sans-serif;color:#fff}
  #gym .card{pointer-events:auto;background:rgba(10,16,30,.92);border:1px solid #2c4a7a;border-radius:14px;padding:14px 16px;box-shadow:0 8px 30px #0008}
  #gym .center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(92vw,420px)}
  #gym .top{position:absolute;left:50%;top:max(8px,env(safe-area-inset-top));transform:translateX(-50%);width:min(94vw,460px)}
  #gym h2{margin:0 0 8px;font-size:18px;letter-spacing:1px} #gym p{margin:6px 0;opacity:.9;font-weight:500}
  #gym .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0} #gym .row>*{flex:1}
  #gym button{pointer-events:auto;border:0;border-radius:10px;padding:11px 12px;font:700 14px system-ui;background:#2f6fdb;color:#fff;min-width:60px}
  #gym button.alt{background:#27344f} #gym button.on{background:#e8a400;color:#111} #gym button:disabled{opacity:.4}
  #gym .hud{display:flex;justify-content:center;align-items:center;gap:14px;background:rgba(10,16,30,.8);border-radius:12px;padding:6px 14px;font-size:22px}
  #gym .b{color:#5ab0ff} #gym .o{color:#ffa94d} #gym small{opacity:.7;font-weight:500}
  #gym .cd{position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);font:800 120px system-ui;text-shadow:0 0 30px #000}
  #gym .tag{display:inline-block;padding:2px 8px;border-radius:8px;background:#27344f;font-size:12px;margin-right:6px}
  #gym .good{color:#6dff9a} #gym .bad{color:#ff7a7a} #gym .busy{opacity:.85;text-align:center}`;

  const fmt = (t) => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ---------------------------------------------------------------- análisis (worker con Pyodide + rlcoach)
  function makeAnalyzer() {
    let w = null, ready = null, id = 0; const pend = {};
    function init() {
      if (ready) return ready;
      ready = new Promise((resolve, reject) => {
        w = new Worker('webbots/gymworker.js');
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.t === 'ready') m.ok ? resolve() : reject(new Error(m.err));
          else if (m.t === 'res' && pend[m.id]) { pend[m.id](m.out); delete pend[m.id]; }
        };
        w.postMessage({ t: 'init', base: new URL('.', location.href).href });
      });
      ready.catch(() => { ready = null; });
      return ready;
    }
    const call = async (body) => { await init(); return new Promise((res) => { const i = ++id; pend[i] = res; w.postMessage(Object.assign({ t: 'req', id: i }, body)); }); };
    return { init, analyze: (doc) => call({ op: 'analyze', doc }), evaluate: (error, attempt) => call({ op: 'evaluate', error, attempt }) };
  }

  // ---------------------------------------------------------------- almacenamiento
  function makeStore() {
    const KEY = 'rocketprismas.gym.v1';
    const idb = () => new Promise((res, rej) => { const r = indexedDB.open('rocketprismas-gym', 1); r.onupgradeneeded = () => r.result.createObjectStore('replays'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return {
      load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } },
      save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* lleno */ } },
      async saveReplay(doc) { try { const db = await idb(); db.transaction('replays', 'readwrite').objectStore('replays').put(doc, 'last'); } catch (e) { /* sin IndexedDB */ } },
      async loadReplay() { try { const db = await idb(); return await new Promise((res) => { const r = db.transaction('replays').objectStore('replays').get('last'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); } catch (e) { return null; } },
    };
  }

  // ---------------------------------------------------------------- vista
  function build(core, store) {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const root = document.createElement('div'); root.id = 'gym'; document.body.appendChild(root);
    root.innerHTML = '<div class="top" id="gym-top"></div><div class="center" id="gym-center"></div><div class="cd" id="gym-cd"></div>';
    const top = root.querySelector('#gym-top'), center = root.querySelector('#gym-center'), cd = root.querySelector('#gym-cd');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      const act = b.dataset.act, val = b.dataset.val;
      if (act === 'download') { store.loadReplay().then((d) => { if (!d) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: 'application/json' })); a.download = 'gym-match-' + Date.now() + '.prismas.json'; a.click(); }); return; }
      if (act === 'select') core.act('select', { [b.dataset.key]: b.dataset.key === 'rank' ? +val : val });
      else if (act === 'speed') core.act('speed', { value: +val });
      else core.act(act);
    });
    const btn = (label, act, cls, extra) => '<button class="' + (cls || '') + '" data-act="' + act + '" ' + (extra || '') + '>' + label + '</button>';

    function hudHtml(h) {
      const clock = h.overtime ? 'OT +' + fmt(h.clock) : fmt(h.clock);
      return '<div class="hud"><span class="b">' + h.score[0] + '</span><span>' + clock + '</span><span class="o">' + h.score[1] + '</span></div>' +
        '<div style="text-align:center"><small>' + esc(h.opponents.join(' + ')) + ' · first to a 4-goal lead wins by forfeit</small></div>';
    }

    function render(v) {
      top.innerHTML = ''; center.innerHTML = ''; center.style.display = 'none';
      const show = (html) => { center.style.display = 'block'; center.innerHTML = '<div class="card">' + html + '</div>'; };
      if (v.busy) { show('<div class="busy">' + (BUSY[v.busy] || '…') + '</div>'); if (v.phase !== 'review') return; center.style.display = 'none'; }
      if (v.phase === 'menu') {
        const m = v.menu;
        show('<h2>GYM</h2><p>Pick your rank and mode. Play, lose, then fix the exact mistake that cost you.</p>' +
          '<div class="row">' + m.ranks.map((r) => btn(r.name, 'select', m.selection.rank === r.idx ? 'on' : 'alt', 'data-key="rank" data-val="' + r.idx + '"')).join('') + '</div>' +
          '<div class="row">' + m.modes.map((x) => btn(x, 'select', m.selection.mode === x ? 'on' : 'alt', 'data-key="mode" data-val="' + x + '"')).join('') + '</div>' +
          (v.error ? '<p class="bad">' + esc(ERR[v.error] || v.error) + '</p>' : '') +
          '<div class="row">' + btn('PLAY', 'start') + (m.canResume ? btn('RESUME REVIEW', 'resume', 'alt') : '') + '</div>');
      } else if (v.phase === 'match' && v.hud) {
        top.innerHTML = hudHtml(v.hud);
      } else if (v.phase === 'result') {
        const r = v.result;
        if (!r) { show('<h2>Match over</h2><p class="bad">' + esc(ERR[v.error] || v.error || '') + '</p><div class="row">' + btn('PLAY AGAIN', 'next_match') + btn('MENU', 'menu', 'alt') + '</div>'); return; }
        const win = r.outcome !== 'lost';
        show('<h2 class="' + (win ? 'good' : 'bad') + '">' + (win ? 'VICTORY' : 'DEFEAT') + ' ' + r.score[0] + '–' + r.score[1] + '</h2>' +
          '<p><span class="tag">' + END[r.result.reason] + '</span>vs ' + esc(r.bot) + '</p>' +
          '<p>' + (r.outcome === 'advance' ? 'Convincing win. Next opponent: <b>' + esc(r.unlocked) + '</b>.' : 'Close one. Same opponent next, win by 2+ to move up.') + '</p>' +
          (v.error ? '<p class="bad">' + esc(ERR[v.error] || v.error) + '</p>' : '') +
          '<div class="row">' + btn('NEXT MATCH', 'next_match') + btn('SAVE REPLAY', 'download', 'alt') + btn('MENU', 'menu', 'alt') + '</div>');
      } else if (v.phase === 'review' && v.review) {
        const r = v.review, e = r.error, k = KIND[e.kind] || [e.kind, ''];
        const spd = '<div class="row">' + r.speeds.map((s) => btn(s + 'x', 'speed', r.speed === s ? 'on' : 'alt', 'data-val="' + s + '"')).join('') + '</div>';
        let body = '<h2>MISTAKE ' + (r.idx + 1) + '/' + r.total + ' · ' + esc(k[0]) + '</h2>' +
          '<p><span class="tag">match time ' + fmt(e.t) + '</span><span class="tag">impact ' + Math.round(e.impact * 100) + '</span><span class="tag">' + r.fixed + ' fixed</span></p>' +
          '<p>' + esc(e.why) + '</p><p><small>Tip: ' + esc(e.hint) + '</small></p>';
        if (r.mode === 'ready') {
          body += '<small>You are back in the exact situation, about ' + e.scenario.error_offset_s.toFixed(1) + 's before it happened.</small>' + spd + '<div class="row">' + btn('GO', 'go') +
            (r.demo.available ? btn('WATCH ' + esc(r.demo.rank.replace('*', '')).toUpperCase() + ' BOT', 'demo', 'alt', r.demo.loading ? 'disabled' : '') : btn('NO HIGHER RANK', 'demo', 'alt', 'disabled')) + '</div>' +
            (r.demo.available ? '<small>Demo: ' + esc(r.demo.bot) + ' (' + esc(r.demo.rank) + '), one rank above you</small>' : '') +
            (r.attempts ? '<div class="row">' + btn('SKIP', 'skip', 'alt') + '</div>' : '');
        } else if (r.mode === 'demo' || r.mode === 'restoring') {
          body += '<p class="busy">' + esc(r.demo.bot || '') + ' is driving your car…</p>' + spd + '<div class="row">' + btn('BACK TO ME', 'stop_demo', 'alt') + '</div>';
        } else if (r.mode === 'attempt') {
          body += '<p class="busy">Your turn. Reproduce the solution.</p>' + spd + '<div class="row">' + btn('FINISH', 'finish_attempt', 'alt') + btn('RESTART', 'retry', 'alt') + '</div>';
        } else if (r.mode === 'evaluating') {
          body += '<p class="busy">Checking whether the mistake is fixed…</p>';
        } else if (r.mode === 'result') {
          const ev = r.evaluation, fixed = ev && ev.corrected;
          body += '<p class="' + (fixed ? 'good' : 'bad') + '"><b>' + (fixed ? 'Mistake corrected ✓' : 'Not yet') + '</b>' + (fixed ? '' : ': ' + (ev.reasons || []).map((x) => REASON[x] || x).join(', ')) + '</p>' +
            '<div class="row">' + (fixed ? btn('NEXT MISTAKE', 'next') : btn('TRY AGAIN', 'retry') + (r.demo.available ? btn('WATCH BOT', 'demo', 'alt') : '') + btn('SKIP', 'skip', 'alt')) + '</div>';
        }
        top.innerHTML = '<div class="card">' + body + '</div>';
      } else if (v.phase === 'rematch' && v.rematch) {
        const r = v.rematch;
        show('<h2>READY FOR THE REMATCH</h2><p>' + r.fixed + '/' + r.total + ' key mistakes fixed. Prove it against <b>' + esc(r.opponents.join(' + ')) + '</b> (' + esc(r.rank) + ').</p>' +
          '<div class="row">' + btn('REMATCH', 'rematch') + btn('MENU', 'menu', 'alt') + '</div>');
      }
    }
    return { render, hud: (h) => { if (h && core.state.phase === 'match') top.innerHTML = hudHtml(h); }, countdown: (n) => { cd.textContent = n > 0 ? n : (n === 0 ? 'GO!' : ''); if (n === 0) setTimeout(() => { cd.textContent = ''; }, 600); } };
  }

  // ---------------------------------------------------------------- cableado
  function launch() {
    if (window.__gym) return;
    const RS = window.RS, Bots = window.Bots, Recorder = window.Recorder;
    const info = Bots && Bots.info && Bots.info();
    if (!RS || !info) { alert('Bots are still loading, try again in a moment.'); return; }
    const store = makeStore(), analyzer = makeAnalyzer(), proxy = {};
    const ui = { render: (v) => proxy.v.render(v), hud: (h) => proxy.v.hud(h), countdown: (n) => proxy.v.countdown(n) };
    const core = window.GymCore.create({ RS, Bots, Recorder, analyzer, ui, store });
    proxy.v = build(core, store);
    window.__gymRender = proxy.v.render;     // para pruebas de interfaz (tools/gym/test_ui.mjs)
    window.__gym = core;
    (function loop() { requestAnimationFrame(loop); core.frame(); })();   // se registra después del bucle de game.js: corre tras la física
    core.open(info);
  }

  function boot() {
    const menu = document.getElementById('start-menu');
    if (!menu) return;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'gym-button'; b.innerHTML = '<span>GYM (BOTS + COACH)</span>';
    const sec = document.createElement('div'); sec.className = 'menu-section';
    sec.innerHTML = '<div class="menu-label">Train</div>'; sec.appendChild(b); menu.appendChild(sec);
    b.addEventListener('click', () => { menu.remove(); launch(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.Gym = { launch };
})();
