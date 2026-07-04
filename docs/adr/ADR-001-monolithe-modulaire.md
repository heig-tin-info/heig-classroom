# ADR-001 — Monolithe modulaire, processus unique, scission `WORKER_MODE` en option

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

La plateforme sert un portail web, deux API, un endpoint webhooks, un flux SSE et des jobs de
fond (deadline, provisionnement, grading). Volumétrie faible (NFR-11 : 30 à 100 étudiants par
classroom, 20 classrooms actives), disponibilité cible 99 % (NFR-08), équipe d'exploitation
réduite à un enseignant assisté ponctuellement. Le coût de possession est le critère majeur.
Les rafales (webhooks à la deadline) sont un problème de file d'attente, pas de scalabilité.

## Décision

1. Un **monolithe modulaire** : un seul processus Node.js (`hgc-server`) porte le portail
   (SPA statique), l'API portail, l'API à clé v1, la réception des webhooks, le flux SSE et
   les workers de jobs.
2. Les frontières internes sont des **modules TypeScript** à interfaces explicites (`auth`,
   `roster`, `assignments`, `github`, `provisioning`, `protected-files`, `deadline`,
   `grading`, `sync`, `metrics`, `notifications`, `api-v1`, `events`, `jobs`), plus un paquet
   `packages/domain` de règles métier pures (regex GR-02, agrégation GR-06, éligibilité GR-05,
   gel GR-12/14) sans dépendance framework ni base.
3. Une variable d'environnement `WORKER_MODE` permet de scinder ultérieurement les rôles `web`
   et `worker` **sans changement de code** : l'option d'évolution est gratuite, pas payée
   d'avance.
4. Le SPOF mono-processus est **accepté** : redémarrage automatique, webhooks re-livrés
   (GH-62), deadlines rattrapées par le ticker (NFR-09) ; une panne du portail n'empêche
   jamais les étudiants de travailler sur GitHub.

## Conséquences

- Un seul log à lire, une seule unité de déploiement, un rollback trivial (tag précédent).
- Pas de cache distribué : les tokens d'installation GitHub vivent en mémoire (GH-03).
- Le bus d'événements SSE est un simple EventEmitter in-process ; en cas de scission
  `WORKER_MODE`, il bascule sur `LISTEN/NOTIFY` Postgres (prévu, non implémenté en v1).
- Tout incident (fuite mémoire, job bloquant) touche simultanément portail, webhooks et
  deadlines : risque assumé face à NFR-08 (99 %), surveillé par la sonde externe.

## Alternatives rejetées

1. **Microservices** (aucune proposition ne les retenait) : la volumétrie ne les justifie
   pas ; chaque service ajouterait déploiement, réseau et observabilité à exploiter.
2. **Deux rôles de processus dès la v1** (proposition robustesse : conteneurs `web` +
   `worker`, relais `LISTEN/NOTIFY`) : un conteneur et un canal de communication de plus,
   non indispensables à 100 étudiants ; la revue a retenu la scission en option
   (`WORKER_MODE`, proposition productivité) plutôt que payée d'avance.
3. **Kubernetes ou orchestrateur** : rien dans les NFR ne le justifie ; exploitation
   permanente disproportionnée pour une équipe d'une personne.
