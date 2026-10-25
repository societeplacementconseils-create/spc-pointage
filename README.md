# SPC Pointage : pointage des agents par scan du code QR du lieu

Chaque lieu de travail a son **code QR**, imprimé sur une affiche. À l'arrivée et au départ, l'agent scanne ce code avec l'application SPC Pointage sur son téléphone Android.
Le pointage est signé et chaîné, enregistré **avec ou sans connexion**, puis envoyé au dépôt GitHub de données. Le GPS n'est plus nécessaire : si la position est disponible, elle est notée à titre d'information seulement.

| Application | Pour qui | Ce qu'elle fait |
|---|---|---|
| `agent/` | Agents de terrain | Scanne le code QR du lieu (ou saisit le code de secours) pour pointer l'arrivée et le départ. Historique, état de synchronisation. |
| `supervisor/` | Chefs d'équipe, superviseurs | Voit son équipe du jour, valide, saisit un pointage manuel pour un agent sans téléphone. |
| `central/` | Direction, opérations | Crée agents, superviseurs, lieux et plannings. Génère et imprime les codes QR. Contrôle les pointages, détecte les anomalies, exporte les heures. |

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

## Remplacer un code QR
Si une affiche est perdue ou photographiée : central → Lieux → Code QR → **Remplacer le code**. L'ancien code est refusé dès que les téléphones se sont synchronisés. Imprimez et posez la nouvelle affiche.

## Interconnexion avec l'application de gestion SPC
Central → **Mois** → « Exporter pour l'application SPC » produit `spc-pointages-AAAA-MM.json`.
Dans l'application de gestion SPC : **Réglages → Importer les pointages GPS** (le nom du bouton est conservé). Le **code client** du lieu (ex. `CLI-2026-001`) et le **code de pointage** de l'intervenante (ex. `AGT-001`, dans sa fiche) doivent correspondre.

## Limites et précautions (à lire)
- **Une affiche peut être photographiée.** Quelqu'un pourrait scanner la photo du code depuis un autre endroit. Parades : placer l'affiche à l'intérieur du lieu, contrôles du superviseur, **alerte facultative « scan loin du lieu »** (central → Réglages, utile seulement si les coordonnées du lieu sont fiables), remplacement du code en cas de doute. Un code QR qui change automatiquement (affiché sur l'écran du superviseur) est possible plus tard.
- **Lecture du QR par la caméra** : elle repose sur la fonction de lecture de codes de Chrome sur Android. Si un téléphone ne la propose pas, ou si la caméra est refusée, l'agent saisit le **code de secours** inscrit sous le QR.
- **Jeton sur les téléphones.** Le jeton « terrain » est présent sur chaque téléphone activé : il donne accès au dépôt de données (privé, limité à ce seul dépôt). Si un téléphone est perdu : révoquez le jeton sur GitHub, créez-en un nouveau, ressaisissez-le dans le central et renvoyez les liens d'activation.
- **Clés.** Les clés de signature des agents et la **clé maîtresse des codes QR** ne sont que dans le navigateur du central. Exportez-les (Réglages → Exporter les clés) et gardez le fichier en lieu sûr. Sans la clé maîtresse, les codes QR existants ne pourraient plus être réimprimés à l'identique : il faudrait les remplacer.
- **Vie privée** : l'application ne trace pas les déplacements. Si la position est disponible au moment du scan, elle est notée ; informez les agents et mentionnez le pointage dans leur contrat ou règlement intérieur.
- **Limites GitHub** : 5 000 requêtes par heure et par jeton ; largement suffisant pour des dizaines d'agents.

## Tests
`node tests/mock-github.js 4010` lance un faux serveur GitHub ; `python3 tests/e2e.py` joue le scénario complet (central, superviseur, deux agents, saisie du code, scan simulé, coupure de connexion, remplacement du code, falsification) : 36 contrôles. `python3 tests/qr-check.py` vérifie que les codes QR générés se lisent (OpenCV).

## Dépôt de données
Voir `data-template/README.md`.
