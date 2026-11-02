// Pool de solveurs multi-cœurs.
// Le temps de résolution d'un même modèle varie beaucoup selon la graine aléatoire de HiGHS
// (de 9 à 22 s mesuré) : chaque résolution est lancée en course sur plusieurs cœurs avec des
// graines différentes, la première réponse gagne et les autres workers sont relancés.

let nextId = 1;

export class SolverPool {
  constructor(size) {
    this.size = size;
    this.idle = [];
    this.waiting = [];
    for (let i = 0; i < size; i++) this.idle.push(this.spawn());
  }

  spawn() {
    return new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
  }

  async acquire(n) {
    const got = this.idle.splice(0, n);
    while (got.length === 0) {
      await new Promise(r => this.waiting.push(r));
      got.push(...this.idle.splice(0, n));
    }
    return got;
  }

  release(worker) {
    this.idle.push(worker);
    const w = this.waiting.shift();
    if (w) w();
  }

  // Résout en course sur `racers` workers ; renvoie le premier résultat
  async solve(lp, options = {}, racers = 1) {
    const workers = await this.acquire(racers);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let done = false;
      workers.forEach((w, i) => {
        w.onmessage = ({ data }) => {
          if (data.id !== id || done) return;
          done = true;
          for (const other of workers) {
            if (other === w) this.release(other);
            else { other.terminate(); this.release(this.spawn()); } // arrête les perdants
          }
          if (data.error) reject(new Error(data.error));
          else resolve(data.result);
        };
        w.onerror = e => {
          if (done) return;
          done = true;
          workers.forEach(o => { o.terminate(); this.release(this.spawn()); });
          reject(new Error(e.message || 'Erreur du solveur'));
        };
        w.postMessage({ id, lp, options: { ...options, random_seed: i } });
      });
    });
  }
}
