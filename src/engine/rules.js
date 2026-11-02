// Règles du jeu (Dofus 3.7) utilisées par le moteur. Sources dans le README.

export const LEVEL = 200;
export const STAT_POINTS = 995; // 5 points par niveau
export const SCROLL = 100; // parchemins : +100 par caractéristique

// Stats de base d'un personnage niveau 200, avant équipement
export const BASE = { pa: 7, pm: 3, invo: 1, vita: 50 + 5 * (LEVEL - 1), pods: 1000, crit: 0 };

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
