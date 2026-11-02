// Transforme data/raw/*.json (DofusDB) en un fichier compact public/game.json pour l'appli.
// Usage : node scripts/build-data.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const RAW = new URL('../data/raw/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(`${name}.json`, RAW), 'utf8'));
const fr = o => (o && o.fr) || '';

// id de caractéristique DofusDB -> clé interne
export const CHARAC = {
  1: 'pa', 23: 'pm', 19: 'po', 26: 'invo',
  11: 'vita', 12: 'sagesse', 10: 'force', 15: 'intel', 13: 'chance', 14: 'agi',
  25: 'puissance', 98: 'puissance', // « Puissance Sorts » ne compte que pour les sorts : même effet ici
  16: 'do', 89: 'doFeu', 90: 'doEau', 88: 'doTerre', 91: 'doAir', 92: 'doNeutre',
  18: 'crit', 86: 'doCrit', 84: 'doPou', 49: 'soins',
  123: 'pctSorts', 120: 'pctDist', 125: 'pctMelee', 122: 'pctArmes', 107: 'pctFinaux',
  34: 'resFeu', 35: 'resEau', 33: 'resTerre', 36: 'resAir', 37: 'resNeutre',
  55: 'rfFeu', 56: 'rfEau', 54: 'rfTerre', 57: 'rfAir', 58: 'rfNeutre',
  87: 'resCrit', 85: 'resPou', 121: 'resDist', 124: 'resMelee', 141: 'resSorts', 142: 'resArmes',
  79: 'tacle', 78: 'fuite', 82: 'retPA', 83: 'retPM', 27: 'esqPA', 28: 'esqPM',
  44: 'ini', 48: 'pp', 40: 'pods', 50: 'renvoi',
};

const SLOT_OF_TYPE = {
  1: 'amulette', 9: 'anneau', 10: 'ceinture', 11: 'bottes', 16: 'chapeau', 17: 'cape', 82: 'bouclier',
  2: 'arme', 3: 'arme', 4: 'arme', 5: 'arme', 6: 'arme', 7: 'arme', 8: 'arme', 19: 'arme', 22: 'arme', 271: 'arme',
  12: 'familier', 121: 'familier', 331: 'familier', 332: 'familier', 333: 'familier',
  23: 'dofus', 151: 'dofus', 217: 'dofus',
};

// Effets de dégâts / soins des sorts : effectId -> [type, élément]
const SPELL_LINES = {
  96: ['dmg', 'eau'], 97: ['dmg', 'terre'], 98: ['dmg', 'air'], 99: ['dmg', 'feu'], 100: ['dmg', 'neutre'],
  91: ['vol', 'eau'], 92: ['vol', 'terre'], 93: ['vol', 'air'], 94: ['vol', 'feu'], 95: ['vol', 'neutre'],
  2822: ['dmg', 'best'],
  108: ['soin', 'feu'], 2998: ['soin', 'eau'], 2999: ['soin', 'air'], 3000: ['soin', 'terre'], 3001: ['soin', 'neutre'],
};
const PASSIVE_EFFECT = 1175;

const [effectsRaw, items, sets, breeds, variants, spells, levels] = await Promise.all(
  ['effects', 'items', 'item-sets', 'breeds', 'spell-variants', 'spells', 'spell-levels'].map(read),
);
const effects = new Map(effectsRaw.map(e => [e.id, e]));
const spellById = new Map(spells.map(s => [s.id, s]));
const levelById = new Map(levels.map(l => [l.id, l]));

// Convertit un effet d'item ou de panoplie en [clé, valeur max]
function statOf(effectId, min, max) {
  const e = effects.get(effectId);
  const key = e && CHARAC[e.characteristic];
  if (!key) return null;
  const sign = e.characteristicOperator === '-' ? -1 : 1;
  // jet max pour un bonus, malus le plus faible pour un malus
  const v = sign > 0 ? Math.max(min, max) : min;
  return [key, sign * v];
}

