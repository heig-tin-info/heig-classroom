# Dependencies and the Dependabot lockfile trap

## Why Dependabot's npm pull requests fail CI

Every Dependabot npm pull request in this repository arrives red, and always
with the same error, whatever it was bumping:

```
ERR_PNPM_MISSING_TARBALL_INTEGRITY  Cannot install package
"xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz":
its lockfile entry has no "integrity" field, so pnpm cannot verify the
downloaded tarball.
```

`apps/web` depends on SheetJS by URL, not by version:

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

SheetJS stopped publishing `xlsx` to the npm registry after 0.18.5, so the
vendor's own CDN is the official distribution. There is nothing wrong with that
specifier — the problem is what happens to it on the way through Dependabot.

pnpm can only record the `integrity` of a URL tarball if it **downloads** the
tarball and hashes it. Resolving alone is not enough: `pnpm install
--lockfile-only` writes the entry without an integrity too, so this is not a
Dependabot bug so much as a consequence of how it regenerates the lockfile. The
correct entry, the one on `main`, looks like this:

```yaml
xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz:
  resolution: {integrity: sha512-oLDq3jw7…, tarball: https://cdn.sheetjs.com/…}
```

and what comes back from Dependabot has lost the first field.

The failure is doing its job. pnpm is refusing to install an unverified tarball
from a non-registry host, which is exactly what you want a package manager to do.
Do not silence it, and do not reach for `--no-frozen-lockfile` in CI: the whole
point of the pinned lockfile is that the production image installs the same
bytes that were tested.

## Repairing a Dependabot bump

Do not fix Dependabot's lockfile. Throw it away and redo the bump on top of the
known-good one, which keeps every untouched entry — including the integrity —
exactly as it was:

```bash
git checkout -b chore/<what-you-are-bumping> origin/main
# edit the versions in the package.json files by hand
pnpm install                      # NOT --lockfile-only: it must fetch to hash
grep -A1 '^  xlsx@https' pnpm-lock.yaml     # the integrity must still be there
pnpm install --frozen-lockfile    # what CI runs; must pass
pnpm build && pnpm typecheck && pnpm test
```

Then close the Dependabot pull request as superseded, so it does not linger and
get merged later by mistake.

If you ever do need to re-derive the integrity from scratch, it is the base64
SHA-512 of the tarball, and you can check it against the lockfile without
trusting anyone:

```bash
curl -sSL https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz \
  | openssl dgst -sha512 -binary | openssl base64 -A
```

## How Dependabot is set up here

`.github/dependabot.yml` exists to keep the number of pull requests that need
the repair above as low as possible.

For npm, `open-pull-requests-limit: 0` switches **version** updates off. That
looks backwards in a file whose purpose is to configure updates, but adding an
npm entry at all is what would have enabled them, and a weekly batch of version
bumps is a weekly batch of broken lockfiles to repair by hand. Security pull
requests are explicitly not subject to that limit, so they keep arriving — and
they are the ones worth the trouble. A group then collapses them into a single
pull request rather than one per package: the three that piled up here needed
exactly the same repair, and it is now done once.

The group carries `applies-to: security-updates`, which is easy to miss and
silently fatal: a group without it defaults to version updates, so it would
have grouped nothing at all.

GitHub Actions and the Docker base image are configured the other way round,
with version updates on, because neither touches the pnpm lockfile and their
pull requests merge as they arrive. Majors of the `node` base image are ignored
on purpose — moving production to a new Node major is a decision taken with
`engines` and the CI matrix, not one to discover in a dependency pull request.
`ignore` only ever applies to version updates, so that costs nothing in safety.

## Before merging a server dependency

A green suite does not, by itself, clear a bump of something that serves
production traffic. Check what the tests actually reach: `STATIC_DIR` is empty
by default, so for a long time nothing exercised `@fastify/static` or the SPA
fallback at all, while production sets it on every boot. That gap is closed now
(`app.test.ts`, "app (serving the built SPA)"), but the lesson generalizes —
when a bump's only risk area is a code path guarded by configuration, make sure
a test sets that configuration before you trust the green tick.
