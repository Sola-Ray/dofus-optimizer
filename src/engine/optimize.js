// Moteur d'optimisation : choisit items, forgemagie et points de caractéristique pour maximiser
// les dégâts (élément le plus faible parmi ceux joués).
//
// Méthode : programme linéaire en nombres entiers (HiGHS) + plans coupants de Kelley sur le
// logarithme des dégâts. Le log des dégâts est (presque) concave : chaque itération ajoute une
// tangente au point trouvé, ce qui resserre la borne jusqu'à converger.
import {
  BASE, STAT_POINTS, SCROLL, CARACS, ELEMENT_STAT, ELEMENT_DO, ELEMENT_RES,
  FM_ITEM_WEIGHT, FM_SLOTS, SLOT_LIMIT, SINGLE_EXO, lineCap, pointSegments,
} from './rules.js';
import { parseCriteria, checkCriteria } from './criteria.js';
import { classSpells, elementSpells, score, elementScores } from './damage.js';
import { PASSIVES } from './passives.js';

export const DEFAULT_CONFIG = {
  breedId: 7,
  elements: ['feu'],
  attack: 'dist', // 'dist' | 'melee'
  scenario: 'moyen', // 'moyen' | 'burst'
  fullScroll: true,
  min: { pa: 12, pm: 6 }, // minimums de stats (n'importe quelle clé, + resMoy)
  // exoPct : % dommages (sorts, distance, mêlée) ajoutables par item, toutes lignes confondues
  fm: { overs: true, exos: true, exoPct: 1, exoPA: true, exoPM: true, exoPO: false },
  minLevel: 1,
  banned: [],
  forced: [],
  maxIterations: 14,
};

const RES_KEYS = Object.values(ELEMENT_RES);
const PCT_KEYS = ['pctSorts', 'pctDist', 'pctMelee'];
const EPS_RES = 1e-6; // départage : à dégâts égaux, préférer plus de résistances

// ---------- Préparation ----------

function relevantKeys(cfg) {
  const keys = new Set(['do', 'puissance', 'crit', 'doCrit', 'pctSorts', 'pctFinaux', cfg.attack === 'melee' ? 'pctMelee' : 'pctDist',
    'pa', 'pm', 'vita', ...CARACS, ...RES_KEYS]);
  for (const el of cfg.elements) { keys.add(ELEMENT_STAT[el]); keys.add(ELEMENT_DO[el]); }
  for (const k of Object.keys(cfg.min)) if (k !== 'resMoy') keys.add(k);
  return keys;
}

function passiveMatters(p) {
  const e = PASSIVES[p];
  if (!e) return false;
  const v = e.moyen;
  return typeof v === 'function' || Object.keys(v).length > 0 || Object.keys(e.burst || {}).length > 0;
}

