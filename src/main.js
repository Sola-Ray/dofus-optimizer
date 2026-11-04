import { DEFAULT_CONFIG, AUTO_ELEMENTS } from './engine/optimize.js';
import { DEFAULT_LEVELING, suggestTiers } from './engine/leveling.js';
import { teamPlan, initiativeOf } from './engine/team.js';
import { simulateSpell, classSpells, passivePoison } from './engine/damage.js';
import { turnDamage, equippedWeapon } from './engine/rotation.js';
import { PASSIVES } from './engine/passives.js';
import { evaluateStuff, placeItem, alternatives } from './engine/edit.js';
import { STAT_LABEL, ELEMENTS, STAT_CAP, totalStat } from './engine/rules.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = n => Math.round(n).toLocaleString('fr-FR');
const ITEM_IMG = id => `https://api.dofusdb.fr/img/items/${id}.png`;
const SPELL_IMG = id => `https://api.dofusdb.fr/img/spells/sort_${id}.png`;
const EL_LABEL = { feu: 'Feu', eau: 'Eau', terre: 'Terre', air: 'Air', neutre: 'Neutre' };
const SLOT_LABEL = {
  arme: 'Arme', bouclier: 'Bouclier', amulette: 'Amulette', anneau: 'Anneau', chapeau: 'Chapeau', cape: 'Cape',
  ceinture: 'Ceinture', bottes: 'Bottes', familier: 'Familier / monture', dofus: 'Dofus / trophée',
};
const SLOT_ORDER = Object.keys(SLOT_LABEL);
const MODE_LABEL = { crit: 'Stuff 100 % critique', noncrit: 'Stuff sans critique' };
// « crit70 » : au moins 70 % de critique du stuff (plancher intermédiaire du mode Auto)
const modeLabel = m => MODE_LABEL[m] || (/^crit\d+$/.test(m) ? `Stuff ≥ ${m.slice(4)} % critique` : m);

// Minimums proposés dans le formulaire (clé, libellé)
const MIN_FIELDS = [
  ['pa', 'PA'], ['pm', 'PM'], ['po', 'Portée'], ['vita', 'Vitalité'], ['resMoy', '% Rés. moyenne'],
  ['crit', '% Critique'], ['invo', 'Invocations'], ['tacle', 'Tacle'], ['fuite', 'Fuite'],
];
// Toutes les autres stats, en minimum facultatif. Initiative, tacle, fuite, prospection, esquives,
// retraits et pods comptent comme en jeu (avec les caractéristiques, voir DERIVED dans rules.js).
const MORE_MINS = [
  ['Caractéristiques', ['force', 'intel', 'chance', 'agi', 'sagesse', 'puissance']],
  ['Dommages', ['do', 'doFeu', 'doEau', 'doTerre', 'doAir', 'doNeutre', 'doCrit', 'doPou', 'pctSorts', 'pctDist', 'pctMelee', 'pctArmes', 'pctFinaux', 'soins']],
  ['Résistances', ['resFeu', 'resEau', 'resTerre', 'resAir', 'resNeutre', 'rfFeu', 'rfEau', 'rfTerre', 'rfAir', 'rfNeutre', 'resCrit', 'resPou', 'resDist', 'resMelee']],
  ['Divers', ['ini', 'pp', 'esqPA', 'esqPM', 'retPA', 'retPM', 'pods', 'renvoi']],
];
const minField = (k, l) => `<label class="field small">${l}<input type="number" min="0"${STAT_CAP[k] ? ` max="${STAT_CAP[k]}"` : ''} data-min="${k}" value="${config.min[k] ?? ''}" placeholder="—"></label>`;
function moreMins() {
  const n = MORE_MINS.flatMap(([, ks]) => ks).filter(k => config.min[k] !== undefined).length;
  return `<details class="more-mins"${n ? ' open' : ''}>
    <summary>Autres minimums <small>${n ? `${n} défini${n > 1 ? 's' : ''}` : 'toutes les stats'}</small></summary>
    ${MORE_MINS.map(([title, ks]) => `<h3>${title}</h3><div class="grid2">${ks.map(k => minField(k, STAT_LABEL[k])).join('')}</div>`).join('')}
  </details>`;
}

let game;
let lastResult = null;
let selectedSpell = null;
let selectedTier = 0;
// Résultat affiché : le stuff, ou celui du palier choisi en leveling
const shown = () => (lastResult?.tiers ? lastResult.tiers[selectedTier].result : lastResult);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// ---------- Configuration persistée ----------

const STORE = 'dofus-optimizer-config';
function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved) {
      const fm = Object.fromEntries(Object.keys(DEFAULT_CONFIG.fm).map(k => [k, saved.fm?.[k] ?? DEFAULT_CONFIG.fm[k]]));
      // anciennes versions : 0 voulait dire « interdit »
      if (!fm.pctExo) Object.assign(fm, { pctExo: 1, pctExoOn: false });
      if (!fm.overBudget) Object.assign(fm, { overBudget: 20, overOn: false });
      const elements = (saved.elements || DEFAULT_CONFIG.elements).filter(el => AUTO_ELEMENTS.includes(el));
      return { ...DEFAULT_CONFIG, mode: 'stuff', ...saved, elements, fm, leveling: { ...structuredClone(DEFAULT_LEVELING), ...saved.leveling } };
    }
  } catch { /* stockage indisponible */ }
  return { ...structuredClone(DEFAULT_CONFIG), mode: 'stuff', leveling: structuredClone(DEFAULT_LEVELING) };
}
function saveConfig() {
  try { localStorage.setItem(STORE, JSON.stringify(config)); } catch { /* ignoré */ }
}
let config = loadConfig();

const TARGET_STORE = 'dofus-optimizer-target';
let target = (() => {
  try { return JSON.parse(localStorage.getItem(TARGET_STORE)) || null; } catch { return null; }
})() || { pv: 10000, resFeu: 0, resEau: 0, resTerre: 0, resAir: 0, resNeutre: 0, rfFeu: 0, rfEau: 0, rfTerre: 0, rfAir: 0, rfNeutre: 0, resCrit: 0, pctSubis: 0 };

// ---------- Formulaire ----------

// Mode leveling : paliers (niveau, PA et PM minimums), seuil pour changer un item, parchemins
function levelingSection() {
  const L = config.leveling;
  const have = new Set(L.tiers.map(t => t.level));
  const els = config.autoElement ? AUTO_ELEMENTS : config.elements;
  const spells = els.length ? suggestTiers(game, config.breedId, els).filter(l => !have.has(l)) : [];
  const cell = (i, k, t, label) => `<td><input type="number" min="${k === 'level' ? 1 : 0}" max="${k === 'level' ? 200 : 20}" data-tier="${i}" data-tk="${k}" value="${t[k]}" aria-label="${label}"></td>`;
  return `<section>
    <h2>Paliers</h2>
    <p class="hint">Un stuff par palier. Les paliers sont optimisés ensemble pour garder des items de l'un à l'autre.</p>
    <table class="tiers"><thead><tr><th>Niveau</th><th>PA min</th><th>PM min</th><th></th></tr></thead><tbody>
      ${L.tiers.map((t, i) => `<tr>${cell(i, 'level', t, 'Niveau du palier')}${cell(i, 'pa', t, 'PA minimum')}${cell(i, 'pm', t, 'PM minimum')}<td><button type="button" class="del" data-untier="${i}" aria-label="Retirer le palier ${t.level}">×</button></td></tr>`).join('')}
    </tbody></table>
    <button type="button" class="ghost wide" id="addTier">Ajouter un palier</button>
    ${spells.length ? `<p class="hint">Sorts de l'élément obtenus aux niveaux (clic pour ajouter un palier) :</p>
    <div class="chips">${spells.map(l => `<button type="button" class="chip" data-addtier="${l}">${l}</button>`).join('')}</div>` : ''}
    <label class="field small">Changer un item seulement s'il rapporte au moins (% de dégâts)
      <input type="number" id="keepGain" min="0" max="50" step="0.5" value="${L.keepGain}">
    </label>
    <label class="field small">Parchemins par caractéristique
      <select id="lvScroll">${[0, 25, 50, 100].map(v => `<option value="${v}" ${v === L.scroll ? 'selected' : ''}>${v ? '+' + v : 'aucun'}</option>`).join('')}</select>
    </label>
    <label class="check"><input type="checkbox" id="lvFm" ${L.fm ? 'checked' : ''}>Forgemagie sur les stuffs de leveling</label>
  </section>`;
}

