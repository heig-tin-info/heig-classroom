# Translation glossary (English → French)

This file is fed verbatim into the system prompt of `scripts/docs-translate.ts`.
Its SHA-256 is part of the translation cache key: editing it invalidates every
cached unit, so change it only when a term is genuinely wrong.

## Domain terms

| English | French |
| --- | --- |
| assignment | devoir |
| classroom | classe |
| roster | liste des étudiants |
| grade (noun) | note |
| grade (verb) | noter |
| grading | notation |
| autograding | notation automatique |
| teacher | enseignant |
| student | étudiant |
| launch token | jeton de lancement |
| workspace | espace de travail |
| deadline | délai de rendu |
| template repository | dépôt modèle |
| student repository | dépôt étudiant |
| protected files | fichiers protégés |
| provisioning | provisionnement |
| reconciliation | réconciliation |
| freeze (a grade) | geler (une note) |
| frozen grade | note gelée |
| submission | rendu |
| feedback | retour |
| runner | runner |
| self-hosted runner | runner auto-hébergé |
| workflow | workflow |
| check run | check run |
| pull request | pull request |
| push | push |
| repository | dépôt |
| branch protection | protection de branche |
| webhook | webhook |
| polling | interrogation périodique |
| ticker | ticker |
| job queue | file de tâches |
| background job | tâche de fond |
| requirement | exigence |
| requirements (document) | cahier des charges |
| needs analysis | analyse des besoins |
| functional specifications | spécifications fonctionnelles |
| architecture decision record | décision d'architecture |
| trade-off | compromis |
| rejected alternatives | alternatives rejetées |
| consequences | conséquences |
| status | statut |
| accepted (ADR status) | acceptée |
| deployment | déploiement |
| release | version |
| rollback | retour arrière |
| backup | sauvegarde |
| monitoring | supervision |
| logging | journalisation |
| log | journal |
| onboarding | prise en main |
| dashboard | tableau de bord |
| settings | paramètres |
| rate limit | limite de débit |
| retry | nouvelle tentative |
| scope (OAuth) | portée |
| identity provider | fournisseur d'identité |
| single sign-on | authentification unique |
| seat | place |
| spike (report) | étude préliminaire |

## Terms kept in English

Safe Exam Browser, GitHub, GitHub App, GitHub Classroom, GitHub Actions,
Switch edu-ID, code-server, Podman, Docker, Fastify, PostgreSQL, Drizzle,
pg-boss, React, SPA, SSE (server-sent events), REST, API, CI, CD, runner,
webhook, workflow, pull request, push, commit, fork, squash, token, monorepo,
Codespace, DigitalOcean, Keycloak, Zod, HEIG-VD, TIN.

## Rules

- Identifiers are never translated: `AU-xx`, `GR-xx`, `NFR-xx`, `GH-xx`,
  `ADR-xxx`, file names, environment variables, code identifiers, URLs.
- Code fences, inline code, HTML and Mermaid diagrams stay byte-for-byte
  identical; only prose inside a Mermaid label may be translated when it is a
  plain French-translatable sentence — when in doubt, leave it.
- Heading anchors change with the heading text; internal links pointing at a
  French anchor must be updated accordingly.
- Relative links keep the same target path: `docs/fr/` mirrors `docs/`, so a
  link that resolves inside the tree keeps working.
- French typography: non-breaking space before `: ; ! ?` and inside `« »` is
  *not* required in this documentation (plain spaces are used), but numbers keep
  a space before a unit (`30 %`, `1 Go`).
- Use the formal, impersonal register of technical documentation. Address the
  reader with "vous" when the English uses "you".
