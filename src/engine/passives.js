// Passifs des Dofus, prysmaradites et légendaires qui changent les dégâts.
// Ils ne figurent pas dans les stats des items : chaque passif est traduit à la main depuis son texte
// officiel, pour deux scénarios :
//   moyen : moyenne sur un combat de 5 tours
//   burst : le meilleur tour pour frapper
// Champs possibles : finaux (% dommages finaux, multiplicatif), pctSorts, pctDist, pctMelee,
// cible (% dommages subis par la cible), et n'importe quelle stat additive (do, puissance, crit…).
// Une fonction reçoit les stats du perso (s) quand l'effet en dépend.
// def : réduction moyenne des dégâts subis (affichage seulement).

const ELEMENT_STAT = { feu: 'intel', eau: 'chance', terre: 'force', air: 'agi', neutre: 'force' };

export const PASSIVES = {
  // --- Dofus ---
  8395: { // Pourpre : +1 % finaux par attaque subie, 2 tours, 10 fois
    moyen: { finaux: 5 }, burst: { finaux: 10 },
    note: 'Suppose 2 à 3 attaques subies par tour (PvM).',
  },
  5952: { // Turquoise : +1 % finaux par coup critique, 3 tours, 10 fois
    moyen: s => ({ finaux: Math.min(10, 3 * 3 * critChance(s)) }),
    burst: s => ({ finaux: Math.min(10, 3 * 3 * critChance(s)) }),
    note: 'Suppose 3 sorts par tour : les cumuls dépendent de ton taux de critique.',
  },
  8396: { // Vulbis : +10 % finaux si aucune attaque subie depuis le tour précédent
    moyen: { finaux: 5 }, burst: { finaux: 10 },
    note: 'Suppose que tu n\'es pas attaqué un tour sur deux.',
  },
  18888: { // Tacheté : +20 Dommages le tour suivant si tu as frappé
    moyen: { do: 16 }, burst: { do: 20 },
  },
  18629: { // Ébène : +2 % dist/mêlée en alternant, 5 fois, 3 tours, + poison
    moyen: { pctDist: 4, pctMelee: 4 }, burst: { pctDist: 10, pctMelee: 10 },
    note: 'Demande d\'alterner attaques en mêlée et à distance. Poison non compté.',
  },
  18665: { // Ivoire : réduit de 50 % une attaque sur 5
    moyen: {}, burst: {}, def: 10,
  },
  5454: { // Nébuleux : +20 % finaux tours impairs, -10 % tours pairs
    moyen: { finaux: 5 }, burst: { finaux: 20 },
    note: 'Moyen = alternance +20 % / -10 %. Burst = un tour impair.',
  },
  18672: { // Argenté Scintillant : +20 % finaux 1 tour sous 20 % PV, 1 fois par combat
    moyen: { finaux: 4 }, burst: {},
  },
  28516: { // Sylvestre : +8 Puissance par PM utilisé, 2 tours
    moyen: { puissance: 24 }, burst: { puissance: 48 },
    note: 'Suppose 3 PM utilisés par tour.',
  },
  20981: { // Cauchemar : +100 Puissance après des dommages de poussée
    moyen: {}, burst: { puissance: 100 },
    note: 'Seulement si tu occasionnes ou subis de la poussée.',
  },
  // --- Prysmaradites ---
  14908: { // Surpryz : +100 % / 35 % / 15 % critique sur les 3 premiers tours
    moyen: { crit: 30 }, burst: { crit: 100 },
  },
  14913: { // Prynyang : +10 % / +3 % / -10 % finaux sur 3 tours
    moyen: { finaux: 0.6 }, burst: { finaux: 10 },
  },
  14903: { moyen: { finaux: -6 }, burst: { finaux: -10 }, note: '+1 PA non compté dans le stuff.' },
  14904: { moyen: { finaux: -14 }, burst: { finaux: -35 }, note: '+2 PA non comptés dans le stuff.' },
  14905: { moyen: { finaux: -10 }, burst: { finaux: -50 }, note: '+3 PA non comptés dans le stuff.' },
  14948: { moyen: {}, burst: { pctMelee: 8 }, note: 'Mêlée uniquement.' },
  // --- Légendaires ---
  7331: { // Dofusteuse : +400 dans un élément par tour (eau > terre > air > feu)
    moyen: s => statBonus(s, 100), burst: s => statBonus(s, 400),
    note: 'Chaque élément reçoit +400 un tour sur quatre.',
  },
  11359: { moyen: { finaux: 5 }, burst: { finaux: 7 }, note: 'Trompe-la-Mort : au-dessus de 50 % PV.' },
  11360: { moyen: { finaux: 2 }, burst: { finaux: 10 }, note: 'Brâm : demande des retraits PA/PM.' },
  11369: { moyen: { pctSorts: 1 }, burst: { pctSorts: 4 }, note: 'Jhessica : ennemis au contact en fin de tour.' },
  11354: { moyen: { cible: 3 }, burst: { cible: 6 }, note: 'Ciseaux du Destin : ennemis au contact.' },
  31856: { moyen: { finaux: 3 }, burst: { finaux: 4 } }, // Oto Mustam : 1 % par ennemi en vie (4 max)
  31860: { moyen: { cible: 4 }, burst: { cible: 4, finaux: 10 }, note: 'Thanatena : augmente aussi tes dégâts subis.' },
  11357: { moyen: {}, burst: {} }, // Buhorado : dommages poussée seulement
};

export function critChance(s, spellCrit = 10) {
  return Math.max(0, Math.min(1, (spellCrit + (s.crit || 0)) / 100));
}

// Dofusteuse : on ne compte le bonus que sur les éléments joués par le perso
function statBonus(s, value) {
  const out = {};
  for (const el of s.elements || []) out[ELEMENT_STAT[el]] = value;
  return out;
}

export function passiveEffect(spellId, scenario, stats) {
  const p = PASSIVES[spellId];
  if (!p) return null;
  const e = p[scenario];
  return typeof e === 'function' ? e(stats) : e;
}