// Nouveau palier : PA / PM du palier de niveau inférieur le plus proche
function addTier(level) {
  const tiers = config.leveling.tiers;
  const below = [...tiers].filter(t => t.level <= level).sort((a, b) => b.level - a.level)[0] || tiers[0] || { pa: 8, pm: 4 };
  tiers.push({ level, pa: below.pa, pm: below.pm });
  tiers.sort((a, b) => a.level - b.level);
  saveConfig();
  renderConfig();
}

function renderConfig() {
  const breeds = [...game.breeds].sort((a, b) => a.n.localeCompare(b.n));
  const itemName = id => game.items.find(i => i.id === id)?.n || id;
  const lv = config.mode === 'leveling';
  $('#config').innerHTML = `
    <section>
      <fieldset class="seg"><legend>Mode</legend>
        <label title="Un stuff pour un niveau donné"><input type="radio" name="mode" value="stuff" ${lv ? '' : 'checked'}>Un stuff</label>
        <label title="Un stuff par palier de niveau, en gardant des items d'un palier à l'autre"><input type="radio" name="mode" value="leveling" ${lv ? 'checked' : ''}>Leveling</label>
      </fieldset>
      <h2>Personnage</h2>
      <label class="field">Classe
        <select id="breed">${breeds.map(b => `<option value="${b.id}" ${b.id === config.breedId ? 'selected' : ''}>${esc(b.n)}</option>`).join('')}</select>
      </label>
      ${lv ? '' : `<label class="field small">Niveau du personnage
        <input type="number" id="level" min="1" max="200" value="${config.level}">
      </label>`}
      <fieldset class="chips"><legend>Éléments joués</legend>
        ${AUTO_ELEMENTS.map(el => `<label class="chip el-${el}"><input type="checkbox" name="el" value="${el}" ${config.elements.includes(el) && !config.autoElement ? 'checked' : ''} ${config.autoElement ? 'disabled' : ''}>${EL_LABEL[el]}</label>`).join('')}
        <label class="chip" title="Calcule un stuff par élément et garde celui qui fait le plus de dégâts"><input type="checkbox" id="autoEl" ${config.autoElement ? 'checked' : ''}>Auto</label>
      </fieldset>
      <fieldset class="seg"><legend>Portée des attaques</legend>
        <label><input type="radio" name="attack" value="dist" ${config.attack === 'dist' ? 'checked' : ''}>Distance</label>
        <label><input type="radio" name="attack" value="melee" ${config.attack === 'melee' ? 'checked' : ''}>Mêlée</label>
      </fieldset>
      <fieldset class="seg seg3"><legend>Passifs comptés sur</legend>
        <label title="Moyenne sur un combat de 5 tours"><input type="radio" name="scenario" value="moyen" ${config.scenario === 'moyen' ? 'checked' : ''}>Combat moyen</label>
        <label title="Le premier tour du combat"><input type="radio" name="scenario" value="tour1" ${config.scenario === 'tour1' ? 'checked' : ''}>Tour 1</label>
        <label title="Le meilleur tour pour frapper"><input type="radio" name="scenario" value="burst" ${config.scenario === 'burst' ? 'checked' : ''}>Tour de burst</label>
      </fieldset>
      ${lv ? '' : `<fieldset class="seg seg3"><legend>Critique</legend>
        <label title="Compare 100 % critique, sans critique et deux compromis intermédiaires, garde le meilleur"><input type="radio" name="critMode" value="auto" ${config.critMode === 'auto' ? 'checked' : ''}>Auto</label>
        <label title="Vise 100 % critique sur tous les sorts de l'élément"><input type="radio" name="critMode" value="crit" ${config.critMode === 'crit' ? 'checked' : ''}>100 %</label>
        <label><input type="radio" name="critMode" value="noncrit" ${config.critMode === 'noncrit' ? 'checked' : ''}>Sans</label>
      </fieldset>
      <label class="check"><input type="checkbox" id="scroll" ${config.fullScroll ? 'checked' : ''}>Full parchemins (+100 partout)</label>`}
    </section>
    ${spellSection()}
    ${lv ? levelingSection() : `<section>
      <h2>Minimums à respecter</h2>
      <div class="grid2">
        ${MIN_FIELDS.map(([k, l]) => minField(k, l)).join('')}
      </div>
      ${moreMins()}
    </section>`}
    ${lv && !config.leveling.fm ? '' : `<section>
      <h2>Forgemagie</h2>
      <p class="hint">Une seule finition par item, comme en vrai. Le moteur choisit item par item la finition qui rapporte le plus parmi celles cochées, ou aucune.</p>
      <label class="check"><input type="checkbox" data-fm="transcendance" ${config.fm.transcendance ? 'checked' : ''}>Runes de transcendance</label>
      <div class="opt">
        <label class="check"><input type="checkbox" data-fm="pctExoOn" ${config.fm.pctExoOn ? 'checked' : ''}>Exo % dommages, jusqu'à</label>
        <select id="pctExo" aria-label="Exo % dommages maximum">${[1, 2, 3, 4].map(v => `<option value="${v}" ${v === config.fm.pctExo ? 'selected' : ''}>${v} %</option>`).join('')}</select>
      </div>
      <div class="opt">
        <label class="check"><input type="checkbox" data-fm="overOn" ${config.fm.overOn ? 'checked' : ''}>Over / exo de stat, jusqu'à</label>
        <select id="overBudget" aria-label="Poids maximum de l'over">${[10, 20, 30, 50].map(v => `<option value="${v}" ${v === config.fm.overBudget ? 'selected' : ''}>poids ${v}</option>`).join('')}</select>
      </div>
      <div class="chips">
        ${['PA', 'PM', 'PO'].map(k => `<label class="chip"><input type="checkbox" data-fm="exo${k}" ${config.fm['exo' + k] ? 'checked' : ''}>Exo ${k}</label>`).join('')}
      </div>
      <p class="hint">Un seul exo PA, PM et PO compte sur l'ensemble du stuff. Une transcendance verrouille l'item.</p>
      <label class="field">Qualité des jets des items
        <select id="rollQuality">${[[1, '100 %'], [0.95, '95 %'], [0.85, '85 %']].map(([v, l]) => `<option value="${v}" ${v === config.rollQuality ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
    </section>`}
    <section>
      <h2>Items</h2>
      ${lv ? '' : `<label class="field small">Niveau minimum des items<input type="number" id="minLevel" min="1" max="200" value="${config.minLevel}"></label>`}
      <label class="check"><input type="checkbox" id="gelano" ${config.gelanoPaPm ? 'checked' : ''}>Imposer un Gelano PA PM (exo PM)</label>
      <label class="field">Ajouter un item
        <input id="itemSearch" list="itemList" placeholder="Nom d'un item…" autocomplete="off">
        <datalist id="itemList">${game.items.map(i => `<option value="${esc(i.n)}">`).join('')}</datalist>
      </label>
      <div class="row">
        <button type="button" class="ghost" id="forceBtn">Imposer</button>
        <button type="button" class="ghost" id="banBtn">Interdire</button>
      </div>
      <ul class="tags">
        ${config.forced.map(id => `<li class="tag forced">${esc(itemName(id))}<button type="button" aria-label="Retirer" data-unforce="${id}">×</button></li>`).join('')}
        ${config.banned.map(id => `<li class="tag banned">${esc(itemName(id))}<button type="button" aria-label="Retirer" data-unban="${id}">×</button></li>`).join('')}
      </ul>
    </section>
    <button type="button" class="primary" id="run">Générer le meilleur stuff</button>
  `;
  bindConfig();
}

// Sorts à optimiser, cochés par classe (config.spellsByBreed) ; rien de coché = automatique
function spellSection() {
  const chosen = new Set(config.spellsByBreed?.[config.breedId] || []);
  const level = config.mode === 'leveling' ? 200 : config.level;
  const offensive = classSpells(game, config.breedId, level).filter(sp => sp.lines.some(l => l.k === 'dmg' || l.k === 'vol'));
  return `<section>
    <details class="spells-pick" ${chosen.size ? 'open' : ''}>
      <summary><h2>Sorts à optimiser</h2><small>${chosen.size ? `${chosen.size} coché${chosen.size > 1 ? 's' : ''}` : 'automatique'}</small></summary>
      <p class="hint">Le moteur maximise les dégâts moyens des sorts cochés. Un élément sans sort coché reste automatique : les sorts d'un combat de 5 tours joué au mieux, pondérés par leur nombre de lancers.</p>
      <div class="chips">${offensive.map(sp => `<label class="chip"><input type="checkbox" data-spell="${sp.id}" ${chosen.has(sp.id) ? 'checked' : ''}>${esc(sp.n)} <small>${sp.pa} PA</small></label>`).join('')}</div>
    </details>
  </section>`;
}

function onConfigChange(e) {
  const t = e.target;
  const root = $('#config');
  // changements qui modifient le formulaire lui-même : on le redessine
  let redraw = false;
  if (t.name === 'mode') { config.mode = t.value; redraw = true; }
  else if (t.id === 'breed') { config.breedId = Number(t.value); redraw = true; }
  else if (t.id === 'autoEl') { config.autoElement = t.checked; redraw = true; }
  else if (t.name === 'el') { config.elements = [...root.querySelectorAll('input[name=el]:checked')].map(i => i.value); redraw = config.mode === 'leveling'; }
  else if (t.dataset.tier) {
    const tier = config.leveling.tiers[Number(t.dataset.tier)];
    const max = t.dataset.tk === 'level' ? 200 : 20;
    tier[t.dataset.tk] = Math.min(max, Math.max(t.dataset.tk === 'level' ? 1 : 0, Number(t.value) || 0));
    if (t.dataset.tk === 'level') { config.leveling.tiers.sort((a, b) => a.level - b.level); redraw = true; }
  } else if (t.id === 'keepGain') config.leveling.keepGain = Math.max(0, Number(t.value) || 0);
  else if (t.id === 'lvScroll') config.leveling.scroll = Number(t.value);
  else if (t.id === 'lvFm') { config.leveling.fm = t.checked; redraw = true; }
  else if (t.name === 'attack') config.attack = t.value;
  else if (t.name === 'scenario') config.scenario = t.value;
  else if (t.name === 'critMode') config.critMode = t.value;
  else if (t.id === 'scroll') config.fullScroll = t.checked;
  else if (t.id === 'gelano') config.gelanoPaPm = t.checked;
  else if (t.id === 'pctExo') config.fm.pctExo = Number(t.value);
  else if (t.id === 'overBudget') config.fm.overBudget = Number(t.value);
  else if (t.id === 'rollQuality') config.rollQuality = Number(t.value);
  else if (t.dataset.fm) config.fm[t.dataset.fm] = t.checked;
  else if (t.dataset.spell) {
    config.spellsByBreed = { ...config.spellsByBreed, [config.breedId]: [...root.querySelectorAll('[data-spell]:checked')].map(i => Number(i.dataset.spell)) };
    root.querySelector('.spells-pick summary small').textContent = config.spellsByBreed[config.breedId].length ? `${config.spellsByBreed[config.breedId].length} coché(s)` : 'automatique';
  }
  else if (t.dataset.min) {
    if (t.value === '') delete config.min[t.dataset.min];
    else {
      // 12 PA, 6 PM, 6 PO au plus en début de combat
      const cap = STAT_CAP[t.dataset.min];
      config.min[t.dataset.min] = cap ? Math.min(cap, Number(t.value)) : Number(t.value);
      if (cap && Number(t.value) > cap) t.value = cap;
    }
  } else if (t.id === 'level') {
    config.level = Math.min(200, Math.max(1, Number(t.value) || 200));
    t.value = config.level;
  } else if (t.id === 'minLevel') config.minLevel = Math.max(1, Number(t.value) || 1);
  saveConfig();
  if (redraw) renderConfig();
}

function bindConfig() {
  const root = $('#config');
  // #config garde ses écouteurs quand le formulaire est redessiné : on ne les pose qu'une fois
  if (!root.dataset.bound) root.addEventListener('change', onConfigChange);
  root.dataset.bound = '1';
  const pick = list => {
    const name = $('#itemSearch').value.trim().toLowerCase();
    const it = game.items.find(i => i.n.toLowerCase() === name);
    if (!it) { $('#itemSearch').setCustomValidity('Item introuvable'); $('#itemSearch').reportValidity(); return; }
    $('#itemSearch').setCustomValidity('');
    config.forced = config.forced.filter(id => id !== it.id);
    config.banned = config.banned.filter(id => id !== it.id);
    config[list].push(it.id);
    saveConfig();
    renderConfig();
  };
  $('#forceBtn').onclick = () => pick('forced');
  $('#banBtn').onclick = () => pick('banned');
  root.querySelectorAll('[data-unforce]').forEach(b => b.onclick = () => {
    config.forced = config.forced.filter(id => id !== Number(b.dataset.unforce)); saveConfig(); renderConfig();
  });
  root.querySelectorAll('[data-unban]').forEach(b => b.onclick = () => {
    config.banned = config.banned.filter(id => id !== Number(b.dataset.unban)); saveConfig(); renderConfig();
  });
  if ($('#addTier')) $('#addTier').onclick = () => addTier(Math.min(200, (config.leveling.tiers.at(-1)?.level ?? 0) + 20));
  root.querySelectorAll('[data-addtier]').forEach(b => b.onclick = () => addTier(Number(b.dataset.addtier)));
  root.querySelectorAll('[data-untier]').forEach(b => b.onclick = () => {
    config.leveling.tiers.splice(Number(b.dataset.untier), 1); saveConfig(); renderConfig();
  });
  $('#run').onclick = run;
}

// ---------- Génération ----------

// ---------- Progression sur le bouton ----------
// Le nombre d'itérations n'est pas connu d'avance : chaque mode avance par étapes (phase 1 sur les
// meilleurs items, phase 2 sur tous les items, finitions), et la barre glisse doucement entre deux
// étapes sans jamais dépasser la suivante, pour ne pas paraître figée.
const progress = { modes: {}, count: 1, shown: 0, timer: null };
function modeFraction(p) {
  if (p.phase === 3) return 0.95;
  const [start, span] = p.phase === 1 ? [0.03, 0.42] : [0.45, 0.45];
  return start + span * (1 - 0.5 ** p.iter);
}
function progressTarget() {
  const fr = Object.values(progress.modes).map(modeFraction);
  return (fr.reduce((a, b) => a + b, 0) + (progress.count - fr.length) * 0.02) / progress.count;
}
function paintButton() {
  const pct = Math.floor(progress.shown * 100);
  const btn = $('#run');
  btn.textContent = `Calcul en cours… ${pct} %`;
  btn.style.setProperty('--pct', `${pct}%`);
}
function startProgress(modeCount) {
  Object.assign(progress, { modes: {}, count: modeCount, shown: 0 });
  $('#run').classList.add('running');
  paintButton();
  clearInterval(progress.timer);
  progress.timer = setInterval(() => {
    const cap = Math.min(progressTarget() + 0.12, 0.97);
    progress.shown = Math.max(progress.shown, progress.shown + (cap - progress.shown) * 0.015);
    paintButton();
  }, 200);
}
function stopProgress() {
  clearInterval(progress.timer);
  const btn = $('#run');
  btn.classList.remove('running');
  btn.style.removeProperty('--pct');
  btn.textContent = 'Générer le meilleur stuff';
}

function run() {
  if (!config.autoElement && !config.elements.length) { setStatus('Choisis au moins un élément.', 'error'); return; }
  const nEl = config.autoElement ? AUTO_ELEMENTS.length : 1;
  $('#run').disabled = true;
  setStatus('Préparation du modèle…');
  if (config.mode === 'leveling') {
    if (!config.leveling.tiers.length) { setStatus('Ajoute au moins un palier.', 'error'); $('#run').disabled = false; return; }
    // leveling : sans critique (100 % critique n'est pas atteignable à bas niveau)
    startProgress(config.leveling.tiers.length * nEl);
    worker.postMessage({ type: 'leveling', config: { ...config, critMode: 'noncrit' } });
    return;
  }
  // Auto : 100 %, sans critique et deux planchers intermédiaires (critModes dans optimize.js)
  startProgress((config.critMode === 'auto' ? 4 : 1) * nEl);
  worker.postMessage({ type: 'run', config });
}

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    // leveling : les paliers seuls d'abord, puis le modèle commun de l'élément remplace ses paliers
    const sub = data.subMode ?? data.mode;
    const pre = data.element ? `${data.element}:` : '';
    if (sub === 'joint' && !progress.modes[data.mode]) {
      const tierKeys = Object.keys(progress.modes).filter(k => k.startsWith(`${pre}t`));
      tierKeys.forEach(k => delete progress.modes[k]);
      progress.count -= config.leveling.tiers.length - 1;
    }
    progress.modes[data.mode] = data;
    progress.shown = Math.max(progress.shown, progressTarget());
    paintButton();
    if (data.value === undefined) return;
    const el = data.element ? `${EL_LABEL[data.element]} · ` : '';
    if (data.label) setStatus(`${el}${data.label} · ${data.phase === 3 ? 'finitions' : `itération ${data.iter}`} · ${fmt(data.value)} dégâts moyens par sort${sub === 'joint' ? ' au dernier palier' : ''}`);
    else setStatus(`${el}${modeLabel(sub)} · ${['', 'meilleurs items', 'tous les items', 'finitions'][data.phase]} · itération ${data.iter} · ${fmt(data.value)} dégâts moyens par sort`);
  } else if (data.type === 'result') {
    // termine visiblement à 100 % avant de rendre la main
    clearInterval(progress.timer);
    progress.shown = 1;
    paintButton();
    setTimeout(stopProgress, 600);
    $('#run').disabled = false;
    lastResult = data.result;
    selectedSpell = null;
    selectedTier = 0;
    editing = null;
    const tiers = data.result.tiers || [{ result: data.result }];
    const warn = tiers.flatMap(t => [...t.result.violations.map(v => `${STAT_LABEL[v.key] || v.key} < ${v.min}`), ...t.result.unmetConditions.map(n => `condition non remplie : ${n}`)]
      .map(w => (t.level ? `niv. ${t.level} : ${w}` : w)));
    const took = ` (${Math.round(data.result.seconds)} s)`;
    const what = data.result.tiers ? `${tiers.length} stuffs trouvés` : 'Stuff trouvé';
    const around = aroundNames ? ` autour de ${aroundNames.join(', ')}` : '';
    aroundNames = null;
    setStatus(warn.length ? `${what}${around}${took}, avec des réserves : ${warn.join(', ')}` : `${what}${around}${took}.`, warn.length ? 'warn' : 'ok');
    renderStuff();
    renderSim();
  } else if (data.type === 'refinished') {
    const { original, savedName, draftName, autoElement, seconds } = lastResult;
    refinishing = false;
    const next = evaluateStuff(game, { ...data.result, original, savedName, draftName, autoElement, seconds, lost: [] });
    // la forgemagie du moteur est linéarisée : sur un stuff sans problème, elle peut faire un peu moins
    if (!lastResult.issues?.length && next.score < lastResult.score) setStatus('La forgemagie actuelle fait déjà au moins autant de dégâts : rien n\'a changé.', 'ok');
    else {
      lastResult = next;
      setStatus(next.issues.length ? 'Forgemagie recalculée, mais des problèmes restent.' : 'Forgemagie recalculée.', next.issues.length ? 'warn' : 'ok');
    }
    renderStuff();
    renderSim();
  } else if (data.type === 'error') {
    aroundNames = null;
    if (refinishing) { refinishing = false; renderStuff(); setStatus(data.message, 'error'); return; }
    stopProgress();
    $('#run').disabled = false;
    setStatus(data.message, 'error');
  }
};

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

// ---------- Onglet Stuff ----------

// Icônes des stats comme en jeu ; DofusDB n'a pas toutes les icônes, on retombe sur la plus proche
const ICON_FALLBACK = {
  resFeu: 'tx_intelligence', resEau: 'tx_chance', resTerre: 'tx_strength', resAir: 'tx_agility', resNeutre: 'tx_neutral',
  rfFeu: 'tx_intelligence', rfEau: 'tx_chance', rfTerre: 'tx_strength', rfAir: 'tx_agility', rfNeutre: 'tx_neutral', pctSorts: 'tx_damagesPercent', pctDist: 'tx_damagesPercent', pctMelee: 'tx_damagesPercent',
  pctArmes: 'tx_damagesPercent', pctFinaux: 'tx_damagesPercent', resDist: 'tx_pushReduction', resMelee: 'tx_pushReduction',
  resSorts: 'tx_pushReduction', resArmes: 'tx_pushReduction',
};
function statIcon(k) {
  const asset = ICON_FALLBACK[k] || game.statIcon?.[k];
  return asset ? `<img class="sicon" src="${import.meta.env.BASE_URL}icons/${asset}.png" alt="" width="18" height="18">` : '<span class="sicon"></span>';
}

// Lignes d'effets façon infobulle du jeu : icône, valeur, libellé, [jet min à max]
function statLines(st, cls = '', rolls = {}) {
  return Object.entries(st).filter(([k]) => STAT_LABEL[k])
    .map(([k, v]) => `<li class="${cls} ${v < 0 ? 'neg' : 'pos'}">${statIcon(k)}<b>${v > 0 && cls ? '+' : ''}${fmt(v)}</b> ${esc(STAT_LABEL[k])}${rolls[k] ? ` <span class="roll">[${rolls[k][0]} à ${rolls[k][1]}]</span>` : ''}</li>`).join('');
}

// Conditions lisibles : « CA>299&CS>299 » -> « Agilité > 299 et Force > 299 »
const COND_LABEL = {
  CS: 'Force', CI: 'Intelligence', CC: 'Chance', CA: 'Agilité', CV: 'Vitalité', CW: 'Sagesse',
  CP: 'PA', CM: 'PM', pk: 'Bonus de panoplie', PL: 'Niveau',
};
function conditionText(c) {
  return c.split('|').map(group => group.replace(/[()]/g, '').split('&').map(atom => {
    const m = /^([A-Za-z]{2})([<>=!~])(.*)$/.exec(atom);
    return m && COND_LABEL[m[1]] ? `${COND_LABEL[m[1]]} ${m[2]} ${m[3]}` : atom;
  }).join(' et ')).join(' ou ');
}

// Fiche complète façon infobulle du jeu
function itemSheet(it) {
  const g = game.items.find(i => i.id === it.id) || {};
  const sec = (title, body) => `<div class="sheet-sec"><h4>${title}</h4>${body}</div>`;
  const w = g.w;
  const weapon = w ? sec('Effets de l\'arme', `
    <p class="wstats">${w.pa} PA · portée ${w.po[0]}–${w.po[1]} · ${w.n ? `${w.n} lancer${w.n > 1 ? 's' : ''} par tour · ` : ''}critique ${w.cc} %${w.cb ? ` (+${w.cb})` : ''}</p>
    <ul class="lines">${w.lines.map(l => `<li class="pos">${statIcon(ELEMENT_DO_KEY[l.el] || 'do')}<b>${l.min}${l.max > l.min ? ` à ${l.max}` : ''}</b> ${l.k === 'vol' ? 'vol' : l.k === 'soin' ? 'soins' : 'dommages'} ${EL_LABEL[l.el] || l.el}</li>`).join('')}</ul>`) : '';
  const passive = it.passive && game.passives[it.passive]
    ? sec('Effet passif', `<p class="passive-text">${esc(game.passives[it.passive].d)}</p>`) : '';
  const extra = g.x ? `<ul class="lines extra">${g.x.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  return `${weapon}
    ${Object.keys(it.st).length || extra ? sec('Effets', `<ul class="lines">${statLines(it.st, '', it.r || {})}</ul>${extra}`) : ''}
    ${passive}
    ${Object.keys(it.fm).length ? sec('Forgemagie', `<ul class="lines fm">${statLines(it.fm, 'fm')}</ul>`) : ''}
    ${it.trans ? sec(`Transcendance · ${esc(it.trans.n)}`, `<ul class="lines fm">${statLines({ [it.trans.k]: it.trans.v }, 'fm')}<li class="locked">Empêche les futures forgemagies</li></ul>`) : ''}
    ${it.c ? sec('Conditions', `<p class="cond">${esc(conditionText(it.c))}</p>`) : ''}
    ${g.d ? `<details class="desc-item"><summary>Description</summary><p>${esc(g.d)}</p></details>` : ''}`;
}
const ELEMENT_DO_KEY = { feu: 'doFeu', eau: 'doEau', terre: 'doTerre', air: 'doAir', neutre: 'doNeutre' };

// Frise du mode leveling : un bouton par palier, puis le bilan du palier choisi
// ---------- Modifications du stuff généré ----------
// Remplacer un item (il reprend la finition de l'ancien) ou retoucher ses lignes ; le reste est figé.
// « Recalculer la FM » refait seulement la forgemagie, items et points de caractéristique gardés.

let editing = null; // index dans lastResult.items de l'item en cours de modification
let refinishing = false;
let aroundNames = null; // items imposés pendant « Recalculer le stuff autour »
const ALT_SHOWN = 30;
const editable = () => lastResult && !lastResult.tiers;

// lost : finitions perdues au remplacement, par item ; elles disparaissent si l'item est retouché
function applyItems(items, lost) {
  if (!lastResult.original) {
    const { original, savedName, draftName, ...generated } = lastResult;
    lastResult.original = structuredClone(generated);
  }
  lastResult = evaluateStuff(game, { ...lastResult, items, lost }, lost.map(l => l.text));
  renderStuff();
  renderSim();
}

// Items mis à la place de ceux du stuff généré
const changedItems = r => {
  const before = new Set(r.original.items.map(it => it.id));
  return r.items.filter(it => !before.has(it.id));
};

// Relance le moteur complet en imposant les items remplacés, avec les réglages qui ont produit ce stuff
function runAround() {
  const r = lastResult;
  const ids = changedItems(r).map(it => it.id);
  const cfg = {
    ...r.config, autoElement: false,
    forced: [...new Set([...r.config.forced, ...ids])], banned: r.config.banned.filter(id => !ids.includes(id)),
  };
  aroundNames = changedItems(r).map(it => it.n);
  $('#run').disabled = true;
  setStatus('Préparation du modèle…');
  startProgress(cfg.critMode === 'auto' ? 2 : 1);
  worker.postMessage({ type: 'run', config: cfg });
  renderStuff();
}

function editBanner(r) {
  if (!r.original) return '';
  const pct = r.original.score > 0 ? (100 * (r.score - r.original.score)) / r.original.score : 0;
  const issues = r.issues || [];
  return `<div class="banner edit-banner ${issues.length ? 'warn' : ''}">
    <p>Stuff modifié : <strong>${fmt(r.score)}</strong> dégâts moyens, contre ${fmt(r.original.score)} pour le stuff généré (${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %).</p>
    ${issues.length ? `<ul>${issues.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    <div class="edit-actions">
      <button type="button" class="ghost" id="refinish" ${refinishing ? 'disabled' : ''}>${refinishing ? 'Recalcul de la FM…' : 'Recalculer la FM'}</button>
      ${changedItems(r).length ? `<button type="button" class="ghost" id="around" title="Garde ${esc(changedItems(r).map(it => it.n).join(', '))} et recalcule tout le reste" ${$('#run')?.disabled ? 'disabled' : ''}>Recalculer le stuff autour</button>` : ''}
      <button type="button" class="ghost" id="revert">Revenir au stuff généré</button>
    </div>
  </div>`;
}

// Fiche en mode modification : chaque ligne d'effet et de forgemagie est un champ
function itemEditor(it) {
  const row = (k, v, kind) => `<li>${statIcon(k)}<input type="number" class="line-input" value="${v}" data-line="${kind}" data-k="${k}" aria-label="${esc(STAT_LABEL[k])}"> ${esc(STAT_LABEL[k])}${kind === 'st' && it.r?.[k] ? ` <span class="roll">[${it.r[k][0]} à ${it.r[k][1]}]</span>` : ''}</li>`;
  const free = Object.keys(STAT_LABEL).filter(k => !(k in it.fm));
  return `<div class="editor" data-editor="${it.idx}">
    <div class="sheet-sec"><h4>Effets</h4><ul class="lines">${Object.entries(it.st).filter(([k]) => STAT_LABEL[k]).map(([k, v]) => row(k, v, 'st')).join('')}</ul></div>
    <div class="sheet-sec"><h4>Forgemagie</h4><ul class="lines fm">${Object.entries(it.fm).map(([k, v]) => row(k, v, 'fm')).join('')}</ul>
      <select class="add-fm" data-addk aria-label="Ligne de forgemagie à ajouter"><option value="">Ajouter une ligne…</option>${free.map(k => `<option value="${k}">${esc(STAT_LABEL[k])}</option>`).join('')}</select>
      ${it.trans ? `<label class="trans-line"><input type="checkbox" data-trans checked> Transcendance ${esc(it.trans.n)} (+${it.trans.v} ${esc(STAT_LABEL[it.trans.k])})</label>` : ''}
    </div>
    <p class="hint">Une ligne de forgemagie à 0 est retirée.</p>
  </div>`;
}

function bindEdits() {
  const root = $('#tab-stuff');
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const idx = Number(b.dataset.edit);
    editing = editing === idx ? null : idx;
    renderStuff();
  });
  root.querySelectorAll('[data-alt]').forEach(b => b.onclick = () => openAlternatives(Number(b.dataset.alt)));
  const ed = root.querySelector('[data-editor]');
  if (ed) {
    const idx = Number(ed.dataset.editor);
    const update = change => {
      const items = structuredClone(lastResult.items);
      change(items[idx]);
      applyItems(items, (lastResult.lost || []).filter(l => l.id !== items[idx].id));
    };
    ed.querySelectorAll('[data-line]').forEach(inp => inp.onchange = () => update(it => {
      const v = Number(inp.value) || 0;
      if (inp.dataset.line === 'st') it.st[inp.dataset.k] = v;
      else if (v) it.fm[inp.dataset.k] = v;
      else delete it.fm[inp.dataset.k];
    }));
    ed.querySelector('[data-addk]').onchange = e => {
      const k = e.target.value;
      if (!k) return;
      update(it => { it.fm[k] = 1; });
      $(`[data-editor] [data-line="fm"][data-k="${k}"]`)?.select();
    };
    const tr = ed.querySelector('[data-trans]');
    if (tr) tr.onchange = () => update(it => { it.trans = null; });
  }
  if ($('#revert')) $('#revert').onclick = () => {
    const { savedName, draftName } = lastResult;
    lastResult = { ...lastResult.original, savedName, draftName };
    editing = null;
    setStatus('Stuff généré rétabli.', 'ok');
    renderStuff();
    renderSim();
  };
  if ($('#around')) $('#around').onclick = runAround;
  if ($('#refinish')) $('#refinish').onclick = () => {
    refinishing = true;
    const { original, savedName, draftName, ...r } = lastResult;
    worker.postMessage({ type: 'refinish', result: r });
    setStatus('Recalcul de la forgemagie…');
    renderStuff();
  };
}

// Fenêtre des alternatives d'un emplacement : les 30 meilleures, ou celles dont le nom correspond
function openAlternatives(idx) {
  const cur = lastResult.items[idx];
  const list = alternatives(game, lastResult, idx);
  document.querySelectorAll('.alt-dialog').forEach(d => d.remove());
  const dlg = document.createElement('dialog');
  dlg.className = 'alt-dialog';
  const shut = () => { dlg.close(); dlg.remove(); };
  dlg.innerHTML = `
    <header><div><small>${SLOT_LABEL[cur.s]}</small><h3>À la place de ${esc(cur.n)}</h3></div>
      <button type="button" class="ghost" data-close>Fermer</button></header>
    <p class="hint">Le reste du stuff est figé ; le nouvel item reprend la finition de l'ancien quand elle tient sur lui. Écart en dégâts moyens.</p>
    <input type="search" class="alt-search" placeholder="Chercher un item…" aria-label="Chercher un item">
    <ul class="alt-list"></ul>`;
  const norm = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const fill = q => {
    const rows = (q ? list.filter(a => norm(a.n).includes(norm(q))) : list).slice(0, ALT_SHOWN);
    dlg.querySelector('.alt-list').innerHTML = rows.map(a => `
      <li class="${a.current ? 'current' : ''}">
        <img src="${ITEM_IMG(a.img)}" alt="" width="36" height="36" loading="lazy">
        <div class="alt-name"><strong>${esc(a.n)}</strong><small>niv. ${a.l}${a.current ? ' · actuel' : a.worn ? ' · déjà porté' : ''}</small>
          ${a.issues.length ? `<ul class="alt-issues">${a.issues.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>
        <span class="alt-pct ${a.pct < -0.05 ? 'neg' : a.pct > 0.05 ? 'pos' : ''}">${a.current || a.worn ? '—' : `${a.pct >= 0 ? '+' : ''}${a.pct.toFixed(1)} %`}<small>${fmt(a.score)}</small></span>
        <button type="button" class="ghost" data-place="${a.id}" ${a.current || a.worn ? 'disabled' : ''}>Mettre</button>
      </li>`).join('') || '<li class="empty">Aucun item de cet emplacement ne correspond.</li>';
  };
  fill('');
  dlg.querySelector('.alt-search').oninput = e => fill(e.target.value.trim());
  dlg.querySelector('[data-close]').onclick = shut;
  dlg.onclose = () => dlg.remove();
  dlg.onclick = e => {
    if (e.target === dlg) { shut(); return; }
    const b = e.target.closest('[data-place]');
    if (!b) return;
    const { item, lost } = placeItem(game, lastResult, idx, game.items.find(g => g.id === Number(b.dataset.place)));
    const items = lastResult.items.map((it, i) => (i === idx ? item : it));
    const kept = (lastResult.lost || []).filter(l => l.id !== cur.id);
    if (editing === idx) editing = null;
    shut();
    applyItems(items, [...kept, ...lost.map(text => ({ id: item.id, text }))]);
  };
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector('.alt-search').focus();
}

// ---------- Sauvegardes ----------
// Stuffs générés gardés dans le navigateur (localStorage), avec un nom modifiable

const SAVED_STORE = 'dofus-optimizer-saved';
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_STORE)) || []; } catch { return []; }
}
function writeSaved(list) {
  try { localStorage.setItem(SAVED_STORE, JSON.stringify(list)); return true; } catch { return false; }
}

