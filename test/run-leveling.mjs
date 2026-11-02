// Lancement manuel du mode leveling : node test/run-leveling.mjs ['{"leveling":{"keepGain":5}}']
import highsLoader from 'highs';
import { readFileSync } from 'node:fs';
import { optimizeLeveling, suggestTiers } from '../src/engine/leveling.js';
import { createSession } from '../src/engine/session.js';

const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const highs = await highsLoader();
const solver = {
  open: async lp => createSession(highs, lp),
  solve: async (lp, o) => highs.solve(lp, o),
};
const config = { breedId: 7, elements: ['feu'], critMode: 'noncrit', ...JSON.parse(process.argv[2] || '{}') };
console.log('paliers des sorts', suggestTiers(game, config.breedId, config.elements));
const t0 = Date.now();
const res = await optimizeLeveling(solver, game, config,
  p => p.value !== undefined && console.log(`[${p.label} phase ${p.phase}] iter ${p.iter} score ${p.value.toFixed(1)} ${((Date.now() - t0) / 1000).toFixed(1)} s`));
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s, ${res.candidates} candidats`);
for (const t of res.tiers) {
  const r = t.result;
  console.log(`\n== Niveau ${t.level} : ${r.score.toFixed(1)} (seul ${t.alone.toFixed(1)}, ${(100 * r.score / t.alone).toFixed(1)} %), ${t.added.length} nouveaux, ${t.kept.length} gardés · PA ${r.stats.pa} PM ${r.stats.pm}`);
  for (const it of r.items) console.log(`  ${t.kept.includes(it.id) ? '=' : '+'} ${it.s.padEnd(9)} ${it.n} (${it.l})`);
}
