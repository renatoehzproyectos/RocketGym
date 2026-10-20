// Arnés headless: carga el rocketsim.wasm real en Node. Lo usan las pruebas del gimnasio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadPhysics() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.startsWith('file:')) {
      const buf = fs.readFileSync(new URL(s));
      return new Response(buf, { headers: { 'Content-Type': 'application/wasm' } });
    }
    return realFetch(u);
  };
  const mod = await import(pathToFileURL(path.join(ROOT, 'dist', 'rocketsim.js')).href);
  const M = await mod.default({ locateFile: (f) => pathToFileURL(path.join(ROOT, 'dist', f)).href });
  M.init();
  M.createArena();
  return M;
}

export const TICK = 1 / 120;
