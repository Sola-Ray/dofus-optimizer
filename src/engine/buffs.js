// Catalogue des buffs d'équipe, lu dans les données du jeu (effets `fx` des sorts, voir build-data.mjs).
// Deux familles :
//   - buffs d'allié : stats qui augmentent les dégâts de la cible (PA, Puissance, Dommages, caracs,
//     % dommages, critique…), sur un allié, sur le lanceur ou sur les alliés d'une zone ;
//   - malus d'ennemi qui augmentent les dégâts de toute l'équipe : baisse de résistances (% et fixes),
//     « Dommages subis x N % » (stocké en pctSubis = N − 100, comme target.pctSubis dans damage.js).
// Les effets passés par un état ou un sous-sort ne sont pas dans game.json : les importants sont codés
// à la main (HAND), les autres sont listés dans les ignorés avec la raison, pour les afficher au joueur.
//
// Forme d'un buff :
//   { spellId, n, pa, lim, target, effects: { stat: valeur }, range?: { stat: [min, max] },
//     critEffects?, duration, delay, selfToo, zone?, per?, condition?, drawback?, then?, note, txt,
//     source: 'auto' | 'main' }
//   target   : 'self' (le lanceur seulement), 'ally' (un allié ciblé), 'allies' (les alliés d'une zone),
//              'enemy' (l'ennemi ciblé), 'enemies' (les ennemis d'une zone)
//   duration : en tours du lanceur (voir « Durée et initiative ») ; -1 = jusqu'à la fin du combat.
//              Les effets de durée 0 (Bond, Massacre, Brassage…) sont dans les ignorés, avec le buff
//              proposé dans ignored[].candidate (uncertain: true) : leur durée réelle est inconnue
//   critEffects : valeurs sur un coup critique, quand elles diffèrent
//   selfToo  : le lanceur peut aussi en profiter (cible lui-même, ou dans sa propre zone)
//   per      : 'pm' = valeur par PM utilisé par la cible (Agitation…), 'entity' = par entité touchée
//   condition: condition de jeu à remplir (posture du lanceur, placement…), affichée au joueur
//   drawback : malus sur des alliés qui va avec un buff du même sort (Odorat : -3 PA tout de suite)
//   then     : contrepartie plus tard, { effects, delay, duration } (PA retirés après Précipitation…)
//   valeur   : moyenne du jet (min + max) / 2, range donne le jet quand il varie
//
// ---------------------------------------------------------------------------------------------------
// Masque de cibles (tm, « targetMask »). Établi en lisant la fonction du client Dofus 2 qui le vérifie
// (DamageUtil.verifySpellEffectMask, client décompilé, ex. github.com/Romain-P/d2gen), puis vérifié
// sur des sorts dont la description dit qui est touché (voir plus bas). Dofus 3 garde le même format.
//   Lettres de type : la cible est touchée si l'UNE d'elles lui correspond.
//     a  alliés (le lanceur compris s'il est dans la zone, invocations comprises)   A  ennemis
//     g  alliés sauf le lanceur : la présence de g exclut toujours le lanceur
//     c  le lanceur s'il est dans la zone       C  le lanceur, où qu'il soit
//     h / H  personnages joueurs alliés / ennemis        l / L  personnages et compagnons (pas les invocations)
//     d / D  compagnons     i / I  invocations qui jouent     s / S  invocations statiques
//     j / J  toutes les invocations    m / M  monstres (hors invocations qui jouent)
//   Filtres (ET) ; préfixés de « * », ils portent sur le lanceur et non sur la cible :
//     eN / EN  n'a pas / a l'état N     fN / FN  n'est pas / est le monstre N (plusieurs F = l'un d'eux)
//     P  invocation du lanceur ; mais « h,P » dans un sort d'invocation = l'invocateur (Pelle de Fortune,
//        Griffe Invocatrice, Ébriété : « augmente la Puissance du lanceur / de son invocateur »)
//     o / O  lanceur du sort déclencheur    vN / VN  PV > / ≤ N %
//     r / R  sans / avec portail ; b B z Z K p T W U : conditions vérifiées par le serveur seulement
//   Vérifications : Épée de Iop « N'affecte pas le lanceur » = A,g ; Vitalité « plus importante sur le
//   lanceur » = c (20 %) et g,A (10 %) ; Précipitation « l'état n'est pas appliqué sur le lanceur » = g ;
//   Épée Divine « le lanceur et les alliés en zone » = C,a ; Ferveur « le lanceur et ses alliés » = C,a ;
//   Vacarme : soin des Feux Follets du lanceur = a,P,F7376…F7379.
// Zones (z = [forme, taille]) : code ASCII de la forme. P (80) une case, C (67) cercle, X (88) croix,
// L (76) ligne, T (84) ligne perpendiculaire, Q (81) / G (71) carré, a (97) et A (65) toute la carte.
//
// ---------------------------------------------------------------------------------------------------
// Durée et initiative. Source : devblog Ankama de la mise à jour 2.4 (septembre 2011), relayé par
// JeuxOnLine (dofus.jeuxonline.info/actualite/32815) : « les effets de sort se termineront au début
// du tour du lanceur du sort » ; un sort lancé sur un allié « durera un tour complet », quelle que
// soit la place de l'allié dans la timeline. Pas de changement annoncé depuis (Dofus 3 reprend le
// serveur et les règles de Dofus 2), mais non revérifié en jeu sur la 3.7.
// Donc : la durée d'un effet diminue d'un au DÉBUT de chaque tour du lanceur ; l'effet disparaît quand
// elle atteint 0. Un effet de durée d lancé au tour T du lanceur est actif jusqu'au début du tour
// T + d du lanceur :
//   - le lanceur en profite pour la fin du tour T (sorts lancés après le buff) puis aux tours
//     T + 1 … T + d − 1 ;
//   - un allié qui joue APRÈS le lanceur en profite à ses tours T … T + d − 1 ;
//   - un allié qui joue AVANT le lanceur en profite à ses tours T + 1 … T + d.
// Chacun a donc d tours, mais décalés d'un tour pour qui joue avant. Un malus sur un ennemi se lit
// pareil, du point de vue de l'allié qui frappe l'ennemi.
// Effet à retardement (delay k, « dans k tours ») : hypothèse, il s'active au début du tour T + k du
// lanceur (le retardement se décompte comme la durée) puis dure d tours de plus.
// Durée 0 : sens inconnu pour un effet qui reste posé. Les « dommages subis » de Bond, Massacre,
// Brassage, Tir Perçant… sont déclenchés (D) avec une durée 0, comme le « dommages subis x85 % » de
// l'état Saoul du Pandawa, qui dure pourtant tant que l'état dure : ce n'est donc pas « fin du tour du
// lanceur » à coup sûr. activeTurns les traite quand même ainsi (seul le lanceur en profite), le choix
// le plus prudent, mais classBuffs les laisse dans les ignorés.
// Durée -1 : jusqu'à la fin du combat.

