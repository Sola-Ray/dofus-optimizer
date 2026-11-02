import { DEFAULT_CONFIG } from './engine/optimize.js';
import { simulateSpell, classSpells } from './engine/damage.js';
import { PASSIVES } from './engine/passives.js';
import { STAT_LABEL, ELEMENTS } from './engine/rules.js';

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

// Minimums proposés dans le formulaire (clé, libellé)
const MIN_FIELDS = [
  ['pa', 'PA'], ['pm', 'PM'], ['po', 'Portée'], ['vita', 'Vitalité'], ['resMoy', '% Rés. moyenne'],
  ['crit', '% Critique'], ['invo', 'Invocations'], ['tacle', 'Tacle'], ['fuite', 'Fuite'],
];

let game;
let lastResult = null;
let selectedSpell = null;
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
      return { ...DEFAULT_CONFIG, ...saved, fm };
    }
  } catch { /* stockage indisponible */ }
  return structuredClone(DEFAULT_CONFIG);
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

function renderConfig() {
  const breeds = [...game.breeds].sort((a, b) => a.n.localeCompare(b.n));
  const itemName = id => game.items.find(i => i.id === id)?.n || id;
  $('#config').innerHTML = `
    <section>
      <h2>Personnage</h2>
      <label class="field">Classe
        <select id="breed">${breeds.map(b => `<option value="${b.id}" ${b.id === config.breedId ? 'selected' : ''}>${esc(b.n)}</option>`).join('')}</select>
      </label>
      <fieldset class="chips"><legend>Éléments joués</legend>
        ${ELEMENTS.map(el => `<label class="chip el-${el}"><input type="checkbox" name="el" value="${el}" ${config.elements.includes(el) ? 'checked' : ''}>${EL_LABEL[el]}</label>`).join('')}
      </fieldset>
      <fieldset class="seg"><legend>Portée des attaques</legend>
        <label><input type="radio" name="attack" value="dist" ${config.attack === 'dist' ? 'checked' : ''}>Distance</label>
        <label><input type="radio" name="attack" value="melee" ${config.attack === 'melee' ? 'checked' : ''}>Mêlée</label>
      </fieldset>
      <fieldset class="seg"><legend>Passifs comptés sur</legend>
        <label title="Moyenne sur un combat de 5 tours"><input type="radio" name="scenario" value="moyen" ${config.scenario === 'moyen' ? 'checked' : ''}>Combat moyen</label>
        <label title="Le meilleur tour pour frapper"><input type="radio" name="scenario" value="burst" ${config.scenario === 'burst' ? 'checked' : ''}>Tour de burst</label>
      </fieldset>
      <fieldset class="seg seg3"><legend>Critique</legend>
        <label title="Compare 100 % critique et sans critique, garde le meilleur"><input type="radio" name="critMode" value="auto" ${config.critMode === 'auto' ? 'checked' : ''}>Auto</label>
        <label title="Vise 100 % critique sur tous les sorts de l'élément"><input type="radio" name="critMode" value="crit" ${config.critMode === 'crit' ? 'checked' : ''}>100 %</label>
        <label><input type="radio" name="critMode" value="noncrit" ${config.critMode === 'noncrit' ? 'checked' : ''}>Sans</label>
      </fieldset>
      <label class="check"><input type="checkbox" id="scroll" ${config.fullScroll ? 'checked' : ''}>Full parchemins (+100 partout)</label>
    </section>
    <section>
      <h2>Minimums à respecter</h2>
      <div class="grid2">
        ${MIN_FIELDS.map(([k, l]) => `<label class="field small">${l}<input type="number" min="0" data-min="${k}" value="${config.min[k] ?? ''}" placeholder="—"></label>`).join('')}
      </div>
    </section>
    <section>
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
    </section>
    <section>
      <h2>Items</h2>
      <label class="field small">Niveau minimum des items<input type="number" id="minLevel" min="1" max="200" value="${config.minLevel}"></label>
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

function bindConfig() {
  const root = $('#config');
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'breed') config.breedId = Number(t.value);
    else if (t.name === 'el') config.elements = [...root.querySelectorAll('input[name=el]:checked')].map(i => i.value);
    else if (t.name === 'attack') config.attack = t.value;
    else if (t.name === 'scenario') config.scenario = t.value;
    else if (t.name === 'critMode') config.critMode = t.value;
    else if (t.id === 'scroll') config.fullScroll = t.checked;
    else if (t.id === 'pctExo') config.fm.pctExo = Number(t.value);
    else if (t.id === 'overBudget') config.fm.overBudget = Number(t.value);
    else if (t.id === 'rollQuality') config.rollQuality = Number(t.value);
    else if (t.dataset.fm) config.fm[t.dataset.fm] = t.checked;
    else if (t.dataset.min) {
      if (t.value === '') delete config.min[t.dataset.min];
      else config.min[t.dataset.min] = Number(t.value);
    } else if (t.id === 'minLevel') config.minLevel = Math.max(1, Number(t.value) || 1);
    saveConfig();
  });
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
  $('#run').onclick = run;
}

// ---------- Génération ----------

function run() {
  if (!config.elements.length) { setStatus('Choisis au moins un élément.', 'error'); return; }
  $('#run').disabled = true;
  setStatus('Préparation du modèle…');
  worker.postMessage({ type: 'run', config });
}

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    setStatus(`${MODE_LABEL[data.mode]} · itération ${data.iter} · ${fmt(data.value)} dégâts moyens par sort · ${data.cores} cœurs`);
  } else if (data.type === 'result') {
    $('#run').disabled = false;
    lastResult = data.result;
    selectedSpell = null;
    const warn = [...data.result.violations.map(v => `${STAT_LABEL[v.key] || v.key} < ${v.min}`), ...data.result.unmetConditions.map(n => `condition non remplie : ${n}`)];
    const took = ` (${Math.round(data.result.seconds)} s sur ${data.result.cores} cœurs)`;
    setStatus(warn.length ? `Stuff trouvé${took}, avec des réserves : ${warn.join(', ')}` : `Stuff trouvé${took}.`, warn.length ? 'warn' : 'ok');
    renderStuff();
    renderSim();
  } else if (data.type === 'error') {
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
  rfTerre: 'tx_strength', pctSorts: 'tx_damagesPercent', pctDist: 'tx_damagesPercent', pctMelee: 'tx_damagesPercent',
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

function renderStuff() {
  const r = lastResult;
  const items = [...r.items].sort((a, b) => SLOT_ORDER.indexOf(a.s) - SLOT_ORDER.indexOf(b.s));
  const passiveNotes = r.items.filter(i => i.passive && PASSIVES[i.passive]).map(i => {
    const p = game.passives[i.passive];
    return `<li><strong>${esc(i.n)}</strong> — ${esc(p?.d || '')}${PASSIVES[i.passive].note ? `<br><em>Hypothèse : ${esc(PASSIVES[i.passive].note)}</em>` : ''}</li>`;
  }).join('');
  const s = r.stats;
  const groups = [
    ['Général', ['pa', 'pm', 'po', 'vita', 'invo', 'crit']],
    ['Caractéristiques', ['force', 'intel', 'chance', 'agi', 'sagesse', 'puissance']],
    ['Dommages', ['do', 'doFeu', 'doEau', 'doTerre', 'doAir', 'doNeutre', 'doCrit', 'pctSorts', 'pctDist', 'pctMelee', 'pctFinaux']],
    ['Résistances', ['resFeu', 'resEau', 'resTerre', 'resAir', 'resNeutre', 'rfFeu', 'rfEau', 'rfTerre', 'rfAir', 'rfNeutre', 'resCrit']],
    ['Divers', ['tacle', 'fuite', 'retPA', 'retPM', 'esqPA', 'esqPM', 'ini', 'pp', 'soins']],
  ];
  $('#tab-stuff').innerHTML = `
    <div class="score-row">
      ${Object.entries(r.elementScores).map(([el, v]) => `<div class="score el-${el}"><span>${EL_LABEL[el]}</span><strong>${fmt(v)}</strong><small>dégâts moyens par sort (sans cible)</small></div>`).join('')}
      <div class="score"><span>Points de carac.</span><strong>${Object.entries(r.points).map(([k, v]) => `${v} ${STAT_LABEL[k]}`).join(', ') || '—'}</strong><small>${r.pointsCost} / 995 points utilisés</small></div>
    </div>
    ${critBanner(r)}
    <div class="items">
      ${items.map(it => `
        <article class="item">
          <header><img src="${ITEM_IMG(it.img)}" alt="" width="48" height="48" loading="lazy">
            <div><small>${SLOT_LABEL[it.s]} · niv. ${it.l}</small><h3>${esc(it.n)}</h3>${it.set ? `<small class="set">${esc(game.sets[it.set]?.n || '')}</small>` : ''}</div>
          </header>
          <ul class="lines">${statLines(it.st, '', it.r || {})}</ul>
          ${Object.keys(it.fm).length ? `<ul class="lines fm"><li class="fm-title">Forgemagie</li>${statLines(it.fm, 'fm')}</ul>` : ''}
          ${it.trans ? `<ul class="lines fm"><li class="fm-title">Transcendance · ${esc(it.trans.n)}</li>${statLines({ [it.trans.k]: it.trans.v }, 'fm')}<li class="locked">Empêche les futures forgemagies</li></ul>` : ''}
          ${it.c ? `<p class="cond">Condition : ${esc(it.c)}</p>` : ''}
        </article>`).join('')}
    </div>
    ${r.setBonuses.length ? `<h2>Bonus de panoplie</h2><div class="sets">${r.setBonuses.map(b => `<div class="setbox"><strong>${esc(b.n)}</strong> (${b.count} items)<ul class="lines">${statLines(b.bonus)}</ul></div>`).join('')}</div>` : ''}
    <h2>Caractéristiques finales</h2>
    <div class="stat-groups">
      ${groups.map(([title, keys]) => `<div class="stat-group"><h3>${title}</h3><dl>${keys.map(k => `<dt>${statIcon(k)}${STAT_LABEL[k]}</dt><dd>${fmt(s[k] || 0)}</dd>`).join('')}</dl></div>`).join('')}
    </div>
    <h2>Valeur des options de forgemagie sur ce stuff</h2>
    <p class="hint">Gain de dégâts si on ajoutait cette seule option au stuff final. Les overs sont comparés à poids égal à 1 % de dommages (15).</p>
    <table class="compare"><tbody>${r.fmComparison.filter(o => o.gain > 0).map(o => `<tr class="${o.trans ? 'trans' : ''}"><td>${esc(o.label)}</td><td>+${o.pct.toFixed(2)} %</td><td>+${fmt(o.gain)}</td></tr>`).join('')}</tbody></table>
    ${passiveNotes ? `<h2>Passifs pris en compte</h2><ul class="passives">${passiveNotes}</ul>` : ''}
  `;
}

function critBanner(r) {
  const c = r.crit;
  const runs = c.runs.map(x => `${MODE_LABEL[x.mode]} : <strong>${fmt(x.score)}</strong>`).join(' · ');
  const target = c.mode === 'crit' ? ` (${c.target} % de critique du stuff visés pour que tous les sorts soient à 100 %, actuel ${fmt(r.stats.crit || 0)} %)` : '';
  return `<p class="banner">Choix du moteur : <strong>${MODE_LABEL[c.mode]}</strong>${target}. ${c.runs.length > 1 ? runs : ''}${c.failed ? ` · ${esc(c.failed)}` : ''}</p>`;
}

// ---------- Onglet Simulation ----------

function renderSim() {
  if (!lastResult) return;
  const r = lastResult;
  const breed = game.breeds.find(b => b.id === r.config.breedId);
  const ctx = { ...r.ctx, refSpells: {} };
  const spells = classSpells(game, breed.id);
  const sims = new Map(spells.map(sp => [sp.id, simulateSpell(sp, r.stats, ctx, target)]));
  const offensive = sp => sp.lines.some(l => l.k !== 'soin');
  const tField = (k, l) => `<label class="field small">${l}<input type="number" data-target="${k}" value="${target[k] ?? 0}"></label>`;
  if (!selectedSpell || !sims.has(selectedSpell)) selectedSpell = spells.filter(offensive).sort((a, b) => sims.get(b.id).average - sims.get(a.id).average)[0]?.id;
  const sel = spells.find(s => s.id === selectedSpell);
  const res = sel && sims.get(sel.id);
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
    <div class="sim">
      <ul class="spell-list" role="listbox" aria-label="Sorts">
        ${breed.variants.map(pair => `<li class="pair">${pair.map(id => game.spells[id]).filter(Boolean).map(sp => {
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

document.querySelectorAll('[data-tab]').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b === btn)));
  $('#tab-stuff').hidden = btn.dataset.tab !== 'stuff';
  $('#tab-sim').hidden = btn.dataset.tab !== 'sim';
});

// ---------- Démarrage ----------

game = await fetch(`${import.meta.env.BASE_URL}game.json`).then(r => r.json());
worker.postMessage({ type: 'game', game });
$('#dataInfo').textContent = `${game.items.length} items · ${Object.keys(game.sets).length} panoplies · données DofusDB du ${new Date(game.builtAt).toLocaleDateString('fr-FR')}`;
renderConfig();
