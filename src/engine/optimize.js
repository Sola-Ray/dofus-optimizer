// Moteur d'optimisation : choisit items, forgemagie et points de caractéristique pour maximiser
// les dégâts (élément le plus faible parmi ceux joués).
//
// Méthode : programme linéaire en nombres entiers (HiGHS) + plans coupants de Kelley sur le
// logarithme des dégâts. Le log des dégâts est (presque) concave : chaque itération ajoute une
// tangente au point trouvé, ce qui resserre la borne jusqu'à converger.
import {
  BASE, STAT_POINTS, SCROLL, CARACS, ELEMENT_STAT, ELEMENT_DO, ELEMENT_RES,
  FM_ITEM_WEIGHT, FM_SLOTS, SLOT_LIMIT, SINGLE_EXO, STAT_LABEL, lineCap, pointSegments,
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
  // transcendance : un item reçoit soit over/exo, soit une rune de transcendance (puis plus de FM)
  fm: { overs: true, exos: true, exoPct: 1, exoPA: true, exoPM: true, exoPO: false, transcendance: true },
  // 'auto' : compare 100 % critique et sans critique ; 'crit' ; 'noncrit'
  critMode: 'auto',
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

  // Meilleure rune de transcendance par stat utile
  const trans = {};
  if (cfg.fm.transcendance) for (const r of game.transcendance || []) {
    if (!keys.has(r.k) || r.v <= 0) continue;
    if (!trans[r.k] || r.v > trans[r.k].v) trans[r.k] = r;
  }
  // Critique visé pour que tous les sorts de l'élément qui peuvent critiquer soient à 100 %
  const critTarget = Math.max(0, ...cfg.elements.map(el => {
    const cc = refSpells[el].filter(sp => sp.cc > 0).map(sp => sp.cc);
    return cc.length ? 100 - Math.min(...cc) : 0;
  }));
  return { cfg, keys: [...keys], items, sets, refSpells, breed, runeWeight: w, trans, critTarget };
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
  for (const [k, n] of Object.entries(sol.trans || {})) add(k, n * problem.trans[k].v);
  st.setBonus = sol.setBonuses.length;
  return st;
}

function ctxOf(problem, passives, real = false) {
  const { cfg } = problem;
  return {
    elements: cfg.elements, attack: cfg.attack, scenario: cfg.scenario, refSpells: problem.refSpells, passives,
    ignoreCrit: !real && problem.mode === 'noncrit',
  };
}

// ---------- Modèle LP ----------

const num = v => (Math.abs(v) < 1e-12 ? 0 : +v.toFixed(9));
function term(c, v) { const n = num(c); return n === 0 ? '' : ` ${n >= 0 ? '+' : '-'} ${Math.abs(n)} ${v}`; }

