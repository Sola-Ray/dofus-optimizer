# dofus-optimizer : notes de projet

Optimiseur de stuff Dofus 3 (patch 3.7). Site : https://sola-ray.github.io/dofus-optimizer/ (redéployé par GitHub Actions à chaque push sur `master`). Le README décrit les règles modélisées et les limites ; ce fichier garde ce qui n'est pas évident en lisant le code.

## Commandes

- `npm run dev` : appli locale (Vite, port 5173).
- `npm run data` : retélécharge DofusDB (`data/raw/`, non versionné) puis reconstruit `public/game.json` et `public/icons/`.
- `node test/run-eni.mjs [auto|crit|noncrit] '<config json>'` : lance le moteur en ligne de commande (Eniripsa feu, 12 PA / 6 PM par défaut). Exemple : `'{"fm":{"pctExo":2},"min":{"pa":12,"pm":6,"po":6,"resMoy":25}}'`.

## Sources de données Dofus 3

- **DofusDB** (`https://api.dofusdb.fr`) : source utilisée. CORS ouvert, pages de 50 résultats maximum, filtres type `typeId[$in][]=…`. Collections utiles : `items`, `item-sets`, `item-types`, `effects` (dont `effectPowerRate` = poids des runes), `characteristics` (dont `asset` = icône), `breeds`, `spell-variants`, `spells`, `spell-levels`. Icônes : `https://dofusdb.fr/icons/characteristics/<asset>.png` (pas d'icône pour les résistances ni les % dommages).
- **dofusdude** (`https://api.dofusdu.de/dofus3/v1/…`) : couvre aussi Dofus 3 en français ; `ankama_id` = id officiel.
- **DofusBook** : `curl` renvoie 403 (Cloudflare), mais depuis un navigateur `fetch('/api/stuffs/dofus/public/<id>')` donne un stuff complet en JSON ; chaque item a `official` = id Ankama. Les liens courts `d-bk.net/fr/d/<code>` redirigent vers l'id. Utile pour valider la formule de dégâts.
- **Prix HDV** : aucune API publique. Meilleure source trouvée : KamaMaster (prix par serveur, appli rendue côté client, à lire via navigateur).
- Aucune API Ankama pour l'inventaire ; lire le trafic du client = risque de ban, à exclure.

## Pièges des données

- Les **malus de panoplie** sont stockés déjà négatifs (`from: -40`) alors que ceux des items sont positifs : `statOf` prend la valeur absolue avant d'appliquer le signe.
- Les **passifs** (Dofus, prysmaradites, légendaires) sont l'effet `1175` ; l'id du sort est dans `diceNum`. Leur texte officiel est dans le sort, leur effet chiffré est codé à la main dans `src/engine/passives.js`.
- Objets de MJ à exclure : conditions `PX`, `PN`, `GM`.
- Runes de transcendance : `typeId` 211 ; le niveau de la rune est le niveau minimum de l'item.
- Les sorts ont plusieurs grades (`minPlayerLevel`) : `grades` dans `game.json`, choisis selon le niveau du perso.

## Règles validées avec le joueur

- Forgemagie réaliste : **une finition par item** (transcendance, exo % dommages 1 à 4 %, over dans un budget de poids, exo PA / PM / PO). Exception : exo lourd + over si le total tient dans 101 de poids (exo PM 90 + 1 % critique 10, vu sur du Padgref). Les finitions cochées sont *autorisées*, jamais imposées ; le moteur explique pourquoi chaque exo est utilisé ou non.
- 2 % d'exo de dommages ≈ 1 chance sur 1 000, 4 % existe (quelques items par an). Ne pas ajouter de commentaires de rareté dans l'interface (jugé « cringe »).
- % sorts et % distance se multiplient : il faut les équilibrer (`improveFinishes`).
- Mode critique : Auto compare « tous les sorts de l'élément à 100 % » et « sans critique ».
- Dofus Sylvestre : +8 Puissance par PM utilisé sur 2 tours, très fort (moyen 8 × PM, burst 16 × PM).
- Référence : le stuff de Koza (Eni feu très riche, Sylvestre) fait ≈ 827 dégâts moyens sans passifs dans notre formule.

## Performance

Le temps passe dans la recherche d'une bonne première solution, pas dans le branch-and-bound. D'où : session HiGHS persistante (coupes ajoutées à chaud + `setSolution`), trois tangentes de départ sur des stats de fin de jeu, phase 1 sur les 40 meilleurs items par emplacement puis phase 2 sur tous les items. N'actualiser la borne de Kelley que si le statut est optimal.

## Git

Commiter avec l'identité perso `Sola-Ray <solaraycontact@gmail.com>` (configurée en local dans ce dépôt ; l'identité globale de la machine est professionnelle).
