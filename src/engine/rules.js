// Règles du jeu (Dofus 3.7) utilisées par le moteur. Sources dans le README.

export const LEVEL = 200;
export const STAT_POINTS = 995; // 5 points par niveau
export const statPoints = level => 5 * (Math.min(level, LEVEL) - 1);
export const SCROLL = 100; // parchemins : +100 par caractéristique

// Stats de base d'un personnage niveau 200, avant équipement : 50 + 5 PdV par niveau (55 au niveau 1,
// 1 050 au niveau 200, comme DofusBook)
export const BASE = { pa: 7, pm: 3, invo: 1, vita: 50 + 5 * LEVEL, pods: 1000, crit: 0 };
// 6 PA de base, +1 au niveau 100
export const baseStats = level => ({ ...BASE, pa: level >= 100 ? 7 : 6, vita: 50 + 5 * Math.min(level, LEVEL) });

// Stats dont le total en jeu dépend des caractéristiques (vérifié sur DofusBook) : la stat des items
// plus des termes [stat, diviseur ou multiplicateur], plus une base. Un diviseur est arrondi par
// défaut (fuite = fuite des items + floor(agilité / 10)). Les stats brutes (st.fuite…) restent celles
// des items ; totalStat donne le total affiché en jeu, utilisé pour les minimums.
export const DERIVED = {
  ini: { terms: [['force', 1], ['intel', 1], ['chance', 1], ['agi', 1]] },
  tacle: { terms: [['agi', 1 / 10]] },
  fuite: { terms: [['agi', 1 / 10]] },
  esqPA: { terms: [['sagesse', 1 / 10]] },
  esqPM: { terms: [['sagesse', 1 / 10]] },
  retPA: { terms: [['sagesse', 1 / 10]] },
  retPM: { terms: [['sagesse', 1 / 10]] },
  pp: { terms: [['chance', 1 / 10]], base: 100 },
  pods: { terms: [['force', 5]] },
};
export function totalStat(st, k) {
  const d = DERIVED[k];
  let v = st[k] || 0;
  if (!d) return v;
  for (const [c, f] of d.terms) v += f < 1 ? Math.floor((st[c] || 0) * f + 1e-9) : f * (st[c] || 0);
  return v + (d.base || 0);
}
// PA en début de combat plafonnés à 12 : au-delà, seuls les PA gagnés en combat (Ocre, légendaires…) comptent
export const PA_CAP = 12;
// Plafonds en début de combat (PA, PM, PO) : un minimum demandé au-delà ne sert à rien, il est ramené au plafond
export const STAT_CAP = { pa: PA_CAP, pm: 6, po: 6 };

export const ELEMENTS = ['feu', 'eau', 'terre', 'air', 'neutre'];
export const ELEMENT_STAT = { feu: 'intel', eau: 'chance', terre: 'force', air: 'agi', neutre: 'force' };
export const ELEMENT_DO = { feu: 'doFeu', eau: 'doEau', terre: 'doTerre', air: 'doAir', neutre: 'doNeutre' };
export const ELEMENT_RES = { feu: 'resFeu', eau: 'resEau', terre: 'resTerre', air: 'resAir', neutre: 'resNeutre' };
export const ELEMENT_RF = { feu: 'rfFeu', eau: 'rfEau', terre: 'rfTerre', air: 'rfAir', neutre: 'rfNeutre' };
export const CARACS = ['force', 'intel', 'chance', 'agi'];

// Forgemagie : une ligne ne dépasse pas 101 de poids (sauf jet naturel plus haut),
// et un item ne porte pas plus de 101 de poids en over + exo.
export const FM_LINE_WEIGHT = 101;
export const FM_ITEM_WEIGHT = 101;
// Un seul exo PA, PM et PO compte sur l'ensemble du stuff
export const SINGLE_EXO = ['pa', 'pm', 'po'];
// Emplacements forgemageables
export const FM_SLOTS = new Set(['amulette', 'anneau', 'ceinture', 'bottes', 'chapeau', 'cape', 'bouclier', 'arme']);

export const SLOT_LIMIT = {
  amulette: 1, anneau: 2, ceinture: 1, bottes: 1, chapeau: 1, cape: 1, bouclier: 1, arme: 1, familier: 1, dofus: 6,
};

// Valeur max d'une ligne après forgemagie
export function lineCap(weight, natural) {
  return Math.max(natural, Math.floor(FM_LINE_WEIGHT / weight));
}

// Coût en points de caractéristique : paliers [seuil, coût par point]
export function pointSegments(tiers) {
  return tiers.map(([from, cost], i) => ({
    from, cost, width: i + 1 < tiers.length ? tiers[i + 1][0] - from : Infinity,
  }));
}

export const STAT_LABEL = {
  pa: 'PA', pm: 'PM', po: 'Portée', invo: 'Invocations', vita: 'Vitalité', sagesse: 'Sagesse',
  force: 'Force', intel: 'Intelligence', chance: 'Chance', agi: 'Agilité', puissance: 'Puissance',
  do: 'Dommages', doFeu: 'Dommages Feu', doEau: 'Dommages Eau', doTerre: 'Dommages Terre', doAir: 'Dommages Air',
  doNeutre: 'Dommages Neutre', crit: '% Critique', doCrit: 'Dommages Critiques', doPou: 'Dommages Poussée',
  soins: 'Soins', pctSorts: '% Dommages sorts', pctDist: '% Dommages distance', pctMelee: '% Dommages mêlée',
  pctArmes: '% Dommages armes', pctFinaux: '% Dommages finaux',
  resFeu: '% Rés. Feu', resEau: '% Rés. Eau', resTerre: '% Rés. Terre', resAir: '% Rés. Air', resNeutre: '% Rés. Neutre',
  rfFeu: 'Rés. Feu', rfEau: 'Rés. Eau', rfTerre: 'Rés. Terre', rfAir: 'Rés. Air', rfNeutre: 'Rés. Neutre',
  resCrit: 'Rés. Critiques', resPou: 'Rés. Poussée', resDist: '% Rés. distance', resMelee: '% Rés. mêlée',
  resSorts: '% Rés. sorts', resArmes: '% Rés. armes', tacle: 'Tacle', fuite: 'Fuite', retPA: 'Retrait PA',
  retPM: 'Retrait PM', esqPA: 'Esquive PA', esqPM: 'Esquive PM', ini: 'Initiative', pp: 'Prospection',
  pods: 'Pods', renvoi: 'Renvoi',
};
