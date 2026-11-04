# dofus-optimizer : notes de projet

Optimiseur de stuff Dofus 3 (patch 3.7). Site : https://sola-ray.github.io/dofus-optimizer/ (redéployé par GitHub Actions à chaque push sur `master`). Le README décrit les règles modélisées et les limites ; ce fichier garde ce qui n'est pas évident en lisant le code.

## Commandes

- `npm run dev` : appli locale (Vite, port 5173).
- `npm run data` : retélécharge DofusDB (`data/raw/`, non versionné) puis reconstruit `public/game.json` et `public/icons/`.
- `node test/run-leveling.mjs '<config json>'` : mode leveling en ligne de commande (Eni feu, paliers par défaut). Exemple : `'{"leveling":{"keepGain":5}}'`.
- `npm test` : tests (`test/*.test.mjs`, ~3 min) : stats et jets de sorts face à DofusBook, formule, lignes de dégâts, paliers de panoplie, minimums sur stats calculées, modes critiques, optimiseur face à deux stuffs Huzounet avec score et mode critique figés (`SNAPSHOT`, à mettre à jour quand le modèle change exprès).
- `node test/crit-floor.mjs <code Huzounet> <plancher|crit|noncrit>` : un seul mode critique, pour régler `CRIT_FLOOR_STEPS`.
- `node test/compare-huzounet.mjs [--shard k/N] [--out f.jsonl] [--eval] [--no-vita]` : les 117 stuffs Huzounet à un ou deux éléments évalués par le moteur, puis l'optimiseur sous leurs minimums (PA, PM, PO, rés. moyenne, vitalité) et la même forgemagie (exos PA / PM / PO). ~1 min par stuff : lancer 16 shards en parallèle.
- `node test/run-eni.mjs [auto|crit|noncrit] '<config json>'` : lance le moteur en ligne de commande (Eniripsa feu, 12 PA / 6 PM par défaut). Exemple : `'{"fm":{"pctExo":2},"min":{"pa":12,"pm":6,"po":6,"resMoy":25}}'`.

## Sources de données Dofus 3