// Nom par défaut : mode, classe, niveau (ou paliers), élément
function defaultName(r) {
  const cfg = (r.tiers ? r.tiers[0].result : r).config;
  const breed = game.breeds.find(b => b.id === cfg.breedId)?.n || '';
  const lvl = r.tiers ? `niv. ${r.tiers[0].level} à ${r.tiers.at(-1).level}` : `niv. ${cfg.level}`;
  return `${r.tiers ? 'Leveling' : 'Stuff'} ${breed} ${lvl} ${cfg.elements.map(el => EL_LABEL[el]).join('-')}`;
}

function saveBar() {
  return `<form class="save-bar" id="saveForm">
    <label class="field">Nom de la fiche<input id="saveName" maxlength="80" value="${esc(lastResult.draftName ?? lastResult.savedName ?? defaultName(lastResult))}"></label>
    <button type="submit" class="ghost">Sauvegarder</button>
  </form>`;
}

function bindSaveBar() {
  // le nom tapé survit au changement de palier (le stuff est redessiné)
  $('#saveName').oninput = e => { lastResult.draftName = e.target.value; };
  $('#saveForm').onsubmit = e => {
    e.preventDefault();
    const name = $('#saveName').value.trim() || defaultName(lastResult);
    const { savedName, draftName, original, ...result } = lastResult;
    const list = loadSaved();
    list.unshift({ id: Date.now(), name, savedAt: new Date().toISOString(), result });
    if (!writeSaved(list)) { setStatus('Sauvegarde impossible : le stockage du navigateur est plein ou bloqué.', 'error'); return; }
    lastResult.savedName = name;
    delete lastResult.draftName;
    setStatus(`Fiche « ${name} » sauvegardée.`, 'ok');
    renderSaved();
    renderTeam();
  };
}

