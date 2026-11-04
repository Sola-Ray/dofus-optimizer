// Télécharge les données brutes depuis l'API DofusDB vers data/raw/.
// Usage : node scripts/fetch-data.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const API = 'https://api.dofusdb.fr';
const OUT = new URL('../data/raw/', import.meta.url);
const PAGE = 50; // plafond imposé par l'API
const PASSIVE_EFFECT = 1175; // effet « sort passif » des Dofus, prysmaradites et légendaires

// Types d'items équipables (voir /item-types)
const EQUIP_TYPES = [
  1, 9, 10, 11, 16, 17, // amulette, anneau, ceinture, bottes, chapeau, cape
  2, 3, 4, 5, 6, 7, 8, 19, 22, 271, // armes
  82, // bouclier
  18, 121, 331, 332, 333, // familier (12 = potions), montilier, montures
  23, 151, 217, // dofus, trophée, prysmaradite
];

async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function fetchAll(path, query = '') {
  const first = await getJson(`${API}/${path}?$limit=${PAGE}&$skip=0${query}`);
  const all = [...first.data];
  const skips = [];
  for (let s = PAGE; s < first.total; s += PAGE) skips.push(s);
  // quelques requêtes en parallèle, sans marteler l'API
  for (let i = 0; i < skips.length; i += 6) {
    const pages = await Promise.all(
      skips.slice(i, i + 6).map(s => getJson(`${API}/${path}?$limit=${PAGE}&$skip=${s}${query}`)),
    );
    for (const p of pages) all.push(...p.data);
  }
  process.stdout.write(`${path}: ${all.length}/${first.total}\n`);
  return all;
}

async function fetchByIds(path, ids) {
  const out = [];
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += PAGE) {
    const q = list.slice(i, i + PAGE).map(id => `&id[$in][]=${id}`).join('');
    out.push(...(await getJson(`${API}/${path}?$limit=${PAGE}${q}`)).data);
  }
  process.stdout.write(`${path} (par id): ${out.length}/${list.length}\n`);
  return out;
}

const save = (name, data) => writeFile(new URL(`${name}.json`, OUT), JSON.stringify(data));

await mkdir(OUT, { recursive: true });

const characteristics = await fetchAll('characteristics');
const effects = await fetchAll('effects');
const breeds = await fetchAll('breeds');
const variants = await fetchAll('spell-variants');
const itemQuery = EQUIP_TYPES.map(t => `&typeId[$in][]=${t}`).join('');
const items = await fetchAll('items', itemQuery);
const runes = await fetchAll('items', '&typeId=211'); // runes de transcendance
const sets = await fetchAll('item-sets', '&$select[]=id&$select[]=name&$select[]=effects&$select[]=bonusIsSecret');

// Sorts : ceux des classes (variantes) + ceux lancés par les items (passifs des Dofus, légendaires…)
const spellIds = new Set();
for (const v of variants) v.spellIds.forEach(id => spellIds.add(id));
for (const b of breeds) (b.breedSpellsId || []).forEach(id => spellIds.add(id));
for (const it of items) for (const e of it.possibleEffects || []) {
  if (e.spellId > 0) spellIds.add(e.spellId);
  if (e.effectId === PASSIVE_EFFECT) spellIds.add(e.diceNum); // le passif pointe son sort dans diceNum
}
const spells = await fetchByIds('spells', [...spellIds]);
const levelIds = spells.flatMap(s => s.spellLevels || []);
const spellLevels = await fetchByIds('spell-levels', levelIds);

// Sorts déclenchés depuis les niveaux de sorts d'items (passifs à plusieurs étages)
const nested = new Set();
for (const lvl of spellLevels) for (const e of [...(lvl.effects || []), ...(lvl.criticalEffect || [])])
  if (e.spellId > 0 && !spellIds.has(e.spellId)) nested.add(e.spellId);
const nestedSpells = nested.size ? await fetchByIds('spells', [...nested]) : [];
const nestedLevels = nestedSpells.length ? await fetchByIds('spell-levels', nestedSpells.flatMap(s => s.spellLevels || [])) : [];

await Promise.all([
  save('characteristics', characteristics),
  save('effects', effects),
  save('breeds', breeds),
  save('spell-variants', variants.map(({ spells: _s, ...v }) => v)),
  save('items', items),
  save('runes', runes),
  save('item-sets', sets),
  save('spells', [...spells, ...nestedSpells]),
  save('spell-levels', [...spellLevels, ...nestedLevels]),
]);
console.log('OK');
