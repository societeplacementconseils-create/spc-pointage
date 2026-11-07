# SPC Pointage : pointage des agents par scan du code QR du lieu

Chaque lieu de travail a son **code QR**, imprimé sur une affiche. À l'arrivée et au départ, l'agent scanne ce code avec l'application SPC Pointage sur son téléphone Android.
Le pointage est signé et chaîné, enregistré **avec ou sans connexion**, puis envoyé au dépôt GitHub de données. Le GPS n'est plus nécessaire : si la position est disponible, elle est notée à titre d'information seulement.

| Application | Pour qui | Ce qu'elle fait |
|---|---|---|
| `agent/` | Agents de terrain | Scanne le code QR du lieu (ou saisit le code de secours) pour pointer l'arrivée et le départ. Historique, état de synchronisation. |
| `supervisor/` | Chefs d'équipe, superviseurs | **Scanne les badges d'un groupe d'employés** sur le site d'un client, voit son équipe du jour, valide, saisit un pointage manuel. |
| `central/` | Direction, opérations | Crée agents, superviseurs, lieux et plannings. Génère et imprime les codes QR des lieux et les **badges** des agents. Contrôle les pointages, détecte les anomalies, exporte les heures. |

## Comment ça marche
1. Dans le central, **Lieux → Nouveau lieu** : le code QR est créé tout de suite. **Code QR → Imprimer l'affiche** : une affiche A4 avec le logo, le nom du lieu, le QR et un **code de secours** de 16 caractères.
2. L'affiche est placée dans le lieu, à un endroit visible.
3. L'agent ouvre SPC Pointage, touche **Scanner le code QR du lieu**, vise l'affiche, confirme l'arrivée (puis le départ plus tard). Si la caméra ne marche pas, il tape le **code de secours**.
4. L'application vérifie le code **sans connexion** : le dépôt ne contient que l'**empreinte** du code (jamais le code lui-même). Elle vérifie aussi que le lieu est bien dans le planning de l'agent.
5. Le pointage (heure, lieu, agent, mode « qr ») est signé avec la clé de l'appareil et chaîné au précédent. Il est stocké sur le téléphone puis envoyé à GitHub au retour du réseau.
6. Le central contrôle : signature, chaîne, suppression, horloge du téléphone décalée, pointage manuel, absence, départ non pointé.

## Mise en service
Voir les étapes déjà réalisées : dépôt public `spc-pointage` (applications) avec GitHub Pages, dépôt privé `spc-pointage-data` (données), deux jetons limités à ce dépôt (Contents : lecture et écriture), puis configuration du central (dépôt + jetons), création des agents, des lieux et des plannings, envoi des liens d'activation par WhatsApp.
Sur Android : ouvrir le lien d'activation dans Chrome, menu ⋮ → **Ajouter à l'écran d'accueil**, autoriser la **caméra** (et la localisation si souhaité).

## Deux façons de pointer
1. **Scan du code du lieu (individuel)** : chaque agent scanne l'affiche du lieu avec son propre téléphone.
2. **Scan des badges (groupe)** : chaque agent a un **badge personnel** (carte au format bancaire avec logo, nom, identifiant, QR et code de secours). Le chef d'équipe, sur le site du client, ouvre l'onglet **Badges** de SPC Superviseur, choisit le lieu et le mode (arrivée puis départ automatiques, arrivées seulement ou départs seulement), puis scanne les badges de tout le groupe l'un après l'autre : signal sonore et vibration à chaque pointage, liste des derniers pointages, **appel du jour** (qui est pointé, qui manque). Les pointages sont signés par le chef d'équipe, marqués « badge », et fonctionnent aussi **sans connexion**.
   - Le central crée le badge à la création de l'agent (Agents → Badge → Imprimer le badge, ou **Imprimer tous les badges** : une planche, plusieurs cartes par page A4). Les agents déjà créés reçoivent leur badge automatiquement.
   - Le même badge n'est pas pointé deux fois en moins d'une minute. Un badge inconnu, falsifié, remplacé ou d'un agent désactivé est refusé. Un agent hors planning est accepté mais marqué « hors planning ».
   - L'agent voit sur son propre téléphone les pointages faits pour lui par badge.
   - **Perte d'un badge** : Agents → Badge → Remplacer le badge ; l'ancien est refusé dès que les téléphones se sont synchronisés.

## Remplacer un code QR
Si une affiche est perdue ou photographiée : central → Lieux → Code QR → **Remplacer le code**. L'ancien code est refusé dès que les téléphones se sont synchronisés. Imprimez et posez la nouvelle affiche.

