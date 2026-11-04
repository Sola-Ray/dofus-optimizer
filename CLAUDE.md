# dofus-optimizer : notes de projet

Optimiseur de stuff Dofus 3 (patch 3.7). Site : https://sola-ray.github.io/dofus-optimizer/ (redéployé par GitHub Actions à chaque push sur `master`). Le README décrit les règles modélisées et les limites ; ce fichier garde ce qui n'est pas évident en lisant le code.

## Commandes

- `npm run dev` : appli locale (Vite, port 5173).
- `npm run data` : retélécharge DofusDB (`data/raw/`, non versionné) puis reconstruit `public/game.json` et `public/icons/`.
- `node test/run-leveling.mjs '<config json>'` : mode leveling en ligne de commande (Eni feu, paliers par défaut). Exemple : `'{"leveling":{"keepGain":5}}'`.
- `node test/run-eni.mjs [auto|crit|noncrit] '<config json>'` : lance le moteur en ligne de commande (Eniripsa feu, 12 PA / 6 PM par défaut). Exemple : `'{"fm":{"pctExo":2},"min":{"pa":12,"pm":6,"po":6,"resMoy":25}}'`.

## Sources de données Dofus 3

- **DofusDB** (`https://api.dofusdb.fr`) : source utilisée. CORS ouvert, pages de 50 résultats maximum, filtres type `typeId[$in][]=…`. Collections utiles : `items`, `item-sets`, `item-types`, `effects` (dont `effectPowerRate` = poids des runes), `characteristics` (dont `asset` = icône), `breeds`, `spell-variants`, `spells`, `spell-levels`. Icônes : `https://dofusdb.fr/icons/characteristics/<asset>.png` (pas d'icône pour les résistances ni les % dommages).
- **dofusdude** (`https://api.dofusdu.de/dofus3/v1/…`) : couvre aussi Dofus 3 en français ; `ankama_id` = id officiel.
- **DofusBook** : `curl` renvoie 403 (Cloudflare), mais depuis un navigateur `fetch('/api/stuffs/dofus/public/<id>')` donne un stuff complet en JSON ; chaque item a `official` = id Ankama. Les liens courts `d-bk.net/fr/d/<code>` redirigent vers l'id. Utile pour valider la formule de dégâts.
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

## Règles validées avec le joueur

- Forgemagie réaliste : **une finition par item** (transcendance, exo % dommages 1 à 4 %, over dans un budget de poids, exo PA / PM / PO). Exception : exo lourd + over si le total tient dans 101 de poids (exo PM 90 + 1 % critique 10, vu sur du Padgref). Les finitions cochées sont *autorisées*, jamais imposées ; le moteur explique pourquoi chaque exo est utilisé ou non.
- 2 % d'exo de dommages ≈ 1 chance sur 1 000, 4 % existe (quelques items par an). Ne pas ajouter de commentaires de rareté dans l'interface (jugé « cringe »).
- % sorts et % distance se multiplient : il faut les équilibrer (`improveFinishes`).
- Mode critique : Auto compare « tous les sorts de l'élément à 100 % » et « sans critique ».
- Passifs : trois scénarios (combat moyen, tour 1, burst). Les PA gagnés en combat valent des dégâts par tour (+1 PA à 12 PA ≈ +8 %), sinon le moteur ignorait l'Ocre que joue Koza.
- **PA** : le combat commence au plus à 12 PA (`PA_CAP`) ; au-delà, seuls les PA gagnés en combat (Ocre, légendaires…) comptent. Sous 12, les PA du stuff valent des dégâts par tour d'après la courbe `paCurve` (rotation des sorts de référence, `pickSpells`), dans le score comme dans le modèle (variables `zpa_p`). Sans plafond, le moteur montait à 17 PA.
- **Attaques subies** : une seule hypothèse pour Pourpre, Vulbis et Ocre (attaqué un tour sur deux, 2,5 attaques ce tour-là : `ATTACKED`, `HITS` dans `passives.js`). Avant, le Pourpre supposait 2 à 3 attaques par tour et l'Ocre un tour sur deux, et le moteur cumulait les deux.
- Dofus Sylvestre : +8 Puissance par PM utilisé sur 2 tours, très fort (moyen 8 × PM, burst 16 × PM).
- Référence : le stuff de Koza (Eni feu très riche, Sylvestre) faisait ≈ 827 dégâts moyens sans passifs, mais avant `directLines` (Vacarme compté double) : à recalculer.

## Performance

Le temps passe dans la recherche d'une bonne première solution, pas dans le branch-and-bound. D'où : session HiGHS persistante (coupes ajoutées à chaud + `setSolution`), trois tangentes de départ sur des stats de fin de jeu, phase 1 sur les 40 meilleurs items par emplacement puis phase 2 sur tous les items. N'actualiser la borne de Kelley que si le statut est optimal.

Mode leveling (`src/engine/leveling.js`) : le modèle commun est fait des sections de `buildSections` de chaque palier, renommées avec le suffixe `__k`. Les candidats de chaque palier sont l'union des items élagués de **tous** les paliers (via `keepIds`), sinon un item gardé d'un palier à l'autre peut disparaître des candidats du palier suivant et le moteur est forcé de le changer.

## Git

Commiter avec l'identité perso `Sola-Ray <solaraycontact@gmail.com>` (configurée en local dans ce dépôt ; l'identité globale de la machine est professionnelle).
