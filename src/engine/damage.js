// Formule de dégâts Dofus 3 et simulation des jets de sorts.
//   brut   = floor(jet × (100 + carac + puissance) / 100 + Dommages + Dommages élément [+ Dommages critiques])
//   bonus  = brut × (1 + % sorts) × (1 + % distance ou mêlée)    (catégories différentes : multiplicatif)
//   final  = bonus × Π(1 + % dommages finaux) × (1 + % dommages subis par la cible)
//   cible  = (final − résistance fixe [− rés. critiques]) × (1 − % résistance)
import { ELEMENTS, ELEMENT_STAT, ELEMENT_DO, ELEMENT_RES, ELEMENT_RF } from './rules.js';
import { passiveEffect } from './passives.js';

// Sorts dont les dégâts ne se lisent pas tels quels dans les données, codés à la main.
//   stack   : dommages de base augmentés à chaque cumul (Torrent Arcanique : +2 par combinaison
//             élémentaire, 6 au plus ; 3 combinaisons supposées avant de le lancer)
//   all     : toutes les lignes frappent, quel que soit leur élément (sinon, un sort à plusieurs
//             éléments n'en applique qu'un : le meilleur, ou celui que demande un état)
//   none    : aucun dégât direct (les lignes du sort sont jouées plus tard, par un autre effet)
//   add     : lignes absentes des données (jouées par un sous-sort non téléchargé)
//   client  : garder les lignes d'affichage (explosion différée sûre : Sablier, Sentence…)
//   delayed : écarter les lignes à retardement (coup qui ne part que sous condition)
const hit = (el, min, max, cmin, cmax) => [
  { k: 'dmg', el, min, max, crit: false, tm: 'A', z: '' },
  { k: 'dmg', el, min: cmin, max: cmax, crit: true, tm: 'A', z: '' },
];
export const SPELL_RULES = {
  14342: { stack: { per: 2, n: 3, max: 6 }, all: true, note: 'Torrent Arcanique : frappe dans les 4 éléments ; 3 combinaisons élémentaires supposées avant le lancer (+2 dommages de base chacune, 6 au plus).' },
  32033: { all: true, note: 'Supernova : frappe le meilleur et le pire élément du lanceur.' },
  13835: { all: true, note: 'Embuscade : frappe Eau, Terre, Feu et Air.' },
  13403: { all: true, note: 'Appui : frappe Feu, Terre, Eau et Air.' },
  32450: { add: hit('feu', 26, 29, 31, 35), note: 'Flèche Fulminante : premier coup du sous-sort (26 à 29 Feu), sans les rebonds.' },
  25802: { none: true, note: 'Mot Alchimique : la Fiole ne frappe qu’à sa destruction.' },
  23386: { none: true, note: 'Parade : riposte quand le lanceur est attaqué en mêlée.' },
  12936: { none: true, note: 'Comploteur : dégâts à la mort du double, au 3e tour.' },
  13479: { none: true, note: 'Bombe Collante : dégâts à l’activation de la bombe.' },
  32433: { delayed: true, note: 'Flèche Persécutrice : le second coup ne part que si la cible est hors de vue.' },
  12903: { none: true, note: 'Concentration de Chakra : vol de vie seulement sur dommages de pièges.' },
  32432: { client: true, note: 'Flèche Boomerang : le retour en fin de tour refrappe la cible.' },
  13261: { client: true }, 13147: { client: true }, 13568: { client: true }, // explosions différées sûres
};

