# SPC Pointage : pointage des agents par présence sur site

Système de pointage d'arrivée et de départ pour les agents SPC, fondé sur leur présence réelle sur le lieu de travail.
Trois applications Android installables (sans boutique d'applications), interconnectées par GitHub, qui fonctionnent **avec ou sans connexion**.

| Application | Pour qui | Ce qu'elle fait |
|---|---|---|
| `agent/` | Agents de terrain | Pointe l'arrivée et le départ. Le pointage n'est accepté que dans la zone GPS du lieu. Détecte l'arrivée automatiquement (application ouverte). |
| `supervisor/` | Chefs d'équipe, superviseurs | Voit son équipe du jour, **enregistre un nouveau lieu avec ses coordonnées GPS sur place**, valide les pointages hors zone, saisit un pointage manuel. |
| `central/` | Direction, opérations | Crée agents, superviseurs, lieux et plannings. Contrôle les pointages, détecte les anomalies, exporte les heures. |

## Comment ça marche

1. Les trois applications sont des pages web installables (PWA), hébergées gratuitement sur **GitHub Pages**.
2. Les données (agents, lieux, plannings, pointages) sont des fichiers JSON dans un **dépôt GitHub privé**, lus et écrits par l'API GitHub.
3. **Hors connexion** : chaque pointage est enregistré sur le téléphone (base IndexedDB) avec sa position GPS (le GPS marche sans réseau), puis envoyé automatiquement au retour de la connexion. Les applications s'ouvrent aussi sans réseau.
4. **Sécurité des pointages** : chaque pointage est signé (HMAC-SHA-256) avec la clé de l'appareil et chaîné au précédent. Le central détecte toute modification, toute suppression et toute signature invalide.
5. **Zone** : le lieu est enregistré avec ses coordonnées et un rayon (100 m par défaut). Un pointage est accepté si la position est dans le rayon et la précision GPS suffisante (60 m au plus). Sinon, l'agent peut pointer « hors zone » avec un motif, et le superviseur valide ou refuse.

## Mise en service pas à pas (compte GitHub `societeplacementconseils-create`)

### 1. Créer les deux dépôts
Sur https://github.com/new :
- `spc-pointage` : **public** (il contient seulement le code, aucun secret). Nécessaire pour GitHub Pages gratuit.
- `spc-pointage-data` : **privé**. Cochez « Add a README file ».

### 2. Publier les applications
Dans `spc-pointage` : « Add file » → « Upload files », glissez tout le contenu de ce dossier (y compris le fichier caché `.nojekyll`), puis « Commit changes ».
Ensuite : **Settings → Pages → Source : Deploy from a branch → `main` / `(root)` → Save**.
Après une minute, les applications sont en ligne : `https://societeplacementconseils-create.github.io/spc-pointage/`

### 3. Créer les deux jetons d'accès
Sur GitHub : **Settings (votre profil) → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
Créez deux jetons :
- `spc-central` (pour la direction) et `spc-terrain` (pour les téléphones de terrain).
- *Repository access* : **Only select repositories → `spc-pointage-data`** uniquement.
- *Permissions → Repository permissions → Contents : Read and write*. Rien d'autre.
- Expiration : 90 jours à 1 an (notez la date de renouvellement).
Copiez chaque jeton (il n'est affiché qu'une fois).

### 4. Configurer le central
Ouvrez `https://societeplacementconseils-create.github.io/spc-pointage/central/` (ordinateur ou Android).
Saisissez : dépôt `societeplacementconseils-create/spc-pointage-data`, branche `main`, jeton central, jeton terrain.
**Réglages → Exporter les clés** : gardez ce fichier en lieu sûr (les clés de signature ne sont qu'ici).

### 5. Créer les utilisateurs, les lieux, les plannings
- **Agents** → « Nouvel agent ou superviseur » → le central affiche un **lien d'activation** : envoyez-le par WhatsApp à la personne (bouton fourni). Le lien contient la clé de son téléphone : ne l'envoyez qu'à elle.
- **Lieux** : saisissez les coordonnées ou laissez le superviseur enregistrer le lieu sur place.
- **Plannings** : agent, lieu, jours, horaires.

### 6. Sur chaque téléphone Android
Ouvrir le lien d'activation dans **Chrome** → menu ⋮ → **Ajouter à l'écran d'accueil**. Autoriser la **localisation précise**. Dans les réglages Android, activer « Date et heure automatiques » et ne pas restreindre la batterie pour Chrome.

## Règles de fonctionnement
- L'agent ne voit que ses lieux du jour. Il appuie sur « Pointer mon arrivée » : l'application mesure sa position, calcule la distance au lieu et enregistre l'heure.
- **Arrivée automatique** : quand l'application est ouverte et que l'agent est dans la zone (2 mesures consécutives, dans la fenêtre horaire), l'arrivée est enregistrée seule. Le départ se pointe toujours à la main (l'agent peut sortir pendant sa pause).
- Plusieurs arrivées/départs par jour sont possibles. Les heures sont calculées par le central (pause d'une heure déduite pour une journée d'un seul tenant de 6 h ou plus, réglable).
- Le central signale : hors zone à valider, signature invalide, empreinte modifiée, chaîne interrompue, pointage manuel, heure du téléphone décalée ou différente de l'heure GPS, départ non pointé, absence, pointage supprimé.

## Version Android native (détection en arrière-plan)
Le dossier séparé `spc-pointage-android` contient l'application Android native qui affiche l'application agent et détecte l'arrivée et le départ **même application fermée** (géorepérage Android, service de courte durée, envoi automatique). Elle se compile dans le cloud par GitHub Actions (voir son README). Les pointages natifs sont signés comme les autres et vérifiés par le central (mention « Détection automatique (Android) »). Quand l'application web tourne dans la version native, le suivi continu web est désactivé pour éviter les doublons.

## Interconnexion avec l'application de gestion SPC
Central → **Mois** → « Exporter pour l'application SPC » produit `spc-pointages-AAAA-MM.json`.
Dans l'application de gestion SPC : **Réglages → Importer les pointages GPS**. Les lignes alimentent le Rapport journalier (arrivée, départ, absence, anomalies).
Pour que la liaison fonctionne : le **code client** du lieu (ex. `CLI-2026-001`) doit correspondre au client SPC, et le **code de pointage** de l'intervenante (ex. `AGT-001`) doit être renseigné dans sa fiche.

## Limites et précautions (à lire)
- **Pas de suivi en arrière-plan dans la version web.** Une application web ne peut pas lire le GPS quand elle est fermée : l'arrivée automatique ne fonctionne que **application ouverte**. Pour la détection en arrière-plan, utilisez la version Android native (dossier `spc-pointage-android`).
- **GPS fictif.** Un navigateur ne peut pas détecter une application de fausse localisation. Les garde-fous : précision GPS exigée, comparaison heure téléphone / heure GPS, signature, validation des cas hors zone, contrôle du superviseur.
- **Jeton sur les téléphones.** Le jeton « terrain » est présent sur chaque téléphone activé : il donne accès au dépôt de données (privé, limité à ce seul dépôt). Si un téléphone est perdu : révoquez le jeton sur GitHub, créez-en un nouveau, ressaisissez-le dans le central et renvoyez les liens d'activation. Un agent ne peut pas forger le pointage d'un autre (il n'a pas sa clé), mais un téléphone compromis peut lire les données du dépôt.
- **Clés de signature** : stockées uniquement dans le central. Sans elles, les signatures ne peuvent plus être vérifiées : exportez-les.
- **Vie privée** : la position n'est enregistrée qu'au moment d'un pointage. L'application ne trace pas les déplacements. Informez les agents et mentionnez le pointage GPS dans leur contrat ou règlement intérieur.
- **Limites GitHub** : 5 000 requêtes par heure et par jeton ; largement suffisant pour des dizaines d'agents.

## Tests
`node tests/mock-github.js 4010` lance un faux serveur GitHub ; `python3 tests/e2e.py` joue le scénario complet (central, superviseur, deux agents, coupure de connexion, falsification, pont natif simulé, pointage natif vérifié) avec Playwright : 37 contrôles. `python3 tests/native-compat.py` compare la fabrication des pointages natifs aux calculs JavaScript (46 événements).

## Dépôt de données
Voir `data-template/README.md` pour la structure des fichiers.
