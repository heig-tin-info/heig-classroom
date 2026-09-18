# ADR-002 — Node.js + TypeScript + Fastify backend

## Status

Accepted (2026-07-03, phase 3).

## Context

The backend has to integrate deeply with GitHub (App, webhooks, Git Data) and with OIDC
Switch edu-ID, and to expose some thirty REST endpoints plus an SSE stream. There is a single
maintainer, and the code is often picked up by assistants; debugging at night before a
deadline is the sizing scenario. Octokit, the official GitHub client, is TypeScript.

## Decision

1. **Node.js 22 LTS + TypeScript 5 strict**, a single language for back end, front end and
   CLI, with shared Zod schemas (`packages/contracts`): one contract, zero type duplication.
2. **Fastify 5** as the HTTP framework: lightweight, native schema validation (Zod via the
   type provider), trivial SSE, generated OpenAPI (`@fastify/swagger`), rate limiting
   (`@fastify/rate-limit`).
3. Systematic authorization (AU-23/24) is an **explicit Fastify middleware** applied to
   every route (classroom ownership for a teacher, `claimed` enrollment for a student).
4. Integration libraries: `octokit` plus the `retry`/`throttling` plugins (NFR-10, GH-63),
   `@octokit/webhooks` (HMAC), `openid-client` (AU-01), Luxon (C-02), pino (AU-41).

## Consequences

- No dependency injection and no decorators: the execution flow reads line by line, and an
  assistant finds its bearings without learning a framework.
- Structural discipline (which NestJS would impose) rests on the module boundaries of
  ADR-001 and on code review.
- In development, a test OIDC IdP (Keycloak or a mock) stands in for Switch edu-ID behind
  `openid-client`: milestone M1 does not depend on the institutional process.

## Rejected alternatives

1. **NestJS** (productivity proposal: modules, DI, guards as the implementation of AU-24):
   an unnecessary layer for some thirty endpoints; DI errors and decorator magic are exactly
   what we do not want to debug the night before a submission. The guards are replaced by an
   explicit middleware, with the same AU-24 guarantee.
2. **ts-rest** (productivity): type sharing is already covered by Zod plus a client generated
   from the OpenAPI document; one structural dependency fewer.
3. **Another runtime or language** (Go, Python): would lose the single front/back/CLI
   language and the official Octokit ecosystem.