const outItems = [];
const passiveIds = new Set();
for (const it of items) {
  const slot = SLOT_OF_TYPE[it.typeId];
  if (!slot || it.level > 200) continue;
  const st = {};
  const roll = {};
  let passive = 0;
  for (const e of it.possibleEffects || []) {
    if (e.effectId === PASSIVE_EFFECT) { passive = e.diceNum; continue; }
    const s = statOf(e.effectId, e.diceNum, e.diceSide);
    if (!s) continue;
    st[s[0]] = (st[s[0]] || 0) + s[1];
    if (e.diceSide > e.diceNum) roll[s[0]] = [e.diceNum, e.diceSide];
  }
  if (!Object.keys(st).length && !passive) continue;
  if (passive) passiveIds.add(passive);
  outItems.push({
    id: it.id, n: fr(it.name), t: it.typeId, s: slot, l: it.level,
    set: it.itemSetId > 0 ? it.itemSetId : 0, c: it.criterions || '',
    st, r: roll, p: passive || undefined, img: it.iconId,
  });
}

const usedSets = new Set(outItems.map(i => i.set).filter(Boolean));
const outSets = {};
for (const s of sets) {
  if (!usedSets.has(s.id)) continue;
  // effects[k] = bonus quand k objets de la panoplie sont portés
  const bonus = (s.effects || []).map(list => {
    const b = {};
    for (const e of list || []) {
      const r = statOf(e.effectId, e.from, e.to);
      if (r) b[r[0]] = (b[r[0]] || 0) + r[1];
    }
    return b;
  });
  outSets[s.id] = { n: fr(s.name), b: bonus };
}

// Sorts : niveau le plus haut accessible au niveau 200
function spellInfo(id) {
  const s = spellById.get(id);
  if (!s) return null;
  const lv = (s.spellLevels || []).map(l => levelById.get(l)).filter(l => l && l.minPlayerLevel <= 200);
  const l = lv[lv.length - 1];
  if (!l) return null;
  const lines = (effects, crit) => effects.flatMap(e => {
    const m = SPELL_LINES[e.effectId];
    if (!m) return [];
    const min = e.diceNum, max = Math.max(e.diceNum, e.diceSide);
    return [{ k: m[0], el: m[1], min, max, crit, tm: e.targetMask || '' }];
  });
  return {
    id, n: fr(s.name), d: fr(s.description), img: s.iconId,
    pa: l.apCost, cc: l.criticalHitProbability, po: [l.minRange, l.range], lvl: l.minPlayerLevel,
    lines: [...lines(l.effects || [], false), ...lines(l.criticalEffect || [], true)],
  };
}

const outSpells = {};
const outBreeds = [];
for (const b of breeds) {
  const pairs = variants.filter(v => v.breedId === b.id).map(v => v.spellIds);
  for (const p of pairs) for (const id of p) if (!outSpells[id]) {
    const info = spellInfo(id);
    if (info) outSpells[id] = info;
  }
  outBreeds.push({
    id: b.id, n: fr(b.shortName) || fr(b.name),
    cost: {
      force: b.statsPointsForStrength, intel: b.statsPointsForIntelligence,
      chance: b.statsPointsForChance, agi: b.statsPointsForAgility,
      vita: b.statsPointsForVitality, sagesse: b.statsPointsForWisdom,
    },
    variants: pairs.filter(p => p.every(id => outSpells[id])),
  });
}

const passives = {};
for (const id of passiveIds) {
  const s = spellById.get(id);
  if (s) passives[id] = { n: fr(s.name), d: fr(s.description).replace(/\{\{[^}]*::([^}]*)\}\}/g, '$1') };
}

// Poids des runes par point de stat (forgemagie), lus dans les données du jeu
const runeWeight = {};
for (const e of effectsRaw) {
  const key = CHARAC[e.characteristic];
  if (key && e.bonusType === 1 && e.effectPowerRate > 0 && e.characteristicOperator === '+' && !(key in runeWeight))
    runeWeight[key] = Math.round(e.effectPowerRate * 100) / 100;
}

await mkdir(new URL('../public/', import.meta.url), { recursive: true });
const game = { builtAt: new Date().toISOString(), items: outItems, sets: outSets, breeds: outBreeds, spells: outSpells, passives, runeWeight };
await writeFile(new URL('../public/game.json', import.meta.url), JSON.stringify(game));
console.log(`items ${outItems.length}, panoplies ${Object.keys(outSets).length}, classes ${outBreeds.length}, sorts ${Object.keys(outSpells).length}, passifs ${Object.keys(passives).length}`);
