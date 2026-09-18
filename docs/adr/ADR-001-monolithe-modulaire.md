# ADR-001 — Modular monolith, single process, optional `WORKER_MODE` split

## Status

Accepted (2026-07-03, phase 3).

## Context

The platform serves a web portal, two APIs, a webhook endpoint, an SSE stream and background
jobs (deadline, provisioning, grading). Volumes are low (NFR-11: 30 to 100 students per
classroom, 20 active classrooms), the availability target is 99 % (NFR-08), and the operations
team is one teacher with occasional help. Cost of ownership is the deciding criterion.
Bursts (webhooks at the deadline) are a queueing problem, not a scalability one.

## Decision

1. A **modular monolith**: a single Node.js process (`hgc-server`) carries the portal
   (static SPA), the portal API, the v1 key-based API, webhook reception, the SSE stream and
   the job workers.
2. Internal boundaries are **TypeScript modules** with explicit interfaces (`auth`,
   `roster`, `assignments`, `github`, `provisioning`, `protected-files`, `deadline`,
   `grading`, `sync`, `metrics`, `notifications`, `api-v1`, `events`, `jobs`), plus a
   `packages/domain` package of pure business rules (GR-02 regex, GR-06 aggregation, GR-05
   eligibility, GR-12/14 freezing) with no framework or database dependency.
3. A `WORKER_MODE` environment variable makes it possible to split the `web` and `worker`
   roles later **without any code change**: the evolution option is free, not paid for
   upfront.
4. The single-process SPOF is **accepted**: automatic restart, webhooks redelivered
   (GH-62), deadlines caught up by the ticker (NFR-09); a portal outage never prevents
   students from working on GitHub.

## Consequences

- A single log to read, a single deployment unit, a trivial rollback (previous tag).
- No distributed cache: GitHub installation tokens live in memory (GH-03).
- The SSE event bus is a plain in-process EventEmitter; should a `WORKER_MODE` split
  happen, it switches to Postgres `LISTEN/NOTIFY` (planned, not implemented in v1).
- Any incident (memory leak, blocking job) hits portal, webhooks and deadlines at once:
  a risk accepted against NFR-08 (99 %), watched by the external probe.

## Rejected alternatives

1. **Microservices** (no proposal retained them): the volumes do not justify them; every
   service would add deployment, networking and observability to operate.
2. **Two process roles from v1 on** (robustness proposal: `web` + `worker` containers,
   `LISTEN/NOTIFY` relay): one more container and one more communication channel, not
   essential at 100 students; the review kept the split as an option (`WORKER_MODE`,
   productivity proposal) rather than paid for upfront.
3. **Kubernetes or an orchestrator**: nothing in the NFRs justifies it; the ongoing
   operational load is out of proportion for a one-person team.