## Renvoi des pointages vers l'application de gestion SPC
Le renvoi est automatique et passe par un **fichier vérifié** : le central contrôle les signatures, calcule les heures, puis écrit `exports/pointages-AAAA-MM.json` dans le dépôt de données. L'application de gestion le récupère et alimente le **Rapport journalier** (arrivée, départ, absences, anomalies, mode de pointage).
1. **Central** : la publication est automatique à chaque ouverture du central (mois en cours, et mois précédent pendant les 7 premiers jours). Onglet **Mois → Publier maintenant** pour forcer. Réglages : case « Publier automatiquement » (activée par défaut).
2. **Jeton de lecture** : sur GitHub, créez un troisième jeton `spc-gestion` limité au dépôt `spc-pointage-data`, permission **Contents : Read-only** (lecture seule).
3. **Application de gestion** : ouvrez le fichier `spc-gestion-client.html` depuis votre ordinateur (la page publiée dans Claude n'a pas le droit de contacter GitHub : utilisez alors **Importer un fichier**). Réglages → rubrique **Pointages** : dépôt `societeplacementconseils-create/spc-pointage-data`, branche `main`, jeton `spc-gestion`, cochez « Récupérer automatiquement à l'ouverture », **Enregistrer la connexion**, puis **Récupérer les pointages**.
4. **Liaison des données** : le **code client** du lieu (ex. `CLI-2026-001`) doit être celui de la fiche client ; l'agent est reconnu par son **nom** (puis lié à son code `AGT-001` automatiquement) ou par le code de pointage saisi dans sa fiche. Les lignes sans équivalent sont signalées dans le compte rendu.
5. Une nouvelle récupération du même mois met à jour les lignes sans doublon. Le jeton reste dans le navigateur et n'est jamais inclus dans les sauvegardes.
En secours, **Mois → Exporter pour l'application SPC** télécharge le même fichier, à importer avec **Importer un fichier**.

## Limites et précautions (à lire)
- **Une affiche peut être photographiée.** Quelqu'un pourrait scanner la photo du code depuis un autre endroit. Parades : placer l'affiche à l'intérieur du lieu, contrôles du superviseur, **alerte facultative « scan loin du lieu »** (central → Réglages, utile seulement si les coordonnées du lieu sont fiables), remplacement du code en cas de doute. Un code QR qui change automatiquement (affiché sur l'écran du superviseur) est possible plus tard.
- **Prêt de badge.** Un badge peut être prêté à un collègue. Parades : le chef d'équipe scanne les badges en présence des employés et vérifie les visages, et le central voit qui a scanné chaque badge. Une photo d'identité sur le badge est possible plus tard.
- **Lecture du QR par la caméra** : elle repose sur la fonction de lecture de codes de Chrome sur Android. Si un téléphone ne la propose pas, ou si la caméra est refusée, l'agent saisit le **code de secours** inscrit sous le QR.
- **Jeton sur les téléphones.** Le jeton « terrain » est présent sur chaque téléphone activé : il donne accès au dépôt de données (privé, limité à ce seul dépôt). Si un téléphone est perdu : révoquez le jeton sur GitHub, créez-en un nouveau, ressaisissez-le dans le central et renvoyez les liens d'activation.
- **Clés.** Les clés de signature des agents et la **clé maîtresse des codes QR** ne sont que dans le navigateur du central. Exportez-les (Réglages → Exporter les clés) et gardez le fichier en lieu sûr. Sans la clé maîtresse, les codes QR existants ne pourraient plus être réimprimés à l'identique : il faudrait les remplacer.
- **Vie privée** : l'application ne trace pas les déplacements. Si la position est disponible au moment du scan, elle est notée ; informez les agents et mentionnez le pointage dans leur contrat ou règlement intérieur.
- **Limites GitHub** : 5 000 requêtes par heure et par jeton ; largement suffisant pour des dizaines d'agents.

## Tests
`node tests/mock-github.js 4010` lance un faux serveur GitHub ; `python3 tests/e2e.py` joue le scénario complet (central, superviseur, deux agents, saisie du code, scan simulé, coupure de connexion, remplacement du code, falsification) : 56 contrôles. `python3 tests/gestion-sync.py` teste la récupération des pointages par l'application de gestion (14 contrôles, après e2e.py). `python3 tests/qr-check.py` vérifie que les codes QR générés se lisent (OpenCV).

## Dépôt de données
Voir `data-template/README.md`.
