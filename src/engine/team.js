// Équipe : à partir de stuffs générés, qui doit buffer qui (et quand) pour maximiser les dégâts de
// toute l'équipe sur un cycle de tours.
//
// Modèle :
//   - ordre de jeu = ordre d'initiative (index 0 joue en premier) ; la durée d'un buff se décompte au
//     début du tour du lanceur (activeTurns dans buffs.js) : un allié qui joue avant le lanceur en
//     profite un tour plus tard ;
//   - dégâts d'un membre à un tour = turnDamage (rotation.js) avec ses stats + les buffs actifs, et
//     ses PA du tour moins ceux dépensés en buffs : buffer coûte les dégâts que le lanceur aurait faits ;
//   - un lancer de sort applique toutes ses lignes de buff (Agitation : PM + Puissance par PM utilisé ;
//     Avarice : PA aux alliés de la zone + Puissance au lanceur) ;
//   - « alliés (zone) » touche toute l'équipe et un malus sur l'ennemi profite à tous : on suppose
//     l'équipe groupée et une seule cible ;
//   - limites : lancers par tour et par cible, relance, relance initiale ; PA du tour ; cumul (st) :
//     avec st = 1, relancer le sort sur une cible qui l'a encore rafraîchit le buff sans l'ajouter ;
//   - horizon : un lancer dont la contrepartie tomberait après le dernier tour est interdit
//     (Précipitation au dernier tour ne paierait jamais ses -3 PA) ;
//   - recherche gloutonne : on ajoute le lancer qui rapporte le plus de dégâts d'équipe, tant que ça
//     rapporte. Ce n'est pas un optimum prouvé, mais chaque lancer retenu est rentable.
//   - buff « bu » par la cible (viaTarget, potion de la Fiole d'Eniripsa) : il commence au tour de la
//     cible, qui paie une attaque (son sort de dégâts le moins cher, targetPa) ; « carac » = la
//     caractéristique de son élément ;
// Hors modèle : buffs à condition (posture, placement), buffs avec un malus pour des alliés, effets de
// durée 0 (dans les ignorés du catalogue), cumul partagé des Encouragements d'Eniripsa, placement.
import { classSpells } from './damage.js';
import { turnDamage, equippedWeapon } from './rotation.js';
import { classBuffs, activeTurns, thenTurns } from './buffs.js';
import { CARACS, ELEMENT_STAT } from './rules.js';

const ENEMY = new Set(['enemy', 'enemies']);

// Initiative d'un perso : somme des caractéristiques + bonus d'initiative (PV pleins)
export const initiativeOf = stats => (stats.ini || 0) + CARACS.reduce((t, c) => t + (stats[c] || 0), 0);

// Membre prêt à simuler, à partir d'un résultat d'optimisation (une fiche sauvegardée)
function member(game, m) {
  const r = m.result;
  const { breedId, level } = r.config;
  const cat = classBuffs(game, breedId, level);
  const skipped = [];
  const usable = cat.buffs.filter(b => {
    const why = b.condition ? `condition : ${b.condition}` : b.drawback ? 'malus sur des alliés' : b.uncertain ? 'durée inconnue' : '';
    if (why) skipped.push({ n: b.n, why });
    return !why;
  });
  // un lancer = toutes les lignes de buff d'un même sort
  const casts = [];
  for (const b of usable) {
    let c = casts.find(x => x.spellId === b.spellId);
    if (!c) casts.push(c = { spellId: b.spellId, n: b.n, pa: b.pa, lim: b.lim || {}, lines: [] });
    c.lines.push(b);
  }
  const spells = classSpells(game, breedId, level);
  const weapon = equippedWeapon(game, r.items);
  const options = turnDamage(spells, r.stats, r.ctx, { weapon }).options;
  return {
    name: m.name, breedId, level, stats: r.stats, ctx: r.ctx, spells, weapon, casts, skipped, ignored: cat.ignored,
    mainStat: ELEMENT_STAT[r.ctx.elements[0]], cheapestPa: Math.min(...options.map(o => o.pa)),
  };
}

// Un lancer vise un allié quand l'une de ses lignes est « allié ciblé »
const needsTarget = c => c.lines.some(l => l.target === 'ally');

