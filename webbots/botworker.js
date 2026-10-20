// Web Worker: Pyodide (Python en WASM) ejecutando un bot de RLBotPack sin instalar nada.
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
let runner = null;
onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'init') {
    try {
      const py = await loadPyodide();
      if (m.numpy) await py.loadPackage('numpy');
      for (const p of m.files) {
        const buf = new Uint8Array(await (await fetch(m.base + p)).arrayBuffer());
        const dir = '/web/' + p.substring(0, p.lastIndexOf('/'));
        py.FS.mkdirTree(dir);
        py.FS.writeFile('/web/' + p, buf);
      }
      py.runPython("import sys; sys.path.insert(0, '/web/webbots/py')");
      runner = py.pyimport('webrunner');
      const spec = Object.assign({}, m.spec, { dir: '/web/' + m.spec.dir });
      runner.init(JSON.stringify(spec));
      postMessage({ t: 'ready', ok: true });
    } catch (err) { postMessage({ t: 'ready', ok: false, err: String(err) }); }
  } else if (m.t === 'reinit' && runner) {
    // Gimnasio: tras reconstruir una situación, los bots arrancan sin rutinas viejas (mismo Pyodide, agentes nuevos).
    try { runner.init(JSON.stringify(Object.assign({}, m.spec, { dir: '/web/' + m.spec.dir }))); postMessage({ t: 'reinit', ok: true }); }
    catch (err) { postMessage({ t: 'reinit', ok: false, err: String(err) }); }
  } else if (m.t === 'state' && runner) {
    try { const c = JSON.parse(runner.step(JSON.stringify(m.s)));
      let chat = []; try { chat = JSON.parse(runner.chats()); } catch (e) {}
      postMessage({ t: 'ctl', c, chat }); }
    catch (err) { postMessage({ t: 'ctl', c: {}, err: String(err) }); }
  }
};
