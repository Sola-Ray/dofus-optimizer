// Dégâts par tour : la meilleure suite de sorts lançable avec ses PA, en respectant les limites de lancer.
// C'est un petit sac à dos : chaque sort coûte des PA, rapporte ses dégâts moyens (simulateSpell,
// critique compris) et a un nombre de lancers maximum sur le tour. Réutilisable avec des stats
// modifiées (stats du stuff + buffs d'alliés) : il suffit de passer d'autres stats.
//
// Hypothèses :
//   - Une seule cible par défaut (targets), sans résistances. Limite d'un sort sur le tour :
//     min(lancers par tour, lancers par cible × nombre de cibles), 0 = illimité. Chaque cible reçoit
//     ses propres lancers : les zones qui touchent plusieurs cibles à la fois ne sont pas comptées.
//   - Seuls comptent les sorts qui ont une ligne de dommages ou de vol de vie dans un élément joué
//     (ou « meilleur élément »), et seulement ces lignes. Les soins, buffs, glyphes, poisons et effets
//     déclenchés ne comptent pas. Les sorts de la classe ne se renforcent pas entre eux.
//   - Arme (option weapon = champ `w` de l'item) : toutes ses lignes de dommages comptent, quel que
//     soit l'élément ; % dommages armes à la place de % sorts ; critique = critique de l'arme + bonus
//     de coup critique (cb) sur chaque ligne ; limite = lancers par tour de l'arme.
//   - Relance (cd) : lancé au tour t, le sort revient au tour t + cd ; avec une relance, un seul lancer
//     par tour. La relance globale (gcd) compte comme une relance (un seul lanceur dans l'équipe).
//     Relance initiale (cd0) : premier lancer au tour cd0 + 1.
//   - Meilleur tour : tous les sorts sont disponibles (relances ignorées, un seul lancer pour les
//     sorts à relance).
//   - Tour moyen : combat de `turns` tours (5 par défaut, comme le combat moyen des passifs), en
//     partant du tour 1 avec les relances initiales ; planification exacte sur tout le combat (un sort
//     à relance n'est pas forcément lancé dès qu'il revient), moyenne des dégâts des tours.
//   - PA constants à chaque tour (stats.pa par défaut). Les passifs suivent ctx.scenario pour tous
//     les tours ; les PA gagnés par les passifs sont déjà comptés en % de dégâts (voir passives.js).
import { simulateSpell } from './damage.js';

const NO_TARGET = {};

// Dégâts moyens d'un lancer d'arme : toutes les lignes s'appliquent (pas « un seul élément »)
function weaponCast(w, stats, ctx, target) {
  const lines = w.lines.filter(l => l.k === 'dmg' || l.k === 'vol');
  if (!lines.length) return null;
  const spell = { cc: w.cc || 0, lines: [...lines, ...lines.map(l => ({ ...l, min: l.min + (w.cb || 0), max: l.max + (w.cb || 0), crit: true }))] };
  const res = simulateSpell(spell, { ...stats, pctSorts: stats.pctArmes || 0 }, ctx, target);
  const total = rows => rows.reduce((t, r) => t + (r.min + r.max) / 2, 0);
  return (1 - res.critChance) * total(res.rows.normal) + res.critChance * total(res.rows.crit);
}

// Sorts lançables et leurs limites. spells = classSpells(…) (déjà au bon grade).
export function turnOptions(spells, stats, ctx, { target = NO_TARGET, weapon = null, targets = 1 } = {}) {
  const played = l => (l.k === 'dmg' || l.k === 'vol') && (l.el === 'best' || ctx.elements.includes(l.el));
  const out = [];
  for (const sp of spells) {
    const lines = sp.lines.filter(played);
    if (!lines.length || !sp.pa) continue;
    const dmg = simulateSpell({ ...sp, lines }, stats, ctx, target).average;
    if (dmg <= 0) continue;
    const lim = sp.lim || {};
    const cd = Math.max(lim.cd || 0, lim.gcd || 0);
    out.push({ id: sp.id, n: sp.n, img: sp.img, pa: sp.pa, dmg, cap: castCap(lim.n, lim.nt, targets, cd), cd, cd0: lim.cd0 || 0 });
  }
  if (weapon?.pa) {
    const dmg = weaponCast(weapon, stats, ctx, target);
    if (dmg > 0) out.push({ id: 'arme', n: 'Arme', pa: weapon.pa, dmg, cap: castCap(weapon.n, 0, targets, 0), cd: 0, cd0: 0, weapon: true });
  }
  return out;
}

const castCap = (n, nt, targets, cd) => Math.min(n || Infinity, nt ? nt * targets : Infinity, cd > 0 ? 1 : Infinity);

