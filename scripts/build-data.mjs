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
  2822: ['dmg', 'best'], 2828: ['vol', 'best'], 2832: ['dmg', 'worst'],
  // dommages selon les PM restants (Zénith, Flèche du Jugement) : comptés pleins, lancés avant de bouger
  1013: ['dmg', 'air'], 1016: ['dmg', 'terre'],
  108: ['soin', 'feu'], 2998: ['soin', 'eau'], 2999: ['soin', 'air'], 3000: ['soin', 'terre'], 3001: ['soin', 'neutre'],
};
const PASSIVE_EFFECT = 1175;

const [effectsRaw, items, sets, breeds, variants, spells, levels, runes] = await Promise.all(
  ['effects', 'items', 'item-sets', 'breeds', 'spell-variants', 'spells', 'spell-levels', 'runes'].map(read),
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
  // Les panoplies stockent déjà leurs malus en négatif (-40), les items en positif (40)
  const v = sign > 0 ? Math.max(min, max) : min;
  return [key, sign * Math.abs(v)];
}

// Effets techniques jamais affichés en jeu (échangeable, lié, attitude, mutations…)
const HIDDEN_EFFECTS = new Set([10, 812, 981, 982, 983, 984, 3829, 3830, 3831, 3832, 3833, 3834, 3835]);

// Texte d'un effet à partir du modèle du jeu : « #1{{~1~2 à }}#2 dommages Feu », « #1 : +#3 Portée maximale »…
function effectText(e) {
  let t = fr(effects.get(e.effectId)?.description);
  if (!t) return '';
  const range = e.diceSide > e.diceNum;
  // #1 d'un bonus de sort = nom du sort
  const one = /^#1 :/.test(t) ? (fr(spellById.get(e.diceNum)?.name) || `Sort ${e.diceNum}`) : e.diceNum;
  t = t.replace(/\{\{~1~2([^}]*)\}\}/g, range ? '$1' : '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace('#1', one).replace('#2', range ? e.diceSide : '').replace('#3', e.value);
  return t.replace(/\s+/g, ' ').trim();
}

const outItems = [];
const passiveIds = new Set();
for (const it of items) {
  const slot = SLOT_OF_TYPE[it.typeId];
  if (!slot || it.level > 200) continue;
  // objets réservés aux MJ ou à un personnage nommé (PX = droits admin, PN = nom, GM = MJ)
  if (/\b(PX|PN|GM)[<>=!~]/.test(it.criterions || '')) continue;
  const st = {};
  const roll = {};
  const weaponLines = [];
  const extra = [];
  let passive = 0;
  for (const e of it.possibleEffects || []) {
    if (e.effectId === PASSIVE_EFFECT) { passive = e.diceNum; continue; }
    const s = statOf(e.effectId, e.diceNum, e.diceSide);
    if (s) {
      st[s[0]] = (st[s[0]] || 0) + s[1];
      if (e.diceSide > e.diceNum) roll[s[0]] = [e.diceNum, e.diceSide];
      continue;
    }
    // Effets hors stats : jets de l'arme, bonus de sorts des items de classe, « Arme de chasse »…
    const line = SPELL_LINES[e.effectId];
    if (slot === 'arme' && line) {
      weaponLines.push({ k: line[0], el: line[1], min: e.diceNum, max: Math.max(e.diceNum, e.diceSide) });
    } else if (e.visibleInTooltip !== false && !HIDDEN_EFFECTS.has(e.effectId)) {
      const text = effectText(e);
      if (text) extra.push(text);
    }
  }
  if (!Object.keys(st).length && !passive) continue;
  if (passive) passiveIds.add(passive);
  const weapon = slot === 'arme' && it.apCost ? {
    pa: it.apCost, po: [it.minRange, it.range], cc: it.criticalHitProbability, cb: it.criticalHitBonus,
    n: it.maxCastPerTurn, lines: weaponLines,
  } : undefined;
  outItems.push({
    id: it.id, n: fr(it.name), t: it.typeId, s: slot, l: it.level,
    set: it.itemSetId > 0 ? it.itemSetId : 0, c: it.criterions || '',
    st, r: roll, p: passive || undefined, img: it.iconId,
    w: weapon, x: extra.length ? extra : undefined, d: fr(it.description).trim() || undefined,
  });
}

