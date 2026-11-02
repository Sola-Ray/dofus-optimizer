// Session de résolution persistante : le modèle reste chargé dans HiGHS entre les itérations
// de Kelley. On ajoute les nouvelles coupes et on repart de la solution précédente, au lieu de
// tout reconstruire. Le solveur prouve alors l'optimum en quelques secondes au lieu de ~30 s.

export function createSession(highs, lp, options = {}) {
  const model = highs.createModel({ format: 'lp', data: lp });
  model.options.set({ output_flag: false, ...options });
  const n = model.getDimensions().numCols;
  const names = Array.from({ length: n }, (_, j) => model.getColName(j));
  const index = new Map(names.map((nm, j) => [nm, j]));
  const { modelStatus } = highs.constants;

  return {
    // Résout ; cols = variables non nulles, au format { nom: { Primal } } du moteur
    run(opts = {}) {
      model.options.set(opts);
      model.run();
      const status = model.getModelStatus();
      const sol = model.getSolution().colValue;
      const cols = {};
      for (let j = 0; j < n; j++) if (sol[j]) cols[names[j]] = { Primal: sol[j] };
      return {
        optimal: status === modelStatus.optimal,
        infeasible: status === modelStatus.infeasible,
        feasible: Object.keys(cols).length > 0,
        objective: model.getObjectiveValue(),
        cols,
      };
    },
    // coupes = [{ terms: { nomDeVariable: coef }, rhs }] ajoutées en  Σ coef·var <= rhs
    addCuts(cuts) {
      for (const c of cuts) {
        const indices = [], values = [];
        for (const [name, v] of Object.entries(c.terms)) {
          const j = index.get(name);
          if (j !== undefined && v) { indices.push(j); values.push(v); }
        }
        model.addRow(-highs.infinity, c.rhs, { indices, values });
      }
    },
    // Point de départ { nom: valeur } ; les variables absentes valent 0
    warmStart(byName) {
      model.setSolution({ colValue: names.map(nm => byName[nm]?.Primal ?? byName[nm] ?? 0) });
    },
    close() { model.dispose(); },
  };
}