export function teamPlan(game, members, { turns = 4 } = {}) {
  const team = members.map(m => member(game, m));
  const N = team.length;
  const memo = new Map();

  // Dégâts d'un membre avec des bonus de stats, un malus ennemi et ses PA du tour
  const damage = (j, add, target, pa) => {
    const key = `${j}|${pa}|${JSON.stringify(add)}|${JSON.stringify(target)}`;
    if (!memo.has(key)) {
      const m = team[j];
      const stats = { ...m.stats };
      for (const [k, v] of Object.entries(add)) stats[k] = (stats[k] || 0) + v;
      memo.set(key, pa > 0 ? turnDamage(m.spells, stats, m.ctx, { pa, weapon: m.weapon, target }).average.dmg : 0);
    }
    return memo.get(key);
  };

  // Simulation d'un plan : actions = [{ caster, cast, target (index ou null), turn }]
  const simulate = actions => {
    const add = Array.from({ length: N }, () => Array.from({ length: turns + 1 }, () => ({})));
    const foe = Array.from({ length: N }, () => Array.from({ length: turns + 1 }, () => ({})));
    const spent = Array.from({ length: N }, () => new Array(turns + 1).fill(0));
    const put = (bag, k, v) => { bag[k] = (bag[k] || 0) + v; };
    const stacks = new Map(); // « cible|tour|sort|ligne » -> instances déjà comptées
    const room = (j, r, a, li) => {
      const key = `${j}|${r}|${a.cast.spellId}|${li}`;
      const n = stacks.get(key) || 0;
      const st = a.cast.lim.st;
      if (st > 0 && n >= st) return false;
      stacks.set(key, n + 1);
      return true;
    };
    for (const a of actions) {
      spent[a.caster][a.turn] += a.cast.pa;
      a.cast.lines.forEach((line, li) => {
        const who = ENEMY.has(line.target) || line.target === 'allies' ? team.map((_, j) => j)
          : line.target === 'self' ? [a.caster] : [a.target];
        for (const j of who) {
          const into = ENEMY.has(line.target) ? foe : add;
          const scale = line.per === 'pm' ? Math.max(0, team[j].stats.pm || 0) : 1;
          // bu par la cible : à son tour (le suivant si elle joue avant le lanceur), compté comme lancé par elle
          let on;
          if (line.viaTarget) {
            const t = j >= a.caster ? a.turn : a.turn + 1;
            if (t > turns) continue;
            if (line.targetPa === 'cheapest') spent[j][t] += team[j].cheapestPa;
            on = activeTurns(line, j, j, turns, t);
          } else on = activeTurns(line, a.caster, j, turns, a.turn);
          for (const r of on) {
            if (!room(j, r, a, li)) continue;
            for (const [k, v] of Object.entries(line.effects)) put(into[j][r], k === 'carac' ? team[j].mainStat : k, v * scale);
          }
          for (const r of thenTurns(line, a.caster, j, turns, a.turn)) for (const [k, v] of Object.entries(line.then.effects)) put(into[j][r], k, v);
        }
      });
    }
    let total = 0;
    const rows = team.map((m, j) => {
      const perTurn = [];
      for (let r = 1; r <= turns; r++) {
        const pa = (m.stats.pa || 0) + (add[j][r].pa || 0) - spent[j][r];
        const { pa: _pa, ...stats } = add[j][r];
        const target = {};
        for (const [k, v] of Object.entries(foe[j][r])) target[k] = v;
        const d = pa < 0 ? -Infinity : damage(j, stats, target, pa);
        perTurn.push(d);
        total += d;
      }
      return perTurn;
    });
    return { total, rows };
  };

  // Lancers possibles en respectant les limites, étant donné les actions déjà retenues
  const legal = (actions, a) => {
    const lim = a.cast.lim;
    const mine = actions.filter(x => x.caster === a.caster && x.cast.spellId === a.cast.spellId);
    if (lim.cd0 && a.turn <= lim.cd0) return false;
    if (lim.n && mine.filter(x => x.turn === a.turn).length >= lim.n) return false;
    if (lim.nt && a.target !== null && mine.filter(x => x.turn === a.turn && x.target === a.target).length >= lim.nt) return false;
    if (a.cast.lines.some(l => l.then && a.turn + (l.then.delay || 1) > turns)) return false;
    const cd = Math.max(lim.cd || 0, lim.gcd || 0);
    if (cd && mine.some(x => Math.abs(x.turn - a.turn) < cd)) return false;
    return true;
  };

  const base = simulate([]);
  let actions = [];
  let current = base;
  const gains = [];
  for (let step = 0; step < 60; step++) {
    let best = null;
    team.forEach((m, caster) => {
      for (const cast of m.casts) for (let turn = 1; turn <= turns; turn++) {
        const targets = needsTarget(cast) ? team.map((_, j) => j) : [null];
        for (const target of targets) {
          if (target === caster && !cast.lines.some(l => l.selfToo || l.target === 'self')) continue;
          const a = { caster, cast, target, turn };
          if (!legal(actions, a)) continue;
          const sim = simulate([...actions, a]);
          if (sim.total > current.total + 1e-6 && (!best || sim.total > best.sim.total)) best = { a, sim };
        }
      }
    });
    if (!best) break;
    gains.push(best.sim.total - current.total);
    actions = [...actions, best.a];
    current = best.sim;
  }

  const plan = actions.map((a, i) => ({
    turn: a.turn, caster: a.caster, target: a.target, spellId: a.cast.spellId, n: a.cast.n, pa: a.cast.pa, gain: gains[i],
    effects: a.cast.lines.map(l => ({ target: l.target, effects: l.effects, duration: l.duration, delay: l.delay, per: l.per })),
  })).sort((x, y) => x.turn - y.turn || x.caster - y.caster);
  return {
    turns,
    members: team.map((m, j) => ({
      name: m.name, breedId: m.breedId, level: m.level, initiative: initiativeOf(m.stats),
      base: base.rows[j], final: current.rows[j], skipped: m.skipped, ignored: m.ignored,
    })),
    base: base.total, total: current.total, plan,
  };
}
