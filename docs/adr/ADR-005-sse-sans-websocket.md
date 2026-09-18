# ADR-005 — SSE rather than WebSocket, without `Last-Event-ID` replay

## Status

Accepted (2026-07-03, phase 3).

## Context

The portal pushes CI statuses, grades and notifications in real time (GR-10, NT-01). The
stream is strictly one-way, server to browser: the upstream channel already exists (REST).
No functional requirement depends on real time — it is a display comfort.

## Decision

1. **Server-Sent Events** on `GET /app/events` (session cookie required, the same AU-06 auth
   scheme as the portal, outside the `/api/v1` surface reserved for the key-based API).
2. Authorization filtering on the server side: a student only receives the events of their
   own repositories (AU-26).
3. **No `Last-Event-ID` replay** and no ring buffer: on (re)connection the front end replays
   its TanStack Query requests — there is no resume state to maintain on the server.
4. A `:ping` heartbeat every 25 s; `flush_interval -1` on the route in Caddy.
   Degradation: without SSE, a periodic 30 s refetch.

## Consequences

- Plain HTTP: cookies reused as-is, native `EventSource` reconnection, testable with `curl`,
  no dedicated client or server library.
- Losing an SSE event is never losing data: the truth is in the database and the refetch
  brings it back.
- About 200 simultaneous connections at most: trivial for a single Node process. Should a
  `WORKER_MODE` split happen (ADR-001), the internal relay goes through Postgres
  `LISTEN/NOTIFY`.

## Rejected alternatives

1. **WebSocket**: it would only bring useless bidirectionality, a server library, ping-pong
   handling and dedicated authentication — operational code for nothing.
2. **SSE with `Last-Event-ID` replay and a ring buffer** (productivity and robustness
   proposals): finer, but it introduces server state and a resynchronization path that can
   diverge from the refetch; the review kept the stateless variant, whose natural degradation
   is plain polling.
3. **Pure polling**: functional, but it degrades perceived responsiveness (NFR-12 targets
   under 2 min between the end of a run and a visible grade) and multiplies useless requests.