function renderSaved() {
  const list = loadSaved();
  $('#tab-saved').innerHTML = list.length ? `<ul class="saved">${list.map(x => {
    const r = x.result;
    const score = r.tiers ? `${r.tiers.length} paliers` : `${fmt(r.score)} dégâts`;
    return `<li><div><strong>${esc(x.name)}</strong><small>${score} · sauvegardée le ${new Date(x.savedAt).toLocaleDateString('fr-FR')}</small></div>
      <button type="button" class="ghost" data-open="${x.id}">Ouvrir</button>
      <button type="button" class="ghost danger" data-delsaved="${x.id}" aria-label="Supprimer ${esc(x.name)}">Supprimer</button></li>`;
  }).join('')}</ul>` : '<p class="empty">Aucune fiche sauvegardée. Génère un stuff puis clique sur « Sauvegarder ».</p>';
  $('#tab-saved').querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const x = loadSaved().find(s => s.id === Number(b.dataset.open));
    if (!x) return;
    lastResult = { ...x.result, savedName: x.name };
    selectedTier = 0;
    editing = null;
    selectedSpell = null;
    renderStuff();
    renderSim();
    showTab('stuff');
    setStatus(`Fiche « ${x.name} » ouverte.`, 'ok');
  });
  $('#tab-saved').querySelectorAll('[data-delsaved]').forEach(b => b.onclick = () => {
    const x = loadSaved().find(s => s.id === Number(b.dataset.delsaved));
    if (!x || !confirm(`Supprimer la fiche « ${x.name} » ?`)) return;
    writeSaved(loadSaved().filter(s => s.id !== x.id));
    renderSaved();
    renderTeam();
  });
}

