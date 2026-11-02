// Mode leveling : un stuff par palier de niveau, optimisés ensemble pour garder des items d'un
// palier à l'autre au lieu de tout racheter.
//
// Un seul modèle contient une copie du modèle de chaque palier (variables suffixées __k). Une
// variable c_id__k vaut 1 quand l'item id est porté au palier k mais pas au palier k − 1. L'objectif
// est la somme des log(dégâts) des paliers moins λ par item nouveau : avec λ = log(1 + X %), un item
// n'est changé que s'il rapporte au moins X % de dégâts (cumulés sur les paliers où il reste porté).
import {
  prepare, normalizeConfig, gelanoLevel, buildSections, lpText, readSolution, solutionStats, makeCuts,
  pruneTopK, rebuildProblem, startStatsOf, startCuts, kelley, finalize, buildResult, cutRow, ctxOf,
} from './optimize.js';
import { classSpells, elementSpells, score } from './damage.js';

export const DEFAULT_LEVELING = {
  tiers: [
    { level: 50, pa: 8, pm: 4 }, { level: 80, pa: 9, pm: 4 }, { level: 110, pa: 10, pm: 5 },
    { level: 150, pa: 11, pm: 5 }, { level: 200, pa: 12, pm: 6 },
  ],
  keepGain: 3, // % de dégâts minimum pour changer un item
  fm: false, // forgemagie sur les stuffs de leveling
  scroll: 0, // parchemins par caractéristique
};

// Items gardés par emplacement et par direction pour chaque palier (union sur tous les paliers)
const TIER_K = 20;

// Niveaux d'obtention des sorts de dégâts des éléments joués
export function suggestTiers(game, breedId, elements) {
  const levels = new Set();
  for (const sp of classSpells(game, breedId, 200)) {
    const first = game.spells[sp.id].grades?.[0]?.lvl ?? sp.lvl;
    if (elements.some(el => elementSpells([sp], el).length) && first > 1) levels.add(first);
  }
  return [...levels].sort((a, b) => a - b);
}

const RESERVED = new Set(['free']);
const suffix = (text, k) => text.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, id => (RESERVED.has(id) ? id : `${id}__${k}`));

function tierConfig(game, config, lv, tier) {
  const off = { pctExoOn: false, overOn: false, exoPA: false, exoPM: false, exoPO: false, transcendance: false };
  return normalizeConfig(game, {
    ...config,
    level: tier.level,
    min: Object.fromEntries(['pa', 'pm'].filter(k => tier[k] > 0).map(k => [k, tier[k]])),
    minLevel: 1,
    scroll: lv.scroll,
    fm: lv.fm ? config.fm : { ...config.fm, ...off },
    gelanoPaPm: config.gelanoPaPm && tier.level >= gelanoLevel(game),
    critMode: config.critMode === 'crit' ? 'crit' : 'noncrit',
  });
}

