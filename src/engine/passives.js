// Passifs des Dofus, prysmaradites et légendaires qui changent les dégâts.
// Ils ne figurent pas dans les stats des items : chaque passif est traduit à la main depuis son texte
// officiel, pour trois scénarios :
//   moyen : moyenne sur un combat de 5 tours
//   burst : le meilleur tour pour frapper
//   tour1 : le premier tour du combat (aucune attaque subie, aucun cumul encore, tour impair)
// Champs possibles : finaux (% dommages finaux, multiplicatif), pctSorts, pctDist, pctMelee,
// cible (% dommages subis par la cible), et n'importe quelle stat additive (do, puissance, crit…).
// Une fonction reçoit les stats du perso (s) quand l'effet en dépend.
// def : réduction moyenne des dégâts subis (affichage seulement).

const ELEMENT_STAT = { feu: 'intel', eau: 'chance', terre: 'force', air: 'agi', neutre: 'force' };

const PA_NOTE = 'Les PA gagnés en combat sont comptés comme des dégâts en plus sur le tour (+1 PA à 12 PA ≈ +8 %).';

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
  // Vulbis et Ocre : déclencheur « début de tour » avec 1 tour de délai dans les données du jeu,
  // donc rien au tour 1 ; sur 5 tours, au mieux 4 déclenchements.
  8396: { // Vulbis : +10 % finaux si aucune attaque subie depuis le tour précédent
    moyen: { finaux: 4 }, burst: { finaux: 10 },
    note: 'Ne se déclenche qu\'à partir du tour 2. Suppose que tu n\'es pas attaqué un tour sur deux.',
  },
  18888: { // Tacheté : +20 Dommages le tour suivant si tu as frappé
    moyen: { do: 16 }, burst: { do: 20 },
  },
  18629: { // Ébène : +2 % dist/mêlée en alternant, 5 fois, 3 tours, + poison
    moyen: { pctDist: 4, pctMelee: 4 }, burst: { pctDist: 10, pctMelee: 10 },
    note: 'Demande d\'alterner attaques en mêlée et à distance. Poison non compté.',
  },
  8394: { // Ocre : +1 PA au début du tour si aucune attaque subie depuis le tour précédent
    moyen: s => perTurn(s, 0.4), burst: s => perTurn(s, 1),
    note: PA_NOTE + ' Ne se déclenche qu\'à partir du tour 2. Suppose que tu n\'es pas attaqué un tour sur deux.',
  },
  6828: { // Abyssal : +1 PM sans ennemi au contact, sinon +1 PA
    moyen: s => perTurn(s, 0.3), burst: s => perTurn(s, 1),
    note: PA_NOTE + ' Suppose un ennemi au contact un tour sur trois.',
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
  28516: { // Sylvestre : +8 Puissance par PM utilisé, 2 tours (les PM de ce tour et du précédent cumulent)
    moyen: s => ({ puissance: 8 * (s.pm || 0) }), // la moitié de ses PM utilisés à chaque tour
    burst: s => ({ puissance: 16 * (s.pm || 0) }), // tous ses PM utilisés ce tour et le précédent
    note: 'Combat moyen : tu utilises la moitié de tes PM à chaque tour (6 PM = +48 Puissance). '
      + 'Burst : tous tes PM ce tour et le précédent (6 PM = +96 Puissance). Le soin de 8 % n\'est pas compté.',
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
  // Pryssion : sacrifie des dommages finaux contre des PA sur les premiers tours
  14903: { moyen: s => turns(s, 5, [[3, 1, -10]]), burst: s => best(s, 1, -10), note: PA_NOTE },
  14904: { moyen: s => turns(s, 5, [[2, 2, -35]]), burst: s => best(s, 2, -35), note: PA_NOTE },
  14905: { moyen: s => turns(s, 5, [[1, 3, -50]]), burst: s => best(s, 3, -50), note: PA_NOTE },
  // Prycipithon : PA au premier tour
  14930: { moyen: s => turns(s, 5, [[1, 2, 0]]), burst: s => perTurn(s, 2), note: PA_NOTE },
  14931: { moyen: s => turns(s, 5, [[1, 3, 0]]), burst: s => perTurn(s, 3), note: PA_NOTE + ' Les 2 PM perdus ne sont pas comptés.' },
  14932: { moyen: s => turns(s, 5, [[1, 4, 0]]), burst: s => perTurn(s, 4), note: PA_NOTE + ' Les 4 PM perdus ne sont pas comptés.' },
  14948: { moyen: {}, burst: { pctMelee: 8 }, note: 'Mêlée uniquement.' },
  // --- Légendaires ---
  7331: { // Dofusteuse : +400 dans un élément par tour (eau > terre > air > feu)
    moyen: s => statBonus(s, 100), burst: s => statBonus(s, 400),
    note: 'Chaque élément reçoit +400 un tour sur quatre.',
  },
  11361: { // Diadème de Ganymède : +2 PA les tours pairs, -1 PA et -1 PM les tours impairs
    moyen: s => perTurn(s, 0.5), burst: s => perTurn(s, 2), note: PA_NOTE,
  },
  11359: { moyen: { finaux: 5 }, burst: { finaux: 7 }, note: 'Trompe-la-Mort : au-dessus de 50 % PV.' },
  11360: { moyen: { finaux: 2 }, burst: { finaux: 10 }, note: 'Brâm : demande des retraits PA/PM.' },
  11369: { moyen: { pctSorts: 1 }, burst: { pctSorts: 4 }, note: 'Jhessica : ennemis au contact en fin de tour.' },
  11354: { moyen: { cible: 3 }, burst: { cible: 6 }, note: 'Ciseaux du Destin : ennemis au contact.' },
  31856: { moyen: { finaux: 3 }, burst: { finaux: 4 } }, // Oto Mustam : 1 % par ennemi en vie (4 max)
  31860: { moyen: { cible: 4 }, burst: { cible: 4, finaux: 10 }, note: 'Thanatena : augmente aussi tes dégâts subis.' },
  11357: { moyen: {}, burst: {} }, // Buhorado : dommages poussée seulement
};

// Premier tour du combat. Passif absent = aucun effet au tour 1 (Vulbis et Ocre : délai d'un tour).
const TOUR1 = {
  5952: s => ({ finaux: critChance(s) }), // Turquoise : les critiques du tour profitent aux sorts suivants
  5454: { finaux: 20 }, // Nébuleux : tour impair
  28516: s => ({ puissance: 8 * (s.pm || 0) }), // Sylvestre : tous les PM de ce tour seulement
  14908: { crit: 100 }, // Surpryz
  14913: { finaux: 10 }, // Prynyang
  14903: s => perTurn(s, 1, -10), 14904: s => perTurn(s, 2, -35), 14905: s => perTurn(s, 3, -50), // Pryssion
  14930: s => perTurn(s, 2), 14931: s => perTurn(s, 3), 14932: s => perTurn(s, 4), // Prycipithon
  14948: { pctMelee: 4 }, // Pryximite
  7331: s => ((s.elements || []).includes('eau') ? { chance: 400 } : {}), // Dofusteuse : tour 1 = eau
  11361: s => perTurn(s, -1), // Ganymède : tour impair, -1 PA
  11359: { finaux: 7 }, // Trompe-la-Mort : plein de vie
  31856: { finaux: 4 }, // Oto Mustam : 4 ennemis en vie
  31860: { cible: 4 }, // Thanatena
};

// Un PA gagné en combat = environ un sort de plus : compté en % de dégâts sur le tour
// (+1 PA à 12 PA = +8,3 %). Les PA du stuff, eux, ne servent qu'aux minimums demandés.
function perTurn(s, extraPA, finaux = 0) {
  const pa = Math.max(1, s.pa || 12);
  return { finaux: 100 * (((pa + extraPA) / pa) * (1 + finaux / 100) - 1) };
}
// Moyenne sur n tours : [[nbTours, PA gagnés, % finaux], …]
function turns(s, n, phases) {
  let total = 0, used = 0;
  for (const [t, extra, fin] of phases) { total += t * (1 + perTurn(s, extra, fin).finaux / 100); used += t; }
  return { finaux: 100 * ((total + (n - used)) / n - 1) };
}
// Tour de burst : le meilleur tour possible (avec ou sans l'effet)
function best(s, extra, fin) {
  return { finaux: Math.max(0, perTurn(s, extra, fin).finaux) };
}

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
  const e = scenario === 'tour1' ? (TOUR1[spellId] ?? {}) : p[scenario];
  return typeof e === 'function' ? e(stats) : e;
}
