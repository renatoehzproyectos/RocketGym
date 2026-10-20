// Web Worker del gimnasio: Pyodide + rlcoach (solo lo que gym necesita, ver webbots/gym_manifest.json).
// Mensajes:  {t:'init', base}                      -> {t:'ready', ok, err?}
//            {t:'req', id, op, ...}                -> {t:'res', id, out}      (op: 'analyze' | 'evaluate')
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
let handle = null;
onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'init') {
    try {
      const py = await loadPyodide();
      const man = await (await fetch(m.base + 'webbots/gym_manifest.json')).json();
      for (const p of man.files) {
        const buf = new Uint8Array(await (await fetch(m.base + p)).arrayBuffer());
        const rel = p.substring(man.root.length + 1);              // rlcoach/...
        py.FS.mkdirTree('/gym/' + rel.substring(0, rel.lastIndexOf('/')));
        py.FS.writeFile('/gym/' + rel, buf);
      }
      py.runPython("import sys; sys.path.insert(0, '/gym')");
      handle = py.pyimport('rlcoach.gym.analysis').handle;
      postMessage({ t: 'ready', ok: true });
    } catch (err) { postMessage({ t: 'ready', ok: false, err: String(err) }); }
  } else if (m.t === 'req' && handle) {
    try {
      const { t, id, ...req } = m;
      postMessage({ t: 'res', id: m.id, out: JSON.parse(handle(JSON.stringify(req))) });
    } catch (err) { postMessage({ t: 'res', id: m.id, out: { ok: false, error: String(err) } }); }
  }
};