function levelingHeader() {
  const L = lastResult;
  if (!L?.tiers) return '';
  const t = L.tiers[selectedTier];
  const pct = t.alone > 0 ? (100 * t.result.score) / t.alone : 100;
  return `
    <div class="timeline" role="tablist" aria-label="Paliers">
      ${L.tiers.map((x, i) => `<button type="button" role="tab" aria-selected="${i === selectedTier}" data-tierview="${i}">
        <strong>Niv. ${x.level}</strong><span>${fmt(x.result.score)} dégâts</span><small>${i ? `${x.added.length} nouveau${x.added.length > 1 ? 'x' : ''}` : `${x.added.length} items`}</small>
      </button>`).join('')}
    </div>
    <p class="banner">${selectedTier
      ? `<strong>${t.kept.length}</strong> items gardés du palier ${L.tiers[selectedTier - 1].level}, <strong>${t.added.length}</strong> nouveaux.`
      : 'Premier palier : tout le stuff est à acheter.'}
      Le meilleur stuff possible à ce niveau, sans rien garder, ferait ${fmt(t.alone)} dégâts : celui-ci en fait ${pct.toFixed(1)} %.
      Un item n'est changé que s'il rapporte au moins ${L.leveling.keepGain} % de dégâts.</p>`;
}

function renderStuff() {
  const r = shown();
  const tier = lastResult.tiers?.[selectedTier];
  const kept = new Set(tier?.kept || []);
  const badge = it => (tier && selectedTier ? `<span class="badge ${kept.has(it.id) ? 'kept' : 'new'}">${kept.has(it.id) ? 'Gardé' : 'Nouveau'}</span>` : '');
  const items = r.items.map((it, idx) => ({ ...it, idx })).sort((a, b) => SLOT_ORDER.indexOf(a.s) - SLOT_ORDER.indexOf(b.s));
  const passiveNotes = r.items.filter(i => i.passive && PASSIVES[i.passive]).map(i => {
    const p = game.passives[i.passive];
    const e = PASSIVES[i.passive];
    const why = e.none ? `<br><em>Sans effet sur les dégâts : ${esc(e.none)}.</em>` : e.note ? `<br><em>Hypothèse : ${esc(e.note)}</em>` : '';
    return `<li><strong>${esc(i.n)}</strong> — ${esc(p?.d || '')}${why}</li>`;
  }).join('');
  const s = r.stats;
  const groups = [
    ['Général', ['pa', 'pm', 'po', 'vita', 'invo', 'crit']],
    ['Caractéristiques', ['force', 'intel', 'chance', 'agi', 'sagesse', 'puissance']],
    ['Dommages', ['do', 'doFeu', 'doEau', 'doTerre', 'doAir', 'doNeutre', 'doCrit', 'pctSorts', 'pctDist', 'pctMelee', 'pctFinaux']],
    ['Résistances', ['resFeu', 'resEau', 'resTerre', 'resAir', 'resNeutre', 'rfFeu', 'rfEau', 'rfTerre', 'rfAir', 'rfNeutre', 'resCrit']],
    ['Divers', ['tacle', 'fuite', 'retPA', 'retPM', 'esqPA', 'esqPM', 'ini', 'pp', 'pods', 'soins']],
  ];
  $('#tab-stuff').innerHTML = `
    ${saveBar()}
    ${levelingHeader()}
    <div class="score-row">
      ${Object.entries(r.elementScores).map(([el, v]) => `<div class="score el-${el}"><span>${EL_LABEL[el]}</span><strong>${fmt(v)}</strong><small>dégâts moyens par sort (sans cible)</small></div>`).join('')}
      <div class="score"><span>Points de carac.</span><strong>${Object.entries(r.points).map(([k, v]) => `${v} ${STAT_LABEL[k]}`).join(', ') || '—'}</strong><small>${r.pointsCost} / ${r.pointsMax} points utilisés</small></div>
    </div>
    ${autoBanner()}
    ${critBanner(r)}
    ${spellBanner(r)}
    ${editBanner(r)}
    ${(r.exoNotes || []).length ? `<ul class="exo-notes">${r.exoNotes.map(n => `<li class="${n.used ? 'used' : 'skip'}">${esc(n.text)}</li>`).join('')}</ul>` : ''}
    <div class="items">
      ${items.map(it => `
        <article class="item">
          <header><img src="${ITEM_IMG(it.img)}" alt="" width="48" height="48" loading="lazy">
            <div><small>${SLOT_LABEL[it.s]} · niv. ${it.l}</small><h3>${esc(it.n)}</h3>${it.set ? `<small class="set">${esc(game.sets[it.set]?.n || '')}</small>` : ''}</div>
            ${badge(it)}
          </header>
          ${editable() ? `<div class="item-actions">
            <button type="button" class="ghost" data-alt="${it.idx}">Alternatives</button>
            <button type="button" class="ghost" data-edit="${it.idx}" aria-pressed="${editing === it.idx}">${editing === it.idx ? 'Terminer' : 'Modifier'}</button>
          </div>` : ''}
          ${editing === it.idx ? itemEditor(it) : itemSheet(it)}
        </article>`).join('')}
    </div>
    ${r.setBonuses.length ? `<h2>Bonus de panoplie</h2><div class="sets">${r.setBonuses.map(b => `<div class="setbox"><strong>${esc(b.n)}</strong> (${b.count} items)<ul class="lines">${statLines(b.bonus)}</ul></div>`).join('')}</div>` : ''}
    <h2>Caractéristiques finales</h2>
    <div class="stat-groups">
      ${groups.map(([title, keys]) => `<div class="stat-group"><h3>${title}</h3><dl>${keys.map(k => `<dt>${statIcon(k)}${STAT_LABEL[k]}</dt><dd>${fmt(totalStat(s, k))}</dd>`).join('')}</dl></div>`).join('')}
    </div>
    <h2>Valeur des options de forgemagie sur ce stuff</h2>
    <p class="hint">Gain de dégâts si on ajoutait cette seule option au stuff final. Les overs sont comparés à poids égal à 1 % de dommages (15).</p>
    <table class="compare"><tbody>${r.fmComparison.filter(o => o.gain > 0).map(o => `<tr class="${o.trans ? 'trans' : ''}"><td>${esc(o.label)}</td><td>+${o.pct.toFixed(2)} %</td><td>+${fmt(o.gain)}</td></tr>`).join('')}</tbody></table>
    ${passiveNotes ? `<h2>Passifs pris en compte</h2><ul class="passives">${passiveNotes}</ul>` : ''}
  `;
  bindSaveBar();
  bindEdits();
  $('#tab-stuff').querySelectorAll('[data-tierview]').forEach(b => b.onclick = () => {
    selectedTier = Number(b.dataset.tierview);
    selectedSpell = null;
    renderStuff();
    renderSim();
  });
}