// Lignes de dégâts qui frappent la cible quand on lance le sort sur un ennemi, sans état particulier :
//   - les lignes déclenchées plus tard (poisons de début / fin de tour…) comptent pour un seul
//     déclenchement, à part : elles ne sont jamais prises pour un doublon d'un coup direct ;
//   - une ligne d'affichage (c, forClientOnly) sans déclencheur de tour est un effet conditionnel
//     joué par un sous-sort (Monnaie Sonnante sur retrait de PA, Flibuste sur poussée…) : écartée
//     quand le sort a un vrai coup ; gardée si c'est la seule donnée (Harmattan) ;
//   - une ligne qui exige un état sur la cible (EN dans le masque, voir buffs.js) ne s'applique pas,
//     sauf les états élémentaires de l'Huppermage, posés par ses propres sorts ; « sans l'état » (eN)
//     est vrai par défaut. FN (« est le monstre N ») ne filtre rien ici ;
//   - conditions exclusives sur la cible : la variante en majuscule demande une mise en place et ne
//     compte pas (V50 vie sous 50 %, PB a du bouclier, R passé par un portail) ;
//   - un état exigé sur le lanceur (*EN) : si une autre ligne demande « sans cet état » (*eN), c'est
//     une variante qui demande une mise en place (Gueule de Bois, Cerbère) ; sinon, quand le sort a
//     des variantes pour plusieurs états du lanceur, l'une s'applique toujours (Pandawa Sobre / Saoul)
//     et on garde la première ; avec un seul état possible, la ligne ne compte pas (Glas) ;
//   - la même ligne répétée dans une autre zone est une variante (Vacarme sur un Feu Follet, Pendule…) :
//     comptée une fois. Répétée dans la même zone, c'est un vrai second coup (Dagues Boomerang) ;
//   - la ligne doit pouvoir toucher un ennemi ordinaire : A (ennemis), L (hors invocations) ou M
//     (monstres) ; les lignes réservées aux invocations (J, I, S) ou aux alliés sont écartées ;
//   - une ligne aléatoire (p) compte pour sa probabilité (Topkaj : un jet sur six).
const HUPPER_STATES = new Set(['290', '291', '292', '293']);
const targetState = l => (l.tm || '').split(',').some(t => /^E\d+$/.test(t) && !HUPPER_STATES.has(t.slice(1)));
const setupVariant = l => (l.tm || '').split(',').some(t => /^V\d+$/.test(t) || t === 'PB' || t === 'R');
const casterState = l => /(^|,)\*E(\d+)/.exec(l.tm)?.[2];
const hitsEnemy = l => (l.tm || 'A').split(',').some(t => t === 'A' || t === 'L' || t === 'M');
const isDamage = l => l.k === 'dmg' || l.k === 'vol';
export function directLines(spell) {
  const rule = SPELL_RULES[spell.id] || {};
  if (rule.none) return (spell.lines || []).filter(l => !isDamage(l));
  const all = [...(spell.lines || []), ...(rule.add || [])];
  const without = new Set(all.flatMap(l => [...(l.tm || '').matchAll(/(^|,)\*e(\d+)/g)].map(m => m[2])));
  const states = [...new Set(all.filter(l => !l.tr).map(casterState).filter(st => st && !without.has(st)))];
  const usable = l => hitsEnemy(l) && !targetState(l) && !setupVariant(l) && !(rule.delayed && l.dl);
  const hasReal = all.some(l => isDamage(l) && !l.c && usable(l));
  const out = [];
  for (const l of all) {
    if (isDamage(l)) {
      const st = casterState(l);
      if (!usable(l) || (st && (without.has(st) || states.length < 2 || st !== states[0]))) continue;
      if (l.c && !rule.client && hasReal && !/^(TB|TE)/.test(l.tr || '')) continue;
      const twin = out.find(o => !o.tr === !l.tr && o.k === l.k && o.el === l.el && o.min === l.min && o.max === l.max && o.crit === l.crit);
      if (twin && twin.z !== l.z) continue;
    }
    out.push(l);
  }
  if (rule.stack) {
    const add = rule.stack.per * Math.min(rule.stack.n, rule.stack.max);
    return out.map(l => (l.k === 'dmg' ? { ...l, min: l.min + add, max: l.max + add } : l));
  }
  return out;
}

// Sort au niveau du personnage : grade le plus haut déjà débloqué, null si pas encore appris.
// Les lignes gardées sont celles d'un lancer direct sur un ennemi (directLines).
export function spellAtLevel(spell, level = 200) {
  const grade = (spell.grades || [spell]).filter(g => g.lvl <= level).pop();
  if (!grade) return null;
  const sp = { ...spell, ...grade };
  return { ...sp, lines: directLines(sp) };
}

