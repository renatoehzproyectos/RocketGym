// Ejecuta webbots/gymworker.js TAL CUAL en Node con Pyodide real (npm) y un fetch que lee del disco.
// Uso: node tools/gym/run_worker_node.mjs <recording.prismas.json>   (requiere: npm i pyodide@0.26.4 en PYODIDE_DIR)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYO = process.env.PYODIDE_DIR || '/tmp/pyo';
const require = createRequire(path.join(PYO, 'x.js'));

export async function startWorker() {
  const pyodide = require('pyodide');
  const listeners = {};
  const out = [];
  const waiters = [];
  const ctx = vm.createContext({
    console, JSON, Uint8Array, Promise, String, Object, Error, setTimeout, clearTimeout,
    importScripts: () => { ctx.loadPyodide = (o) => pyodide.loadPyodide(Object.assign({ indexURL: path.join(PYO, 'node_modules', 'pyodide') }, o)); },
    fetch: async (u) => {
      const p = path.join(ROOT, String(u).replace(/^\.\//, ''));
      const buf = fs.readFileSync(p);
      return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), json: async () => JSON.parse(buf.toString('utf8')) };
    },
    postMessage: (m) => { out.push(m); waiters.splice(0).forEach((w) => w()); },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'webbots', 'gymworker.js'), 'utf8'), ctx, { filename: 'gymworker.js' });
  const send = (m) => ctx.onmessage({ data: m });
  const next = async (pred) => { for (;;) { const i = out.findIndex(pred); if (i >= 0) return out.splice(i, 1)[0]; await new Promise((r) => waiters.push(r)); } };
  return {
    init: async () => { send({ t: 'init', base: './' }); return next((m) => m.t === 'ready'); },
    req: async (id, body) => { send(Object.assign({ t: 'req', id }, body)); return (await next((m) => m.t === 'res' && m.id === id)).out; },
  };
}

if (process.argv[1] && process.argv[1].endsWith('run_worker_node.mjs')) {
  const w = await startWorker();
  const t0 = Date.now();
  const ready = await w.init();
  console.log('worker ready:', ready, `(${Date.now() - t0} ms)`);
  const doc = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/m2.prismas.json', 'utf8'));
  const t1 = Date.now();
  const res = await w.req(1, { op: 'analyze', doc });
  console.log(`analyze ${doc.frames.length} frames in ${Date.now() - t1} ms -> ok=${res.ok} top=${res.top && res.top.kind} errors=${res.errors && res.errors.length}`);
  if (res.errors) res.errors.forEach((e) => console.log('  ', e.rank, e.kind, 't=' + e.t, 'impact=' + e.impact, '|', e.why));
}