// Sac à dos borné sur les PA : best[p] = meilleurs dégâts avec au plus p PA, et la suite de lancers
function knapsack(options, pa) {
  let best = Array.from({ length: pa + 1 }, () => ({ dmg: 0, casts: [] }));
  for (const o of options) {
    const next = best.map(b => ({ ...b }));
    const kMax = Math.min(o.cap, Math.floor(pa / o.pa));
    for (let p = 0; p <= pa; p++) {
      for (let k = 1; k <= kMax && k * o.pa <= p; k++) {
        const prev = best[p - k * o.pa];
        const dmg = prev.dmg + k * o.dmg;
        if (dmg > next[p].dmg + 1e-9) next[p] = { dmg, casts: [...prev.casts, { o, k }] };
      }
    }
    best = next;
  }
  return best;
}

// Suite de lancers lisible : sorts les plus forts d'abord
const sequence = casts => casts.map(({ o, k }) => ({ id: o.id, n: o.n, img: o.img, pa: o.pa, count: k, dmg: o.dmg * k, weapon: o.weapon || false }))
  .sort((a, b) => b.dmg / b.count - a.dmg / a.count);
const turnOf = casts => {
  const seq = sequence(casts);
  return { dmg: seq.reduce((t, c) => t + c.dmg, 0), pa: seq.reduce((t, c) => t + c.pa * c.count, 0), casts: seq };
};

// Dégâts par tour.
//   stats : stats du perso (stuff + buffs), ctx : { elements, attack, scenario, passives }
//   options : { pa = stats.pa, turns = 5, target = aucune résistance, weapon = item.w, targets = 1 }
// Renvoie { pa, best: tour, average: { dmg, turns: [tour…] }, options } avec
//   tour = { dmg, pa (PA dépensés), casts: [{ id, n, img, pa, count, dmg, weapon }] }
export function turnDamage(spells, stats, ctx, options = {}) {
  const pa = Math.max(0, Math.floor(options.pa ?? stats.pa ?? 0));
  const turns = Math.max(1, options.turns ?? 5);
  const opts = turnOptions(spells, stats, ctx, options);
  // Sorts sans relance : un sac à dos commun à tous les tours. Sorts à relance (ou à relance
  // initiale) : choisis tour par tour, avec leurs états de relance mémorisés.
  const cycled = opts.filter(o => o.cd > 1 || o.cd0 > 0);
  const free = knapsack(opts.filter(o => !cycled.includes(o)), pa);

  // Un tour : meilleure combinaison des sorts à relance disponibles, complétée par les sorts libres
  const turnChoices = available => {
    const list = [];
    const avail = cycled.filter((_, i) => available[i]);
    const walk = (j, cost, used) => {
      if (j === avail.length) {
        const rest = free[pa - cost];
        list.push({ used, dmg: rest.dmg + used.reduce((t, c) => t + c.k * c.o.dmg, 0), casts: [...rest.casts, ...used] });
        return;
      }
      const o = avail[j];
      for (let k = 0; k <= o.cap && cost + k * o.pa <= pa; k++) walk(j + 1, cost + k * o.pa, k ? [...used, { o, k }] : used);
    };
    walk(0, 0, []);
    return list;
  };

  const best = turnOf(turnChoices(cycled.map(() => true)).reduce((a, b) => (b.dmg > a.dmg ? b : a)).casts);

  // Combat de `turns` tours : wait[i] = tours avant que le sort à relance i revienne
  const memo = new Map();
  const plan = (t, wait) => {
    if (t === turns) return { dmg: 0, turns: [] };
    const key = t + ':' + wait.join(',');
    if (memo.has(key)) return memo.get(key);
    let top = null;
    for (const c of turnChoices(wait.map(w => w === 0))) {
      const after = cycled.map((o, i) => (c.used.some(u => u.o === o) ? Math.max(0, o.cd - 1) : Math.max(0, wait[i] - 1)));
      const rest = plan(t + 1, after);
      if (!top || c.dmg + rest.dmg > top.dmg + 1e-9) top = { dmg: c.dmg + rest.dmg, turns: [c.casts, ...rest.turns] };
    }
    memo.set(key, top);
    return top;
  };
  const fight = plan(0, cycled.map(o => o.cd0));
  const perTurn = fight.turns.map(turnOf);

  return { pa, best, average: { dmg: fight.dmg / turns, turns: perTurn }, options: opts };
}

// Arme portée dans un résultat du moteur (champ `w` de l'item dans game.json), ou null
export function equippedWeapon(game, items) {
  const it = items.find(i => i.s === 'arme');
  return (it && game.items.find(g => g.id === it.id)?.w) || null;
}