export function classSpells(game, breedId, level = 200) {
  const breed = game.breeds.find(b => b.id === breedId);
  return breed.variants.flat().map(id => game.spells[id] && spellAtLevel(game.spells[id], level)).filter(Boolean);
}

const hits = (line, el) => (line.k === 'dmg' || line.k === 'vol') && (line.el === el || line.el === 'best');
// Pire élément du lanceur : sa caractéristique élémentaire la plus basse
const STAT_ELEMENTS = ['feu', 'eau', 'terre', 'air'];
const worstOf = stats => STAT_ELEMENTS.reduce((w, e) => ((stats[ELEMENT_STAT[e]] || 0) < (stats[ELEMENT_STAT[w]] || 0) ? e : w));

// Sorts offensifs d'un élément, résumés par leur jet moyen normal et critique, en parts :
// une part par élément frappé. el: null = l'élément joué (lignes de l'élément ou « meilleur »),
// 'worst' = le pire élément du lanceur. Une ligne aléatoire compte pour sa probabilité (p).
// Un sort à règle « all » (Torrent Arcanique) garde toutes ses lignes, chacune dans son élément.
// w : poids du sort dans la moyenne (nombre de lancers, voir pickSpells dans optimize.js).
export function elementSpells(spells, el) {
  const avg = ls => ls.reduce((t, l) => t + (l.p ?? 1) * (l.min + l.max) / 2, 0);
  const count = ls => ls.reduce((t, l) => t + (l.p ?? 1), 0);
  const part = (ls, pel) => {
    const normal = ls.filter(l => !l.crit), critical = ls.filter(l => l.crit);
    return { el: pel, n: avg(normal), c: critical.length ? avg(critical) : avg(normal), nLines: count(normal) };
  };
  const worst = l => (l.k === 'dmg' || l.k === 'vol') && l.el === 'worst';
  return spells.flatMap(s => {
    if (!s.lines.some(l => !l.crit && hits(l, el))) return [];
    const cc = s.lines.some(l => l.crit && hits(l, el)) ? s.cc : 0;
    let parts;
    if (SPELL_RULES[s.id]?.all) {
      const byEl = {};
      for (const l of s.lines) if (l.k === 'dmg' || l.k === 'vol') (byEl[l.el] ||= []).push(l);
      parts = Object.entries(byEl).map(([e, ls]) => part(ls, e === 'best' || e === el ? null : e));
    } else {
      parts = [part(s.lines.filter(l => hits(l, el)), null)];
      if (s.lines.some(worst)) parts.push(part(s.lines.filter(worst), 'worst'));
    }
    return [{ id: s.id, cc, pa: s.pa, w: 1, parts }];
  });
}

