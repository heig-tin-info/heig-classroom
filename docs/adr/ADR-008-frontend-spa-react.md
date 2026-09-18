# ADR-008 — React + Vite SPA front end, accessible headless components, no SSR

## Status

Accepted (2026-07-03, phase 3).

## Context

The portal is an authenticated application (teacher, student) with no SEO need whatsoever.
Table views must render in under 2 s at 100 rows (NFR-11). The interface ships in French with
English addable without a rewrite (NFR-14), dates in Europe/Zurich (C-02), and nine WCAG 2.1
AA criteria are required on the main journeys (NFR-15).

## Decision

1. A **React 19 + Vite 7 SPA**, served as static files by the monolith: no front-end server
   to operate, trivial redeployment.
2. **TanStack Router + Query + Table**: cache and invalidation driven by the SSE events
   (ADR-005), 100-row tables without on-the-fly aggregation.
3. **Radix UI (headless)** as the component foundation: keyboard, focus and ARIA covered by
   construction — NFR-15 compliance does not rest on a continuous effort.
4. **i18next** with externalized strings (NFR-14); **Luxon** for Europe/Zurich display
   (C-02).
5. Types shared with the backend and the CLI through the Zod schemas of
   `packages/contracts`.

## Consequences

- The front end is a folder of static files versioned with the backend: the portal API does
  not need to be versioned (they are deployed together).
- The acceptance accessibility audit (axe-core, NFR-15) checks a foundation that is already
  accessible instead of catching up on home-made components.
- SSE reconnection is resolved by a TanStack Query refetch: no duplicated real-time state.

## Rejected alternatives

1. **Next.js or SSR**: no server rendering is needed (the portal sits behind a login, SEO is
   irrelevant); it would add a front-end server to operate and a deployment coupling.
2. **Home-made UI components**: a recurring accessibility cost and a permanent risk on
   NFR-15; all three proposals converged on a headless foundation.
3. **A Turborepo + pnpm multi-pipeline monorepo setup** (productivity proposal): six packages
   and build pipelines for a one-maintainer project; plain pnpm workspaces are enough for the
   three shared packages.
