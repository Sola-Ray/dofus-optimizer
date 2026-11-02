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
- Forgemagie : poids des runes lus dans les données du jeu (`effectPowerRate`). Une ligne ne dépasse pas 101 de poids, sauf si son jet naturel est plus haut. Un item ne porte pas plus de 101 de poids en over + exo. Un seul exo PA, un seul exo PM et un seul exo PO comptent sur l'ensemble du stuff. Le réglage « % dommages par item » plafonne les lignes de % sorts, distance et mêlée réunies.
- Personnage niveau 200 : 995 points de caractéristique avec les paliers de coût de la classe, +100 par parchemin, 7 PA et 3 PM de base.
- Conditions de port (`CS>299`, `CP<12|CM<6`…) respectées par le solveur. Les conditions hors stats (quêtes, métiers…) sont supposées remplies. Les objets réservés aux MJ sont exclus.

## Limites connues

- **Passifs** des Dofus, prysmaradites et légendaires : traduits à la main dans `src/engine/passives.js`, en deux scénarios (combat moyen sur 5 tours, tour de burst). Chaque hypothèse est affichée sous le stuff.
- **Sorts** : seuls les effets directs de dégâts, de vol de vie et de soin sont simulés. Les effets déclenchés par un autre sort, les glyphes, les poisons et les états ne le sont pas.
- **Plafond de 101 par item** : il vient d'une seule source communautaire, et la place exacte des % sorts / distance avant les résistances reste à confirmer en jeu.