import { classSpells } from './damage.js';

// Stats qui augmentent les dégâts quand un allié les reçoit
const ALLY_STATS = new Set([
  'pa', 'pm', 'po', 'puissance', 'do', 'doFeu', 'doEau', 'doTerre', 'doAir', 'doNeutre',
  'force', 'intel', 'chance', 'agi', 'crit', 'doCrit', 'doPou',
  'pctSorts', 'pctDist', 'pctMelee', 'pctArmes', 'pctFinaux',
]);
// Stats qui augmentent les dégâts de l'équipe quand un ennemi les PERD
const ENEMY_STATS = new Set([
  'resFeu', 'resEau', 'resTerre', 'resAir', 'resNeutre', 'rfFeu', 'rfEau', 'rfTerre', 'rfAir', 'rfNeutre',
  'resCrit', 'resPou', 'resDist', 'resMelee', 'resSorts', 'resArmes',
]);
// Vols : la cible perd, le lanceur gagne
const STEAL = { 266: 'chance', 268: 'agi', 269: 'intel', 271: 'force', 77: 'pm', 84: 'pa', 320: 'po' };
const VULNERABILITY = 1163; // « Dommages subis x N % »
const BASE_DAMAGE = 293; // « Sort : +N dégâts de base » (bonus d'un sort du lanceur)
const STATE = 950;
// Sorts lancés par un sort (sous-sorts) : absents de game.json
const SUB_SPELL = new Set([1160, 792, 2160, 2794, 2795, 2960, 1017, 1019]);