function autoBanner() {
  const a = lastResult.autoElement;
  if (!a) return '';
  const what = lastResult.tiers ? 'moyenne des paliers' : 'dégâts moyens';
  const others = a.runs.filter(x => x.el !== a.chosen).map(x => `${EL_LABEL[x.el]} : ${x.score == null ? 'aucun stuff' : `<strong>${fmt(x.score)}</strong>`}`).join(' · ');
  const best = a.runs.find(x => x.el === a.chosen);
  return `<p class="banner">Élément choisi automatiquement : <strong>${EL_LABEL[a.chosen]}</strong> (${what} ${fmt(best.score)}). ${others}</p>`;
}

function spellBanner(r) {
  const picks = r.spellPicks;
  if (!picks) return '';
  const label = { auto: 'automatique', choisis: 'cochés', générique: 'sort générique' };
  return `<p class="banner spells-used">Sorts optimisés : ${Object.entries(picks).map(([el, p]) => `<span class="el-${el}"><strong>${EL_LABEL[el]}</strong> (${label[p.mode]})</span> ${p.spells.map(s => `${esc(s.n)}${s.w > 1 ? ` ×${s.w}` : ''}`).join(', ')}`).join(' · ')}</p>`;
}

function critBanner(r) {
  const c = r.crit;
  const runs = c.runs.map(x => `${modeLabel(x.mode)} : <strong>${fmt(x.score)}</strong>`).join(' · ');
  const target = c.mode === 'crit' ? ` (${c.target} % de critique du stuff visés pour que tous les sorts soient à 100 %, actuel ${fmt(r.stats.crit || 0)} %)`
    : c.mode !== 'noncrit' ? ` (compromis : au moins ${c.target} % de critique du stuff, actuel ${fmt(r.stats.crit || 0)} %)` : '';
  return `<p class="banner">Choix du moteur : <strong>${modeLabel(c.mode)}</strong>${target}. ${c.runs.length > 1 ? runs : ''}${c.failed ? ` · ${esc(c.failed)}` : ''}</p>`;
}

