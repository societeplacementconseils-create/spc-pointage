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

## Échanges avec l'application de gestion SPC (qui est la source de quoi)
| Donnée | Source | Destination | Fichier dans le dépôt de données |
|---|---|---|---|
| **Personnel** : fiche complète saisie au central (identité, naissance, adresse, pièce d'identité, CNSS, poste, garants, notes, état actif) | **Central** (chiffré) | SPC Gestion (Intervenantes ; superviseurs dans le Robot) | `exports/employes.json` |
| **Clients** (code, nom, adresse, pôles, horaires) | **SPC Gestion** (chiffré) | Central (onglet Lieux) | `echange/clients.json` |
| **Plannings** (agent, client, jours, horaires, prise de poste), déduits des affectations par le Robot opérationnel | **SPC Gestion** (chiffré) | Central (onglet Plannings) | `echange/plannings.json` |
| **Pointages** (arrivée, départ, heures, anomalies, mode) | Central (vérifié) | SPC Gestion (Rapport journalier) | `exports/pointages-AAAA-MM.json` |

**Chiffrement.** Les téléphones de terrain lisent le dépôt de données. Les fichiers du personnel, des clients et des plannings sont donc chiffrés (AES-GCM) avec une **clé d'échange** générée par le central (Réglages → Copier la clé) et copiée une fois dans SPC Gestion (Réglages → Pointages). Les informations sensibles du personnel ne sont jamais écrites en clair dans le dépôt : les fichiers `agents/` ne contiennent que le code, le nom, le téléphone et l'état. La clé d'échange est **masquée par défaut** dans le central (bouton Afficher ou masquer) et fait partie de la sauvegarde des clés du central. Si elle a été vue par quelqu'un qui ne devrait pas la connaître (capture d'écran, message), **Régénérer la clé** : la fiche du personnel est rechiffrée, l'ancienne clé reste conservée seulement pour relire les anciens fichiers, et il faut copier la nouvelle clé dans SPC Gestion.

**Ce qui part, et ce qui ne part jamais.** Vers le central, SPC Gestion n'envoie que le code client, le nom, l'adresse du site, les pôles et les horaires : jamais téléphone, e-mail, santé, préférences ni tarifs (les clients de démonstration sont exclus). Vers SPC Gestion, le central n'envoie aucune clé de signature ni empreinte de badge ou de code QR.

**Mise en place**
1. **Central** : la publication est automatique à chaque ouverture (personnel et pointages du mois en cours, plus le mois précédent pendant les 7 premiers jours). Onglet **Mois → Publier maintenant** pour forcer.
2. **Jeton `spc-gestion`** : jeton GitHub limité au dépôt `spc-pointage-data`, permission **Contents : Read and write** (nécessaire pour envoyer les clients et les plannings). Il reste sur l'ordinateur de la direction, comme le jeton du central.
3. **SPC Gestion** : ouvrez le fichier `spc-gestion-client.html` depuis votre ordinateur (la page publiée dans Claude n'a pas le droit de contacter GitHub). Réglages → **Pointages** : dépôt, branche, jeton, **clé d'échange**, case « Récupérer automatiquement à l'ouverture ». À l'ouverture, l'application récupère les pointages et le personnel, puis envoie les clients et les plannings si leur contenu a changé (une modification est envoyée 4 à 5 secondes plus tard).
4. **Personnel** : onglet **Agents → Nouvel employé** (ou **Fiche** pour modifier) au central : toutes les informations saisies sont transmises à SPC Gestion, qui crée une fiche d'intervenante (dossier à compléter : aucun des 7 contrôles validé, donc non affectable) ou met à jour la fiche reconnue par son code ou son nom. Le dossier de candidature, les pièces et les contrôles restent dans SPC Gestion. Les superviseurs sont consultables dans le Robot opérationnel.
5. **Clients** : au central, onglet **Lieux**, la carte « Clients de SPC Gestion » liste les clients reçus ; **Créer le lieu** (ou **Créer les lieux manquants**) fabrique le lieu avec son code QR ; **Mettre à jour** reprend le nom et l'adresse modifiés. Le central ne modifie jamais un client.
6. **Plannings** : le Robot opérationnel de SPC Gestion déduit les plannings des affectations ; au central, onglet **Plannings**, **Appliquer** (ou **Appliquer tout**) crée les affectations de présence, si l'agent et le lieu du client existent.
7. **Pointages** : une ligne par agent, lieu et jour dans le Rapport journalier ; une nouvelle récupération met à jour sans doublon.
En secours, **Mois → Exporter pour l'application SPC** télécharge le fichier des pointages, à importer avec **Importer un fichier**.

## Robot opérationnel et prospection (dans SPC Gestion)
Le **Robot opérationnel** planifie et suit l'avancement des exécutions (taux de réalisation des placements, absences, retards, suivis J+3/J+15/J+30, incidents, missions par phase, agenda des 7 jours, propositions d'affectation, plannings à transmettre au central). Le module **Prospects** enregistre et note les entreprises et organisations à démarcher ; le robot de prospection est Claude avec le skill SPC. Voir `tests/gestion-robot.py` et le guide du système.

## Limites et précautions (à lire)
- **Une affiche peut être photographiée.** Quelqu'un pourrait scanner la photo du code depuis un autre endroit. Parades : placer l'affiche à l'intérieur du lieu, contrôles du superviseur, **alerte facultative « scan loin du lieu »** (central → Réglages, utile seulement si les coordonnées du lieu sont fiables), remplacement du code en cas de doute. Un code QR qui change automatiquement (affiché sur l'écran du superviseur) est possible plus tard.
- **Prêt de badge.** Un badge peut être prêté à un collègue. Parades : le chef d'équipe scanne les badges en présence des employés et vérifie les visages, et le central voit qui a scanné chaque badge. Une photo d'identité sur le badge est possible plus tard.
- **Lecture du QR par la caméra** : elle repose sur la fonction de lecture de codes de Chrome sur Android. Si un téléphone ne la propose pas, ou si la caméra est refusée, l'agent saisit le **code de secours** inscrit sous le QR.
- **Jeton sur les téléphones.** Le jeton « terrain » est présent sur chaque téléphone activé : il donne accès au dépôt de données (privé, limité à ce seul dépôt). Si un téléphone est perdu : révoquez le jeton sur GitHub, créez-en un nouveau, ressaisissez-le dans le central et renvoyez les liens d'activation.
- **Clés.** Les clés de signature des agents et la **clé maîtresse des codes QR** ne sont que dans le navigateur du central. Exportez-les (Réglages → Exporter les clés) et gardez le fichier en lieu sûr. Sans la clé maîtresse, les codes QR existants ne pourraient plus être réimprimés à l'identique : il faudrait les remplacer.
- **Vie privée** : l'application ne trace pas les déplacements. Si la position est disponible au moment du scan, elle est notée ; informez les agents et mentionnez le pointage dans leur contrat ou règlement intérieur.
- **Limites GitHub** : 5 000 requêtes par heure et par jeton ; largement suffisant pour des dizaines d'agents.

## Tests
`node tests/mock-github.js 4010` lance un faux serveur GitHub ; `python3 tests/e2e.py` joue le scénario complet (central, superviseur, deux agents, saisie du code, scan simulé, coupure de connexion, remplacement du code, falsification) : 77 contrôles. `python3 tests/gestion-sync.py` teste les échanges côté application de gestion : pointages, personnel, clients et plannings chiffrés (36 contrôles, après e2e.py). `python3 tests/gestion-robot.py` teste le robot opérationnel et les prospects (30 contrôles). `python3 tests/qr-check.py` vérifie que les codes QR générés se lisent (OpenCV).

## Dépôt de données
Voir `data-template/README.md`.
