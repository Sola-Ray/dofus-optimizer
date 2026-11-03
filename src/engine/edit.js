// Stuff modifié après génération : remplacer un item, retoucher ses lignes à la main.
// Tout le reste est figé (items, forgemagie, points de caractéristique) ; le nouvel item reprend
// la finition de l'ancien quand elle tient sur lui.
import { FM_SLOTS, SINGLE_EXO, STAT_LABEL, lineCap } from './rules.js';
import { parseCriteria, checkCriteria } from './criteria.js';
import { score, elementScores } from './damage.js';
import {
  problemBase, solutionStats, ctxOf, passiveMatters, violationsOf, fmComparison, exoNotes,
} from './optimize.js';

// Jets d'un item du jeu selon la qualité réglée (comme prepare)
function rolled(gi, cfg) {
  const st = { ...gi.st };
  if (cfg.rollQuality < 1) for (const [k, [lo, hi]] of Object.entries(gi.r || {})) st[k] -= Math.round((1 - cfg.rollQuality) * (hi - lo));
  return st;
}

// Stats et dégâts d'une liste d'items du résultat (forme de buildResult)
function measure(base, r, items) {
  const fm = {};
  for (const it of items) {
    for (const [k, v] of Object.entries(it.fm || {})) fm[k] = (fm[k] || 0) + v;
    if (it.trans) fm[it.trans.k] = (fm[it.trans.k] || 0) + it.trans.v;
  }
  const sol = { items, points: r.points, fm, trans: {} };
  const stats = solutionStats(base, sol);
  const passives = items.map(it => it.passive).filter(p => p && passiveMatters(p));
  const ctx = ctxOf(base, passives, true);
  return { stats, setBonuses: sol.setBonuses, passives, ctx, score: score(stats, ctx) };
}

// Problèmes du stuff : minimums, conditions de port, finitions perdues au remplacement
function issuesOf(r, items, stats, lost = []) {
  const out = violationsOf(r.config, stats).map(v => `${STAT_LABEL[v.key] || '% Rés. moyenne'} : ${Math.round(v.got)}, sous ton minimum de ${v.min}`);
  for (const it of items) if (!checkCriteria(parseCriteria(it.c), stats)) out.push(`Condition de port non remplie : ${it.n}`);
  return [...lost, ...out];
}

// Recalcule tout ce qui dépend des items d'un résultat
export function evaluateStuff(game, r, lost = []) {
  const base = problemBase(game, r.config);
  const m = measure(base, r, r.items);
  const perItem = Object.fromEntries(r.items.filter(it => Object.keys(it.fm || {}).length).map(it => [it.id, it.fm]));
  const violations = violationsOf(r.config, m.stats);
  return {
    ...r,
    stats: m.stats,
    setBonuses: m.setBonuses,
    score: m.score,
    elementScores: elementScores(m.stats, m.ctx),
    ctx: { ...r.ctx, passives: m.passives },
    fmComparison: fmComparison({ ...base, mode: r.crit.mode }, m.stats, m.passives),
    exoNotes: exoNotes(r.config, m.stats, perItem),
    violations,
    unmetConditions: r.items.filter(it => !checkCriteria(parseCriteria(it.c), m.stats)).map(it => it.n),
    issues: issuesOf(r, r.items, m.stats, lost),
  };
}

// Item du jeu mis à la place de r.items[index], avec la finition de l'ancien quand elle tient
export function placeItem(game, r, index, gi) {
  const old = r.items[index];
  const st = rolled(gi, r.config);
  const lost = [];
  const fm = {};
  if (FM_SLOTS.has(gi.s)) {
    for (const [k, v] of Object.entries(old.fm || {})) {
      const nat = st[k] || 0;
      const room = nat < 0 ? 0 : SINGLE_EXO.includes(k) ? (nat === 0 ? 1 : 0) : lineCap(game.runeWeight[k], nat) - nat;
      if (room > 0) fm[k] = Math.min(v, room);
      if (room < v) lost.push(`${gi.n} : ${room > 0 ? `+${room} ${STAT_LABEL[k]} au lieu de +${v}` : `forgemagie +${v} ${STAT_LABEL[k]} impossible`}`);
    }
  }
  let trans = null;
  if (old.trans) {
    const rune = (game.transcendance || []).find(x => x.n === old.trans.n);
    if (FM_SLOTS.has(gi.s) && rune && gi.l >= rune.l) trans = old.trans;
    else lost.push(`${gi.n} : transcendance ${old.trans.n} impossible`);
  }
  const item = { id: gi.id, n: gi.n, s: gi.s, l: gi.l, img: gi.img, set: gi.set, st, r: gi.r, c: gi.c, passive: gi.p || 0, fm, trans };
  return { item, lost };
}

// Tous les items de l'emplacement de r.items[index], essayés un par un à sa place.
// Triés par dégâts ; un item déjà porté ailleurs est marqué et rangé à la fin (on ne porte pas
// deux fois le même).
export function alternatives(game, r, index) {
  const cur = r.items[index];
  const base = problemBase(game, r.config);
  const ref = measure(base, r, r.items).score;
  const banned = new Set(r.config.banned);
  const worn = new Set(r.items.filter((_, i) => i !== index).map(it => it.id));
  return game.items.filter(gi => gi.s === cur.s && gi.l <= r.config.level && !banned.has(gi.id)).map(gi => {
    const { item, lost } = placeItem(game, r, index, gi);
    const items = r.items.map((it, i) => (i === index ? item : it));
    const m = measure(base, r, items);
    return {
      id: gi.id, n: gi.n, l: gi.l, img: gi.img, current: gi.id === cur.id, worn: worn.has(gi.id),
      score: m.score, pct: ref > 0 ? (100 * (m.score - ref)) / ref : 0, issues: issuesOf(r, items, m.stats, lost),
    };
  }).sort((a, b) => a.worn - b.worn || b.score - a.score);
}