export function prepare(game, cfg) {
  const keys = relevantKeys(cfg);
  const banned = new Set(cfg.banned);
  const forced = new Set(cfg.forced);
  const w = game.runeWeight;

  // Panoplies qui donnent au moins un bonus utile
  const usefulSet = new Set(Object.entries(game.sets)
    .filter(([, s]) => s.b.some(b => Object.keys(b).some(k => keys.has(k)))).map(([id]) => Number(id)));

  let items = game.items.filter(it => !banned.has(it.id) && (forced.has(it.id) || it.l >= cfg.minLevel || it.s === 'dofus'));
  items = items.map(it => {
    const crit = parseCriteria(it.c);
    const fmCap = {};
    if (FM_SLOTS.has(it.s)) {
      for (const k of keys) {
        if (!w[k]) continue;
        const nat = it.st[k] || 0;
        if (nat < 0) continue;
        let cap = 0;
        if (SINGLE_EXO.includes(k)) cap = nat === 0 && cfg.fm['exo' + k.toUpperCase()] ? 1 : 0;
        else if (PCT_KEYS.includes(k)) cap = Math.min(cfg.fm.exoPct, lineCap(w[k], nat) - nat);
        else if (nat > 0 ? cfg.fm.overs : cfg.fm.exos) cap = lineCap(w[k], nat) - nat;
        if (cap > 0) fmCap[k] = cap;
      }
    }
    return { ...it, crit, fmCap, passive: it.p && passiveMatters(it.p) ? it.p : 0 };
  });

  // Élagage : un item « simple » dominé par un autre du même emplacement sur toutes les stats utiles
  const simple = it => !it.crit && !it.passive && !(it.set && usefulSet.has(it.set)) && !forced.has(it.id);
  const useful = it => it.passive || forced.has(it.id) || (it.set && usefulSet.has(it.set)) ||
    Object.entries(it.st).some(([k, v]) => keys.has(k) && v > 0) || Object.keys(it.fmCap).length > 0;
  items = items.filter(useful);
  const bySlot = {};
  for (const it of items) (bySlot[it.s] ||= []).push(it);
  const kept = [];
  for (const list of Object.values(bySlot)) {
    for (const b of list) {
      if (!simple(b)) { kept.push(b); continue; }
      const dominated = list.some(a => a !== b && simple(a) && [...keys].every(k => {
        const av = a.st[k] || 0, bv = b.st[k] || 0;
        const wa = w[k] ? Math.max(av, av + (a.fmCap[k] || 0)) : av;
        const wb = w[k] ? Math.max(bv, bv + (b.fmCap[k] || 0)) : bv;
        return av >= bv && wa >= wb;
      }) && [...keys].some(k => (a.st[k] || 0) > (b.st[k] || 0)));
      if (!dominated) kept.push(b);
    }
  }
  items = kept.map((it, idx) => ({ ...it, idx }));

  const sets = [];
  const bySet = {};
  for (const it of items) if (it.set && usefulSet.has(it.set)) (bySet[it.set] ||= []).push(it.idx);
  for (const [id, idxs] of Object.entries(bySet)) {
    if (idxs.length < 2) continue;
    const s = game.sets[id];
    // au-delà du dernier palier, le bonus reste celui du dernier palier
    const bonus = idxs.map((_, n) => s.b[Math.min(n, s.b.length - 1)] || {});
    bonus.push(s.b[Math.min(idxs.length, s.b.length - 1)] || {});
    sets.push({ id: Number(id), n: s.n, items: idxs, bonus, maxK: idxs.length });
  }

  const spells = classSpells(game, cfg.breedId);
  // sans sort de l'élément dans la classe, on prend un sort générique
  const generic = [{ id: 0, n: 25, c: 30, cc: 10, nLines: 1 }];
  const refSpells = Object.fromEntries(cfg.elements.map(el => {
    const list = elementSpells(spells, el);
    return [el, list.length ? list : generic];
  }));
  const breed = game.breeds.find(b => b.id === cfg.breedId);
  return { cfg, keys: [...keys], items, sets, refSpells, breed, runeWeight: w };
}

// ---------- Stats d'une solution ----------

export function solutionStats(problem, sol) {
  const st = { ...BASE };
  const add = (k, v) => { st[k] = (st[k] || 0) + v; };
  const counts = {};
  for (const it of sol.items) {
    for (const [k, v] of Object.entries(it.st)) add(k, v);
    if (it.set) counts[it.set] = (counts[it.set] || 0) + 1;
  }
  sol.setBonuses = [];
  for (const [id, n] of Object.entries(counts)) {
    const set = problem.game?.sets?.[id] || problem.setsById?.[id];
    if (!set || n < 2) continue;
    const b = set.b[Math.min(n, set.b.length - 1)] || {};
    for (const [k, v] of Object.entries(b)) add(k, v);
    sol.setBonuses.push({ id: Number(id), n: set.n, count: n, bonus: b });
  }
  for (const [k, v] of Object.entries(sol.points || {})) add(k, v);
  if (problem.cfg.fullScroll) for (const k of [...CARACS, 'vita', 'sagesse']) add(k, SCROLL);
  for (const [k, v] of Object.entries(sol.fm || {})) add(k, v);
  st.setBonus = sol.setBonuses.length;
  return st;
}

function ctxOf(problem, passives) {
  const { cfg } = problem;
  return { elements: cfg.elements, attack: cfg.attack, scenario: cfg.scenario, refSpells: problem.refSpells, passives };
}

// ---------- Modèle LP ----------