const ALLY_LETTERS = /^[aghl]$/;
const ENEMY_LETTERS = /^[AHLM]$/;
const ZONE_ALL = new Set([65, 97]);
const SINGLE = 80;

// Lit un masque de cibles « a,A,*e4189 » ; voir l'en-tête pour le sens des lettres
export function parseTargetMask(tm = '') {
  const parts = tm.split(',').map(p => p.trim()).filter(Boolean);
  const m = { types: new Set(), stateNeed: [], stateForbid: [], casterNeed: [], casterForbid: [], monsters: [], notMonsters: [], ownSummon: false, other: [] };
  for (const p of parts) {
    const caster = p[0] === '*';
    const body = caster ? p.slice(1) : p;
    const letter = body[0], param = body.slice(1);
    if (!param && /^[aAgcChHlLdDiIsSjJmM]$/.test(letter) && !caster) m.types.add(letter);
    else if (letter === 'e') (caster ? m.casterForbid : m.stateForbid).push(+param);
    else if (letter === 'E') (caster ? m.casterNeed : m.stateNeed).push(+param);
    else if (letter === 'F') m.monsters.push(+param);
    else if (letter === 'f') m.notMonsters.push(+param);
    else if (letter === 'P') m.ownSummon = true;
    else m.other.push(p);
  }
  const t = m.types;
  m.allies = [...t].some(l => ALLY_LETTERS.test(l));
  m.enemies = [...t].some(l => ENEMY_LETTERS.test(l));
  m.caster = t.has('C') ? 'always' : t.has('g') ? 'never' : (t.has('a') || t.has('c')) ? 'inZone' : 'never';
  // « h,P » sans filtre de monstre, dans un sort d'invocation = l'invocateur (voir l'en-tête)
  m.summoner = m.ownSummon && t.has('h') && t.size === 1 && !m.monsters.length && !m.notMonsters.length;
  m.summonsOnly = !m.summoner && (m.ownSummon || m.monsters.length > 0 || ([...t].every(l => /^[iIsSjJdD]$/.test(l)) && t.size > 0));
  return m;
}

// Postures choisies par le joueur : une condition sur ces états du lanceur n'est pas ignorée, elle
// est recopiée dans buff.condition (Pandawa Saoul / Sobre, changés par Bombance et Picole)
const CASTER_MODES = { 498: 'lanceur Saoul', 3531: 'lanceur Sobre' };

// Conditions qui rendent un effet incertain : états à avoir, sur la cible ou le lanceur, PV…
// Renvoie { why: raison d'ignorer, mode: posture du lanceur }
function conditionOf(m, f) {
  const out = [];
  const modes = m.casterNeed.filter(id => CASTER_MODES[id]);
  const need = m.casterNeed.filter(id => !CASTER_MODES[id]);
  if (m.stateNeed.length) out.push(`cible dans l'état ${m.stateNeed.join(' ou ')}`);
  if (need.length) out.push(`lanceur dans l'état ${need.join(' ou ')}`);
  if (m.casterForbid.length) out.push(`lanceur hors de l'état ${m.casterForbid.join(', ')}`);
  if (m.other.length) out.push(`condition ${m.other.join(',')}`);
  // « Dommages subis » déclenché sur dommages (D) : c'est la vulnérabilité elle-même, pas une condition
  if (f.tr && !(f.e === VULNERABILITY && f.tr.split('|').every(t => /^X?D$/.test(t)))) out.push(`déclenché (${f.tr})`);
  return { why: out.join(' ; '), mode: modes.map(id => CASTER_MODES[id]).join(', ') };
}

// Effet → [côté, stat, valeur min, valeur max] ou null s'il ne change pas les dégâts de l'équipe
function statOfFx(f) {
  if (STEAL[f.e]) return ['self', STEAL[f.e], f.min, f.max];
  if (f.e === VULNERABILITY) return f.min > 100 ? ['enemy', 'pctSubis', f.min - 100, f.max - 100] : null;
  if (!f.k) return null;
  if (f.sign > 0 && ALLY_STATS.has(f.k)) return ['ally', f.k, f.min, f.max];
  if (f.sign < 0 && ENEMY_STATS.has(f.k)) return ['enemy', f.k, -f.max, -f.min];
  // malus sur un allié : gardé comme contrepartie d'un buff du même sort (Flou Temporel, Odorat…)
  if (f.sign < 0 && ALLY_STATS.has(f.k)) return ['allyMalus', f.k, -f.max, -f.min];
  return null;
}