export async function optimizeLeveling(solver, game, config, onProgress = () => {}) {
  const lv = { ...DEFAULT_LEVELING, ...config.leveling };
  const tiers = [...lv.tiers].filter(t => t.level >= 1 && t.level <= 200).sort((a, b) => a.level - b.level);
  if (!tiers.length) throw new Error('Ajoute au moins un palier.');
  if (!config.elements?.length) throw new Error('Choisis au moins un élément.');
  const mode = config.critMode === 'crit' ? 'crit' : 'noncrit';
  const cfgs = tiers.map(t => tierConfig(game, config, lv, t));
  const lambda = Math.log(1 + lv.keepGain / 100);

  // Candidats : union des meilleurs items de chaque palier, pour qu'un item gardé d'un palier à
  // l'autre soit candidat partout où son niveau le permet.
  const ids = new Set();
  for (const cfg of cfgs) {
    const p = prepare(game, cfg);
    p.setsById = game.sets; p.mode = mode;
    const pruned = p.items.length > 300 ? pruneTopK(p, startStatsOf(p), TIER_K) : p;
    pruned.items.forEach(it => ids.add(it.id));
  }
  const problems = cfgs.map(cfg => {
    const p = prepare(game, { ...cfg, keepIds: [...ids] });
    p.setsById = game.sets; p.mode = mode;
    return rebuildProblem(p, p.items.filter(it => ids.has(it.id)));
  });

  // 1. Chaque palier seul : meilleur stuff possible, et point de départ du modèle commun
  const label = k => `Palier ${tiers[k].level}`;
  const alone = await Promise.all(problems.map((p, k) => {
    const cuts = startCuts(p, startStatsOf(p));
    return kelley(solver, p, cuts, null, e => onProgress({ ...e, mode: `t${k}`, label: label(k) }), 1).then(best => ({ best, cuts }));
  }));

  // 2. Modèle commun
  const parts = problems.map((p, k) => {
    const s = buildSections(p, alone[k].cuts);
    return {
      obj: suffix(s.obj, k), rows: s.rows.map(r => suffix(r, k)), bounds: s.bounds.map(b => suffix(b, k)),
      generals: s.generals.map(g => `${g}__${k}`), binaries: s.binaries.map(b => `${b}__${k}`),
    };
  });
  const idxOf = problems.map(p => new Map(p.items.map(it => [it.id, it.idx])));
  const chg = [];
  for (let k = 1; k < problems.length; k++) {
    for (const it of problems[k].items) {
      const prev = idxOf[k - 1].get(it.id);
      const c = `c${it.id}__${k}`;
      chg.push({ c, k, id: it.id, row: ` chg${it.id}__${k}: ${c} - x${it.idx}__${k}${prev === undefined ? '' : ` + x${prev}__${k - 1}`} >= 0` });
    }
  }
  const joint = {
    obj: parts.map(p => p.obj).join('') + chg.map(x => ` - ${lambda.toFixed(9)} ${x.c}`).join(''),
    rows: [...parts.flatMap(p => p.rows), ...chg.map(x => x.row)],
    bounds: [...parts.flatMap(p => p.bounds), ...chg.map(x => ` 0 <= ${x.c} <= 1`)],
    generals: parts.flatMap(p => p.generals),
    binaries: parts.flatMap(p => p.binaries),
  };

  const split = cols => problems.map((_, k) => {
    const out = {};
    const end = `__${k}`;
    for (const [n, v] of Object.entries(cols)) if (n.endsWith(end)) out[n.slice(0, -end.length)] = v;
    return out;
  });
  const changesOf = sols => sols.map((s, k) => (k === 0 ? [] : s.items.filter(it => !sols[k - 1].items.some(p => p.id === it.id))));
  const evaluate = sols => {
    const scores = sols.map((s, k) => score(solutionStats(problems[k], s), ctxOf(problems[k], s.items.filter(it => it.passive).map(it => it.passive))));
    const nChg = changesOf(sols).reduce((t, c) => t + c.length, 0);
    return { scores, value: scores.reduce((t, v) => t + Math.log(Math.max(v, 1e-9)), 0) - lambda * nChg };
  };
  const startCols = sols => {
    const start = {};
    sols.forEach((s, k) => { for (const [n, v] of Object.entries(s.cols)) start[`${n}__${k}`] = v; });
    changesOf(sols).forEach((list, k) => list.forEach(it => { start[`c${it.id}__${k}`] = 1; }));
    return start;
  };

  const session = await solver.open(lpText(joint));
  let best;
  try {
    const sols0 = alone.map(a => a.best);
    best = { sols: sols0, ...evaluate(sols0) };
    await session.warmStart(startCols(sols0));
    let upper = Infinity;
    onProgress({ mode: 'joint', label: 'Paliers ensemble', phase: 2, iter: 0 });
    for (let iter = 0; iter < (config.maxIterations ?? 14); iter++) {
      const r = await session.run({ time_limit: 120, mip_rel_gap: 1e-4 });
      if (!r.feasible) break; // on garde les paliers seuls
      if (r.optimal) upper = Math.min(upper, r.objective);
      const sols = split(r.cols).map((cols, k) => ({ ...readSolution(problems[k], cols), cols }));
      const ev = evaluate(sols);
      if (ev.value > best.value) best = { sols, ...ev };
      onProgress({ mode: 'joint', label: 'Paliers ensemble', phase: 2, iter: iter + 1, value: best.scores.at(-1) });
      if (best.value >= upper - 1e-3) break;
      const rows = [];
      sols.forEach((s, k) => {
        for (const c of makeCuts(problems[k], solutionStats(problems[k], s), s)) {
          const row = cutRow(c);
          rows.push({ rhs: row.rhs, terms: Object.fromEntries(Object.entries(row.terms).map(([n, v]) => [`${n}__${k}`, v])) });
          alone[k].cuts.push(c);
        }
      });
      await session.addCuts(rows);
      await session.warmStart(startCols(sols));
    }
  } finally {
    session.close();
  }

  // 3. Finitions et résultat de chaque palier
  onProgress({ mode: 'joint', label: 'Paliers ensemble', phase: 3, iter: 0, value: best.scores.at(-1) });
  const results = await Promise.all(problems.map(async (p, k) => {
    const sol = best.sols[k];
    const [fin, finAlone] = await Promise.all([finalize(solver, p, { ...sol, value: best.scores[k] }), finalize(solver, p, alone[k].best)]);
    const result = buildResult(cfgs[k], { mode, ...fin }, [{ mode, realScore: fin.realScore }]);
    const prev = k ? new Set(best.sols[k - 1].items.map(it => it.id)) : null;
    return {
      level: tiers[k].level,
      result,
      alone: finAlone.realScore,
      added: prev ? sol.items.filter(it => !prev.has(it.id)).map(it => it.id) : sol.items.map(it => it.id),
      kept: prev ? sol.items.filter(it => prev.has(it.id)).map(it => it.id) : [],
    };
  }));
  return { leveling: { ...lv, tiers }, tiers: results, candidates: ids.size };
}
