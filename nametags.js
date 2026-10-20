// Name tags sobre los autos de los demás: bots (azul = tu equipo, naranja = rivales) y el rival del multijugador.
//   NameTags.place(key, texto, equipo, mesh)  -> dibuja/actualiza la etiqueta sobre esa malla (llamar cada frame)
//   NameTags.hide(key)
(function () {
  const COLORS = { 0: '#4d9bff', 1: '#ff9a3c' };
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:15';
  const style = document.createElement('style');
  style.textContent = '.ntag{position:absolute;left:0;top:0;display:none;white-space:nowrap;padding:2px 12px 2px 14px;isolation:isolate;' +
    'font:italic 800 14px/1.3 "Arial Narrow","Roboto Condensed",Impact,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#fff;' +
    'text-shadow:0 1px 3px #000;transform-origin:50% 100%;will-change:transform}' +
    '.ntag::before{content:"";position:absolute;inset:0;z-index:-1;background:rgba(6,14,30,.72);border-left:4px solid var(--c);transform:skewX(-12deg)}';
  document.head.appendChild(style);
  document.body.appendChild(layer);

  const tags = new Map();
  let v = null;
  const HEIGHT = 1.15;   // metros (escala de la escena) sobre el centro del auto

  function get(key) {
    let t = tags.get(key);
    if (!t) {
      const el = document.createElement('div'); el.className = 'ntag'; layer.appendChild(el);
      t = { el, text: null, team: null, shown: false }; tags.set(key, t);
    }
    return t;
  }
  function hide(key) {
    const t = tags.get(key);
    if (t && t.shown) { t.el.style.display = 'none'; t.shown = false; }
  }
  function place(key, text, team, mesh) {
    const RS = window.RS;
    if (!RS || !mesh || !window.THREE) { hide(key); return; }
    if (!v) v = new THREE.Vector3();
    v.set(mesh.position.x, mesh.position.y + HEIGHT, mesh.position.z).project(RS.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { hide(key); return; }   // detrás de la cámara / fuera de pantalla
    const t = get(key);
    if (t.text !== text) { t.el.textContent = text; t.text = text; }
    if (t.team !== team) { t.el.style.setProperty('--c', COLORS[team] || '#fff'); t.team = team; }
    const dist = RS.camera.position.distanceTo(mesh.position);
    const s = Math.max(0.6, Math.min(1.15, 34 / dist));
    const x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    t.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-100%) scale(' + s.toFixed(3) + ')';
    if (!t.shown) { t.el.style.display = 'block'; t.shown = true; }
  }
  window.NameTags = { place, hide };

  // Rival del multijugador: en el host es carMesh2, en el visitante es carMesh. Siempre naranja (rival).
  (function mpLoop() {
    requestAnimationFrame(mpLoop);
    const RS = window.RS, info = window.__mpGetRemote && window.__mpGetRemote();
    if (!RS || !info || !info.role || !info.linked) { hide('mp'); return; }
    place('mp', info.name || 'Rival', 1, info.role === 'host' ? RS.carMesh2 : RS.carMesh);
  })();
})();