const num = v => (Math.abs(v) < 1e-12 ? 0 : +v.toFixed(9));
function term(c, v) { const n = num(c); return n === 0 ? '' : ` ${n >= 0 ? '+' : '-'} ${Math.abs(n)} ${v}`; }

function buildLP(problem, cuts) {
  const { cfg, keys, items, sets, breed, runeWeight: w } = problem;
  const rows = [];
  const bounds = [];
  const binaries = [];
  const generals = [];
  const scroll = k => (cfg.fullScroll && (CARACS.includes(k) || k === 'vita' || k === 'sagesse') ? SCROLL : 0);

  // Objectif
  let obj = ' obj: t';
  for (const k of RES_KEYS) obj += term(EPS_RES, `T_${k}`);

  // Totaux de stats
  const segVars = {};
  for (const c of CARACS) segVars[c] = pointSegments(breed.cost[c]).map((s, j) => ({ ...s, v: `p_${c}_${j}` }));
  for (const k of keys) {
    let r = ` def_${k}: T_${k}`;
    for (const it of items) if (it.st[k]) r += term(-it.st[k], `x${it.idx}`);
    for (const s of sets) for (let n = 2; n <= s.maxK; n++) {
      const b = s.bonus[n]?.[k];
      if (b) r += term(-b, `y${s.id}_${n}`);
    }
    if (segVars[k]) for (const sv of segVars[k]) r += term(-1, sv.v);
    if (k === 'vita') r += ' - pv';
    for (const it of items) if (it.fmCap[k]) r += ` - e${it.idx}_${k}`;
    rows.push(`${r} = ${num((BASE[k] || 0) + scroll(k))}`);
    bounds.push(` T_${k} free`);
  }

  // Emplacements
  const slotItems = {};
  for (const it of items) (slotItems[it.s] ||= []).push(it.idx);
  for (const [slot, idxs] of Object.entries(slotItems)) {
    rows.push(` slot_${slot}:${idxs.map(i => ` + x${i}`).join('')} <= ${SLOT_LIMIT[slot]}`);
  }
  // une seule prysmaradite
  const prys = items.filter(it => it.t === 217).map(it => it.idx);
  if (prys.length > 1) rows.push(` prysma:${prys.map(i => ` + x${i}`).join('')} <= 1`);
  for (const it of items) binaries.push(`x${it.idx}`);
  for (const id of cfg.forced) { const it = items.find(i => i.id === id); if (it) rows.push(` force_${it.idx}: x${it.idx} = 1`); }

  // Panoplies
  for (const s of sets) {
    let one = ` set1_${s.id}:`, cnt = ` setn_${s.id}:`;
    for (let n = 0; n <= s.maxK; n++) { one += ` + y${s.id}_${n}`; if (n) cnt += term(n, `y${s.id}_${n}`); binaries.push(`y${s.id}_${n}`); }
    rows.push(`${one} = 1`);
    rows.push(`${cnt}${s.items.map(i => ` - x${i}`).join('')} = 0`);
  }

  // Points de caractéristique
  let pts = ' points:';
  for (const c of CARACS) for (const sv of segVars[c]) {
    pts += term(sv.cost, sv.v);
    bounds.push(sv.width === Infinity ? ` ${sv.v} >= 0` : ` 0 <= ${sv.v} <= ${sv.width}`);
  }
  pts += ' + pv';
  rows.push(`${pts} <= ${STAT_POINTS}`);
  for (const c of CARACS) for (const sv of segVars[c]) generals.push(sv.v);
  generals.push('pv');

  // Forgemagie item par item : 101 de poids max en over + exo, plafond par ligne en borne
  for (const it of items) {
    const ks = Object.keys(it.fmCap);
    if (!ks.length) continue;
    let wr = ` fmw${it.idx}:`;
    for (const k of ks) {
      wr += term(w[k], `e${it.idx}_${k}`);
      bounds.push(` 0 <= e${it.idx}_${k} <= ${it.fmCap[k]}`);
    }
    rows.push(`${wr} - ${FM_ITEM_WEIGHT} x${it.idx} <= 0`);
    const pct = ks.filter(k => PCT_KEYS.includes(k));
    if (pct.length > 1) rows.push(` fmpct${it.idx}:${pct.map(k => ` + e${it.idx}_${k}`).join('')} - ${cfg.fm.exoPct} x${it.idx} <= 0`);
  }
  // Un seul exo PA, PM, PO sur tout le stuff
  for (const k of SINGLE_EXO) {
    const vars = items.filter(it => it.fmCap[k]).map(it => `e${it.idx}_${k}`);
    if (!vars.length) continue;
    rows.push(` exo_${k}:${vars.map(v => ` + ${v}`).join('')} - f_${k} = 0`);
    bounds.push(` 0 <= f_${k} <= 1`);
    generals.push(`f_${k}`);
  }

  // Minimums demandés
  for (const [k, v] of Object.entries(cfg.min)) {
    if (k === 'resMoy') rows.push(` min_resMoy:${RES_KEYS.map(r => ` + 0.2 T_${r}`).join('')} >= ${v}`);
    else if (keys.includes(k)) rows.push(` min_${k}: T_${k} >= ${v}`);
  }

  // Conditions de port (big-M)
  const BIGM = { pa: 20, pm: 20, setBonus: 30 };
  for (const it of items) {
    if (!it.crit) continue;
    const groups = it.crit;
    const gv = groups.map((_, g) => `g${it.idx}_${g}`);
    if (groups.length > 1) {
      rows.push(` cor_${it.idx}:${gv.map(v => ` + ${v}`).join('')} - x${it.idx} >= 0`);
      gv.forEach(v => binaries.push(v));
    }
    groups.forEach((atoms, g) => {
      const on = groups.length > 1 ? gv[g] : `x${it.idx}`;
      atoms.forEach((a, j) => {
        const M = BIGM[a.key] || 5000;
        let lhs;
        if (a.key === 'setBonus') {
          // nombre de panoplies actives
          lhs = sets.map(s => ` - y${s.id}_0 - y${s.id}_1`).join('');
          const n = sets.length;
          if (a.max !== undefined) rows.push(` c${it.idx}_${g}_${j}:${lhs} + ${M} ${on} <= ${a.max + M - n}`);
          return;
        }
        if (!keys.includes(a.key)) return;
        if (a.min !== undefined) rows.push(` c${it.idx}_${g}_${j}: T_${a.key} - ${M} ${on} >= ${a.min - M}`);
        if (a.max !== undefined) rows.push(` c${it.idx}_${g}_${j}: T_${a.key} + ${M} ${on} <= ${a.max + M}`);
      });
    });
  }

  // Coupes de Kelley : t <= log(dégâts) linéarisé, pour chaque élément
  cuts.forEach((c, i) => {
    let r = ` cut${i}: t`;
    for (const [k, g] of Object.entries(c.g)) r += term(-g, `T_${k}`);
    for (const [idx, h] of Object.entries(c.h)) r += term(-h, `x${idx}`);
    rows.push(`${r} <= ${num(c.rhs)}`);
  });
  bounds.push(' t free', ' pv >= 0');

  return [
    'Maximize', obj, 'Subject To', ...rows, 'Bounds', ...bounds,
    generals.length ? 'General' : '', generals.length ? ' ' + generals.join(' ') : '',
    'Binary', ' ' + binaries.join(' '), 'End',
  ].filter(Boolean).join('\n');
}

