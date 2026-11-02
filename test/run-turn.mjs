// Dégâts par tour d'un stuff généré : node test/run-turn.mjs [auto|crit|noncrit] ['{"level":200}'] [tours]
// Même configuration que run-eni.mjs (Eniripsa feu, 12 PA / 6 PM par défaut).
import highsLoader from 'highs';
import { readFileSync } from 'node:fs';
import { optimize } from '../src/engine/optimize.js';
import { createSession } from '../src/engine/session.js';
import { classSpells } from '../src/engine/damage.js';
import { turnDamage, equippedWeapon } from '../src/engine/rotation.js';

const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const highs = await highsLoader();
const solver = {
  open: async lp => createSession(highs, lp),
  solve: async (lp, o) => highs.solve(lp, o),
};
const t0 = Date.now();
const res = await optimize(solver, game, { breedId: 7, elements: ['feu'], min: { pa: 12, pm: 6 }, critMode: process.argv[2] || 'auto', ...JSON.parse(process.argv[3] || '{}') });
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s · score ${res.score.toFixed(1)} · ${res.stats.pa} PA · arme ${res.items.find(i => i.s === 'arme')?.n ?? 'aucune'}`);

const spells = classSpells(game, res.config.breedId, res.config.level);
const turn = turnDamage(spells, res.stats, res.ctx, { weapon: equippedWeapon(game, res.items), turns: Number(process.argv[4]) || 5 });
const line = c => `${c.count > 1 ? c.count + ' × ' : ''}${c.n} (${c.pa} PA)`;
console.log('\nSorts lançables (dégâts moyens par lancer, limite par tour, relance) :');
for (const o of turn.options) console.log(`  ${o.n.padEnd(22)} ${String(o.pa).padStart(2)} PA  ${o.dmg.toFixed(0).padStart(5)}  max ${o.cap === Infinity ? '∞' : o.cap}${o.cd ? `  relance ${o.cd}` : ''}${o.cd0 ? `  initiale ${o.cd0}` : ''}`);
console.log(`\nMeilleur tour : ${turn.best.dmg.toFixed(0)} (${turn.best.pa} / ${turn.pa} PA) : ${turn.best.casts.map(line).join(', ')}`);
console.log(`Tour moyen sur ${turn.average.turns.length} tours : ${turn.average.dmg.toFixed(0)}`);
turn.average.turns.forEach((t, i) => console.log(`  tour ${i + 1} : ${t.dmg.toFixed(0).padStart(5)} (${t.pa} PA) : ${t.casts.map(line).join(', ')}`));