// ---------- Onglet Simulation ----------

function renderSim() {
  if (!lastResult) return;
  const r = shown();
  const breed = game.breeds.find(b => b.id === r.config.breedId);
  const ctx = { ...r.ctx, refSpells: {} };
  const spells = classSpells(game, breed.id, r.config.level);
  const known = new Map(spells.map(sp => [sp.id, sp]));
  const sims = new Map(spells.map(sp => [sp.id, simulateSpell(sp, r.stats, ctx, target)]));
  const offensive = sp => sp.lines.some(l => l.k !== 'soin');
  const tField = (k, l) => `<label class="field small">${l}<input type="number" data-target="${k}" value="${target[k] ?? 0}"></label>`;
  if (!selectedSpell || !sims.has(selectedSpell)) selectedSpell = spells.filter(offensive).sort((a, b) => sims.get(b.id).average - sims.get(a.id).average)[0]?.id;
  const sel = spells.find(s => s.id === selectedSpell);
  const res = sel && sims.get(sel.id);
  const turn = turnDamage(spells, r.stats, ctx, { target, weapon: equippedWeapon(game, r.items) });
  const poison = passivePoison(r.stats, ctx); // sans résistances de la cible
  const seq = t => t.casts.map(c => `${c.count > 1 ? `${c.count} × ` : ''}${esc(c.n)}`).join(', ') || 'aucun sort';
  const line = row => `<li class="el-${row.el}">${row.kind === 'soin' ? 'Soin' : row.kind === 'vol' ? 'Vol de vie' : 'Dommages'} ${EL_LABEL[row.el] || ''} : <strong>${fmt(row.min)}${row.max !== row.min ? ' – ' + fmt(row.max) : ''}</strong></li>`;
  $('#tab-sim').innerHTML = `
    <details class="target" open>
      <summary>Adversaire</summary>
      <div class="grid5">
        ${tField('pv', 'PV')}${tField('pctSubis', '% dommages subis')}${tField('resCrit', 'Rés. critiques')}
      </div>
      <div class="grid5">${ELEMENTS.map(el => tField('res' + EL_LABEL[el], '% Rés. ' + EL_LABEL[el])).join('')}</div>
      <div class="grid5">${ELEMENTS.map(el => tField('rf' + EL_LABEL[el], 'Rés. fixe ' + EL_LABEL[el])).join('')}</div>
    </details>
    <section class="turn">
      <p>Dégâts par tour (${turn.pa} PA) : moyen <strong>${fmt(turn.average.dmg)}</strong>${poison ? ` + ${fmt(poison)} de poison des passifs` : ''} sur un combat de ${turn.average.turns.length} tours · meilleur tour <strong>${fmt(turn.best.dmg)}</strong>${turn.average.dmg > 0 && target.pv > 0 ? ` · ${Math.ceil(target.pv / turn.average.dmg)} tours pour tuer` : ''}</p>
      <p class="turn-seq">Meilleur tour : ${seq(turn.best)}</p>
      <details>
        <summary>Tour par tour</summary>
        <ol>${turn.average.turns.map(t => `<li><strong>${fmt(t.dmg)}</strong> · ${seq(t)}</li>`).join('')}</ol>
        <p class="desc">Une cible, limites de lancer et relances du jeu respectées. Seuls les dommages directs des sorts ${ctx.elements.map(el => EL_LABEL[el]).join(' / ')} et de l'arme sont comptés.</p>
      </details>
    </section>
    <div class="sim">
      <ul class="spell-list" role="listbox" aria-label="Sorts">
        ${breed.variants.filter(pair => pair.some(id => known.has(id))).map(pair => `<li class="pair">${pair.map(id => known.get(id)).filter(Boolean).map(sp => {
          const sm = sims.get(sp.id);
          return `<button type="button" role="option" aria-selected="${sp.id === selectedSpell}" data-spell="${sp.id}" class="spell ${offensive(sp) ? '' : 'utility'}">
            <img src="${SPELL_IMG(sp.img)}" alt="" width="36" height="36" loading="lazy">
            <span class="sname">${esc(sp.n)}<small>${sp.pa} PA${offensive(sp) ? ` · ${fmt(sm.average)} moy.` : ''}</small></span>
          </button>`;
        }).join('')}</li>`).join('')}
      </ul>
      <div class="spell-detail">
        ${sel ? `
          <header><img src="${SPELL_IMG(sel.img)}" alt="" width="56" height="56"><div><h3>${esc(sel.n)}</h3><small>${sel.pa} PA · portée ${sel.po[0]}–${sel.po[1]} · critique de base ${sel.cc} %</small></div></header>
          ${sel.lines.length ? `
            <div class="rolls">
              <div><h4>Jet normal</h4><ul>${res.rows.normal.map(line).join('') || '<li>—</li>'}</ul></div>
              <div><h4>Jet critique <small>${Math.round(res.critChance * 100)} % de chances</small></h4><ul>${res.rows.crit.map(line).join('') || '<li>Ce sort ne fait pas de critique.</li>'}</ul></div>
            </div>
            ${offensive(sel) ? `<p class="avg">Moyenne par lancer : <strong>${fmt(res.average)}</strong> · par PA : <strong>${fmt(res.perPA)}</strong>${res.average > 0 ? ` · ${Math.ceil(target.pv / res.average)} lancers pour tuer` : ''}</p>` : ''}
          ` : '<p class="empty">Ce sort n\'a pas de jet de dégâts ou de soin direct.</p>'}
          <p class="desc">${esc(sel.d).replace(/\{\{[^}]*::([^}]*)\}\}/g, '$1')}</p>
        ` : '<p class="empty">Aucun sort.</p>'}
      </div>
    </div>
  `;
  $('#tab-sim').querySelectorAll('[data-spell]').forEach(b => b.onclick = () => { selectedSpell = Number(b.dataset.spell); renderSim(); });
  $('#tab-sim').querySelectorAll('[data-target]').forEach(inp => inp.onchange = () => {
    target[inp.dataset.target] = Number(inp.value) || 0;
    try { localStorage.setItem(TARGET_STORE, JSON.stringify(target)); } catch { /* ignoré */ }
    renderSim();
  });
}