const describe = f => f.txt || `effet ${f.e}`;
const OFFENSIVE_TEXT = /(augmente|vole).{0,60}(puissance|dommages|PA\b|critique|caractéristiques|force|intelligence|chance|agilité)|dommages subis|résistances?\b.{0,20}(retire|réduit)|(retire|réduit).{0,40}résistance/i;
const avg = st => (st[2] + st[3]) / 2;

// Effets d'un grade de sort lus automatiquement : { buffs, ignored, spellBonuses, opaque }
function readSpell(sp) {
  const buffs = [], ignored = [], spellBonuses = [];
  let opaque = 0;
  const groups = new Map();
  const crits = (sp.fx || []).filter(f => f.crit);
  const skip = (f, reason, candidate) => ignored.push({ spellId: sp.id, n: sp.n, effect: describe(f), reason, ...(candidate && { candidate }) });
  for (const f of sp.fx || []) {
    if (f.crit) continue; // jet critique : lu avec l'effet normal correspondant
    if (SUB_SPELL.has(f.e) || f.e === STATE) { opaque++; continue; }
    if (f.e === BASE_DAMAGE) { // bonus d'un sort du lanceur : pour sa rotation, pas pour l'équipe
      spellBonuses.push({ spellId: sp.id, n: sp.n, bonusSpell: f.min, v: f.v, duration: f.d, delay: f.delay || 0, txt: describe(f) });
      continue;
    }
    const st = statOfFx(f);
    if (!st) continue;
    const [side, stat, min, max] = st;
    const m = parseTargetMask(f.tm);
    // un malus d'allié écarté n'est pas montré au joueur (ce n'est pas un buff manqué)
    const drop = (reason) => { if (side !== 'allyMalus') skip(f, reason); };
    if (m.summonsOnly) { drop('sur les invocations seulement'); continue; }
    let target;
    const single = !f.z || (f.z[0] === SINGLE && f.z[1] <= 1);
    if (side === 'self' || m.summoner) target = 'self';
    else if (side === 'enemy') {
      if (!m.enemies) continue;
      target = single ? 'enemy' : 'enemies';
    } else if (side === 'allyMalus' && !m.allies && m.caster === 'never') continue; // malus d'ennemi (retrait de PA…)
    else if (m.allies) target = single ? 'ally' : 'allies';
    else if (m.caster !== 'never') target = 'self';
    else continue; // bonus donné aux ennemis seulement (Boîte de Pandore…)
    if (f.z && ZONE_ALL.has(f.z[0]) && target !== 'self') {
      drop('zone « toute la carte » : effet probablement réservé par le script du sort à certains cas (voir la description)');
      continue;
    }
    const { why, mode } = conditionOf(m, f);
    if (why) { drop(`conditionnel : ${why}`); continue; }
    // le lanceur profite-t-il d'un buff d'allié ? toujours avec C, jamais avec g, sinon s'il peut
    // être dans la zone (portée minimale 0, ou zone autour de la case visée)
    const selfToo = target === 'self' || (side !== 'enemy' && (m.caster === 'always'
      || (m.caster === 'inZone' && ((sp.po?.[0] ?? 1) === 0 || !single))));
    const key = [target, selfToo, f.d, f.delay || 0, m.stateForbid.join('|'), mode].join('/');
    let b = groups.get(key);
    if (!b) {
      b = {
        spellId: sp.id, n: sp.n, pa: sp.pa, lim: sp.lim, target, effects: {}, duration: f.d, delay: f.delay || 0,
        selfToo, source: 'auto', note: '', txt: [], seen: {},
      };
      if (!single) b.zone = f.z;
      if (mode) b.condition = mode;
      if (m.summoner) b.condition = 'donné au lanceur par l\'invocation du sort (voir la description)';
      if (m.stateForbid.length) b.note = `Pas sur une cible déjà dans l'état ${m.stateForbid.join(', ')} (non cumulable).`;
      if (side === 'self' && STEAL[f.e]) b.note = 'Vol : la cible ennemie perd autant.';
      groups.set(key, b);
    }
    // le même effet plusieurs fois sur les mêmes cibles = valeurs au choix du script du sort
    // (Pacte Bestial : 3, 6 ou 9 % selon l'invocation sacrifiée), pas un cumul
    ((b.seen[stat] ??= {})[f.e] ??= []).push(describe(f));
    b.effects[stat] = (b.effects[stat] || 0) + (min + max) / 2;
    b.txt.push(describe(f));
    if (max > min) (b.range ??= {})[stat] = [min, max];
    // jet critique : le même effet (id, cibles, durée) dans la liste critique
    const c = crits.find(x => x.e === f.e && x.tm === f.tm && x.d === f.d && (x.delay || 0) === (f.delay || 0));
    const cst = c && statOfFx(c);
    (b.crit ??= {})[stat] = (b.crit[stat] || 0) + (cst ? avg(cst) : (min + max) / 2);
  }
  // un malus d'allié n'est gardé que si le sort donne aussi un buff à des alliés (pas seulement au lanceur)
  const allyBuff = [...groups.values()].some(b => (b.target === 'ally' || b.target === 'allies') && Object.values(b.effects).some(v => v > 0));
  for (const b of groups.values()) {
    for (const [stat, byEffect] of Object.entries(b.seen)) {
      const list = Object.values(byEffect).find(l => l.length > 1);
      if (!list) continue;
      ignored.push({ spellId: sp.id, n: sp.n, effect: list.join(' / '), reason: 'plusieurs valeurs pour le même effet : choisie par le script du sort selon la situation (voir la description), non comptée' });
      delete b.effects[stat]; delete b.crit[stat];
      if (b.range) delete b.range[stat];
    }
    delete b.seen;
    if (!Object.keys(b.effects).length) continue;
    if (Object.entries(b.crit).some(([k, v]) => v !== b.effects[k])) b.critEffects = b.crit;
    delete b.crit;
    b.txt = b.txt.join(', ');
    // groupe fait seulement de malus sur des alliés : contrepartie d'un buff du sort, sinon sans intérêt
    if (b.target !== 'enemy' && b.target !== 'enemies' && Object.values(b.effects).every(v => v < 0)) {
      if (!allyBuff || b.target === 'self') continue;
      b.drawback = true;
      b.note = [b.note, 'Contrepartie du sort, pas un buff.'].filter(Boolean).join(' ');
    }
    // durée 0 sur un effet déclenché : on ne sait pas combien de temps il reste posé (voir l'en-tête)
    if (b.duration === 0) {
      ignored.push({
        spellId: sp.id, n: sp.n, effect: b.txt, candidate: { ...b, uncertain: true },
        reason: 'durée 0 dans les données : durée réelle inconnue (fin du tour du lanceur, ou tant qu\'un état dure). Gardé en « candidate », non compté.',
      });
    } else buffs.push(b);
  }
  return { buffs, ignored, spellBonuses, opaque };
}

