# dofus-optimizer

Optimiseur de stuff Dofus 3. Pour une classe et un ou plusieurs éléments, il choisit les équipements, les Dofus, la forgemagie (overs et exos) et la répartition des points de caractéristique qui maximisent les dégâts. Il respecte les minimums demandés (PA, PM, résistances…) et les conditions de port. L'onglet Simulation affiche ensuite le jet normal et le jet critique de chaque sort de la classe contre une cible paramétrable.

## Lancer

```bash
npm install
npm run dev
```

Pour mettre à jour les données après un patch (environ 1 minute) :

```bash
npm run data
```

Test rapide du moteur en ligne de commande : `node test/run-eni.mjs`.

## Fonctionnement

- **Données** : API [DofusDB](https://api.dofusdb.fr). Le script récupère équipements, panoplies, classes, variantes de sorts, sorts et passifs, puis les compacte dans `public/game.json`.
- **Moteur** : programme linéaire en nombres entiers résolu par [HiGHS](https://github.com/lovasoa/highs-js) (WebAssembly, dans un Web Worker). Les dégâts sont des produits de stats, donc non linéaires. Le moteur maximise leur logarithme par plans coupants : chaque itération ajoute une tangente au point trouvé, jusqu'à convergence (3 à 6 itérations).
- **Objectif** : dégâts moyens attendus des sorts de l'élément, critique compris. Le moteur décide donc lui-même si jouer critique vaut le coup. En multi-élément, il maximise l'élément le plus faible.

## Règles modélisées

- Formule : `floor(jet × (100 + carac + puissance) / 100 + Dommages + Dommages élément [+ Dommages critiques])`, puis `× (1 + % sorts) × (1 + % distance ou mêlée)`, puis les dommages finaux, puis la résistance fixe et la résistance en % de la cible.
- Forgemagie réaliste : lignes au jet max (ou à 95 / 85 % selon le réglage), puis **une seule finition par item**, choisie par le moteur parmi celles autorisées : exo PA / PM / PO (un seul de chaque sur le stuff), exo 1 % de dommages (sorts, distance ou mêlée), over sur une ligne dans un budget de poids, ou rune de transcendance (verrouille l'item). Poids des runes lus dans les données du jeu (`effectPowerRate`), une ligne ne dépasse pas 101 de poids.
- Critique : en mode auto, le moteur calcule un stuff qui met tous les sorts de l'élément à 100 % de critique et un stuff sans critique, puis garde le meilleur. On peut aussi forcer l'un ou l'autre.
- Calcul multi-cœurs : un pool de solveurs (un par cœur, 8 au plus). Chaque résolution est lancée en course avec des graines différentes, la plus rapide gagne, et les deux modes de critique tournent en parallèle.
- Personnage niveau 200 : 995 points de caractéristique avec les paliers de coût de la classe, +100 par parchemin, 7 PA et 3 PM de base.
- Conditions de port (`CS>299`, `CP<12|CM<6`…) respectées par le solveur. Les conditions hors stats (quêtes, métiers…) sont supposées remplies. Les objets réservés aux MJ sont exclus.

## Limites connues

- **Passifs** des Dofus, prysmaradites et légendaires : traduits à la main dans `src/engine/passives.js`, en deux scénarios (combat moyen sur 5 tours, tour de burst). Chaque hypothèse est affichée sous le stuff.
- **Sorts** : seuls les effets directs de dégâts, de vol de vie et de soin sont simulés. Les effets déclenchés par un autre sort, les glyphes, les poisons et les états ne le sont pas.
- **Taux de réussite de la forgemagie** : Ankama ne publie pas de formule. Le modèle « une finition par item » et les budgets d'over viennent de guides communautaires (Gamosaurus, Huzounet, Papycha, Tofus). La place exacte des % sorts / distance avant les résistances reste à confirmer en jeu.
