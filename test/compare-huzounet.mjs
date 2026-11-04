// Compare le moteur aux stuffs de Huzounet (huzounet.fr, budgets « high » et « legendary »).
//   node test/compare-huzounet.mjs [--shard k/N] [--only code,code] [--out fichier.jsonl] [--eval] [--no-vita]
// Pour chaque stuff à un ou deux éléments (data/huzounet/stuffs.json, exporté de DofusBook) :
//   1. ses dégâts dans notre modèle (mêmes items, mêmes points, mêmes exos) ;
//   2. notre optimiseur, avec ses minimums (PA, PM, PO, résistance moyenne, vitalité sauf --no-vita)
//      et la même forgemagie
//      (exos PA / PM / PO seulement, pas d'over, d'exo % ni de transcendance).
// Le stuff du moteur doit faire au moins autant : sinon le solveur rate un optimum, ou une contrainte
// est mal traduite. --eval saute l'étape 2 (rapide).
import highsLoader from 'highs';
import { readFileSync, appendFileSync } from 'node:fs';
import { optimize } from '../src/engine/optimize.js';
import { evaluateStuff } from '../src/engine/edit.js';
import { createSession } from '../src/engine/session.js';
import { huzounetStuffs, huzounetResult } from './huzounet.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const [k, N] = (arg('--shard') || '0/1').split('/').map(Number);
const only = arg('--only')?.split(',');
const out = arg('--out');
const evalOnly = process.argv.includes('--eval');
const withVita = !process.argv.includes('--no-vita');

const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const highs = await highsLoader();
const solver = { open: async lp => createSession(highs, lp), solve: async (lp, o) => highs.solve(lp, o) };

const KEYS = ['pa', 'pm', 'po', 'vita', 'intel', 'force', 'chance', 'agi', 'puissance', 'do', 'crit', 'doCrit', 'pctSorts', 'pctDist', 'pctMelee'];
const pick = st => Object.fromEntries(KEYS.map(k => [k, Math.round(st[k] || 0)]));

const list = huzounetStuffs().filter((s, i) => (only ? only.includes(s.c) : i % N === k));
for (const s of list) {
  const t0 = Date.now();
  const theirs = evaluateStuff(game, huzounetResult(game, s, { withVita }));
  const row = {
    code: s.c, name: s.name, budget: s.budget, breedId: s.cl, elements: s.elements, attack: theirs.config.attack,
    min: theirs.config.min, missing: s.missing,
    theirs: { score: theirs.score, unmet: theirs.unmetConditions, stats: pick(theirs.stats), items: theirs.items.map(it => it.n) },
  };
  if (!evalOnly) {
    try {
      const ours = await optimize(solver, game, { ...theirs.config, critMode: 'auto' });
      const check = evaluateStuff(game, ours).score;
      row.ours = {
        score: ours.score, recheck: check, crit: ours.crit.mode, runs: ours.crit.runs, violations: ours.violations, unmet: ours.unmetConditions,
        stats: pick(ours.stats), items: ours.items.map(it => it.n), fm: ours.items.filter(it => Object.keys(it.fm).length).map(it => `${it.n} ${JSON.stringify(it.fm)}`),
      };
      row.gain = ours.score / theirs.score - 1;
    } catch (e) {
      row.error = e.message;
    }
  }
  row.seconds = (Date.now() - t0) / 1000;
  const line = JSON.stringify(row);
  if (out) appendFileSync(out, line + '\n');
  console.log(`${s.c} ${s.name.padEnd(42)} eux ${theirs.score.toFixed(1).padStart(7)}${row.ours ? `  nous ${row.ours.score.toFixed(1).padStart(7)}  ${(100 * row.gain).toFixed(1).padStart(6)} %` : ''}${row.error ? '  ERREUR ' + row.error : ''}  ${row.seconds.toFixed(0)} s`);
}
