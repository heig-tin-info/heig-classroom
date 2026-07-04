# ADR-002 — Backend Node.js + TypeScript + Fastify

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

Le backend doit intégrer profondément GitHub (App, webhooks, Git Data), OIDC Switch edu-ID,
et exposer une trentaine d'endpoints REST plus un flux SSE. Un seul mainteneur, du code
souvent repris par des assistants ; le débogage de nuit avant une deadline est le scénario
dimensionnant. Octokit, client GitHub officiel, est TypeScript.

## Décision

1. **Node.js 22 LTS + TypeScript 5 strict**, un seul langage pour back, front et CLI, avec
   schémas Zod partagés (`packages/contracts`) : contrat unique, zéro duplication de types.
2. **Fastify 5** comme framework HTTP : léger, validation par schémas native (Zod via
   type provider), SSE trivial, OpenAPI générée (`@fastify/swagger`), rate limiting
   (`@fastify/rate-limit`).
3. L'autorisation systématique (AU-23/24) est un **middleware Fastify explicite** appliqué à
   chaque route (ownership classroom pour teacher, enrollment `claimed` pour student).
4. Bibliothèques d'intégration : `octokit` + plugins `retry`/`throttling` (NFR-10, GH-63),
   `@octokit/webhooks` (HMAC), `openid-client` (AU-01), Luxon (C-02), pino (AU-41).

## Conséquences

- Pas d'injection de dépendances ni de décorateurs : le flux d'exécution se lit ligne à
  ligne, un assistant retrouve ses marques sans apprentissage de framework.
- La discipline de structure (que NestJS imposerait) repose sur les frontières de modules
  de l'ADR-001 et la revue de code.
- En développement, un IdP OIDC de test (Keycloak ou mock) remplace Switch edu-ID derrière
  `openid-client` : le jalon M1 ne dépend pas de la démarche institutionnelle.

## Alternatives rejetées

1. **NestJS** (proposition productivité : modules, DI, guards comme implémentation d'AU-24) :
   surcouche non indispensable pour une trentaine d'endpoints ; les erreurs de DI et la magie
   des décorateurs sont précisément ce qu'on ne veut pas déboguer la veille d'un rendu. Les
   guards sont remplacés par un middleware explicite, même garantie AU-24.
2. **ts-rest** (productivité) : le partage de types est déjà couvert par Zod + client généré
   depuis l'OpenAPI ; une dépendance structurante de moins.
3. **Autre runtime ou langage** (Go, Python) : perdrait l'unicité de langage front/back/CLI
   et l'écosystème Octokit officiel.