// Applique les passifs : stats additives dans les stats, multiplicateurs à part
export function applyPassives(stats, passiveIds, scenario) {
  const s = { ...stats };
  const mods = { finaux: [], cible: 0, poison: 0 };
  for (const id of passiveIds) {
    const e = passiveEffect(id, scenario, stats);
    if (!e) continue;
    for (const [k, v] of Object.entries(e)) {
      if (k === 'finaux') mods.finaux.push(v);
      else if (k === 'cible') mods.cible += v;
      else if (k === 'poison') mods.poison += v;
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

// Dégâts moyens attendus (sans arrondis ni cible) d'un sort résumé, joué dans l'élément el
function expected(sp, el, stats, mult) {
  const c = critRate(sp.cc, stats);
  let total = 0;
  for (const p of sp.parts) {
    const e = p.el === 'worst' ? worstOf(stats) : p.el || el;
    const m = (100 + (stats[ELEMENT_STAT[e]] || 0) + (stats.puissance || 0)) / 100;
    const fixed = (stats.do || 0) + (stats[ELEMENT_DO[e]] || 0);
    const normal = p.n * m + fixed * p.nLines;
    const crit = p.c * m + (fixed + (stats.doCrit || 0)) * p.nLines;
    total += (1 - c) * normal + c * crit;
  }
  return mult * total;
}

// Poison d'un passif sur un tour, dans l'élément el. Hypothèse : comme un poison de sort, il profite
// de la caractéristique, de la Puissance et des multiplicateurs finaux, pas des Dommages fixes ni des
// % sorts / distance.
export function poisonDamage(el, s, mods) {
  if (!mods.poison) return 0;
  let fin = 1 + (s.pctFinaux || 0) / 100;
  for (const f of mods.finaux) fin *= 1 + f / 100;
  return mods.poison * ((100 + (s[ELEMENT_STAT[el]] || 0) + (s.puissance || 0)) / 100) * fin * (1 + mods.cible / 100);
}

// Objectif du moteur : pour chaque élément joué, moyenne des dégâts attendus de ses sorts ;
// on maximise l'élément le plus faible (équilibre en multi-élément).
export function elementScores(stats, ctx) {
  const { stats: s, mods } = applyPassives({ ...stats, elements: ctx.elements }, ctx.passives || [], ctx.scenario);
  if (ctx.ignoreCrit) s.crit = 0; // mode « sans critique » : seul le critique de base des sorts compte
  const mult = multipliers(s, mods, ctx.attack);
  const out = {};
  for (const el of ctx.elements) {
    const list = ctx.refSpells[el];
    const w = list.reduce((t, sp) => t + (sp.w ?? 1), 0);
    out[el] = w ? list.reduce((t, sp) => t + (sp.w ?? 1) * expected(sp, el, s, mult), 0) / w : 0;
    // un poison par tour, réparti sur les sorts lancés dans le tour (PA / coût moyen des sorts)
    if (mods.poison && w) {
      const cost = list.reduce((t, sp) => t + (sp.w ?? 1) * (sp.pa || 4), 0) / w;
      out[el] += poisonDamage(el, s, mods) / Math.max(1, (s.pa || 12) / cost);
    }
  }
  return out;
}

// Dégâts de poison des passifs sur un tour, dans le meilleur élément joué (onglet Simulation)
export function passivePoison(stats, ctx) {
  const { stats: s, mods } = applyPassives({ ...stats, elements: ctx.elements }, ctx.passives || [], ctx.scenario);
  return Math.max(0, ...ctx.elements.map(el => poisonDamage(el, s, mods)));
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
    const el = l.el === 'best' ? best : l.el === 'worst' ? worstOf(s) : l.el;
    const row = { kind: l.k, el };
    if (l.k === 'soin') {
      row.min = healValue(l.min, el, s);
      row.max = healValue(l.max, el, s);
    } else {
      row.min = hitValue(l.min, el, s, mult, target, l.crit);
      row.max = hitValue(l.max, el, s, mult, target, l.crit);
    }
    // ligne aléatoire : jet moyen pondéré par sa probabilité
    if (l.p) { row.min *= l.p; row.max *= l.p; }
    rows[l.crit ? 'crit' : 'normal'].push(row);
  }
  // Plusieurs éléments sur un même sort = en général un seul s'applique (meilleur élément, condition) :
  // on retient l'élément qui fait le plus de dégâts. Règle « all » : tous les éléments frappent.
  const all = SPELL_RULES[spell.id]?.all;
  const sum = (list, k) => {
    const byEl = {};
    for (const r of list) if (r.kind !== 'soin') byEl[r.el] = (byEl[r.el] || 0) + r[k];
    const v = Object.values(byEl);
    return all ? v.reduce((t, x) => t + x, 0) : Math.max(0, ...v);
  };
  const critChance = critRate(spell.cc, s);
  const avgN = (sum(rows.normal, 'min') + sum(rows.normal, 'max')) / 2;
  const avgC = rows.crit.length ? (sum(rows.crit, 'min') + sum(rows.crit, 'max')) / 2 : avgN;
  return { rows, critChance, average: (1 - critChance) * avgN + critChance * avgC, perPA: spell.pa ? ((1 - critChance) * avgN + critChance * avgC) / spell.pa : 0 };
}

export { ELEMENTS };