// ---------- Lecture d'une solution ----------

function readSolution(problem, cols) {
  const v = name => cols[name]?.Primal ?? 0;
  const items = problem.items.filter(it => v(`x${it.idx}`) > 0.5);
  const points = {};
  for (const c of CARACS) {
    const p = problem.breed.cost[c].reduce((t, _, j) => t + v(`p_${c}_${j}`), 0);
    if (p > 1e-6) points[c] = Math.round(p);
  }
  if (v('pv') > 1e-6) points.vita = Math.round(v('pv'));
  const fm = {};
  for (const it of items) for (const k of Object.keys(it.fmCap)) {
    const e = v(`e${it.idx}_${k}`);
    if (e > 1e-6) fm[k] = (fm[k] || 0) + e;
  }
  return { items, points, fm };
}

// Coût réel en points d'une répartition (paliers)
export function pointsCost(breed, points) {
  let total = 0;
  for (const [k, v] of Object.entries(points)) {
    if (k === 'vita') { total += v; continue; }
    let left = v;
    for (const s of pointSegments(breed.cost[k])) {
      const take = Math.min(left, s.width);
      total += take * s.cost; left -= take;
      if (left <= 0) break;
    }
  }
  return total;
}

// ---------- Linéarisation ----------

const GRAD_KEYS = ['do', 'puissance', 'crit', 'doCrit', 'pctSorts', 'pctDist', 'pctMelee', 'pctFinaux', 'force', 'intel', 'chance', 'agi',
  'doFeu', 'doEau', 'doTerre', 'doAir', 'doNeutre'];

