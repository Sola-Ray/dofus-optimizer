// Essai : plancher de critique choisi au lieu de 100 % ou rien.
//   node test/crit-floor.mjs <code Huzounet> <plancher|crit|noncrit>
import highsLoader from 'highs';
import { readFileSync } from 'node:fs';
import { optimize } from '../src/engine/optimize.js';
import { evaluateStuff } from '../src/engine/edit.js';
import { createSession } from '../src/engine/session.js';
import { huzounetStuffs, huzounetResult } from './huzounet.mjs';
const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const highs = await highsLoader();
const solver = { open: async lp => createSession(highs, lp), solve: async (lp, o) => highs.solve(lp, o) };
const [code, mode] = process.argv.slice(2);
const theirs = evaluateStuff(game, huzounetResult(game, huzounetStuffs().find(s => s.c === code)));
const cfg = { ...theirs.config, critMode: mode === 'noncrit' ? 'noncrit' : 'crit', ...(/^\d+$/.test(mode) ? { critTarget: Number(mode) } : {}) };
const r = await optimize(solver, game, cfg);
console.log(`${code} ${mode.padEnd(8)} score ${r.score.toFixed(1)} (Huzounet ${theirs.score.toFixed(1)}, crit ${theirs.stats.crit})  crit ${Math.round(r.stats.crit)}  viol ${r.violations.length}`);
