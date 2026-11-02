// Formule de dégâts Dofus 3 et simulation des jets de sorts.
//   brut   = floor(jet × (100 + carac + puissance) / 100 + Dommages + Dommages élément [+ Dommages critiques])
//   bonus  = brut × (1 + % sorts) × (1 + % distance ou mêlée)    (catégories différentes : multiplicatif)
//   final  = bonus × Π(1 + % dommages finaux) × (1 + % dommages subis par la cible)
//   cible  = (final − résistance fixe [− rés. critiques]) × (1 − % résistance)
import { ELEMENTS, ELEMENT_STAT, ELEMENT_DO, ELEMENT_RES, ELEMENT_RF } from './rules.js';
import { passiveEffect } from './passives.js';

export function classSpells(game, breedId) {
  const breed = game.breeds.find(b => b.id === breedId);
  return breed.variants.flat().map(id => game.spells[id]).filter(Boolean);
}

const hits = (line, el) => (line.k === 'dmg' || line.k === 'vol') && (line.el === el || line.el === 'best');

// Sorts offensifs d'un élément, résumés par leur jet moyen normal et critique
export function elementSpells(spells, el) {
  return spells.flatMap(s => {
    const normal = s.lines.filter(l => !l.crit && hits(l, el));
    if (!normal.length) return [];
    const critical = s.lines.filter(l => l.crit && hits(l, el));
    const avg = ls => ls.reduce((t, l) => t + (l.min + l.max) / 2, 0);
    return [{ id: s.id, n: avg(normal), c: critical.length ? avg(critical) : avg(normal), cc: critical.length ? s.cc : 0, nLines: normal.length }];
  });
}

// Applique les passifs : stats additives dans les stats, multiplicateurs à part
export function applyPassives(stats, passiveIds, scenario) {
  const s = { ...stats };
  const mods = { finaux: [], cible: 0 };
  for (const id of passiveIds) {
    const e = passiveEffect(id, scenario, stats);
    if (!e) continue;
    for (const [k, v] of Object.entries(e)) {
      if (k === 'finaux') mods.finaux.push(v);
      else if (k === 'cible') mods.cible += v;
      else s[k] = (s[k] || 0) + v;
    }
  }
  return { stats: s, mods };
}

export function multipliers(stats, mods, attack) {
  const pct = (1 + (stats.pctSorts || 0) / 100) * (1 + (stats[attack === 'melee' ? 'pctMelee' : 'pctDist'] || 0) / 100);
  let fin = 1 + (stats.pctFinaux || 0) / 100;
  for (const f of mods.finaux) fin *= 1 + f / 100;
  return pct * fin * (1 + mods.cible / 100);
}

const critRate = (cc, stats) => cc > 0 ? Math.max(0, Math.min(1, (cc + (stats.crit || 0)) / 100)) : 0;

// Dégâts moyens attendus (sans arrondis ni cible) d'un sort résumé
function expected(sp, el, stats, mult) {
  const m = (100 + (stats[ELEMENT_STAT[el]] || 0) + (stats.puissance || 0)) / 100;
  const fixed = (stats.do || 0) + (stats[ELEMENT_DO[el]] || 0);
  const normal = sp.n * m + fixed * sp.nLines;
  const crit = sp.c * m + (fixed + (stats.doCrit || 0)) * sp.nLines;
  const c = critRate(sp.cc, stats);
  return mult * ((1 - c) * normal + c * crit);
}

// Objectif du moteur : pour chaque élément joué, moyenne des dégâts attendus de ses sorts ;
// on maximise l'élément le plus faible (équilibre en multi-élément).
export function elementScores(stats, ctx) {
  const { stats: s, mods } = applyPassives({ ...stats, elements: ctx.elements }, ctx.passives || [], ctx.scenario);
  const mult = multipliers(s, mods, ctx.attack);
  const out = {};
  for (const el of ctx.elements) {
    const list = ctx.refSpells[el];
    out[el] = list.length ? list.reduce((t, sp) => t + expected(sp, el, s, mult), 0) / list.length : 0;
  }
  return out;
}

export function score(stats, ctx) {
  return Math.min(...Object.values(elementScores(stats, ctx)));
}

// Jet affiché comme en jeu, contre une cible
function hitValue(roll, el, stats, mult, target, isCrit) {
  const m = (100 + (stats[ELEMENT_STAT[el]] || 0) + (stats.puissance || 0)) / 100;
  const fixed = (stats.do || 0) + (stats[ELEMENT_DO[el]] || 0) + (isCrit ? stats.doCrit || 0 : 0);
  let d = Math.floor(Math.floor(roll * m + fixed) * mult);
  d -= (target[ELEMENT_RF[el]] || 0) + (isCrit ? target.resCrit || 0 : 0);
  d = Math.floor(Math.max(0, d) * (100 - Math.min(target[ELEMENT_RES[el]] || 0, 100)) / 100);
  return d;
}

function healValue(roll, el, stats) {
  return Math.floor(roll * (100 + (stats[ELEMENT_STAT[el]] || 0)) / 100 + (stats.soins || 0));
}

// Simulation d'un sort : lignes normales et critiques, min-max contre la cible
export function simulateSpell(spell, stats, ctx, target) {
  const { stats: s, mods } = applyPassives({ ...stats, elements: ctx.elements }, ctx.passives || [], ctx.scenario);
  const mult = multipliers(s, mods, ctx.attack) * (1 + (target.pctSubis || 0) / 100);
  const best = ctx.elements.reduce((b, el) => (s[ELEMENT_STAT[el]] || 0) > (s[ELEMENT_STAT[b]] || 0) ? el : b, ctx.elements[0] || 'feu');
  const rows = { normal: [], crit: [] };
  for (const l of spell.lines) {
    const el = l.el === 'best' ? best : l.el;
    const row = { kind: l.k, el };
    if (l.k === 'soin') {
      row.min = healValue(l.min, el, s);
      row.max = healValue(l.max, el, s);
    } else {
      row.min = hitValue(l.min, el, s, mult, target, l.crit);
      row.max = hitValue(l.max, el, s, mult, target, l.crit);
    }
    rows[l.crit ? 'crit' : 'normal'].push(row);
  }
  // Plusieurs éléments sur un même sort = en général un seul s'applique (meilleur élément, condition) :
  // on retient l'élément qui fait le plus de dégâts.
  const sum = (list, k) => {
    const byEl = {};
    for (const r of list) if (r.kind !== 'soin') byEl[r.el] = (byEl[r.el] || 0) + r[k];
    return Math.max(0, ...Object.values(byEl));
  };
  const critChance = critRate(spell.cc, s);
  const avgN = (sum(rows.normal, 'min') + sum(rows.normal, 'max')) / 2;
  const avgC = rows.crit.length ? (sum(rows.crit, 'min') + sum(rows.crit, 'max')) / 2 : avgN;
  return { rows, critChance, average: (1 - critChance) * avgN + critChance * avgC, perPA: spell.pa ? ((1 - critChance) * avgN + critChance * avgC) / spell.pa : 0 };
}

export { ELEMENTS };