// ---------------------------------------------------------------------------------------------------
// Codé à la main, depuis les descriptions officielles et les sous-sorts lus sur DofusDB (absents de
// game.json). Chaque entrée reçoit le sort au grade du perso et renvoie :
//   { buffs?: [buffs, sans les champs communs], ignored?: [{ effect, reason }], replaceAuto?: true }
// replaceAuto : les buffs lus automatiquement pour ce sort sont faux ou incomplets, on les remplace.
const fxOf = (sp, e, tm) => (sp.fx || []).find(f => !f.crit && f.e === e && (tm === undefined || f.tm === tm));
const val = f => f ? (f.min + f.max) / 2 : 0;

export const HAND = {
  // --- Iop ---
  13143: sp => ({ // Agitation : +PM et +Puissance pour chaque PM utilisé (déclencheur CCMPARR)
    replaceAuto: true,
    buffs: [
      { target: 'ally', selfToo: true, effects: { pm: val(fxOf(sp, 128)) }, duration: 1 },
      { target: 'ally', selfToo: true, effects: { puissance: val(fxOf(sp, 138)) }, per: 'pm', duration: 1,
        note: 'Puissance par PM utilisé par la cible pendant son tour (« pour chaque PM utilisé »). Rend aussi Intaclable.' },
    ],
  }),
  13114: sp => ({ // Précipitation : +PA ce tour, PA retirés au tour suivant
    replaceAuto: true,
    buffs: [{
      target: 'ally', selfToo: true, effects: { pa: val(fxOf(sp, 111)) }, duration: 1,
      note: `La cible ne peut plus utiliser son arme (état Précipité, pas sur le lanceur). Au tour suivant elle perd ${val(fxOf(sp, 168))} PA non esquivables.`,
      then: { effects: { pa: -val(fxOf(sp, 168)) }, delay: 1, duration: 1 },
    }],
  }),
  // --- Eniripsa ---
  25856: () => ({ // Vacarme : les +25 % finaux ne vont qu'aux Feux Follets du lanceur
    replaceAuto: true,
    ignored: [{ effect: '25% Dommages finaux', reason: 'pour les Feux Follets du lanceur seulement (description du sort), pas pour les alliés' }],
  }),
  25802: () => ({ // Mot Alchimique : caracs données par la fiole, conditionnelles
    replaceAuto: true,
    ignored: [{
      effect: '+100 / +150 dans une caractéristique, 3 tours',
      reason: 'passe par la Fiole : un allié doit l\'attaquer après qu\'elle a été remplie par l\'Alchi-Rhétorique, et la valeur dépend d\'un état (100 ou 150). Qui reçoit le bonus (l\'attaquant ou le lanceur) n\'est pas clair dans les sous-sorts : non compté.',
    }],
  }),
  // --- Enutrof ---
  13342: sp => ({ // Ruée vers l'Or : +PM tout de suite, Puissance au tour suivant sous condition
    replaceAuto: true,
    buffs: [
      { target: 'ally', selfToo: true, effects: { pm: val(fxOf(sp, 128)) }, duration: 1 },
      { target: 'ally', selfToo: true, effects: { puissance: val(fxOf(sp, 138)) }, delay: 1, duration: 1,
        condition: 'la cible termine son tour au contact d\'un ennemi',
        note: 'Puissance au tour suivant seulement si la cible a fini son tour au contact d\'un ennemi (description du sort).' },
    ],
  }),
  13357: sp => ({ // Boîte à Outils : PA et PM, mais la cible devient Pacifiste
    replaceAuto: true,
    ignored: [{
      effect: `+${val(fxOf(sp, 111))} PA, +${val(fxOf(sp, 128))} PM`,
      reason: 'la cible devient Pacifiste (description du sort), ses invocations aussi : bonus de déplacement, pas de dégâts',
    }],
  }),
  13369: sp => ({ // Décadence : +% finaux tout de suite, autant en moins au tour suivant
    replaceAuto: true,
    buffs: [{
      target: 'ally', selfToo: true, effects: { pctFinaux: val(fxOf(sp, 1171)) }, duration: 1,
      note: `Au tour suivant la cible a ${val(fxOf(sp, 1172))} % de dommages finaux en moins.`,
      then: { effects: { pctFinaux: -val(fxOf(sp, 1172)) }, delay: 1, duration: 1 },
    }],
  }),
  13362: sp => ({ // Avarice : +PA aux entités autour du lanceur (alliés ET ennemis), Puissance au lanceur
    replaceAuto: true,
    buffs: [
      { target: 'allies', zone: fxOf(sp, 111)?.z, selfToo: false, effects: { pa: val(fxOf(sp, 111)) }, duration: 1,
        note: `Zone autour du lanceur, lanceur exclu ; les ennemis de la zone gagnent aussi les PA. Retire ${val(fxOf(sp, 169))} PM non esquivables aux mêmes cibles.` },
      { target: 'self', selfToo: true, effects: { puissance: val(fxOf(sp, 138, 'C')) }, per: 'entity', duration: 2,
        note: 'Puissance par entité touchée hors de la zone (cumulable 10 fois, description du sort).' },
    ],
  }),
  14274: sp => ({ // Tunnel de Fortune : Puissance au tour suivant par PM utilisé
    replaceAuto: true,
    buffs: [{
      target: 'self', selfToo: true, effects: { puissance: val(fxOf(sp, 138)) }, per: 'pm', delay: 1, duration: 1,
      note: 'Puissance au tour suivant pour chaque PM utilisé ce tour (description du sort). Rend invisible.',
    }],
  }),
};

