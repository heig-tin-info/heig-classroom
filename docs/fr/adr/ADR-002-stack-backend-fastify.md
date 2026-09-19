# ADR-002 — Backend Node.js + TypeScript + Fastify

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

Le backend doit s'intégrer en profondeur avec GitHub (App, webhooks, Git Data) et avec l'OIDC
Switch edu-ID, et exposer une trentaine de points d'entrée REST ainsi qu'un flux SSE. Il n'y a qu'un seul
mainteneur, et le code est souvent repris par des assistants ; déboguer la nuit avant un
délai de rendu est le scénario dimensionnant. Octokit, le client GitHub officiel, est en TypeScript.

## Décision

1. **Node.js 22 LTS + TypeScript 5 strict**, un langage unique pour le back end, le front end et
   la CLI, avec des schémas Zod partagés (`packages/contracts`) : un contrat, zéro duplication de types.
2. **Fastify 5** comme framework HTTP : léger, validation de schéma native (Zod via le
   type provider), SSE trivial, OpenAPI généré (`@fastify/swagger`), limite de débit
   (`@fastify/rate-limit`).
3. L'autorisation systématique (AU-23/24) est un **middleware Fastify explicite** appliqué à
   chaque route (propriété de la classe pour un enseignant, inscription `claimed` pour un étudiant).
4. Bibliothèques d'intégration : `octokit` ainsi que les plugins `retry`/`throttling` (NFR-10, GH-63),
   `@octokit/webhooks` (HMAC), `openid-client` (AU-01), Luxon (C-02), pino (AU-41).

## Conséquences

- Pas d'injection de dépendances ni de décorateurs : le flux d'exécution se lit ligne à ligne, et un
  assistant s'y retrouve sans apprendre un framework.
- La discipline structurelle (que NestJS imposerait) repose sur les frontières de modules de
  l'ADR-001 et sur la revue de code.
- En développement, un IdP OIDC de test (Keycloak ou un mock) remplace Switch edu-ID derrière
  `openid-client` : le jalon M1 ne dépend pas du processus institutionnel.

## Alternatives rejetées

1. **NestJS** (proposition productivité : modules, DI, guards comme implémentation de l'AU-24) :
   une couche inutile pour une trentaine de points d'entrée ; les erreurs de DI et la magie des décorateurs sont exactement
   ce que nous ne voulons pas déboguer la veille d'un rendu. Les guards sont remplacés par un
   middleware explicite, avec la même garantie AU-24.
2. **ts-rest** (productivité) : le partage de types est déjà couvert par Zod et par un client généré
   à partir du document OpenAPI ; une dépendance structurelle de moins.
3. **Un autre runtime ou langage** (Go, Python) : cela ferait perdre le langage unique front/back/CLI
   et l'écosystème Octokit officiel.