// ---------- Onglets ----------

// ---------- Onglet Équipe ----------
// 2 à 4 fiches sauvegardées (stuffs simples), dans l'ordre de jeu (initiative), et le plan de buffs

let teamIds = [];
let teamTurns = 4;
let teamResult = null;

function renderTeam() {
  const saved = loadSaved().filter(x => !x.result.tiers);
  teamIds = teamIds.filter(id => saved.some(x => x.id === id));
  const byId = new Map(saved.map(x => [x.id, x]));
  const order = teamIds.map(id => byId.get(id));
  const fx = e => Object.entries(e.effects).map(([k, v]) => `${v > 0 ? '+' : ''}${fmt(v)} ${k === 'carac' ? 'dans la caractéristique de son élément' : STAT_LABEL[k] || k}${e.per === 'pm' ? ' par PM utilisé' : ''}`).join(', ');
  const T = teamResult;
  $('#tab-team').innerHTML = saved.length < 2
    ? '<p class="empty">Sauvegarde au moins deux stuffs (bouton « Sauvegarder » au-dessus d\'un stuff généré) pour composer une équipe.</p>'
    : `
    <p class="hint">Choisis 2 à 4 fiches. L'ordre de jeu suit l'initiative (à ajuster si besoin) : un buff lancé par un perso qui joue après sa cible ne lui sert qu'au tour suivant.</p>
    <ul class="team-pick">${saved.map(x => `<li><label class="check"><input type="checkbox" data-teampick="${x.id}" ${teamIds.includes(x.id) ? 'checked' : ''} ${!teamIds.includes(x.id) && teamIds.length >= 4 ? 'disabled' : ''}>${esc(x.name)}</label></li>`).join('')}</ul>
    ${order.length ? `<h2>Ordre de jeu</h2><ol class="team-order">${order.map((x, i) => `<li><span>${esc(x.name)}</span><small>initiative ${fmt(initiativeOf(x.result.stats))}</small>
      <button type="button" class="ghost" data-teamup="${i}" ${i ? '' : 'disabled'} aria-label="Faire jouer ${esc(x.name)} plus tôt">↑</button>
      <button type="button" class="ghost" data-teamdown="${i}" ${i < order.length - 1 ? '' : 'disabled'} aria-label="Faire jouer ${esc(x.name)} plus tard">↓</button></li>`).join('')}</ol>` : ''}
    <div class="row team-run">
      <label class="field small">Tours simulés<select id="teamTurns">${[3, 4, 5, 6].map(n => `<option value="${n}" ${n === teamTurns ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="button" class="primary" id="teamRun" ${order.length >= 2 ? '' : 'disabled'}>Calculer les buffs</button>
    </div>
    ${T ? `
      <div class="score-row">
        <div class="score"><span>Équipe sans buffs</span><strong>${fmt(T.base)}</strong><small>dégâts sur ${T.turns} tours</small></div>
        <div class="score"><span>Avec les buffs</span><strong>${fmt(T.total)}</strong><small>+${(100 * (T.total / T.base - 1)).toFixed(1)} %</small></div>
      </div>
      <h2>Qui buffer, et quand</h2>
      ${T.plan.length ? `<ol class="team-plan">${T.plan.map(a => `<li><b>Tour ${a.turn}</b> · ${esc(T.members[a.caster].name)} lance <strong>${esc(a.n)}</strong> (${a.pa} PA)${a.target === null ? '' : ` sur ${esc(T.members[a.target].name)}`}
        <small>${a.effects.map(fx).join(' ; ')} · +${fmt(a.gain)} dégâts d'équipe</small></li>`).join('')}</ol>` : '<p class="empty">Aucun buff ne rapporte plus que les dégâts que son lanceur ferait à la place.</p>'}
      <h2>Dégâts par tour</h2>
      <table class="compare team-table"><thead><tr><th></th>${Array.from({ length: T.turns }, (_, i) => `<th>Tour ${i + 1}</th>`).join('')}</tr></thead><tbody>
        ${T.members.map(m => `<tr><td>${esc(m.name)}</td>${m.final.map((v, i) => `<td>${fmt(v)}<small> (${v >= m.base[i] ? '+' : ''}${fmt(v - m.base[i])})</small></td>`).join('')}</tr>`).join('')}
      </tbody></table>
      ${T.members.some(m => m.skipped.length || m.ignored.length) ? `<details class="team-skipped"><summary>Buffs non comptés</summary><ul>${T.members.flatMap(m => [
        ...m.skipped.map(x => `<li>${esc(m.name)} · ${esc(x.n)} : ${esc(x.why)}</li>`),
        ...m.ignored.map(x => `<li>${esc(m.name)} · ${esc(x.n)} : ${esc(x.reason)}</li>`),
      ]).join('')}</ul></details>` : ''}
      <p class="hint">Hypothèses : équipe groupée (les buffs de zone touchent tout le monde), une seule cible, durées décomptées au début du tour du lanceur, cumul partagé des Encouragements d'Eniripsa non modélisé. Chaque buff retenu rapporte plus que les dégâts que son lanceur aurait faits avec ces PA.</p>
    ` : ''}`;
  const root = $('#tab-team');
  const changed = () => { teamResult = null; renderTeam(); };
  root.querySelectorAll('[data-teampick]').forEach(c => c.onchange = () => {
    const id = Number(c.dataset.teampick);
    if (c.checked) {
      teamIds.push(id);
      // ordre par défaut : initiative décroissante
      teamIds.sort((a, b) => initiativeOf(byId.get(b).result.stats) - initiativeOf(byId.get(a).result.stats));
    } else teamIds = teamIds.filter(x => x !== id);
    changed();
  });
  root.querySelectorAll('[data-teamup]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.teamup);
    [teamIds[i - 1], teamIds[i]] = [teamIds[i], teamIds[i - 1]];
    changed();
  });
  root.querySelectorAll('[data-teamdown]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.teamdown);
    [teamIds[i + 1], teamIds[i]] = [teamIds[i], teamIds[i + 1]];
    changed();
  });
  if ($('#teamTurns')) $('#teamTurns').onchange = e => { teamTurns = Number(e.target.value); changed(); };
  if ($('#teamRun')) $('#teamRun').onclick = () => {
    teamResult = teamPlan(game, order.map(x => ({ name: x.name, result: x.result })), { turns: teamTurns });
    renderTeam();
  };
}

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${name}`; });
}
document.querySelectorAll('[data-tab]').forEach(btn => btn.onclick = () => showTab(btn.dataset.tab));

// ---------- Démarrage ----------

game = await fetch(`${import.meta.env.BASE_URL}game.json`).then(r => r.json());
worker.postMessage({ type: 'game', game });
$('#dataInfo').textContent = `${game.items.length} items · ${Object.keys(game.sets).length} panoplies · données DofusDB du ${new Date(game.builtAt).toLocaleDateString('fr-FR')}`;
renderConfig();
renderSaved();
renderTeam();
