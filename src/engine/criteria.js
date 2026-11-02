// Conditions de port des items (« CS>299&CI>199 », « CP<12|CM<6 »…) en forme normale disjonctive :
// une liste de groupes ET, dont un seul doit être vrai. Les conditions hors stats (quêtes, métiers,
// alignement…) sont supposées remplies.

const KEYS = {
  CS: 'force', CI: 'intel', CC: 'chance', CA: 'agi', CV: 'vita', CW: 'sagesse',
  CP: 'pa', CM: 'pm', pk: 'setBonus',
};

function tokenize(s) {
  return s.match(/\(|\)|&|\||[A-Za-z]{2}[<>=!~][^&|()]*/g) || [];
}

// Grammaire : or := and ('|' and)* ; and := atom ('&' atom)* ; atom := TERM | '(' or ')'
function parse(tokens) {
  let i = 0;
  const or = () => {
    let groups = and();
    while (tokens[i] === '|') { i++; groups = [...groups, ...and()]; }
    return groups;
  };
  const and = () => {
    let groups = atom();
    while (tokens[i] === '&') {
      i++;
      const right = atom();
      groups = groups.flatMap(g => right.map(r => [...g, ...r]));
    }
    return groups;
  };
  const atom = () => {
    const t = tokens[i++];
    if (t === '(') { const g = or(); i++; return g; }
    const m = /^([A-Za-z]{2})([<>=!~])(.*)$/.exec(t || '');
    const key = m && KEYS[m[1]];
    const v = m && Number(m[3]);
    if (!key || !(m[2] === '<' || m[2] === '>') || !Number.isFinite(v)) return [[]]; // ignoré = vrai
    // > v  ->  >= v + 1 ; < v  ->  <= v - 1
    return [[m[2] === '>' ? { key, min: v + 1 } : { key, max: v - 1 }]];
  };
  return or();
}

export function parseCriteria(str) {
  if (!str) return null;
  const groups = parse(tokenize(str));
  if (groups.some(g => g.length === 0)) return null; // un groupe toujours vrai
  return groups;
}

export function checkCriteria(groups, stats) {
  if (!groups) return true;
  return groups.some(g => g.every(a => {
    const v = stats[a.key] || 0;
    return (a.min === undefined || v >= a.min) && (a.max === undefined || v <= a.max);
  }));
}
