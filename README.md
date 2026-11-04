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

Tests : `npm test` (voir Validation). Test rapide du moteur en ligne de commande : `node test/run-eni.mjs`, `node test/run-leveling.mjs` pour le mode leveling, et `node test/run-edit.mjs [emplacement]` pour les alternatives et le recalcul de la forgemagie.

## Modifier un stuff généré

En mode stuff, chaque item a deux boutons :

- **Alternatives** : tous les items de l'emplacement, essayés un par un à la place de l'actuel, triés par dégâts avec l'écart en %. Le reste du stuff est figé (items, forgemagie, points de caractéristique). Le nouvel item reprend la finition de l'ancien quand elle tient sur lui. Les problèmes sont affichés sur chaque ligne : finition impossible, minimum non tenu, condition de port non remplie. Un item déjà porté ailleurs est rangé en bas.
- **Modifier** : chaque ligne d'effet et de forgemagie devient un champ, pour taper son jet réel.

Après une modification, un bandeau donne les dégâts face au stuff généré et liste les problèmes. **Recalculer la FM** refait seulement la forgemagie de tout le stuff, sans changer les items ni les points. **Recalculer le stuff autour** garde les items que tu as mis à la place et relance le moteur complet pour tout le reste, avec les réglages qui ont produit le stuff (les lignes retouchées à la main ne sont pas gardées). **Revenir au stuff généré** annule tout. Un stuff modifié se sauvegarde comme un autre.

## Fiches sauvegardées

Un stuff généré (ou un plan de leveling) se sauvegarde sous un nom modifiable, proposé par défaut à partir du mode, de la classe, du niveau et de l'élément (« Stuff Eniripsa niv. 200 Feu »). L'onglet Sauvegardes liste les fiches pour les rouvrir ou les supprimer. Elles sont gardées dans le navigateur (localStorage) : elles ne passent pas d'un navigateur ou d'un appareil à l'autre.

## Dégâts par tour

L'onglet Simulation donne aussi les dégâts **par tour** : la meilleure suite de sorts avec les PA du stuff, en respectant les lancers par tour, par cible et les relances (limites lues dans les données du jeu). Deux chiffres : le meilleur tour (tous les sorts disponibles) et le tour moyen sur un combat de 5 tours (relances comprises). L'arme compte avec son % dommages armes et son critique.

## Équipe

L'onglet Équipe assemble 2 à 4 fiches sauvegardées et dit **qui buffer, avec quoi et à quel tour** pour maximiser les dégâts de toute l'équipe :

- **Catalogue des buffs** (`src/engine/buffs.js`) : buffs d'alliés (PA, Puissance, Dommages, % dommages…) et malus d'ennemis (résistances, dommages subis), lus dans les données du jeu, plus une liste codée à la main pour ce qui passe par un état ou un sous-sort. Ce qui n'est pas compté est affiché avec la raison. Aucun catalogue de buffs à jour n'existe en ligne : tout vient des données DofusDB.
- **Ordre de jeu** : par initiative, modifiable. La durée d'un buff se décompte au début du tour de son lanceur : un allié qui joue avant le lanceur n'en profite qu'au tour suivant.
- **Eniripsa** : un Encouragement (Stimulant, Galvanisant, Vivifiant) lancé sur une Fiole la fait éclater et touche les alliés autour, pour 2 PA de plus (mécanique absente des données, codée à la main). Un allié ne garde qu'un Encouragement à la fois : le dernier lancé remplace les autres (lu dans les sous-sorts). La potion d'une Fiole remplie (+100 dans une caractéristique pour l'allié qui l'attaque) est aussi comptée.
- **Coût** : buffer coûte des PA, donc les dégâts que le lanceur aurait faits. Un buff n'est retenu que s'il rapporte plus à l'équipe. Les buffs non cumulables (la plupart) ne s'additionnent pas en les relançant.
- **Hypothèses** : équipe groupée (les buffs de zone touchent tout le monde), une seule cible, stuffs figés. Recherche gloutonne : chaque buff retenu est rentable, mais l'optimum n'est pas prouvé.

## Lignes de dégâts des sorts

Les données répètent souvent une ligne de dégâts : variante en zone (Vacarme sur un Feu Follet), variante selon l'état du lanceur (Pandawa Sobre / Saoul), ligne réservée aux invocations ou à une cible sous un état (Flèche Dévorante). Le moteur ne garde que ce qui frappe un ennemi ordinaire lors d'un lancer direct ; une même ligne dans la même zone reste un vrai second coup (Dagues Boomerang). Les poisons comptent pour un déclenchement. Torrent Arcanique est codé à la main : il frappe dans les 4 éléments à la fois (les Dommages et Dommages critiques comptent sur chaque ligne), avec 3 combinaisons élémentaires supposées avant le lancer (+2 dommages de base chacune). Supernova frappe le meilleur et le pire élément du lanceur. Les sorts à cumul (Pugilat, Fureur, Colère de Iop, Flèche Punitive, Tumulte, Tourbière…, 31 sorts) comptent leur bonus moyen par lancer selon une hypothèse de jeu écrite dans `SPELL_RULES` (`src/engine/damage.js`) ; l'onglet Simulation affiche ces jets bonus compris. Les lignes d'affichage (effet joué sous condition par un sous-sort), les variantes exclusives (vie de la cible sous 50 %, bouclier, portail, état du lanceur) et les lignes aléatoires (comptées pour leur probabilité) ne sont pas additionnées.

