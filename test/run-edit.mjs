// Lancement manuel : node test/run-edit.mjs — génère un stuff Eni feu, puis essaie les alternatives
// de la cape, remplace par la 2e, et refait la forgemagie
import highsLoader from 'highs';
import { readFileSync } from 'node:fs';
import { optimize, refinish } from '../src/engine/optimize.js';
import { evaluateStuff, placeItem, alternatives } from '../src/engine/edit.js';
import { createSession } from '../src/engine/session.js';

const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const highs = await highsLoader();
const solver = { open: async lp => createSession(highs, lp), solve: async (lp, o) => highs.solve(lp, o) };
const slot = process.argv[2] || 'cape';
let r = await optimize(solver, game, { breedId: 7, elements: ['feu'], min: { pa: 12, pm: 6 }, critMode: 'noncrit', maxIterations: 6 });
console.log('généré', r.score.toFixed(1), 'réévalué', evaluateStuff(game, r).score.toFixed(1));
const i = r.items.findIndex(it => it.s === slot);
console.log(slot, r.items[i].n, JSON.stringify(r.items[i].fm));
let t = Date.now();
const alts = alternatives(game, r, i);
console.log(`${alts.length} alternatives en ${Date.now() - t} ms`);
for (const a of alts.slice(0, 8)) console.log(`${a.pct.toFixed(1).padStart(6)} %  ${a.n}${a.current ? ' (actuel)' : ''}${a.worn ? ' (porté)' : ''}  ${a.issues.join(' ; ')}`);
const alt = alts.find(a => !a.current && !a.worn);
const { item, lost } = placeItem(game, r, i, game.items.find(g => g.id === alt.id));
r = evaluateStuff(game, { ...r, items: r.items.map((it, j) => (j === i ? item : it)) }, lost);
console.log('remplacé par', item.n, JSON.stringify(item.fm), r.score.toFixed(1), r.issues);
t = Date.now();
const re = await refinish(solver, game, r);
console.log(`FM refaite en ${Date.now() - t} ms`, re.score.toFixed(1), 'violations', re.violations, re.items.map(it => `${it.n} ${JSON.stringify(it.fm)}${it.trans ? ' T' : ''}`).join(' | '));
