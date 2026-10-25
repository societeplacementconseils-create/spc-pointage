# Dépôt de données SPC Pointage (PRIVÉ)

Ce dépôt est rempli automatiquement par les applications. Ne modifiez pas les fichiers à la main.

```
agents/<ID>.json                       utilisateurs (nom, rôle, actif) : jamais de clé secrète ici
sites/<ID>.json                        lieux : nom, adresse, client, superviseur, empreinte du code QR (qrHash) et sa version ; coordonnées GPS facultatives (information)
assignments/<ID>.json                  affectations : agent, lieu, jours, horaires, période
pointages/AAAA-MM/AAAA-MM-JJ/<agent>.json   événements d'arrivée et de départ, signés et chaînés
validations/<ID d'événement>.json      décisions du superviseur sur les pointages hors zone
config/settings.json                   version du format
```

Chaque pointage contient l'heure, le lieu, le mode (qr ou manuel), la position GPS et la distance au lieu quand elles sont disponibles (information),
une empreinte (SHA-256) et une signature (HMAC) : toute modification ou suppression est détectée par l'application centrale.
