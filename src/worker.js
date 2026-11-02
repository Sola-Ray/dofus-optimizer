// Web Worker coordinateur : lance le moteur et répartit les résolutions sur un pool de solveurs.
import { optimize } from './engine/optimize.js';
import { SolverPool } from './solver-pool.js';

// un cœur reste libre pour l'interface ; plafonné pour limiter la mémoire (environ 200 Mo par solveur)
const POOL_SIZE = Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 8));
const pool = new SolverPool(POOL_SIZE);
let game;

self.onmessage = async ({ data }) => {
  if (data.type === 'game') { game = data.game; return; }
  try {
    const modes = data.config.critMode === 'auto' ? 2 : 1;
    const racers = Math.max(1, Math.floor(POOL_SIZE / modes));
    const solver = { solve: (lp, options) => pool.solve(lp, options, racers) };
    const t0 = performance.now();
    const result = await optimize(solver, game, data.config, p => self.postMessage({ type: 'progress', ...p, cores: POOL_SIZE }));
    result.seconds = (performance.now() - t0) / 1000;
    result.cores = POOL_SIZE;
    self.postMessage({ type: 'result', result });
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message || String(e) });
  }
};
