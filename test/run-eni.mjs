// Lancement manuel : node test/run-eni.mjs [auto|crit|noncrit] ['{"fm":{"exoPct":2}}']
import highsLoader from 'highs';
import { readFileSync } from 'node:fs';
import { optimize } from '../src/engine/optimize.js';
import { STAT_LABEL } from '../src/engine/rules.js';

const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const highs = await highsLoader();
const t0 = Date.now();
const res = optimize(highs, game, { breedId: 7, elements: ['feu'], min: { pa: 12, pm: 6 }, critMode: process.argv[2] || 'auto', ...JSON.parse(process.argv[3] || '{}') },
  p => console.log(`[${p.mode}] iter ${p.iter} score ${p.value.toFixed(1)} (${p.items} candidats)`));
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('critique', JSON.stringify(res.crit));
for (const it of res.items) {
  console.log(`${it.s.padEnd(9)} ${it.n} (${it.l})`, Object.keys(it.fm).length ? 'FM ' + JSON.stringify(it.fm) : '', it.trans ? `TRANS ${it.trans.n}` : '');
}
console.log('points', res.points, 'coût', res.pointsCost);
const show = ['pa', 'pm', 'po', 'vita', 'resFeu', 'resEau', 'resTerre', 'resAir', 'resNeutre', 'intel', 'puissance', 'doFeu', 'do', 'crit', 'doCrit', 'pctSorts', 'pctDist'];
console.log(show.map(k => `${STAT_LABEL[k]} ${Math.round(res.stats[k] || 0)}`).join(' | '));
console.log('score', res.score.toFixed(1), 'violations', res.violations, 'conditions', res.unmetConditions);
console.log(res.fmComparison.map(o => `${o.pct.toFixed(2)} %  ${o.label}`).join('\n'));
