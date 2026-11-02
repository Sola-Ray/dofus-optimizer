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
  // Forgemagie réaliste : une seule finition par item, choisie par le moteur parmi celles autorisées.
  //   pctExo : exo % dommages (sorts, distance, mêlée), 0 = interdit
  //   overBudget : poids max d'un over (ou exo léger de stat) sur une ligne, 0 = interdit
  //   transcendance : runes de transcendance (verrouillent l'item)
  //   pctExoOn / overOn : finition autorisée ou non (pctExo / overBudget = valeur max)
  fm: { pctExoOn: true, pctExo: 1, overOn: true, overBudget: 20, exoPA: true, exoPM: true, exoPO: false, transcendance: true },
  rollQuality: 1, // 1 = jets parfaits, 0.95, 0.85…
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

// Stats forgemageables utiles : celles des dégâts et celles sous contrainte
function fmKeys(cfg) {
  const k = new Set(['do', 'puissance', 'crit', 'doCrit', 'pctSorts', cfg.attack === 'melee' ? 'pctMelee' : 'pctDist', ...SINGLE_EXO]);
  for (const el of cfg.elements) { k.add(ELEMENT_STAT[el]); k.add(ELEMENT_DO[el]); }
  for (const m of Object.keys(cfg.min)) if (m === 'resMoy') RES_KEYS.forEach(r => k.add(r)); else k.add(m);
  return k;
}

