// Medidor de boost circular estilo RL. Solo lectura: usa RS.getState() (sin tocar game.js) y solo escribe el DOM cuando cambia el valor.
(function () {
  'use strict';
  const C = 2 * Math.PI * 48, ARC = C * 0.75;   // arco de 270° con la abertura abajo
  const el = document.createElement('div'); el.id = 'rl-boost';
  el.innerHTML = '<svg viewBox="0 0 120 120"><g transform="rotate(135 60 60)" fill="none" stroke-width="11" stroke-linecap="butt">' +
    '<circle class="trk" cx="60" cy="60" r="48" stroke-dasharray="' + ARC + ' ' + C + '"/>' +
    '<circle class="fil" cx="60" cy="60" r="48" stroke-dasharray="0 ' + C + '"/></g></svg><div class="num">0</div><div class="lbl">BOOST</div>';
  document.body.appendChild(el);
  const fil = el.querySelector('.fil'), num = el.querySelector('.num');
  let last = -1, burnT = 0;
  (function loop() {
    requestAnimationFrame(loop);
    const RS = window.RS, g = window.__gym;
    const on = !!(RS && g && g.state && g.state.phase !== 'menu');
    if (el.classList.contains('show') !== on) el.classList.toggle('show', on);
    if (!on) return;
    let v = RS.getInfBoost && RS.getInfBoost() ? 100 : Math.max(0, Math.min(100, Math.round(RS.getState().boost)));
    if (v === last) { if (burnT && performance.now() - burnT > 120) { burnT = 0; el.classList.remove('burn'); } return; }
    if (v < last) { burnT = performance.now(); el.classList.add('burn'); }
    last = v;
    fil.setAttribute('stroke-dasharray', (ARC * v / 100).toFixed(1) + ' ' + C.toFixed(1));
    num.textContent = v;
    el.classList.toggle('low', v <= 20);
  })();
})();

// Chat estilo RL: abajo a la izquierda, texto pequeño, nombre con el color del equipo, se desvanece solo.
(function () {
  const box = document.createElement('div'); box.id = 'rl-chat'; document.body.appendChild(box);
  window.RLChat = { say(name, team, text) {
    const r = document.createElement('div'); r.className = 'row';
    const n = document.createElement('b'); n.className = team === 0 ? 'b' : 'o'; n.textContent = name + ': ';
    r.appendChild(n); r.appendChild(document.createTextNode(text)); box.appendChild(r);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => r.classList.add('out'), 4200); setTimeout(() => r.remove(), 5000);
  } };
})();
