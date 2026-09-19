# Documentation sources — English is the reference, French is generated

The documentation site is bilingual and built by
[zensical](https://zensical.org) from this directory.

(This file is named `TRANSLATION.md` rather than `README.md` because zensical
renders a `README.md` found in `docs_dir` *as the home page*, shadowing
`index.md`.)

| Tree | Language | Status | Published at |
| --- | --- | --- | --- |
| `docs/` | English | **reference, written by hand** | `/` |
| `docs/fr/` | French | **generated, committed** | `/fr/` |

**English is the reference. French is generated.** Never edit an English page
by translating a French one, and never expect a hand edit in `docs/fr/` to
survive unless you record it (see below).

## Translating

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm docs:translate                      # everything that changed
pnpm docs:translate --file docs/index.md # one page
pnpm docs:translate --dry-run            # what would be translated
pnpm docs:translate --check              # CI gate, no API key needed
```

`scripts/docs-translate.ts` walks `docs/**/*.md` (minus `docs/fr/**`, this
file and the glossary), splits each page into sections on its `## ` headings,
and translates the sections that are not already in the cache. A section is
the unit because it is small enough that fixing a typo costs one API call and
large enough that the model keeps a consistent voice across the paragraphs it
translates together.

The cache lives in `docs/.translation-cache.json` and **is committed**. Each
entry is keyed by the SHA-256 of the English section, the model id and the
hash of the glossary; the value is the French text. Changing one English page
therefore retranslates only its changed sections, while changing the model or
the glossary retranslates everything — which is the point, because a new
glossary has to be applied to the whole site.

`ANTHROPIC_API_KEY` is read from the environment. `DOCS_TRANSLATE_MODEL` and
`DOCS_TRANSLATE_CONCURRENCY` (default 4) override the defaults.

## Correcting a translation by hand

A generated page is sometimes wrong — a term the glossary does not cover, a
sentence that reads badly. Fix it directly in `docs/fr/…`, then record the
correction so that the next run does not overwrite it:

```bash
pnpm docs:translate --seed-from-existing
```

That mode reads the French tree, pairs each French section with the English
section of the same rank, and stores it in the cache as if the model had
produced it. If the correction reflects a term that should apply everywhere,
add the term to [the glossary](i18n-glossary.md) instead — but be aware that
editing the glossary invalidates the whole cache and costs a full retranslation.

`--seed-from-existing` requires the French page to have the same `## `
structure as its English source; it reports the pages where the two have
drifted apart instead of pairing them wrongly.

## The CI gate

`.github/workflows/docs.yml` runs `pnpm docs:translate --check` on every push
and pull request touching `docs/`. It needs no API key: it only verifies that
every English section has an up-to-date French text in the cache. When it
fails, it names the pages and tells the author to run `pnpm docs:translate`
locally and commit the result.

## Building the site locally

```bash
python -m venv .venv && .venv/bin/pip install zensical
ZENSICAL=.venv/bin/zensical pnpm docs:build
```

`scripts/docs-build.sh` builds English from `zensical.toml` into `site/` and
French from `zensical.fr.toml` into `site/fr/`, then drops the French pages
from the English search index (zensical cannot exclude a subdirectory of
`docs_dir`, so the English build also walks `docs/fr/`).

The EN/FR switch in the header, the "traduction générée" note on French pages
and the first-visit redirect to the browser's language all live in
`overrides/` — `main.html` and `partials/alternate.html`.

## Not in this pipeline (yet)

The in-app help of the classroom web application (`apps/web/src/help/*.md` and
its `*.fr.md` twins) is still translated by hand. It could join the same
pipeline later: the splitter, the cache and the glossary do not care where the
Markdown comes from, only the source and target paths would need to be
configurable.
