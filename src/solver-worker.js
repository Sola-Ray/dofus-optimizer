// Un solveur HiGHS par worker : le pool en lance plusieurs pour utiliser tous les cœurs.
import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';

const highsPromise = highsLoader({ locateFile: () => wasmUrl });

self.onmessage = async ({ data }) => {
  const highs = await highsPromise;
  try {
    const r = highs.solve(data.lp, data.options);
    // seules les colonnes sont utiles au moteur : on allège le message
    const cols = {};
    for (const [k, v] of Object.entries(r.Columns || {})) if (v.Primal) cols[k] = { Primal: v.Primal };
    self.postMessage({ id: data.id, result: { Status: r.Status, ObjectiveValue: r.ObjectiveValue, Columns: cols } });
  } catch (e) {
    self.postMessage({ id: data.id, error: e.message || String(e) });
  }
};
