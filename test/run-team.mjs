// Lancement manuel de l'écran Équipe : node test/run-team.mjs [fichier de cache] [tours]
// Génère (ou relit depuis le cache) un Iop terre, un Eniripsa feu, un Enutrof eau et un Pandawa air
// niveau 200, puis calcule qui doit buffer qui.
import highsLoader from 'highs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { optimize } from '../src/engine/optimize.js';
import { teamPlan, initiativeOf } from '../src/engine/team.js';
import { createSession } from '../src/engine/session.js';
import { STAT_LABEL } from '../src/engine/rules.js';

const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const cache = process.argv[2];
const turns = Number(process.argv[3] || 4);
const TEAM = [['Iop terre', 8, 'terre'], ['Eniripsa feu', 7, 'feu'], ['Enutrof eau', 3, 'eau'], ['Pandawa air', 12, 'air']];

let members;
if (cache && existsSync(cache)) members = JSON.parse(readFileSync(cache, 'utf8'));
else {
  const highs = await highsLoader();
  const solver = { open: async lp => createSession(highs, lp), solve: async (lp, o) => highs.solve(lp, o) };
  members = [];
  for (const [name, breedId, el] of TEAM) {
    const t0 = Date.now();
    const result = await optimize(solver, game, { breedId, elements: [el], critMode: 'noncrit', min: { pa: 12, pm: 6 } });
    console.log(`${name} : ${result.score.toFixed(0)} dégâts moyens par sort (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    members.push({ name, result });
  }
  if (cache) writeFileSync(cache, JSON.stringify(members));
}

// ordre de jeu : initiative décroissante
members.sort((a, b) => initiativeOf(b.result.stats) - initiativeOf(a.result.stats));
const t0 = Date.now();
const plan = teamPlan(game, members, { turns });
console.log(`\nPlan en ${Date.now() - t0} ms, ${turns} tours. Équipe sans buffs : ${plan.base.toFixed(0)}, avec : ${plan.total.toFixed(0)} (+${(100 * (plan.total / plan.base - 1)).toFixed(1)} %)`);
plan.members.forEach((m, j) => console.log(`  ${j + 1}. ${m.name} (initiative ${m.initiative}) : ${m.base.map(Math.round).join(' / ')} -> ${m.final.map(Math.round).join(' / ')}`));
const fx = e => Object.entries(e.effects).map(([k, v]) => `${v > 0 ? '+' : ''}${Math.round(v)} ${STAT_LABEL[k] || k}${e.per === 'pm' ? ' par PM' : ''}`).join(', ');
console.log('');
for (const a of plan.plan) {
  const who = a.target === null ? '' : ` sur ${plan.members[a.target].name}`;
  console.log(`  Tour ${a.turn} · ${plan.members[a.caster].name} : ${a.n} (${a.pa} PA)${who} → ${a.effects.map(fx).join(' ; ')} · +${Math.round(a.gain)} dégâts d'équipe`);
}
for (const m of plan.members) if (m.skipped.length) console.log(`  ${m.name}, non comptés : ${m.skipped.map(s => `${s.n} (${s.why})`).join(', ')}`);
