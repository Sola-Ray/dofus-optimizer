// Tests du moteur : npm test
//   - stats et jets de sorts comparés à ceux qu'affiche DofusBook pour des stuffs de Huzounet ;
//   - formule de dégâts sur un cas calculé à la main ;
//   - lignes de dégâts gardées par sort (doublons, variantes) ;
//   - optimiseur : au moins aussi bon qu'un stuff Huzounet sous les mêmes contraintes, et score
//     stable (si le modèle change exprès, mettre à jour SNAPSHOT avec la nouvelle valeur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import highsLoader from 'highs';
import { optimize, refinish, normalizeConfig } from '../src/engine/optimize.js';
import { evaluateStuff } from '../src/engine/edit.js';
import { createSession } from '../src/engine/session.js';
import { simulateSpell, spellAtLevel, SPELL_RULES } from '../src/engine/damage.js';
import { huzounetStuffs, huzounetResult } from './huzounet.mjs';

const json = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const game = json('../public/game.json');
const stuffs = huzounetStuffs();
const evaluated = code => evaluateStuff(game, huzounetResult(game, stuffs.find(s => s.c === code)));

// Libellés DofusBook → stats du moteur (Do <élément> affiché = Dommages + Dommages élément)
const DB = {
  PA: s => s.pa, PM: s => s.pm, PO: s => s.po, Critique: s => s.crit, 'Vitalité': s => s.vita - 1045,
  Sagesse: s => s.sagesse, Force: s => s.force, Intelligence: s => s.intel, Chance: s => s.chance, 'Agilité': s => s.agi,
  Puissance: s => s.puissance, Dommages: s => s.do, 'Do Critique': s => s.doCrit,
  'Do Neutre': s => s.do + s.doNeutre, 'Do Terre': s => s.do + s.doTerre, 'Do Feu': s => s.do + s.doFeu,
  'Do Eau': s => s.do + s.doEau, 'Do Air': s => s.do + s.doAir,
  '% Do Sorts': s => s.pctSorts, '% Do Mélée': s => s.pctMelee, '% Do Dist': s => s.pctDist, '% Do Armes': s => s.pctArmes,
  '%Ré Neutre': s => s.resNeutre, '% Ré Terre': s => s.resTerre, '% Ré Feu': s => s.resFeu, '% Ré Eau': s => s.resEau, '% Ré Air': s => s.resAir,
  'Ré Neutre': s => s.rfNeutre, 'Ré Terre': s => s.rfTerre, 'Ré Feu': s => s.rfFeu, 'Ré Eau': s => s.rfEau, 'Ré Air': s => s.rfAir,
};
const zero = st => new Proxy(st, { get: (t, k) => t[k] || 0 });

test('stats totales identiques à DofusBook', () => {
  for (const [code, expected] of Object.entries(json('./fixtures/dofusbook-stats.json').stuffs)) {
    const st = zero(evaluated(code).stats);
    for (const [label, f] of Object.entries(DB)) {
      if (expected[label] === undefined) continue;
      assert.equal(Math.round(f(st)), expected[label], `${code} ${label}`);
    }
  }
});

test('jets des sorts identiques à DofusBook (sorts sans cumul)', () => {
  for (const [code, spells] of Object.entries(json('./fixtures/dofusbook-spells.json').stuffs)) {
    const r = evaluated(code);
    const ctx = { elements: r.config.elements, attack: r.config.attack, scenario: 'moyen', passives: [] };
    for (const [id, exp] of Object.entries(spells)) {
      if (SPELL_RULES[id]?.stack) continue; // le moteur ajoute un cumul moyen, DofusBook affiche le jet de base
      const res = simulateSpell(spellAtLevel(game.spells[id], 200), r.stats, ctx, {});
      const n = res.rows.normal.find(x => x.kind !== 'soin'), c = res.rows.crit.find(x => x.kind !== 'soin');
      assert.deepEqual([n.min, n.max], exp.normal, `${code} ${exp.n} normal`);
      assert.deepEqual([c.min, c.max], exp.crit, `${code} ${exp.n} critique`);
    }
  }
});