export function prepare(game, cfg) {
  const keys = relevantKeys(cfg);
  const fmable = fmKeys(cfg);
  const banned = new Set(cfg.banned);
  const forced = new Set(cfg.forced);
  const w = game.runeWeight;

  // Panoplies qui donnent au moins un bonus utile
  const usefulSet = new Set(Object.entries(game.sets)
    .filter(([, s]) => s.b.some(b => Object.keys(b).some(k => keys.has(k)))).map(([id]) => Number(id)));

  let items = game.items.filter(it => !banned.has(it.id) && (forced.has(it.id) || it.l >= cfg.minLevel || it.s === 'dofus'));
  items = items.map(it => {
    const crit = parseCriteria(it.c);
    // Qualité des jets : 1 = jets parfaits, sinon min + q × (max − min)
    const st = { ...it.st };
    if (cfg.rollQuality < 1) for (const [k, [lo, hi]] of Object.entries(it.r || {})) st[k] -= Math.round((1 - cfg.rollQuality) * (hi - lo));
    const fmCap = {}, fmKind = {};
    if (FM_SLOTS.has(it.s)) {
      for (const k of keys) {
        if (!w[k] || !fmable.has(k)) continue;
        const nat = st[k] || 0;
        if (nat < 0) continue;
        let cap = 0, kind;
        if (SINGLE_EXO.includes(k)) { cap = nat === 0 && cfg.fm['exo' + k.toUpperCase()] ? 1 : 0; kind = 'heavy'; }
        else if (PCT_KEYS.includes(k)) { cap = Math.min(cfg.fm.pctExo, lineCap(w[k], nat) - nat); kind = 'pct'; }
        else { cap = Math.min(lineCap(w[k], nat) - nat, Math.floor(cfg.fm.overBudget / w[k])); kind = 'over'; }
        if (cap > 0) { fmCap[k] = cap; fmKind[k] = kind; }
      }
    }
    return { ...it, st, crit, fmCap, fmKind, passive: it.p && passiveMatters(it.p) ? it.p : 0 };
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

  // Forgemagie réaliste : une seule finition par item, au choix du moteur
  //   heavy : exo PA / PM / PO     pct : exo % dommages     ov : over (budget de poids)     tr : transcendance
  for (const it of items) {
    const ks = Object.keys(it.fmCap);
    const touches = [];
    for (const k of ks) bounds.push(` 0 <= e${it.idx}_${k} <= ${it.fmCap[k]}`);
    const ov = ks.filter(k => it.fmKind[k] === 'over');
    if (ov.length) {
      rows.push(` fmov${it.idx}:${ov.map(k => term(w[k], `e${it.idx}_${k}`)).join('')} - ${cfg.fm.overBudget} ov${it.idx} <= 0`);
      binaries.push(`ov${it.idx}`); touches.push(`ov${it.idx}`);
    }
    const pct = ks.filter(k => it.fmKind[k] === 'pct');
    if (pct.length) {
      rows.push(` fmpe${it.idx}:${pct.map(k => ` + e${it.idx}_${k}`).join('')} - ${cfg.fm.pctExo} pe${it.idx} <= 0`);
      binaries.push(`pe${it.idx}`); touches.push(`pe${it.idx}`);
    }
    // L'exo lourd exclut l'exo % et la transcendance, mais peut recevoir un over dans le poids restant
    // (101 au total : exo PM 90 + 1 % critique 10, exo PO 51 + 50…). Over, exo % et transcendance s'excluent.
    const heavy = ks.filter(k => it.fmKind[k] === 'heavy');
    const exclusive = touches.filter(v => !v.startsWith('ov'));
    if (transOk(it)) { touches.push(`tr${it.idx}`); exclusive.push(`tr${it.idx}`); }
    const heavyRow = [...exclusive, ...heavy.map(k => `e${it.idx}_${k}`)];
    if (heavyRow.length) rows.push(` touch${it.idx}:${heavyRow.map(v => ` + ${v}`).join('')} - x${it.idx} <= 0`);
    if (touches.length > 1) rows.push(` touchb${it.idx}:${touches.map(v => ` + ${v}`).join('')} - x${it.idx} <= 0`);
    for (const k of heavy) {
      const cut = cfg.fm.overBudget - Math.max(0, FM_ITEM_WEIGHT - w[k]);
      if (ov.length && cut > 0) rows.push(` fmhv${it.idx}_${k}:${ov.map(o => term(w[o], `e${it.idx}_${o}`)).join('')} + ${cut} e${it.idx}_${k} <= ${cfg.fm.overBudget}`);
    }
  }
  // Transcendance : tr = item transcendé, n_k = nombre de runes de la stat k
  const transKeys = Object.keys(problem.trans);
  const trItems = items.filter(transOk);
  if (transKeys.length && trItems.length) {
    for (const it of trItems) binaries.push(`tr${it.idx}`);
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

// ---------- Finitions exactes item par item ----------

// Une fois les items choisis, on décide exactement la finition de chacun (une seule par item) :
// over sur une ligne, exo % dommages, exo PA/PM/PO ou rune de transcendance. Les minimums
// (PA, PM, critique visé…) doivent rester tenus ; le reste maximise le gain de dégâts linéarisé.
async function finishItems(solver, problem, sol, grad) {
  const { cfg } = problem;
  const items = sol.items.filter(it => FM_SLOTS.has(it.s));
  const base = solutionStats(problem, { ...sol, fm: {}, trans: {} });
  const rows = [], bounds = [], bins = [], gens = [];
  const contrib = {}; // clé -> liste de [coef, variable]
  const addC = (k, c, v) => (contrib[k] ||= []).push([c, v]);
  let obj = ' obj:';
  const value = k => (grad[k] || 0) * 1000 + 1e-4;
  const heavy = {};
  for (const it of items) {
    const opts = [];
    for (const [k, cap] of Object.entries(it.fmCap)) {
      const kind = it.fmKind[k];
      if (kind === 'over') {
        const o = `o${it.idx}_${k}`, e = `e${it.idx}_${k}`;
        rows.push(` oc${it.idx}_${k}: ${e} - ${cap} ${o} <= 0`);
        bounds.push(` 0 <= ${e} <= ${cap}`);
        gens.push(e); bins.push(o); opts.push(o);
        addC(k, 1, e); obj += term(value(k), e);
      } else {
        const b = `${kind === 'pct' ? 'p' : 'h'}${it.idx}_${k}`;
        bins.push(b); opts.push(b);
        addC(k, cap, b); obj += term(value(k) * cap, b);
        if (kind === 'heavy') (heavy[k] ||= []).push(b);
      }
    }
    for (const r of Object.values(problem.trans)) {
      if (it.l < r.l) continue;
      const t = `t${it.idx}_${r.k}`;
      bins.push(t); opts.push(t);
      addC(r.k, r.v, t); obj += term(value(r.k) * r.v, t);
    }
    // Une finition par item, sauf exo lourd + over si le poids total tient dans 101
    const overs = opts.filter(v => v.startsWith('o'));
    const heavies = opts.filter(v => v.startsWith('h'));
    const others = opts.filter(v => !v.startsWith('o') && !v.startsWith('h'));
    if (heavies.length + others.length) rows.push(` one${it.idx}:${[...heavies, ...others].map(v => ` + ${v}`).join('')} <= 1`);
    if (overs.length + others.length) rows.push(` oneb${it.idx}:${[...overs, ...others].map(v => ` + ${v}`).join('')} <= 1`);
    const overW = Object.keys(it.fmCap).filter(k => it.fmKind[k] === 'over').map(k => term(problem.runeWeight[k], `e${it.idx}_${k}`)).join('');
    for (const h of heavies) {
      const k = h.slice(h.indexOf('_') + 1);
      const cut = cfg.fm.overBudget - Math.max(0, FM_ITEM_WEIGHT - problem.runeWeight[k]);
      if (overW && cut > 0) rows.push(` hv${it.idx}_${k}:${overW} + ${cut} ${h} <= ${cfg.fm.overBudget}`);
    }
  }
  for (const [k, vs] of Object.entries(heavy)) rows.push(` heavy_${k}:${vs.map(v => ` + ${v}`).join('')} <= 1`);

  const mins = { ...cfg.min };
  if (problem.mode === 'crit' && problem.critTarget > 0) mins.crit = Math.max(mins.crit || 0, problem.critTarget);
  const minRows = [];
  for (const [k, v] of Object.entries(mins)) {
    if (k === 'resMoy') {
      const terms = RES_KEYS.flatMap(r => contrib[r] || []).map(([c, x]) => term(c / 5, x)).join('');
      const have = RES_KEYS.reduce((t, r) => t + (base[r] || 0), 0) / 5;
      if (terms) minRows.push(` m_resMoy:${terms} >= ${num(v - have)}`);
    } else if (contrib[k]) minRows.push(` m_${k}:${contrib[k].map(([c, x]) => term(c, x)).join('')} >= ${num(v - (base[k] || 0))}`);
  }
  if (!bins.length) return { perItem: {}, transPerItem: {}, fm: {} };

  const build = withMins => ['Maximize', obj, 'Subject To', ...rows, ...(withMins ? minRows : []),
    ...(rows.length || minRows.length ? [] : [' dummy: 0 x0 >= 0']),
    'Bounds', ...bounds, ...(gens.length ? ['General', ' ' + gens.join(' ')] : []), 'Binary', ' ' + bins.join(' '), 'End'].join('\n');
  let r = await solver.solve(build(true), { time_limit: 10 });
  if (r.Status !== 'Optimal') r = await solver.solve(build(false), { time_limit: 10 });

  const v = name => r.Columns?.[name]?.Primal ?? 0;
  const perItem = {}, transPerItem = {}, fm = {};
  const add = (id, k, val) => { (perItem[id] ||= {})[k] = val; fm[k] = (fm[k] || 0) + val; };
  for (const it of items) {
    for (const [k, cap] of Object.entries(it.fmCap)) {
      const kind = it.fmKind[k];
      if (kind === 'over') { const e = Math.round(v(`e${it.idx}_${k}`)); if (e > 0) add(it.id, k, e); }
      else if (v(`${kind === 'pct' ? 'p' : 'h'}${it.idx}_${k}`) > 0.5) add(it.id, k, cap);
    }
    for (const rn of Object.values(problem.trans)) {
      if (it.l >= rn.l && v(`t${it.idx}_${rn.k}`) > 0.5) {
        transPerItem[it.id] = { n: rn.n, k: rn.k, v: rn.v };
        fm[rn.k] = (fm[rn.k] || 0) + rn.v;
      }
    }
  }
  return { perItem, transPerItem, fm };
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

// Garde par emplacement les K meilleurs items selon plusieurs directions (gradient des dégâts,
// + PA, + PM, + critique), plus les Dofus, les passifs et les items imposés.
const PRUNE_K = 40;

function rebuildProblem(problem, items) {
  items = items.map((it, idx) => ({ ...it, idx }));
  const useful = new Set(problem.sets.map(s => s.id));
  const bySet = {};
  for (const it of items) if (it.set && useful.has(it.set)) (bySet[it.set] ||= []).push(it.idx);
  const sets = [];
  for (const [id, idxs] of Object.entries(bySet)) {
    if (idxs.length < 2) continue;
    const s = problem.setsById[id];
    const bonus = idxs.map((_, n) => s.b[Math.min(n, s.b.length - 1)] || {});
    bonus.push(s.b[Math.min(idxs.length, s.b.length - 1)] || {});
    sets.push({ id: Number(id), n: s.n, items: idxs, bonus, maxK: idxs.length });
  }
  return { ...problem, items, sets };
}

function pruneTopK(problem, startStats, K) {
  const g = makeCuts(problem, startStats, { items: [] })[0].g;
  const setMax = {};
  for (const s of problem.sets) setMax[s.id] = s.bonus[s.bonus.length - 1];
  const lin = (it, w) => {
    let v = 0;
    for (const [k, c] of Object.entries(w)) {
      v += c * ((it.st[k] || 0) + (it.fmCap[k] || 0));
      if (it.set && setMax[it.set]) v += c * (setMax[it.set][k] || 0);
    }
    return v;
  };
  const dirs = [g, { ...g, pa: 1 }, { ...g, pm: 1 }, { ...g, pa: 1, pm: 1 }, { ...g, crit: (g.crit || 0) + 0.02 }];
  const keep = new Set();
  const bySlot = {};
  for (const it of problem.items) (bySlot[it.s] ||= []).push(it);
  for (const list of Object.values(bySlot)) {
    for (const w of dirs) [...list].sort((a, b) => lin(b, w) - lin(a, w)).slice(0, K).forEach(it => keep.add(it.id));
    list.filter(it => it.passive || it.s === 'dofus' || problem.cfg.forced.includes(it.id)).forEach(it => keep.add(it.id));
  }
  return rebuildProblem(problem, problem.items.filter(it => keep.has(it.id)));
}

// Coupe de Kelley -> ligne { terms, rhs } pour une session persistante
const cutRow = c => ({
  terms: {
    t: 1,
    ...Object.fromEntries(Object.entries(c.g).map(([k, g]) => [`T_${k}`, -g])),
    ...Object.fromEntries(Object.entries(c.h).map(([i, h]) => [`x${i}`, -h])),
  },
  rhs: c.rhs,
});

// Boucle de Kelley sur un modèle persistant : coupes ajoutées à chaud, départ sur la solution précédente
async function kelley(solver, problem, cuts, start, onProgress, phase) {
  const session = await solver.open(buildLP(problem, cuts));
  try {
    if (start) await session.warmStart(start);
    onProgress({ mode: problem.mode, phase, iter: 0, items: problem.items.length });
    let best = null, upper = Infinity;
    for (let iter = 0; iter < problem.cfg.maxIterations; iter++) {
      const r = await session.run({ time_limit: 60, mip_rel_gap: 1e-4 });
      if (r.infeasible || !r.feasible) {
        const why = problem.mode === 'crit' ? `Impossible d'atteindre ${problem.critTarget} % critique avec ces minimums.` : 'Aucun stuff ne respecte ces minimums.';
        throw new Error(r.infeasible ? why : 'Le solveur n\'a pas trouvé de solution à temps.');
      }
      // l'objectif n'est une borne que si l'optimum est prouvé
      if (r.optimal) upper = Math.min(upper, r.objective);
      const cur = readSolution(problem, r.cols);
      const curStats = solutionStats(problem, cur);
      const val = score(curStats, ctxOf(problem, cur.items.filter(it => it.passive).map(it => it.passive)));
      if (!best || val > best.value) best = { ...cur, value: val, cols: r.cols };
      onProgress({ mode: problem.mode, phase, iter: iter + 1, value: best.value, items: problem.items.length });
      if (Math.log(best.value) >= upper - 1e-3) break;
      const newCuts = makeCuts(problem, curStats, cur);
      cuts.push(...newCuts);
      await session.addCuts(newCuts.map(cutRow));
      await session.warmStart(r.cols);
    }
    return best;
  } finally {
    session.close();
  }
}

async function solveMode(solver, game, cfg, mode, onProgress) {
  const full = prepare(game, cfg);
  full.setsById = game.sets;
  full.mode = mode;

  // Tangentes de départ : le point « sans item » plus trois points de stats de fin de jeu
  // plausibles, pour que la première résolution tombe déjà près de l'optimum.
  const startPoints = {};
  for (const el of cfg.elements) startPoints[ELEMENT_STAT[el]] = Math.floor(400 / cfg.elements.length);
  const startStats = solutionStats(full, { items: [], points: startPoints, fm: {} });
  const ref = { puissance: 300, do: 25, doCrit: 90, crit: mode === 'crit' ? full.critTarget : 0, pctSorts: 8, pctDist: 8, pctMelee: 8 };
  for (const el of cfg.elements) { ref[ELEMENT_STAT[el]] = 1000; ref[ELEMENT_DO[el]] = 60; }

  // Phase 1 : items élagués. Phase 2 : tous les items, en partant de la solution de la phase 1.
  const p1 = full.items.length > 600 ? pruneTopK(full, startStats, PRUNE_K) : full;
  const cuts = [...makeCuts(p1, startStats, { items: [] })];
  for (const scale of [0.6, 1, 1.4]) {
    const st = { ...startStats };
    for (const [k, v] of Object.entries(ref)) st[k] = (st[k] || 0) + scale * v;
    cuts.push(...makeCuts(p1, st, { items: [] }));
  }
  let best = await kelley(solver, p1, cuts, null, onProgress, 1);
  let problem = p1;
  if (p1 !== full) {
    const toFull = {};
    for (const it of full.items) toFull[it.id] = it.idx;
    const mapIdx = i => toFull[p1.items[i].id];
    const fullCuts = cuts.map(c => ({ g: c.g, rhs: c.rhs, h: Object.fromEntries(Object.entries(c.h).map(([i, h]) => [mapIdx(+i), h])) }));
    // Solution de départ renommée vers les indices du modèle complet ; les panoplies absentes à 0 item
    const start = {};
    for (const [name, v] of Object.entries(best.cols)) {
      const m = /^(x|e|ov|pe|tr|g)(\d+)(.*)$/.exec(name);
      start[m ? `${m[1]}${mapIdx(+m[2])}${m[3]}` : name] = v;
    }
    for (const s of full.sets) if (!Object.keys(start).some(k => k.startsWith(`y${s.id}_`))) start[`y${s.id}_0`] = 1;
    best = await kelley(solver, full, fullCuts, start, onProgress, 2);
    problem = full;
  }

  // Forgemagie exacte item par item, runes de transcendance, puis stats finales
  onProgress({ mode, phase: 3, iter: 0, value: best.value, items: problem.items.length });
  const bestStats = solutionStats(problem, best);
  const passives = best.items.filter(it => it.passive).map(it => it.passive);
  const grad = makeCuts(problem, bestStats, best)[0]?.g || {};
  const finish = await finishItems(solver, problem, best, grad);
  const ctx = ctxOf(problem, passives, true);
  const { perItem, transPerItem, fm } = improveFinishes(problem, best, finish, ctx);
  const final = { ...best, fm, trans: {} };
  const stats = solutionStats(problem, final);
  return { problem, final, stats, perItem, transPerItem, passives, realScore: score(stats, ctx), ctx };
}

// Les finitions sont choisies avec une pente figée, ce qui met toute la même ligne partout
// (24 % sorts / 6 % distance alors que les deux se multiplient). On améliore item par item en
// recalculant les vrais dégâts : autre ligne de %, autre transcendance… tant que ça rapporte plus
// et que les minimums (et le critique visé) restent tenus.
function improveFinishes(problem, best, finish, ctx) {
  const { cfg } = problem;
  const perItem = structuredClone(finish.perItem);
  const transPerItem = structuredClone(finish.transPerItem);
  const totals = () => {
    const fm = {};
    for (const f of Object.values(perItem)) for (const [k, v] of Object.entries(f)) fm[k] = (fm[k] || 0) + v;
    for (const t of Object.values(transPerItem)) fm[t.k] = (fm[t.k] || 0) + t.v;
    return fm;
  };
  const mins = { ...cfg.min };
  if (problem.mode === 'crit' && problem.critTarget > 0) mins.crit = Math.max(mins.crit || 0, problem.critTarget);
  const ok = st => Object.entries(mins).every(([k, v]) => (k === 'resMoy'
    ? RES_KEYS.reduce((t, r) => t + (st[r] || 0), 0) / 5 : st[k] || 0) >= v - 1e-6);
  const evaluate = () => {
    const st = solutionStats(problem, { ...best, fm: totals(), trans: {} });
    return ok(st) ? score(st, ctx) : -Infinity;
  };

  let current = evaluate();
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (const it of best.items.filter(i => FM_SLOTS.has(i.s))) {
      const fm = perItem[it.id] || {};
      // on ne touche qu'aux items avec une seule finition « légère » (exo %, transcendance ou rien)
      if (Object.keys(fm).some(k => it.fmKind[k] !== 'pct')) continue;
      const options = [{ fm: {}, tr: null }];
      for (const [k, cap] of Object.entries(it.fmCap)) if (it.fmKind[k] === 'pct') options.push({ fm: { [k]: cap }, tr: null });
      for (const r of Object.values(problem.trans)) if (it.l >= r.l) options.push({ fm: {}, tr: { n: r.n, k: r.k, v: r.v } });
      const saved = { fm: perItem[it.id], tr: transPerItem[it.id] };
      let bestOpt = null;
      for (const o of options) {
        perItem[it.id] = o.fm; transPerItem[it.id] = o.tr;
        if (!o.tr) delete transPerItem[it.id];
        const v = evaluate();
        if (v > current + 1e-6) { current = v; bestOpt = o; }
      }
      const keep = bestOpt || saved;
      perItem[it.id] = keep.fm || {};
      if (keep.tr) transPerItem[it.id] = keep.tr; else delete transPerItem[it.id];
      if (bestOpt) improved = true;
    }
    if (!improved) break;
  }
  for (const id of Object.keys(perItem)) if (!Object.keys(perItem[id]).length) delete perItem[id];
  return { perItem, transPerItem, fm: totals() };
}

// Pourquoi chaque exo PA / PM / PO coché est utilisé ou non. Un exo coché n'est jamais imposé :
// le moteur ne le pose que s'il sert un minimum demandé ; sinon une autre finition rapporte plus.
function exoNotes(cfg, stats, perItem) {
  const notes = [];
  for (const k of SINGLE_EXO) {
    const K = k.toUpperCase();
    if (!cfg.fm[`exo${K}`]) continue;
    const used = Object.values(perItem).some(f => f[k]);
    const min = cfg.min[k];
    const have = Math.round(stats[k] || 0);
    if (used && min !== undefined && have - 1 < min) {
      notes.push({ k, used, text: `Exo ${K} utilisé : sans lui tu serais à ${have - 1} ${K}, sous ton minimum de ${min}.` });
    } else if (used) {
      notes.push({ k, used, text: `Exo ${K} utilisé : il ne coûte aucun dégât ici, aucune autre finition ne rapportait plus sur cet item.` });
    } else {
      notes.push({ k, used, text: min !== undefined
        ? `Exo ${K} non utilisé : ton minimum de ${min} ${K} est atteint sans lui (${have}), et d'autres finitions rapportent plus de dégâts.`
        : `Exo ${K} non utilisé : sans minimum de ${K} demandé, il n'augmente pas les dégâts ; d'autres finitions rapportent plus.` });
    }
  }
  return notes;
}

// solver.open(lp) -> session persistante, solver.solve(lp, options) -> résultat ponctuel ;
// les modes de critique tournent en parallèle
export async function optimize(solver, game, config, onProgress = () => {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, fm: { ...DEFAULT_CONFIG.fm, ...config.fm }, min: { ...(config.min ?? DEFAULT_CONFIG.min) } };
  // une finition décochée = valeur max à 0 (le moteur ne la propose pas)
  if (!cfg.fm.pctExoOn) cfg.fm.pctExo = 0;
  if (!cfg.fm.overOn) cfg.fm.overBudget = 0;
  if (!cfg.elements.length) throw new Error('Choisis au moins un élément.');

  const modes = cfg.critMode === 'auto' ? ['crit', 'noncrit'] : [cfg.critMode];
  let lastError;
  const runs = (await Promise.all(modes.map(mode => solveMode(solver, game, cfg, mode, onProgress)
    .then(r => ({ mode, ...r }), e => { lastError = e; return null; })))).filter(Boolean);
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
      id: it.id, n: it.n, s: it.s, l: it.l, img: it.img, set: it.set, st: it.st, r: it.r, c: it.c, passive: it.p || 0,
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
    exoNotes: exoNotes(cfg, stats, perItem),
    violations,
    unmetConditions: unmet,
    candidates: problem.items.length,
  };
}
