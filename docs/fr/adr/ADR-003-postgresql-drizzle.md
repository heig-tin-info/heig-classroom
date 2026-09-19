# ADR-003 — PostgreSQL comme unique composant à état, accès par un ORM Drizzle isolé

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

La plateforme est la source de vérité pour les comptes, la liste des étudiants, la configuration des devoirs, les clés
d'API, l'audit et les notes gelées (C-01) ; GitHub est la source de vérité pour le contenu Git et les exécutions.
Il nous faut des transactions (import CSV atomique AU-14), des contraintes d'unicité comme mécanisme
d'idempotence (NFR-09), des sessions révocables (AU-06), une file de tâches durable et une sauvegarde simple
(NFR-16 : RPO 24 h, RTO 4 h).

## Décision

1. **PostgreSQL 17 est l'unique composant à état** : données métier, sessions (hachées), la
   file de tâches pg-boss, la déduplication des webhooks, l'audit. Un seul `pg_dump` couvre l'ensemble du
   périmètre NFR-16.
2. Horodatages `timestamptz` en UTC partout, convertis en Europe/Zurich pour l'affichage
   (C-02) ; clés primaires `uuid` v7 (triables dans le temps).
3. **Les contraintes UNIQUE sont le mécanisme d'idempotence** : tout rejeu se termine par un
   `ON CONFLICT DO NOTHING`, jamais par un doublon.
4. Accès par **Drizzle ORM + drizzle-kit** (proche de SQL, migrations SQL versionnées, exécutées
   au démarrage sous verrou), avec des versions épinglées. L'accès à la base de données est isolé derrière une
   couche de dépôts : le risque pré-1.0 de Drizzle est contenu (un basculement vers Kysely est possible
   sans toucher au domaine).
5. Immuabilité de l'audit **au niveau de la base de données** : le rôle SQL applicatif n'a ni
   `UPDATE` ni `DELETE` sur `audit_log` (NFR-05) ; seule la routine de pseudonymisation
   de protection des données (LPD), sous un rôle dédié, peut réécrire les champs d'identité (NFR-07).

## Conséquences

- Une seule brique à sauvegarder, superviser et restaurer ; le runbook de restauration tient sur une page et
  le test semestriel valide le RTO.
- Lorsqu'une tâche se comporte mal, le diagnostic se fait en SQL directement sur les tables pg-boss — aucune couche
  opaque entre le mainteneur et ses données.
- Mettre à jour Drizzle est un travail ciblé, jamais un point bloquant : les migrations sont des fichiers SQL
  bruts, indépendants de l'API de l'ORM.

## Alternatives rejetées

1. **Prisma** (proposition productivité) : productif, mais ajoute un moteur binaire et une chaîne de
   génération entre le mainteneur et son SQL ; quand une requête verrouille, on lit du SQL, pas du Prisma.
2. **Redis comme second composant à état** (sessions ou file) : une pièce mobile de plus, une
   sauvegarde de plus et un mode de défaillance de plus, sans besoin justifié par une NFR (voir ADR-004).
3. **Sessions JWT** : l'AU-06 exige une invalidation côté serveur ; une table de sessions (jeton haché)
   suffit et évite toute machinerie de révocation de jetons.