test('formule de dégâts : cas calculé à la main', () => {
  const spell = { id: -1, cc: 0, pa: 3, lines: [{ k: 'dmg', el: 'feu', min: 100, max: 100, crit: false }] };
  const stats = { intel: 900, puissance: 100, do: 20, doFeu: 30, pctSorts: 10, pctDist: 10 };
  const ctx = { elements: ['feu'], attack: 'dist', scenario: 'moyen', passives: [] };
  // floor(100 × 11 + 50) = 1150 ; × 1,1 × 1,1 = 1391,5 → 1391 ; (1391 − 10) × 0,8 = 1104,8 → 1104
  const res = simulateSpell(spell, stats, ctx, { resFeu: 20, rfFeu: 10 });
  assert.equal(res.rows.normal[0].min, 1104);
  // en mêlée, le % distance ne compte pas : 1150 × 1,1 = 1265 → (1265 − 10) × 0,8 = 1004
  assert.equal(simulateSpell(spell, stats, { ...ctx, attack: 'melee' }, { resFeu: 20, rfFeu: 10 }).rows.normal[0].min, 1004);
});

test('lignes de dégâts gardées par sort', () => {
  const count = id => spellAtLevel(game.spells[id], 200).lines.filter(l => (l.k === 'dmg' || l.k === 'vol') && !l.crit).length;
  assert.equal(count(25856), 1, 'Vacarme : la variante Feu Follet ne compte pas');
  assert.equal(count(32446), 2, 'Flèche Dévorante : lignes réservées aux états écartées');
  assert.equal(count(13438), 2, 'Dagues Boomerang : vrai second coup');
});

test('paliers de panoplie : b[n] = bonus à n objets', () => {
  const katcheur = Object.values(game.sets).find(s => /Katcheur/.test(s.n));
  assert.equal(katcheur.b[2].pa, undefined, 'Katcheur ×2 sans PA');
  assert.equal(katcheur.b[3].pa, 1, 'Katcheur ×3 : +1 PA');
});

// Stuff trouvé par le moteur pour Huppermage eau / air (1Vewf) : la Ceintacé demande PA < 12 ou PM < 6.
// La forgemagie finale ajoutait un exo PM gratuit et passait à 12 PA / 6 PM, condition cassée.
const CEINTACE_STUFF = [30949, 15701, 13642, 15698, 18592, 15699, 13641, 18591, 739, 7043, 7115, 7754, 13825, 22013, 13673, 20358];

test('forgemagie finale : conditions de port respectées', { timeout: 120_000 }, async () => {
  const highs = await highsLoader();
  const solver = { open: async lp => createSession(highs, lp), solve: async (lp, o) => highs.solve(lp, o) };
  const config = normalizeConfig(game, {
    breedId: 17, elements: ['eau', 'air'], min: { pa: 12, pm: 5, po: 5 },
    fm: { pctExoOn: false, overOn: false, transcendance: false, exoPA: true, exoPM: true, exoPO: true },
  });
  const byId = new Map(game.items.map(it => [it.id, it]));
  const items = CEINTACE_STUFF.map(id => { const gi = byId.get(id); return { ...gi, passive: gi.p || 0, fm: {}, trans: null }; });
  const r = await refinish(solver, game, { config, items, points: { chance: 300, agi: 300 }, crit: { mode: 'crit', runs: [], failed: null } });
  assert.deepEqual(r.unmetConditions, []);
  assert.ok(r.stats.pa < 12 || r.stats.pm < 6, `${r.stats.pa} PA / ${r.stats.pm} PM`);
  assert.deepEqual(r.violations, []);
});

// Score attendu du moteur sur un stuff Huzounet donné, mêmes contraintes (voir compare-huzounet.mjs)
const SNAPSHOT = { '1Kjm2': 1482.2 };

test('optimiseur : bat le stuff Huzounet, score stable', { timeout: 300_000 }, async () => {
  const highs = await highsLoader();
  const solver = { open: async lp => createSession(highs, lp), solve: async (lp, o) => highs.solve(lp, o) };
  for (const [code, expected] of Object.entries(SNAPSHOT)) {
    const theirs = evaluated(code);
    const ours = await optimize(solver, game, { ...theirs.config, critMode: 'auto' });
    assert.deepEqual(ours.violations, [], `${code} : minimums tenus`);
    assert.deepEqual(ours.unmetConditions, [], `${code} : conditions de port`);
    assert.ok(ours.score >= theirs.score - 1e-6, `${code} : ${ours.score} < Huzounet ${theirs.score}`);
    assert.ok(Math.abs(evaluateStuff(game, ours).score - ours.score) < 1e-6 * ours.score, `${code} : réévaluation identique`);
    assert.ok(Math.abs(ours.score / expected - 1) < 0.005, `${code} : score ${ours.score.toFixed(1)}, attendu ${expected}`);
  }
});
