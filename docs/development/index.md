# Development

This section is the engineering memory of HEIG Classroom. The project is
developed primarily by Claude, Anthropic's coding agent, working from these
documents: they are not an afterthought but the actual source of truth that
drives implementation. If you contribute, human or AI, start here.

The method is deliberately old school: requirements first, then specifications,
then architecture, then code. Every requirement carries a stable identifier
(US-xx for user stories, NFR-xx for non-functional requirements, AU/GH/GR-xx for
the functional specs) and the code references those identifiers in comments and
commit messages. When a decision changes, the document is revised first, then
the code follows.

What you will find here, in reading order:

1. **Needs analysis** (French): the original idea, actors, domain model, risks
   and the decisions that shaped everything else.
2. **Requirements** (French): user stories with acceptance criteria,
   non-functional requirements, constraints, and the validated hypotheses
   (H1 to H12, with their revisions).
3. **Functional specifications** (French): the precise behavior of every
   subsystem, from Switch edu-ID login to grading collection.
4. **Architecture** (French): the consolidated design, a Fastify monolith over
   PostgreSQL driving GitHub through a GitHub App, plus twelve architecture
   decision records under `docs/adr/` in the repository.
5. **Spike reports**: what was actually measured against the real GitHub API
   before committing to a design, including the traps discovered along the way
   (Octokit retry on empty repositories, `safe.bareRepository`, and friends).

The specification documents are written in French and typeset with
[TeXSmith](https://github.com/heig-tin-info/texsmith); each one builds to a PDF
with `texsmith docs/<doc>.md --build`. Everything user-facing (portal, guide,
this site) is in English.
