# UI mock and screenshots

How to look at every screen of `apps/web` without a backend, and how to capture
what you looked at. The visual contract itself lives in `apps/web/DESIGN.md`;
the working rules for a UI change live in `.claude/skills/hgc-ui/SKILL.md`.

## Running the mock

```bash
pnpm --filter @hgc/web dev:mock      # http://localhost:5173
```

`src/mock/index.ts` replaces `window.fetch` and `EventSource` with an in-memory
portal: every endpoint the app calls is served from fixtures, and mutations edit
those fixtures so the flows feel real. A reload starts over. The module is
imported behind `import.meta.env.VITE_MOCK`, so a production build drops it.

## URL flags

Flags are read from the query string, remembered in `localStorage` and then
removed from the URL, exactly like the persona. Append `=0` to clear one
(`?many=0`), and read the console line on boot to see which are active.

| Flag | What it does |
| --- | --- |
| `?as=teacher\|student\|admin` | Persona of the session. |
| `?unlinked=1` | Student with no GitHub account linked. |
| `?empty=1` | Nothing anywhere: no classrooms, no roster, no assignments, no teachers, no scheduled tasks. Classrooms stay addressable by URL, so `/classrooms/c1` shows an empty roster and an empty assignment list. |
| `?fail=1` | Every GET under `/app/api` answers 500 `{"message":"Simulated failure"}`, except `/app/api/me` so the shell still renders. The error state appears after about one second: React Query retries once (never on a 4xx) before giving up. |
| `?slow=1` | 2.5 s of latency on every call: the skeletons and spinners stay on screen. |
| `?many=1` | 30 classrooms, a 120-student roster and 40 assignments on the first one: long lists, long tables and the sidebar under load. |

Fixed classrooms worth knowing:

| Path | State |
| --- | --- |
| `/classrooms/c1` | Everything nominal: GitHub App installed, Team plan, assignments covering draft, published, locked, online, duration-based and group work. |
| `/classrooms/c2` | Installed but on the GitHub Free plan, and `ANTHROPIC_API_KEY` missing: two warning banners, plus an SEB exam assignment. |
| `/classrooms/c3` | Co-taught classroom (`isOwner: false`): the owner-only actions are gone. |
| `/classrooms/c4` | GitHub App **not installed**: the install wizard replaces the assignments. |
| `/classrooms/c5` | Organization **missing** on GitHub (`exists: false`): the read-only failure banner. |

Group assignments (issue #2) have their own fixtures, reachable from
`/classrooms/<id>/assignments/<id>/groups`:

| Path | State |
| --- | --- |
| `/classrooms/c1/assignments/a7/groups` | Draft being formed: four groups, one over the size hint of 3, fifteen students still unassigned. |
| `/classrooms/c1/assignments/a6/groups` | Published: everyone placed, and the first group owns a repository, so it is locked (no rename, no delete, no ✕). |
| `/classrooms/c2/assignments/b3/groups` | Group mode with nothing formed yet: the empty state and the whole roster on the left. |
| `/classrooms/c1/assignments/a2/groups` | Individual assignment: the 409 `group_mode_off` answer, not a failure. |

## Screenshots

```bash
pnpm --filter @hgc/web dev:mock                    # terminal 1
pnpm --filter @hgc/web screenshots                 # terminal 2
```

`apps/web/scripts/screenshots.mjs` drives Chromium through `playwright-core`
(a devDependency of `@hgc/web`). It is a development tool: nothing imports it,
it is not part of the build, and it does not run in CI.

| Flag | Effect |
| --- | --- |
| `--list` | Print the scene names and exit. |
| `--only=<substring>` | Keep the scenes whose name contains it; repeatable. A bare word works too. |
| `--width=390` | Viewport width; repeatable (`--width=390 --width=768 --width=1440`). Default 1440. |
| `--dark` | Dark theme (sets `hgc-theme` and the OS colour scheme). |
| `--fold` | Viewport only, instead of the whole page. |

`BASE` (default `http://localhost:5173`) and `OUT` (default
`apps/web/screenshots/`, git-ignored) are environment variables. Files are named
`<scene><-dark><-width>.png`, so a light 1440 shot is just `<scene>.png`.

A scene is one entry of the `scenes` array: a persona, a URL (mock flags
included), optional `localStorage` entries and an optional `act` that opens a
sheet, a menu or a dialog before the shot. Adding a state to look at means
adding one line there. The runner reports any console or page error next to the
file it wrote, which is the cheapest regression check the app has.

Then **read the PNGs**. A change that was not looked at is not finished.