- **DofusDB** (`https://api.dofusdb.fr`) : source utilisée. CORS ouvert, pages de 50 résultats maximum, filtres type `typeId[$in][]=…`. Collections utiles : `items`, `item-sets`, `item-types`, `effects` (dont `effectPowerRate` = poids des runes), `characteristics` (dont `asset` = icône), `breeds`, `spell-variants`, `spells`, `spell-levels`. Icônes : `https://dofusdb.fr/icons/characteristics/<asset>.png` (pas d'icône pour les résistances ni les % dommages).
- **dofusdude** (`https://api.dofusdu.de/dofus3/v1/…`) : couvre aussi Dofus 3 en français ; `ankama_id` = id officiel.
- **DofusBook** : `curl` renvoie 403 (Cloudflare), mais depuis un navigateur `fetch('/api/stuffs/dofus/public/<id>')` donne un stuff complet en JSON ; chaque item a `official` = id Ankama. Les liens courts `d-bk.net/fr/d/<code>` redirigent vers l'id. Utile pour valider la formule de dégâts.
- **Huzounet** (`https://huzounet.fr/api/equipments/search?budget=high|legendary&page=n`) : stuffs de référence par classe et élément, avec leur lien DofusBook. Le code court `d-bk.net/fr/d/<code>` est l'id DofusBook en base 62 (alphabet `0-9A-Za-z`), donc pas besoin de suivre la redirection. Export dans `data/huzounet/stuffs.json` (2026-11). Dans l'API DofusBook : `fmGlobal` = exos PA / PM / PO globaux, `fmItems` = valeur finale de la ligne (pas un ajout), `stuffCarac.base_*` = points investis. Stats de la page objets et jets de l'onglet Sorts (« effets calculés ») : lus au navigateur, figés dans `test/fixtures/`.
- **Prix HDV** : aucune API publique. Meilleure source trouvée : KamaMaster (prix par serveur, appli rendue côté client, à lire via navigateur).
- Aucune API Ankama pour l'inventaire ; lire le trafic du client = risque de ban, à exclure.

## Pièges des données

- **Paliers de panoplie** : dans DofusDB, `effects[k]` est le bonus à k + 1 objets (`effects[0]` = 1 objet, vide). `build-data` décale d'un cran pour que `b[n]` soit le bonus à n objets. Avant la correction, chaque panoplie donnait le bonus du palier suivant (Katcheur ×2 recevait le +1 PA du ×3) et le moteur la surévaluait.
- **Zones des sorts** : `data/dofusbook-spells.json` (versionné), exporté depuis un navigateur via `https://www.dofusbook.net/api/spells/class/<id>` (19 classes + 19 = sorts communs), à refaire à chaque patch. `build-data` en tire `zb` (groupes qui frappent un ennemi : titre, zone, taille).
- **Ébène** : ses bonus se déclenchent par sous-sort sur `CDM` / `CDR` (le porteur occasionne des dommages en mêlée / à distance), donc à chaque instance de dommages : un sort en zone qui touche 3 monstres en donne 3.
- Les **malus de panoplie** sont stockés déjà négatifs (`from: -40`) alors que ceux des items sont positifs : `statOf` prend la valeur absolue avant d'appliquer le signe.
- Les **passifs** (Dofus, prysmaradites, légendaires) sont l'effet `1175` ; l'id du sort est dans `diceNum`. Leur texte officiel est dans le sort, leur effet chiffré est codé à la main dans `src/engine/passives.js`.
- Pour savoir quand un passif se déclenche, lire les effets du sort dans `spell-levels` : `triggers` (`TB` = début de tour, `TE` = fin de tour, `D` = dommages subis, `CC` = coup critique…) et `delay`. Vulbis et Ocre ont `TB` avec `delay: 1` : rien au tour 1.
- Objets de MJ à exclure : conditions `PX`, `PN`, `GM`.
- Runes de transcendance : `typeId` 211 ; le niveau de la rune est le niveau minimum de l'item.
- Les sorts ont plusieurs grades (`minPlayerLevel`) : `grades` dans `game.json`, choisis selon le niveau du perso.
- **Sous-sorts et états absents** : `fetch-data.mjs` ne télécharge que les sorts des classes et des items ; les ~460 sorts lancés par un sort (effets 1160, 792, 2160…) et les noms d'états (`spell-states`) n'y sont pas. Le catalogue de buffs (`src/engine/buffs.js`) code donc à la main ce qui passe par eux.
- **Masque de cibles** (`targetMask`) : sens des lettres documenté en tête de `buffs.js` (lu dans le client Dofus 2 décompilé, vérifié sur des sorts). Piège : le script d'un sort peut réserver un effet à un cas que le masque ne dit pas (Vacarme : +25 % finaux en zone « toute la carte » pour les Feux Follets seulement).
- **Lignes conditionnelles** : `c` (forClientOnly) = ligne d'affichage, souvent jouée par un sous-sort sous condition (retrait de PA, poussée…) ; `p` = ligne aléatoire (une seule des lignes tirées part) ; masques en majuscule `V50` / `PB` / `R` et `*EN` face à `*eN` = variante qui demande une mise en place. Effets 2828 (vol meilleur élément) et 2832 (pire élément) : à mapper, sinon Folie Sanguinaire ou Kyrja comptent 0. Le détail est en tête de `directLines`.
- **Lignes de dégâts en double** : beaucoup de sorts répètent une ligne (variante en zone, variante par état du lanceur, ligne réservée aux invocations ou à un état de la cible). `directLines` dans `damage.js` ne garde que ce qui frappe un ennemi ordinaire lors d'un lancer direct ; sans ça Vacarme comptait double et Flèche Dévorante 7 fois. Même ligne dans la même zone = vrai second coup (Dagues Boomerang). Les poisons comptent pour un déclenchement. Sorts à cumul (Torrent Arcanique) : `SPELL_RULES`.

- **Conditions de port après la forgemagie** : `finishItems` refait la FM hors du modèle principal, avec un petit bonus (1e-4) sur toute finition ; sans les conditions de port dans son LP, il posait un exo PM « gratuit » qui cassait la Ceintacé (PA < 12 ou PM < 6). Tout nouveau passage qui modifie les stats après le MIP doit revérifier `checkCriteria`.
- **Écarts avec Huzounet** (`data/huzounet/compare.csv`, planchers de critique compris) : faibles pour Iop, Crâ, Ecaflip, Forgelance, Steamer, Sram (+13 à +18 % en médiane), forts pour Féca, Huppermage, Zobal, Xélor, Osamodas, Sadida (+40 à +58 %), y compris en se limitant aux stuffs sans critique : ce sont les dégâts non modélisés (invocations, glyphes, états), pas une surévaluation du critique.

- **Stats calculées** (`DERIVED`, `totalStat` dans `rules.js`) : `st.fuite`, `st.ini`… restent les valeurs des items ; le total en jeu (avec caractéristiques, base 100 de prospection, 1 000 pods) passe par `totalStat`, utilisé pour les minimums, l'affichage et l'initiative d'équipe. Dans le LP, l'arrondi floor(agilité / 10) passe par un entier `q` (10 q ≤ T_agi).

## Règles validées avec le joueur

- Forgemagie réaliste : **une finition par item** (transcendance, exo % dommages 1 à 4 %, over dans un budget de poids, exo PA / PM / PO). Exception : exo lourd + over si le total tient dans 101 de poids (exo PM 90 + 1 % critique 10, vu sur du Padgref). Les finitions cochées sont *autorisées*, jamais imposées ; le moteur explique pourquoi chaque exo est utilisé ou non.
- 2 % d'exo de dommages ≈ 1 chance sur 1 000, 4 % existe (quelques items par an). Ne pas ajouter de commentaires de rareté dans l'interface (jugé « cringe »).
- % sorts et % distance se multiplient : il faut les équilibrer (`improveFinishes`).
- Mode critique : Auto compare « tous les sorts de l'élément à 100 % », « sans critique » et deux planchers intermédiaires (`critN`, `CRIT_FLOOR_STEPS` : 100 % − 20 et − 40 points), où le critique compte pour sa vraie valeur au-dessus du plancher. Les dégâts ne sont pas concaves en taux × dommages critiques : un plancher bas laissé libre ne trouve pas le compromis (Eni feu : plancher 70 → 1 084, plancher 40 → 1 073, 100 % → 1 036), d'où plusieurs planchers. Le compromis est venu du joueur (Huzounet joue l'Eni feu à ~85 % en jeu).
- Passifs : trois scénarios (combat moyen, tour 1, burst). Les PA gagnés en combat valent des dégâts par tour (+1 PA à 12 PA ≈ +8 %), sinon le moteur ignorait l'Ocre que joue Koza.
- **PA** : le combat commence au plus à 12 PA (`PA_CAP`) ; au-delà, seuls les PA gagnés en combat (Ocre, légendaires…) comptent. Sous 12, les PA du stuff valent des dégâts par tour d'après la courbe `paCurve` (rotation des sorts de référence, `pickSpells`), dans le score comme dans le modèle (variables `zpa_p`). Sans plafond, le moteur montait à 17 PA. Même plafond pour les PM et la PO (`STAT_CAP` : 12 PA, 6 PM, 6 PO) : un minimum au-delà est ramené au plafond, et le Sylvestre compte au plus 6 PM.
- **Attaques subies** : une seule hypothèse pour Pourpre, Vulbis et Ocre (attaqué un tour sur deux, 2,5 attaques ce tour-là : `ATTACKED`, `HITS` dans `passives.js`). Avant, le Pourpre supposait 2 à 3 attaques par tour et l'Ocre un tour sur deux, et le moteur cumulait les deux.
- Dofus Sylvestre : +8 Puissance par PM utilisé sur 2 tours, très fort (moyen 8 × PM, burst 16 × PM).
- Référence : le stuff de Koza (Eni feu très riche, Sylvestre) faisait ≈ 827 dégâts moyens sans passifs, mais avant `directLines` (Vacarme compté double) : à recalculer.

## Performance

Le temps passe presque entièrement dans HiGHS (le JS : < 3 %). D'où : session HiGHS persistante (coupes ajoutées à chaud + `setSolution`), trois tangentes de départ sur des stats de fin de jeu, phase 1 sur les 40 meilleurs items par emplacement puis phase 2 sur tous les items. N'actualiser la borne de Kelley que si le statut est optimal.

- **Inégalités de panoplie** (`setj`, `problem.tight`) : sans elles la relaxation continue touche la moitié du bonus à 2 items avec un seul item porté (y_0 = y_2 = 0,5), d'où des MIP lents. Pas dans le modèle commun du leveling (mesuré sans gain).
- **Pré-boucle LP** (`relaxedCuts`) : Kelley sur la relaxation continue avant le premier MIP ; la phase 1 converge en un MIP au lieu de 4. Les points de départ sont ramenés sous les coupes (`fitStart`), sinon HiGHS doit les réparer.
- **Phase 2 par coûts réduits** : LP du modèle complet, puis tout item avec z* + d(x) < objectif du départ est fixé à 0 (`setBounds`) ; la borne de Kelley prend le max avec la borne des items fixés.
- Essayé sans gain : big-M resserrés sur les conditions de port, options HiGHS (presolve, heuristiques, symétrie…), K = 25 en phase 1, départ glouton palier par palier pour le leveling. Le MIP commun du leveling (~75 % de son temps) reste le point lent : c'est surtout de la recherche d'incumbent, très sensible au chemin.
- Les temps varient de ±30 % selon la charge de la machine ; le résultat, lui, est déterministe : comparer les valeurs, et les temps sur plusieurs configs.

Mode leveling (`src/engine/leveling.js`) : le modèle commun est fait des sections de `buildSections` de chaque palier, renommées avec le suffixe `__k`. Les candidats de chaque palier sont l'union des items élagués de **tous** les paliers (via `keepIds`), sinon un item gardé d'un palier à l'autre peut disparaître des candidats du palier suivant et le moteur est forcé de le changer.

## Git

Commiter avec l'identité perso `Sola-Ray <solaraycontact@gmail.com>` (configurée en local dans ce dépôt ; l'identité globale de la machine est professionnelle).
