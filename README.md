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

Test rapide du moteur en ligne de commande : `node test/run-eni.mjs`, et `node test/run-leveling.mjs` pour le mode leveling.

## Fiches sauvegardées

Un stuff généré (ou un plan de leveling) se sauvegarde sous un nom modifiable, proposé par défaut à partir du mode, de la classe, du niveau et de l'élément (« Stuff Eniripsa niv. 200 Feu »). L'onglet Sauvegardes liste les fiches pour les rouvrir ou les supprimer. Elles sont gardées dans le navigateur (localStorage) : elles ne passent pas d'un navigateur ou d'un appareil à l'autre.

## Mode leveling

Un stuff par palier de niveau (par défaut 50, 80, 110, 150 et 200, avec des PA / PM minimums propres à chaque palier). Les niveaux d'obtention des sorts de l'élément sont proposés comme paliers. Les paliers sont optimisés **ensemble** : changer un item coûte une pénalité, réglée par « changer un item seulement s'il rapporte au moins X % de dégâts » (3 % par défaut). Le moteur garde donc les panoplies qui restent bonnes plusieurs paliers au lieu de tout racheter, comme les stuffs de leveling des guides. Chaque palier affiche les items gardés et nouveaux, et ses dégâts comparés au meilleur stuff possible à ce niveau sans rien garder.

Par défaut : sans critique, sans forgemagie ni transcendance, parchemins réglables (0 à 100). Calcul : chaque palier seul (sur les 20 meilleurs items par emplacement et par direction, union sur tous les paliers), puis un seul modèle qui contient tous les paliers, en partant de ces solutions. Environ 2 minutes pour 5 paliers.

## Fonctionnement

- **Données** : API [DofusDB](https://api.dofusdb.fr). Le script récupère équipements, panoplies, classes, variantes de sorts, sorts et passifs, puis les compacte dans `public/game.json`.
- **Moteur** : programme linéaire en nombres entiers résolu par [HiGHS](https://github.com/lovasoa/highs-js) (WebAssembly, dans un Web Worker). Les dégâts sont des produits de stats, donc non linéaires. Le moteur maximise leur logarithme par plans coupants : chaque itération ajoute une tangente au point trouvé, jusqu'à convergence (3 à 6 itérations).
- **Objectif** : dégâts moyens attendus des sorts de l'élément, critique compris. Le moteur décide donc lui-même si jouer critique vaut le coup. En multi-élément, il maximise l'élément le plus faible.
- **Élément automatique** : un calcul par élément (feu, eau, terre, air ; le neutre n'est pas proposé), on garde celui qui fait le plus de dégâts. Un mélange d'éléments ne peut pas battre le meilleur élément seul, puisque le multi-élément maximise l'élément le plus faible. En leveling, les éléments sont comparés sur la moyenne des dégâts des paliers. Les calculs tournent en parallèle, mais c'est environ 4 fois plus long.

## Règles modélisées

- Formule : `floor(jet × (100 + carac + puissance) / 100 + Dommages + Dommages élément [+ Dommages critiques])`, puis `× (1 + % sorts) × (1 + % distance ou mêlée)`, puis les dommages finaux, puis la résistance fixe et la résistance en % de la cible.
- Forgemagie réaliste : lignes au jet max (ou à 95 / 85 % selon le réglage), puis **une seule finition par item** (sauf exo PA / PM / PO + over si le poids total tient dans 101, par ex. exo PM + 1 % critique), choisie par le moteur parmi celles autorisées : exo PA / PM / PO (un seul de chaque sur le stuff), exo 1 % de dommages (sorts, distance ou mêlée), over sur une ligne dans un budget de poids, ou rune de transcendance (verrouille l'item). Poids des runes lus dans les données du jeu (`effectPowerRate`), une ligne ne dépasse pas 101 de poids.
- Critique : en mode auto, le moteur calcule un stuff qui met tous les sorts de l'élément à 100 % de critique et un stuff sans critique, puis garde le meilleur. On peut aussi forcer l'un ou l'autre.
- Calcul rapide : le modèle reste chargé dans HiGHS entre les itérations (coupes ajoutées à chaud, départ sur la solution précédente), trois tangentes de départ sur des stats de fin de jeu, une phase sur les 40 meilleurs items par emplacement puis une phase sur tous les items, et un solveur par mode de critique, en parallèle.
- Personnage niveau 200 : 995 points de caractéristique avec les paliers de coût de la classe, +100 par parchemin, 7 PA et 3 PM de base.
- Conditions de port (`CS>299`, `CP<12|CM<6`…) respectées par le solveur. Les conditions hors stats (quêtes, métiers…) sont supposées remplies. Les objets réservés aux MJ sont exclus.

## Limites connues

- **Passifs** des Dofus, prysmaradites et légendaires : traduits à la main dans `src/engine/passives.js`, en trois scénarios (combat moyen sur 5 tours, tour 1, tour de burst). Les PA gagnés en combat (Ocre, Prycipithon, Ganymède…) comptent comme des dégâts en plus sur le tour. Chaque hypothèse est affichée sous le stuff.
- **Sorts** : seuls les effets directs de dégâts, de vol de vie et de soin sont simulés. Les effets déclenchés par un autre sort, les glyphes, les poisons et les états ne le sont pas.
- **Taux de réussite de la forgemagie** : Ankama ne publie pas de formule. Le modèle « une finition par item » et les budgets d'over viennent de guides communautaires (Gamosaurus, Huzounet, Papycha, Tofus). La place exacte des % sorts / distance avant les résistances reste à confirmer en jeu.