function buildLP(problem, cuts) {
  const { cfg, keys, items, sets, breed, runeWeight: w } = problem;
  const transOk = it => FM_SLOTS.has(it.s) && Object.keys(problem.trans).length > 0;
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
    if (problem.trans[k]) r += term(-problem.trans[k].v, `n_${k}`);
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
    rows.push(`${wr} - ${FM_ITEM_WEIGHT} x${it.idx}${transOk(it) ? ` + ${FM_ITEM_WEIGHT} tr${it.idx}` : ''} <= 0`);
    const pct = ks.filter(k => PCT_KEYS.includes(k));
    if (pct.length > 1) rows.push(` fmpct${it.idx}:${pct.map(k => ` + e${it.idx}_${k}`).join('')} - ${cfg.fm.exoPct} x${it.idx} <= 0`);
  }
  // Transcendance : tr = item transcendé (exclut over/exo), n_k = nombre de runes de la stat k
  const transKeys = Object.keys(problem.trans);
  const trItems = items.filter(transOk);
  if (transKeys.length && trItems.length) {
    for (const it of trItems) { rows.push(` trx${it.idx}: tr${it.idx} - x${it.idx} <= 0`); binaries.push(`tr${it.idx}`); }
    rows.push(` trsum:${transKeys.map(k => ` + n_${k}`).join('')}${trItems.map(it => ` - tr${it.idx}`).join('')} <= 0`);
    for (const k of transKeys) {
      // la rune demande un item de niveau suffisant
      const ok = trItems.filter(it => it.l >= problem.trans[k].l);
      rows.push(` trlvl_${k}: n_${k}${ok.map(it => ` - tr${it.idx}`).join('')} <= 0`);
      generals.push(`n_${k}`);
    }
  }

  // Un seul exo PA, PM, PO sur tout le stuff
  for (const k of SINGLE_EXO) {
    const vars = items.filter(it => it.fmCap[k]).map(it => `e${it.idx}_${k}`);
    if (!vars.length) continue;
    rows.push(` exo_${k}:${vars.map(v => ` + ${v}`).join('')} - f_${k} = 0`);
    bounds.push(` 0 <= f_${k} <= 1`);
    generals.push(`f_${k}`);
  }

  // Mode critique : tous les sorts de l'élément à 100 % (critique du stuff, hors passifs)
  if (problem.mode === 'crit' && problem.critTarget > 0) rows.push(` crit100: T_crit >= ${problem.critTarget}`);

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
  const trans = {};
  for (const k of Object.keys(problem.trans)) { const n = Math.round(v(`n_${k}`)); if (n > 0) trans[k] = n; }
  const transItems = new Set(items.filter(it => v(`tr${it.idx}`) > 0.5).map(it => it.id));
  return { items, points, fm, trans, transItems };
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
  const fmItems = sol.items.filter(it => FM_SLOTS.has(it.s) && Object.keys(it.fmCap).length && !sol.transItems?.has(it.id));
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
      const constrained = cfg.min[k] !== undefined || (k === 'crit' && problem.mode === 'crit');
      const prio = (constrained ? 1000 : 0) + (grad[k] || 0) * 1000 + 1e-3;
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

// ---------- Attribution des runes de transcendance ----------

// n_k runes par stat sur les items transcendés : les runes de plus haut niveau vont aux items de plus haut niveau
function assignTranscendance(problem, sol) {
  const items = sol.items.filter(it => sol.transItems?.has(it.id)).sort((a, b) => b.l - a.l);
  const runes = Object.entries(sol.trans || {}).flatMap(([k, n]) => Array(n).fill(problem.trans[k]))
    .sort((a, b) => b.l - a.l);
  const out = {};
  runes.forEach((r, i) => { if (items[i] && items[i].l >= r.l) out[items[i].id] = { n: r.n, k: r.k, v: r.v }; });
  return out;
}

// ---------- Comparatif des options de forgemagie ----------

// Gain de dégâts de chaque option ajoutée seule au stuff final : % dommages, overs, transcendances.
// Les overs sont comparés à poids égal (15, le poids d'1 % de dommages).
function fmComparison(problem, stats, passives) {
  const ctx = ctxOf(problem, passives, true);
  const base = score(stats, ctx);
  const w = problem.runeWeight;
  const el = problem.cfg.elements[0];
  const pctKey = problem.cfg.attack === 'melee' ? 'pctMelee' : 'pctDist';
  const over = k => ({ label: `Over +${Math.floor(15 / w[k])} ${STAT_LABEL[k]} (poids 15)`, add: { [k]: Math.floor(15 / w[k]) } });
  const opts = [
    { label: 'Exo +1 % Dommages sorts (poids 15)', add: { pctSorts: 1 } },
    { label: `Exo +1 ${STAT_LABEL[pctKey]} (poids 15)`, add: { [pctKey]: 1 } },
    over(ELEMENT_STAT[el]), over('puissance'), over(ELEMENT_DO[el]), over('doCrit'), over('crit'),
    ...Object.values(problem.trans).map(r => ({ label: `${r.n} : +${r.v} ${STAT_LABEL[r.k]} (transcendance)`, add: { [r.k]: r.v }, trans: true })),
  ];
  return opts.map(o => {
    const st = { ...stats };
    for (const [k, v] of Object.entries(o.add)) st[k] = (st[k] || 0) + v;
    const gain = score(st, ctx) - base;
    return { label: o.label, trans: !!o.trans, gain, pct: base > 0 ? (100 * gain) / base : 0 };
  }).sort((a, b) => b.gain - a.gain);
}

