# ADR-003 — PostgreSQL seul composant stateful, accès par Drizzle ORM isolé

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

La plateforme est la source de vérité pour comptes, roster, configuration des assignments,
clés API, audit et notes gelées (C-01) ; GitHub l'est pour le contenu Git et les runs. Il
faut des transactions (import CSV atomique AU-14), des contraintes d'unicité comme mécanisme
d'idempotence (NFR-09), des sessions révocables (AU-06), une file de jobs durable et une
sauvegarde simple (NFR-16 : RPO 24 h, RTO 4 h).

## Décision

1. **PostgreSQL 17 est l'unique composant stateful** : données métier, sessions (hash),
   file de jobs pg-boss, déduplication des webhooks, audit. Un seul `pg_dump` couvre tout le
   périmètre NFR-16.
2. Horodatages `timestamptz` en UTC partout, conversion Europe/Zurich à l'affichage (C-02) ;
   PK `uuid` v7 (tri temporel).
3. Les **contraintes UNIQUE sont le mécanisme d'idempotence** : tout rejeu se termine en
   `ON CONFLICT DO NOTHING`, jamais en doublon.
4. Accès par **Drizzle ORM + drizzle-kit** (SQL-proche, migrations SQL versionnées,
   exécutées au démarrage avec lock), versions épinglées. L'accès base est isolé derrière
   une couche repository : le risque pré-1.0 de Drizzle est contenu (bascule Kysely possible
   sans toucher au domaine).
5. Immutabilité de l'audit **au niveau base** : le rôle SQL applicatif n'a ni `UPDATE` ni
   `DELETE` sur `audit_log` (NFR-05) ; seule la routine de pseudonymisation LPD (rôle dédié)
   peut réécrire les champs d'identité (NFR-07).

## Conséquences

- Une seule brique à sauvegarder, superviser et restaurer ; le runbook de restauration tient
  en une page et le test semestriel valide le RTO.
- Quand un job pose problème, le diagnostic se fait en SQL directement sur les tables
  pg-boss — pas de couche opaque entre le mainteneur et ses données.
- La montée de version Drizzle est un chantier ciblé, jamais un blocage : les migrations
  sont des fichiers SQL bruts, indépendants de l'API de l'ORM.

## Alternatives rejetées

1. **Prisma** (proposition productivité) : productif, mais ajoute un moteur binaire et une
   chaîne de génération entre le mainteneur et son SQL ; quand une requête verrouille, on lit
   du SQL, pas du Prisma.
2. **Redis comme second composant stateful** (sessions ou file) : une pièce mobile, une
   sauvegarde et une panne de plus, sans besoin justifié par une NFR (voir ADR-004).
3. **JWT de session** : AU-06 exige l'invalidation côté serveur ; une table de sessions
   (token hashé) suffit et évite toute gestion de révocation de jetons.
