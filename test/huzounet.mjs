// Stuffs de Huzounet (data/huzounet/stuffs.json) traduits en résultat du moteur, pour evaluateStuff.
// Le fichier vient de huzounet.fr (/api/equipments/search?budget=high|legendary) et de DofusBook
// (/api/stuffs/dofus/public/<id>, lu depuis un navigateur ; le code court d-bk.net est l'id en base 62,
// alphabet 0-9A-Za-z). Champs : sl = emplacement → id Ankama, b = points de caractéristique,
// sc = parchemins, fm = exos globaux (pa, pm, po), fi = lignes retouchées par item (valeur finale).
import { readFileSync } from 'node:fs';
import { normalizeConfig, resMoy } from '../src/engine/optimize.js';
import { evaluateStuff } from '../src/engine/edit.js';
import { FM_SLOTS, STAT_CAP } from '../src/engine/rules.js';

export const ELEMENTS = ['feu', 'eau', 'terre', 'air'];
const POINTS = { vi: 'vita', sa: 'sagesse', fo: 'force', in: 'intel', ch: 'chance', ag: 'agi' };
const DB_STAT = { pa: 'pa', pm: 'pm', po: 'po', cc: 'crit' };

// Stuffs de dégâts à un ou deux éléments (sans multi, PP ni tank)
export function huzounetStuffs() {
  const all = JSON.parse(readFileSync(new URL('../data/huzounet/stuffs.json', import.meta.url), 'utf8'));
  return all.filter(s => s.tags.split('/').every(t => ELEMENTS.includes(t))).map(s => ({ ...s, elements: s.tags.split('/') }));
}

// Résultat du moteur pour un stuff Huzounet. Config : ses minimums (PA, PM, PO plafonnés, résistance
// moyenne, vitalité sauf withVita: false), la même forgemagie (exos PA / PM / PO), mêlée si son stuff a plus de % mêlée que de % distance.
export function huzounetResult(game, s, { withVita = true } = {}) {
  const byId = new Map(game.items.map(it => [it.id, it]));
  s.missing = [];
  s.unknownFm = Object.keys(s.fm).filter(k => !DB_STAT[k]);
  const items = [];
  for (const [slot, id] of Object.entries(s.sl)) {
    const gi = byId.get(id);
    if (!gi) { s.missing.push(id); continue; }
    const fm = {};
    for (const [k, v] of Object.entries(s.fi[slot] || {})) {
      const key = DB_STAT[k];
      if (key && v !== (gi.st[key] || 0)) fm[key] = v - (gi.st[key] || 0);
    }
    items.push({ id: gi.id, n: gi.n, s: gi.s, l: gi.l, img: gi.img, set: gi.set, st: { ...gi.st }, r: gi.r, c: gi.c, passive: gi.p || 0, fm, trans: null });
  }
  // exos globaux : posés sur un item forgemageable sans la stat (seul le total compte)
  for (const [k, v] of Object.entries(s.fm)) {
    const key = DB_STAT[k];
    if (!key) continue;
    const it = items.find(i => FM_SLOTS.has(i.s) && !(i.st[key] > 0) && !i.fm[key]) || items.find(i => FM_SLOTS.has(i.s));
    it.fm[key] = (it.fm[key] || 0) + v;
  }
  const points = {};
  for (const [k, v] of Object.entries(s.b)) if (v) points[POINTS[k]] = v;
  const fm = { pctExoOn: false, overOn: false, transcendance: false, exoPA: true, exoPM: true, exoPO: true };
  const build = cfg => ({ config: normalizeConfig(game, cfg), items, points, crit: { mode: 'crit', runs: [] } });
  const base = { breedId: s.cl, level: s.lv, elements: s.elements, fullScroll: true, fm, min: {} };
  const stats = evaluateStuff(game, build(base)).stats;
  const attack = (stats.pctMelee || 0) > (stats.pctDist || 0) ? 'melee' : 'dist';
  const min = { pa: Math.min(STAT_CAP.pa, stats.pa), pm: Math.min(STAT_CAP.pm, stats.pm), resMoy: Math.floor(resMoy(stats)) };
  if (stats.po > 0) min.po = Math.min(STAT_CAP.po, stats.po);
  // survie égale : même vitalité (sans elle, le moteur échange la vie contre des dégâts)
  if (withVita) min.vita = stats.vita;
  return build({ ...base, attack, min });
}