const usedSets = new Set(outItems.map(i => i.set).filter(Boolean));
const outSets = {};
for (const s of sets) {
  if (!usedSets.has(s.id)) continue;
  // DofusDB : effects[k] = bonus quand k + 1 objets sont portés (effects[0] = 1 objet, vide).
  // Le moteur lit b[n] pour n objets : on décale d'un cran (b[0] = aucun objet).
  // Exemple : Katcheur, 3 objets, effects = [{}, bonus à 2, bonus à 3 (+1 PA)].
  const bonus = [[], ...(s.effects || [])].map(list => {
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
    // tr = déclencheur (poison de début / fin de tour…), z = zone : servent à écarter les lignes
    // qui ne sont pas un coup direct sur la cible (voir directLines dans damage.js)
    const z = e.zoneDescr ? `${e.zoneDescr.shape}:${e.zoneDescr.param1}` : '';
    // c = ligne d'affichage seulement (forClientOnly : souvent jouée par un sous-sort, sous condition),
    // dl = retardement en tours, p = probabilité d'une ligne aléatoire (une seule des lignes tirées s'applique)
    return [{
      k: m[0], el: m[1], min, max, crit, tm: e.targetMask || '', tr: e.triggers && e.triggers !== 'I' ? e.triggers : undefined, z,
      c: e.forClientOnly ? 1 : undefined, dl: e.delay || undefined, p: e.random > 0 ? +(e.random / 100).toFixed(4) : undefined,
    }];
  });
  // Effets autres que les dégâts (buffs, malus, états, sorts lancés…) : matière du catalogue de buffs.
  // k = stat du moteur quand l'effet modifie une caractéristique, e = id d'effet, d = durée en tours,
  // tm = cibles (« a » alliés, « c » lanceur…), z = forme et taille de la zone, txt = texte du jeu
  const fx = (list, crit) => list.flatMap(e => {
    if (SPELL_LINES[e.effectId] || HIDDEN_EFFECTS.has(e.effectId)) return [];
    const ef = effects.get(e.effectId);
    // sans opérateur + / -, l'effet n'est pas un gain de stat même s'il pointe une caractéristique
    // (265 « -X dommages reçus » pointe Dommages sans opérateur)
    const key = ef && /^[+-]$/.test(ef.characteristicOperator) && CHARAC[ef.characteristic];
    const sign = ef?.characteristicOperator === '-' ? -1 : 1;
    return [{
      e: e.effectId, k: key || undefined, sign: key ? sign : undefined, min: e.diceNum, max: Math.max(e.diceNum, e.diceSide), v: e.value || undefined,
      d: e.duration, delay: e.delay || undefined, tm: e.targetMask || '', z: e.zoneDescr ? [e.zoneDescr.shape, e.zoneDescr.param1] : undefined,
      tr: e.triggers && e.triggers !== 'I' ? e.triggers : undefined, crit: crit || undefined, txt: effectText(e) || undefined,
    }];
  });
  const grade = g => ({
    pa: g.apCost, cc: g.criticalHitProbability, po: [g.minRange, g.range], lvl: g.minPlayerLevel,
    lines: [...lines(g.effects || [], false), ...lines(g.criticalEffect || [], true)],
    // limites de lancer : par tour, par cible, relance (tours), relance initiale, relance globale,
    // st = effets du sort cumulables sur une même cible (1 = relancer rafraîchit, ≤ 0 = sans limite)
    lim: { n: g.maxCastPerTurn, nt: g.maxCastPerTarget, cd: g.minCastInterval, cd0: g.initialCooldown || undefined, gcd: g.globalCooldown > 0 ? g.globalCooldown : undefined, st: g.maxStack },
    fx: [...fx(g.effects || [], false), ...fx(g.criticalEffect || [], true)],
  });
  // grades = progression du sort selon le niveau du personnage (le dernier est celui du niveau 200)
  return { id, n: fr(s.name), d: fr(s.description), img: s.iconId, ...grade(l), grades: lv.map(grade) };
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

// Zones des sorts d'après DofusBook (data/dofusbook-spells.json, exporté à la main depuis un
// navigateur : https://www.dofusbook.net/api/spells/class/<id>, Cloudflare bloque curl). Plus lisible
// que zoneDescr : un groupe par cible et par cas (« Ennemi », « Lanceur sous Mot de Feu »,
// « 1 charge »…). zb = groupes du dernier grade qui frappent un ennemi : [titre, zone, taille].
// Exemple : Vacarme a [Ennemi, case, 1] et [Ennemi, cercle, 2] (la zone, lancé sur un Feu Follet).
const DB_DAMAGE = /^[dv](n|t|f|e|a|me|pe)$/;
try {
  const db = JSON.parse(await readFile(new URL('../data/dofusbook-spells.json', import.meta.url), 'utf8'));
  for (const list of Object.values(db.classes)) for (const s of list) {
    const out = outSpells[s.id];
    if (!out) continue;
    const top = Math.max(...s.g.map(g => g[0]));
    const zb = s.g.filter(g => g[0] === top && /Ennemi/.test(g[1]) && g[4].split(',').some(e => DB_DAMAGE.test(e)))
      .map(g => [g[1], g[2], g[3]]);
    if (zb.length) out.zb = zb;
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  console.warn('data/dofusbook-spells.json absent : zones des sorts non renseignées');
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

// Runes de transcendance : une ligne fixe, l'item ne peut plus être forgemagé ensuite.
// Le niveau de la rune est le niveau minimum de l'item.
const transcendance = runes.flatMap(r => {
  const e = (r.possibleEffects || []).map(x => statOf(x.effectId, x.diceNum, x.diceSide)).find(Boolean);
  return e ? [{ id: r.id, n: fr(r.name), l: r.level, k: e[0], v: e[1] }] : [];
});

// Icônes des stats (comme en jeu), copiées dans public/icons pour ne pas dépendre de dofusdb.fr
const characteristics = await read('characteristics');
const statIcon = {};
for (const [id, key] of Object.entries(CHARAC)) {
  const asset = characteristics.find(c => c.id === Number(id))?.asset;
  if (asset && !statIcon[key]) statIcon[key] = asset;
}
const ICONS = new URL('../public/icons/', import.meta.url);
await mkdir(ICONS, { recursive: true });
for (const asset of new Set(Object.values(statIcon))) {
  const file = new URL(`${asset}.png`, ICONS);
  try { await readFile(file); continue; } catch { /* à télécharger */ }
  const res = await fetch(`https://dofusdb.fr/icons/characteristics/${asset}.png`);
  if (res.ok) await writeFile(file, Buffer.from(await res.arrayBuffer()));
}
// on ne garde que les icônes réellement disponibles (DofusDB n'a pas celles des résistances)
for (const [k, asset] of Object.entries(statIcon)) {
  try { await readFile(new URL(`${asset}.png`, ICONS)); } catch { delete statIcon[k]; }
}

await mkdir(new URL('../public/', import.meta.url), { recursive: true });
const game = { builtAt: new Date().toISOString(), items: outItems, sets: outSets, breeds: outBreeds, spells: outSpells, passives, runeWeight, transcendance, statIcon };
await writeFile(new URL('../public/game.json', import.meta.url), JSON.stringify(game));
console.log(`transcendance ${transcendance.length}, items ${outItems.length}, panoplies ${Object.keys(outSets).length}, classes ${outBreeds.length}, sorts ${Object.keys(outSpells).length}, passifs ${Object.keys(passives).length}`);
