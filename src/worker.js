// Web Worker coordinateur : lance le moteur ; chaque session de résolution a son propre worker
// solveur, si bien que les modes critique / sans critique tournent sur deux cœurs en parallèle.
import { optimize, withAutoElement, refinish } from './engine/optimize.js';
import { optimizeLeveling } from './engine/leveling.js';

let game;
let nextId = 1;

// Client d'un worker solveur : chaque appel renvoie une promesse
function solverWorker() {
  const w = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
  };
  w.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'Erreur du solveur')); pending.clear(); };
  const call = (op, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, ...args });
  });
  return { call, terminate: () => w.terminate() };
}

const solver = {
  async open(lp) {
    const w = solverWorker();
    await w.call('open', { lp });
    return {
      run: options => w.call('run', { options }),
      addCuts: cuts => w.call('addCuts', { cuts }),
      warmStart: start => w.call('warmStart', { start }),
      setBounds: (names, lo, hi) => w.call('setBounds', { names, lo, hi }),
      close: () => w.terminate(),
    };
  },
  async solve(lp, options) {
    const w = solverWorker();
    try { return await w.call('solve', { lp, options }); } finally { w.terminate(); }
  },
};

self.onmessage = async ({ data }) => {
  if (data.type === 'game') { game = data.game; return; }
  if (data.type === 'refinish') {
    try {
      self.postMessage({ type: 'refinished', result: await refinish(solver, game, data.result) });
    } catch (e) {
      self.postMessage({ type: 'error', message: e.message || String(e) });
    }
    return;
  }
  try {
    const t0 = performance.now();
    const run = data.type === 'leveling' ? optimizeLeveling : optimize;
    const result = await withAutoElement(run, solver, game, data.config, p => self.postMessage({ type: 'progress', ...p }));
    result.seconds = (performance.now() - t0) / 1000;
    self.postMessage({ type: 'result', result });
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message || String(e) });
  }
};