## Mode leveling

Un stuff par palier de niveau (par défaut 50, 80, 110, 150 et 200, avec des PA / PM minimums propres à chaque palier). Les niveaux d'obtention des sorts de l'élément sont proposés comme paliers. Les paliers sont optimisés **ensemble** : changer un item coûte une pénalité, réglée par « changer un item seulement s'il rapporte au moins X % de dégâts » (3 % par défaut). Le moteur garde donc les panoplies qui restent bonnes plusieurs paliers au lieu de tout racheter, comme les stuffs de leveling des guides. Chaque palier affiche les items gardés et nouveaux, et ses dégâts comparés au meilleur stuff possible à ce niveau sans rien garder.

Par défaut : sans critique, sans forgemagie ni transcendance, parchemins réglables (0 à 100). Calcul : chaque palier seul (sur les 20 meilleurs items par emplacement et par direction, union sur tous les paliers), puis un seul modèle qui contient tous les paliers, en partant de ces solutions. Environ 2 minutes pour 5 paliers.

## Fonctionnement

- **Données** : API [DofusDB](https://api.dofusdb.fr). Le script récupère équipements, panoplies, classes, variantes de sorts, sorts et passifs, puis les compacte dans `public/game.json`.
- **Moteur** : programme linéaire en nombres entiers résolu par [HiGHS](https://github.com/lovasoa/highs-js) (WebAssembly, dans un Web Worker). Les dégâts sont des produits de stats, donc non linéaires. Le moteur maximise leur logarithme par plans coupants : chaque itération ajoute une tangente au point trouvé, jusqu'à convergence (3 à 6 itérations).
- **Objectif** : dégâts moyens attendus des sorts optimisés, critique compris. Le moteur décide donc lui-même si jouer critique vaut le coup. En multi-élément, il maximise l'élément le plus faible.
- **Sorts optimisés** : ceux cochés dans « Sorts à optimiser » (par classe). Sinon, automatique : les sorts d'un combat de 5 tours joué au mieux (limites de lancer et relances), sur des stats de fin de jeu, pondérés par leur nombre de lancers. En multi-élément, un seul combat avec les sorts de tous les éléments : on alterne les éléments pour lancer chaque sort à deux lignes. Les sorts retenus sont affichés au-dessus du stuff.
- **Élément automatique** : un calcul par élément (feu, eau, terre, air ; le neutre n'est pas proposé), on garde celui qui fait le plus de dégâts. Un mélange d'éléments ne peut pas battre le meilleur élément seul, puisque le multi-élément maximise l'élément le plus faible. En leveling, les éléments sont comparés sur la moyenne des dégâts des paliers. Les calculs tournent en parallèle, mais c'est environ 4 fois plus long.

## Règles modélisées

- Formule : `floor(jet × (100 + carac + puissance) / 100 + Dommages + Dommages élément [+ Dommages critiques])`, puis `× (1 + % sorts) × (1 + % distance ou mêlée)`, puis les dommages finaux, puis la résistance fixe et la résistance en % de la cible.
- Forgemagie réaliste : lignes au jet max (ou à 95 / 85 % selon le réglage), puis **une seule finition par item** (sauf exo PA / PM / PO + over si le poids total tient dans 101, par ex. exo PM + 1 % critique), choisie par le moteur parmi celles autorisées : exo PA / PM / PO (un seul de chaque sur le stuff), exo 1 % de dommages (sorts, distance ou mêlée), over sur une ligne dans un budget de poids, ou rune de transcendance (verrouille l'item). Poids des runes lus dans les données du jeu (`effectPowerRate`), une ligne ne dépasse pas 101 de poids.
- Critique : en mode auto, le moteur calcule quatre stuffs : tous les sorts de l'élément à 100 % de critique, sans critique, et deux compromis (au moins 20 et 40 points de critique de moins que le 100 %, par exemple 70 et 50 % pour l'Eniripsa feu), puis garde le meilleur. Les compromis gagnent souvent : Eniripsa feu à 75 % de critique fait 4,6 % de plus que les deux extrêmes. On peut aussi forcer 100 % ou sans critique.
- Calcul rapide : le modèle reste chargé dans HiGHS entre les itérations (coupes ajoutées à chaud, départ sur la solution précédente), trois tangentes de départ sur des stats de fin de jeu, une pré-boucle sur la relaxation continue, une phase sur les 40 meilleurs items par emplacement puis une phase sur tous les items (où les items qui ne peuvent pas battre la première phase sont écartés par coûts réduits), des inégalités valides sur les panoplies qui resserrent la relaxation, et un solveur par mode de critique, en parallèle.
- Personnage niveau 200 : 995 points de caractéristique avec les paliers de coût de la classe, +100 par parchemin, 7 PA, 3 PM et 1 050 PdV de base (50 + 5 par niveau).
- Minimums : n'importe quelle stat (bloc « Autres minimums »). Initiative, tacle, fuite, prospection, esquives, retraits PA / PM et pods comptent comme en jeu, caractéristiques comprises : initiative = items + force + intelligence + chance + agilité, tacle et fuite = items + agilité / 10, esquives et retraits = items + sagesse / 10, prospection = 100 + items + chance / 10, pods = 1 000 + items + 5 × force (arrondis par défaut, vérifié sur DofusBook). Ces stats sont aussi affichées en total dans les caractéristiques finales.
- Conditions de port (`CS>299`, `CP<12|CM<6`…) respectées par le solveur. Les conditions hors stats (quêtes, métiers…) sont supposées remplies. Les objets réservés aux MJ sont exclus.

## Limites connues

- **Passifs** des Dofus, prysmaradites et légendaires : traduits à la main dans `src/engine/passives.js`, en trois scénarios (combat moyen sur 5 tours, tour 1, tour de burst). Les PA gagnés en combat (Ocre, Prycipithon, Ganymède…) comptent comme des dégâts en plus sur le tour. Les poisons des passifs (Ébène, Pestilence) profitent de la caractéristique, de la Puissance et des dommages finaux, et sont répartis sur les sorts du tour. Les passifs sans effet sur les dégâts (boucliers, soins, résistances, placement) sont affichés comme tels. Chaque hypothèse est affichée sous le stuff.
- **Sorts** : seuls les effets directs de dégâts, de vol de vie et de soin sont simulés. Les effets déclenchés par un autre sort, les glyphes, les poisons et les états ne le sont pas.
- **Taux de réussite de la forgemagie** : Ankama ne publie pas de formule. Le modèle « une finition par item » et les budgets d'over viennent de guides communautaires (Gamosaurus, Huzounet, Papycha, Tofus). % sorts et % distance se multiplient comme dans DofusBook (vérifié sur ses jets, voir Validation) ; leur place avant les résistances de la cible reste à confirmer en jeu.
- **Classes à mécaniques** : les invocations, glyphes, états et poisons de sort ne comptent pas. Pour Féca, Huppermage, Zobal, Xélor, Osamodas et Sadida, les écarts avec les stuffs de Huzounet sont les plus grands (+40 à +58 %) : ces stuffs servent aussi des dégâts que le moteur ne voit pas. Les dégâts affichés sont moins sûrs pour ces classes.

## Validation

`npm test` (environ 3 minutes, lancé aussi par GitHub Actions avant chaque déploiement) :

- **Stats** : 9 stuffs de Huzounet (classes, budgets et éléments variés) donnent exactement les 32 stats affichées par DofusBook (caractéristiques, dommages, résistances, critique, PA / PM / PO).
- **Jets de sorts** : les 26 sorts sans cumul relevés sur DofusBook (Iop terre légendaire avec % sorts, % distance et Dommages critiques négatifs ; Eniripsa feu) donnent les mêmes jets normaux et critiques.
- **Optimiseur** : sur un stuff de Huzounet, le moteur fait au moins autant de dégâts sous les mêmes contraintes, avec un score figé pour repérer une régression.
- Formule calculée à la main, lignes de dégâts gardées (Vacarme, Flèche Dévorante, Dagues Boomerang), paliers de panoplie, conditions de port après la forgemagie.

`node test/compare-huzounet.mjs` compare le moteur aux 117 stuffs de Huzounet à un ou deux éléments (budgets prestige et légendaire, novembre 2026), sous leurs minimums (PA, PM, PO, résistance moyenne, vitalité) et avec la même forgemagie (exos PA / PM / PO). Le moteur fait au moins autant sur les 117 : +24 % de dégâts en médiane d'après son propre modèle, +16 % face aux stuffs critiques de Huzounet, +2 % au plus près (Iop terre). Un compromis de critique (50 à 75 %) gagne sur 114 stuffs sur 117, et rapporte +4 % en médiane (jusqu'à +10 %) face au meilleur de 100 % / sans critique. Résultats dans `data/huzounet/compare.csv`. Ce gain est mesuré par le modèle du moteur : il montre que le solveur trouve bien l'optimum de son modèle, pas que les stuffs font ces dégâts en jeu.