// ---------- Boucle principale ----------

function solveMode(highs, game, cfg, mode, onProgress) {
  const problem = prepare(game, cfg);
  problem.setsById = game.sets;
  problem.mode = mode;

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
      const why = mode === 'crit' ? `Impossible d'atteindre ${problem.critTarget} % critique avec ces minimums.` : 'Aucun stuff ne respecte ces minimums.';
      throw new Error(r.Status === 'Infeasible' ? why : `Solveur : ${r.Status}`);
    }
    upper = Math.min(upper, r.ObjectiveValue);
    cur = readSolution(problem, r.Columns);
    curStats = solutionStats(problem, cur);
    const passives = cur.items.filter(it => it.passive).map(it => it.passive);
    const val = score(curStats, ctxOf(problem, passives));
    if (!best || val > best.value) best = { ...cur, value: val };
    onProgress({ mode, iter: iter + 1, value: best.value, items: problem.items.length });
    if (Math.log(best.value) >= upper - 1e-3) break;
    cuts.push(...makeCuts(problem, curStats, cur));
  }

  // Forgemagie exacte item par item, runes de transcendance, puis stats finales
  const bestStats = solutionStats(problem, best);
  const passives = best.items.filter(it => it.passive).map(it => it.passive);
  const grad = makeCuts(problem, bestStats, best)[0]?.g || {};
  const { perItem, fm } = distributeFM(highs, problem, best, grad);
  const transPerItem = assignTranscendance(problem, best);
  const final = { ...best, fm };
  const stats = solutionStats(problem, final);
  const ctx = ctxOf(problem, passives, true);
  return { problem, final, stats, perItem, transPerItem, passives, realScore: score(stats, ctx), ctx };
}

export function optimize(highs, game, config, onProgress = () => {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, fm: { ...DEFAULT_CONFIG.fm, ...config.fm }, min: { ...(config.min ?? DEFAULT_CONFIG.min) } };
  if (!cfg.elements.length) throw new Error('Choisis au moins un élément.');

  const modes = cfg.critMode === 'auto' ? ['crit', 'noncrit'] : [cfg.critMode];
  const runs = [];
  let lastError;
  for (const mode of modes) {
    try { runs.push({ mode, ...solveMode(highs, game, cfg, mode, onProgress) }); }
    catch (e) { lastError = e; }
  }
  if (!runs.length) throw lastError;
  const chosen = runs.reduce((a, b) => (b.realScore > a.realScore ? b : a));
  const { problem, final, stats, perItem, transPerItem, passives, ctx } = chosen;

  const violations = Object.entries(cfg.min)
    .filter(([k, v]) => (k === 'resMoy' ? RES_KEYS.reduce((t, r) => t + (stats[r] || 0), 0) / 5 : stats[k] || 0) < v - 1e-6)
    .map(([k, v]) => ({ key: k, min: v, got: stats[k] }));
  const unmet = final.items.filter(it => !checkCriteria(it.crit, stats)).map(it => it.n);

  return {
    config: cfg,
    items: final.items.map(it => ({
      id: it.id, n: it.n, s: it.s, l: it.l, img: it.img, set: it.set, st: it.st, c: it.c, passive: it.p || 0,
      fm: perItem[it.id] || {}, trans: transPerItem[it.id] || null,
    })),
    points: final.points,
    pointsCost: pointsCost(problem.breed, final.points),
    setBonuses: final.setBonuses,
    stats,
    score: chosen.realScore,
    elementScores: elementScores(stats, ctx),
    ctx: { elements: ctx.elements, attack: ctx.attack, scenario: ctx.scenario, passives },
    crit: {
      mode: chosen.mode, target: problem.critTarget,
      runs: runs.map(r => ({ mode: r.mode, score: r.realScore })),
      failed: modes.length > runs.length ? lastError?.message : null,
    },
    fmComparison: fmComparison(problem, stats, passives),
    violations,
    unmetConditions: unmet,
    candidates: problem.items.length,
  };
}
