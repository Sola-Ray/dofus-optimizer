// Web Worker : charge HiGHS et lance le moteur sans bloquer l'interface.
import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import { optimize } from './engine/optimize.js';

let highsPromise;
let game;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'game') { game = data.game; return; }
    highsPromise ||= highsLoader({ locateFile: () => wasmUrl });
    const highs = await highsPromise;
    const result = optimize(highs, game, data.config, p => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'result', result });
  } catch (e) {
    // une erreur WASM peut laisser le solveur dans un état invalide : on le recharge
    highsPromise = null;
    self.postMessage({ type: 'error', message: e.message || String(e) });
  }
};