function makeCuts(problem, stats, sol) {
  const passives = sol.items.filter(it => it.passive).map(it => it.passive);
  const ctx = ctxOf(problem, passives);
  const base = elementScores(stats, ctx);
  const cuts = [];
  for (const el of problem.cfg.elements) {
    const f0 = Math.log(Math.max(base[el], 1e-9));
    const g = {};
    for (const k of GRAD_KEYS) {
      if (!problem.keys.includes(k)) continue;
      const d = k.startsWith('pct') || k === 'crit' ? 1 : 5;
      const f1 = Math.log(Math.max(elementScores({ ...stats, [k]: (stats[k] || 0) + d }, ctx)[el], 1e-9));
      const gk = (f1 - f0) / d;
      if (Math.abs(gk) > 1e-12) g[k] = gk;
    }
    // Items à passif : effet marginal en log, à stats constantes
    const h = {};
    for (const it of problem.items) {
      if (!it.passive) continue;
      const on = passives.includes(it.passive);
      const other = on ? passives.filter(p => p !== it.passive) : [...passives, it.passive];
      const fo = Math.log(Math.max(elementScores(stats, ctxOf(problem, other))[el], 1e-9));
      const delta = on ? f0 - fo : fo - f0;
      if (Math.abs(delta) > 1e-9) h[it.idx] = delta;
    }
    // t <= f0 + Σ g (T - T0) + Σ h (x - x0)
    let rhs = f0;
    for (const [k, gk] of Object.entries(g)) rhs -= gk * (stats[k] || 0);
    for (const [idx, hv] of Object.entries(h)) if (sol.items.some(it => it.idx === Number(idx))) rhs -= hv;
    cuts.push({ g, h, rhs });
  }
  return cuts;
}

// ---------- Répartition exacte de la forgemagie item par item ----------

function distributeFM(highs, problem, sol, grad) {
  const { runeWeight: w, cfg } = problem;
  const fmItems = sol.items.filter(it => FM_SLOTS.has(it.s) && Object.keys(it.fmCap).length);
  const keys = Object.keys(sol.fm);
  if (!fmItems.length || !keys.length) return { perItem: {}, fm: {} };
  const rows = [], bounds = [], gens = [];
  let obj = ' obj:';
  for (const it of fmItems) {
    let wr = ` w${it.idx}:`;
    for (const k of keys) {
      const cap = it.fmCap[k];
      if (!cap) continue;
      const v = `e${it.idx}_${k}`;
      // priorité aux stats sous contrainte, puis gradient des dégâts
      const prio = (cfg.min[k] !== undefined ? 1000 : 0) + (grad[k] || 0) * 1000 + 1e-3;
      obj += term(prio, v);
      wr += term(w[k], v);
      bounds.push(` 0 <= ${v} <= ${cap}`);
      gens.push(v);
    }
    rows.push(`${wr} <= ${FM_ITEM_WEIGHT}`);
    const pct = keys.filter(k => it.fmCap[k] && PCT_KEYS.includes(k));
    if (pct.length > 1) rows.push(` p${it.idx}:${pct.map(k => ` + e${it.idx}_${k}`).join('')} <= ${cfg.fm.exoPct}`);
  }
  for (const k of keys) {
    const vars = fmItems.filter(it => it.fmCap[k]).map(it => `e${it.idx}_${k}`);
    if (vars.length) rows.push(` tot_${k}:${vars.map(v => ` + ${v}`).join('')} <= ${Math.ceil(sol.fm[k] - 1e-6)}`);
  }
  const lp = ['Maximize', obj, 'Subject To', ...rows, 'Bounds', ...bounds, 'General', ' ' + gens.join(' '), 'End'].join('\n');
  const r = highs.solve(lp, { time_limit: 10 });
  const perItem = {}, fm = {};
  for (const it of fmItems) for (const k of keys) {
    const val = Math.round(r.Columns?.[`e${it.idx}_${k}`]?.Primal ?? 0);
    if (val > 0) { (perItem[it.id] ||= {})[k] = val; fm[k] = (fm[k] || 0) + val; }
  }
  return { perItem, fm };
}