// Notes ajoutées à des buffs lus automatiquement (sans les remplacer)
const NOTES = {
  25742: 'Encouragement : le cumul est partagé avec les autres Encouragements (Mot Vivifiant, Mot Galvanisant…).',
  25744: 'Encouragement : le cumul est partagé avec les autres Encouragements.',
  25745: 'Encouragement : le cumul est partagé avec les autres Encouragements. Donne aussi un bouclier.',
  12826: 'Seulement quand le Pandawa porte son Tonneau (description du sort).',
  32475: 'Le Crâ perd 2 % de dommages distance et 1 de Portée par PM utilisé pendant la durée.',
};

// Catalogue d'une classe au niveau donné : { buffs, ignored, spellBonuses }
//   spellBonuses : « +N dégâts de base » d'un sort du lanceur sur lui-même (Colère de Iop, Mot Secret…),
//   utiles à la rotation du lanceur mais pas à l'équipe
export function classBuffs(game, breedId, level = 200) {
  const buffs = [], ignored = [], spellBonuses = [];
  for (const sp of classSpells(game, breedId, level)) {
    const auto = readSpell(sp);
    const hand = HAND[sp.id]?.(sp);
    const common = { spellId: sp.id, n: sp.n, pa: sp.pa, lim: sp.lim };
    if (!hand?.replaceAuto) buffs.push(...auto.buffs);
    for (const b of hand?.buffs || []) buffs.push({ ...common, delay: 0, note: '', ...b, source: 'main' });
    spellBonuses.push(...auto.spellBonuses);
    // un sort codé à la main a été relu : ses ignorés automatiques sont remplacés par les siens
    if (!hand) ignored.push(...auto.ignored);
    for (const i of hand?.ignored || []) ignored.push({ spellId: sp.id, n: sp.n, ...i });
    if (NOTES[sp.id]) for (const b of buffs) if (b.spellId === sp.id) b.note = [b.note, NOTES[sp.id]].filter(Boolean).join(' ');
    // états et sous-sorts non lus, sur un sort dont la description parle d'un bonus offensif
    const found = [...buffs, ...ignored, ...spellBonuses].some(b => b.spellId === sp.id);
    if (auto.opaque && !found && OFFENSIVE_TEXT.test(sp.d || '')) {
      ignored.push({
        spellId: sp.id, n: sp.n, effect: (sp.d || '').split('\n')[0],
        reason: 'passe par un état ou un sous-sort dont les effets ne sont pas dans les données : non compté',
      });
    }
  }
  return { buffs, ignored, spellBonuses };
}

