// Catalogue des buffs d'équipe d'une classe : node test/run-buffs.mjs [classe] [niveau]
// (7 = Eniripsa, 8 = Iop, 3 = Enutrof, 12 = Pandawa…). Affiche les buffs, les ignorés et un exemple
// de tours actifs selon l'ordre de jeu.
import { readFileSync } from 'node:fs';
import { classBuffs, activeTurns } from '../src/engine/buffs.js';
import { STAT_LABEL } from '../src/engine/rules.js';

const game = JSON.parse(readFileSync(new URL('../public/game.json', import.meta.url), 'utf8'));
const breedId = Number(process.argv[2] || 7);
const level = Number(process.argv[3] || 200);
const breed = game.breeds.find(b => b.id === breedId);
if (!breed) throw new Error(`classe ${breedId} inconnue : ${game.breeds.map(b => `${b.id} ${b.n}`).join(', ')}`);

const label = k => STAT_LABEL[k] || (k === 'pctSubis' ? '% Dommages subis' : k);
const fmt = (effects, range) => Object.entries(effects)
  .map(([k, v]) => `${v > 0 ? '+' : ''}${v}${range?.[k] ? ` (${range[k][0]} à ${range[k][1]})` : ''} ${label(k)}`).join(', ');
const TARGET = { self: 'lanceur', ally: 'allié', allies: 'alliés (zone)', enemy: 'ennemi', enemies: 'ennemis (zone)' };
const dur = b => b.duration < 0 ? 'combat' : b.duration === 0 ? 'ce tour' : `${b.duration} t.`;
const limits = l => [l.n && `${l.n}/tour`, l.nt && `${l.nt}/cible`, l.cd && `relance ${l.cd}`, l.cd0 && `relance initiale ${l.cd0}`, l.gcd && `relance globale ${l.gcd}`].filter(Boolean).join(', ');

const { buffs, ignored, spellBonuses } = classBuffs(game, breedId, level);
console.log(`${breed.n} niveau ${level} : ${buffs.length} buffs, ${ignored.length} ignorés\n`);
for (const b of buffs) {
  console.log(`${b.n.padEnd(24)} ${String(b.pa).padStart(1)} PA  ${(TARGET[b.target] + (b.selfToo && b.target !== 'self' ? ' + lanceur' : '')).padEnd(26)} ${fmt(b.effects, b.range)}`
    + `  [${dur(b)}${b.delay ? `, dans ${b.delay} t.` : ''}${b.per ? (b.per === 'pm' ? ', par PM utilisé' : ', par entité touchée') : ''}]`
    + `${b.critEffects ? `  critique : ${fmt(b.critEffects)}` : ''}${limits(b.lim) ? `  (${limits(b.lim)})` : ''}`
    + `${b.source === 'main' ? '  [main]' : ''}${b.uncertain ? '  [incertain]' : ''}`);
  if (b.condition) console.log(`${' '.repeat(26)}si : ${b.condition}`);
  if (b.note) console.log(`${' '.repeat(26)}${b.note}`);
  if (b.then) console.log(`${' '.repeat(26)}puis : ${fmt(b.then.effects)} [${b.then.duration} t., dans ${b.then.delay} t.]`);
}
console.log('\nIgnorés :');
for (const i of ignored) console.log(`  ${i.n} : ${i.effect} → ${i.reason}`);
if (spellBonuses.length) console.log(`\nBonus de sorts du lanceur (rotation) : ${spellBonuses.map(s => s.txt).join(' ; ')}`);

// Exemple : lanceur 2e de la timeline, allié 1er (joue avant) et 3e (joue après), sur 4 tours
const ex = buffs.find(b => b.duration > 0 && b.target !== 'self');
if (ex) {
  console.log(`\nTours actifs de « ${ex.n} » (durée ${ex.duration}, lancé au tour 1 par le 2e de la timeline) :`);
  console.log(`  allié qui joue avant : tours ${activeTurns(ex, 1, 0, 4).join(', ')}`);
  console.log(`  allié qui joue après : tours ${activeTurns(ex, 1, 2, 4).join(', ')}`);
  console.log(`  lanceur              : tours ${activeTurns(ex, 1, 1, 4).join(', ')}`);
}
