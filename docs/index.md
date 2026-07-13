# HEIG Classroom

HEIG Classroom is the TIN department's replacement for the retired GitHub
Classroom: a small portal that turns a GitHub organization into a teaching
machine. Teachers publish assignments from regular Git repositories, students
each get a private, protected copy in one click, a CI workflow grades every
push, and repositories lock themselves when the deadline hits. The portal runs
at [classroom.chevallier.io](https://classroom.chevallier.io).

Start with [About](guide/about.md) for the why and the workflows. Hosting the
portal yourself is covered in [Deployment](deployment/index.md) — including
the one-time [GitHub App](deployment/github-app.md) setup; teachers never
create GitHub applications, installing the App on their organization is one
click in the portal. The full requirements and architecture live in the
Specifications section (in French), including the twelve architecture decision
records under `docs/adr/` in the repository.

The stack in one sentence: a Fastify monolith over PostgreSQL, a React SPA,
Switch edu-ID for identity, and a GitHub App doing the heavy lifting, with
server-sent events keeping every open view live.