// ---------------------------------------------------------------------------------------------------
// Tours de la cible où un buff s'applique. Ordre de jeu = ordre d'initiative : casterIndex et
// targetIndex sont les places dans la timeline (0 = joue en premier). castTurn = tour où le lanceur
// lance le sort (1 par défaut). Renvoie les numéros de tour (1 … nTurns) de la cible. Pour un malus
// sur un ennemi, targetIndex est la place de l'allié qui frappe. Voir « Durée et initiative ».
// Le lanceur lui-même (targetIndex = casterIndex) a le tour du lancer compté, pour ses sorts suivants.
export function activeTurns(buff, casterIndex, targetIndex, nTurns, castTurn = 1) {
  const d = buff.duration, k = buff.delay || 0;
  const self = casterIndex === targetIndex;
  if (d === 0) return self && castTurn + k <= nTurns ? [castTurn + k] : [];
  const out = [];
  // début : au lancer (k = 0) ou au début du tour castTurn + k du lanceur ; fin : début du tour
  // castTurn + k + d du lanceur (jamais avec d = -1)
  const start = castTurn + k;
  const end = d < 0 ? Infinity : start + d;
  for (let r = castTurn; r <= nTurns; r++) {
    // la cible joue au tour r avant (before) ou après le lanceur
    const before = targetIndex < casterIndex;
    const afterStart = self ? r >= start : before ? r > start : r >= start;
    const beforeEnd = self ? r < end : before ? r <= end : r < end;
    if (afterStart && beforeEnd) out.push(r);
  }
  return out;
}

// Même chose, pour la contrepartie d'un buff (then : PA retirés au tour suivant de Précipitation)
export function thenTurns(buff, casterIndex, targetIndex, nTurns, castTurn = 1) {
  return buff.then ? activeTurns(buff.then, casterIndex, targetIndex, nTurns, castTurn) : [];
}