// ---------- Boucle principale ----------

export function optimize(highs, game, config, onProgress = () => {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, fm: { ...DEFAULT_CONFIG.fm, ...config.fm }, min: { ...(config.min ?? DEFAULT_CONFIG.min) } };
  const problem = prepare(game, cfg);
  problem.setsById = game.sets;
  if (!cfg.elements.length) throw new Error('Choisis au moins un élément.');

  // Point de départ : tous les points dans les caracs des éléments joués
  const startPoints = {};
  for (const el of cfg.elements) startPoints[ELEMENT_STAT[el]] = Math.floor(400 / cfg.elements.length);
  let cur = { items: [], points: startPoints, fm: {} };
  let curStats = solutionStats(problem, cur);
  const cuts = [...makeCuts(problem, curStats, cur)];

  let best = null, upper = Infinity;
  for (let iter = 0; iter < cfg.maxIterations; iter++) {
    const lp = buildLP(problem, cuts);
    const r = highs.solve(lp, { time_limit: 30, mip_rel_gap: 1e-4 });
    if (r.Status !== 'Optimal' && r.Status !== 'Time limit reached') {
      throw new Error(r.Status === 'Infeasible' ? 'Aucun stuff ne respecte ces minimums.' : `Solveur : ${r.Status}`);
    }
    upper = Math.min(upper, r.ObjectiveValue);
    cur = readSolution(problem, r.Columns);
    curStats = solutionStats(problem, cur);
    const passives = cur.items.filter(it => it.passive).map(it => it.passive);
    const val = score(curStats, ctxOf(problem, passives));
    if (!best || val > best.value) best = { ...cur, value: val };
    onProgress({ iter: iter + 1, value: best.value, bound: Math.exp(upper), items: problem.items.length });
    if (Math.log(best.value) >= upper - 1e-3) break;
    cuts.push(...makeCuts(problem, curStats, cur));
  }

  // Forgemagie exacte item par item, puis stats finales
  const bestStats = solutionStats(problem, best);
  const passives = best.items.filter(it => it.passive).map(it => it.passive);
  const grad = makeCuts(problem, bestStats, best)[0]?.g || {};
  const { perItem, fm } = distributeFM(highs, problem, best, grad);
  const final = { ...best, fm };
  const stats = solutionStats(problem, final);
  const ctx = ctxOf(problem, passives);
  const violations = Object.entries(cfg.min)
    .filter(([k, v]) => (k === 'resMoy' ? RES_KEYS.reduce((t, r) => t + (stats[r] || 0), 0) / 5 : stats[k] || 0) < v - 1e-6)
    .map(([k, v]) => ({ key: k, min: v, got: stats[k] }));
  const unmet = final.items.filter(it => !checkCriteria(it.crit, stats)).map(it => it.n);

  return {
    config: cfg,
    items: final.items.map(it => ({ id: it.id, n: it.n, s: it.s, l: it.l, img: it.img, set: it.set, st: it.st, c: it.c, passive: it.p || 0, fm: perItem[it.id] || {} })),
    points: final.points,
    pointsCost: pointsCost(problem.breed, final.points),
    setBonuses: final.setBonuses,
    stats,
    score: score(stats, ctx),
    elementScores: elementScores(stats, ctx),
    ctx: { elements: ctx.elements, attack: ctx.attack, scenario: ctx.scenario, passives },
    violations,
    unmetConditions: unmet,
    candidates: problem.items.length,
  };
}
