// Worker solveur : garde une session HiGHS persistante (modèle chargé entre les itérations)
// ou fait une résolution ponctuelle. Un worker par mode de critique : ils tournent en parallèle.
import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import { createSession } from './engine/session.js';

const highsPromise = highsLoader({ locateFile: () => wasmUrl });
let session = null;

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    const highs = await highsPromise;
    let result;
    if (op === 'open') { session?.close(); session = createSession(highs, data.lp, data.options); }
    else if (op === 'run') result = session.run(data.options);
    else if (op === 'addCuts') session.addCuts(data.cuts);
    else if (op === 'warmStart') session.warmStart(data.start);
    else if (op === 'setBounds') session.setBounds(data.names, data.lo, data.hi);
    else if (op === 'close') { session?.close(); session = null; }
    else if (op === 'solve') {
      const r = highs.solve(data.lp, data.options);
      const cols = {};
      for (const [k, v] of Object.entries(r.Columns || {})) if (v.Primal) cols[k] = { Primal: v.Primal };
      result = { Status: r.Status, ObjectiveValue: r.ObjectiveValue, Columns: cols };
    }
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
