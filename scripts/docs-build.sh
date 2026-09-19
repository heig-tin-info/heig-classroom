#!/usr/bin/env bash
#
# Build the bilingual documentation into a single `site/` directory:
#
#   site/       English — the reference version, from docs/ and zensical.toml
#   site/fr/    French  — generated pages, from docs/fr/ and zensical.fr.toml
#
# zensical has no way to exclude a subdirectory of docs_dir, so the English
# build also renders docs/fr/** (with the English chrome) into site/fr and
# indexes those pages for search. Both are undone here: the directory is
# removed before the French build writes the real thing, and the French entries
# are dropped from the English search index.
#
# Set ZENSICAL=/path/to/zensical to use a specific executable (a virtualenv).

set -euo pipefail

cd "$(dirname "$0")/.."

ZENSICAL="${ZENSICAL:-zensical}"

echo "==> English (docs/ -> site/)"
rm -rf site
"$ZENSICAL" build --clean

# zensical copies every non-Markdown file of docs_dir into the output; the
# translation cache has no business being served.
rm -f site/.translation-cache.json

echo "==> French (docs/fr/ -> site/fr/)"
rm -rf site/fr
"$ZENSICAL" build --clean -f zensical.fr.toml

echo "==> Pruning French pages from the English search index"
node - <<'NODE'
const fs = require("node:fs");

const file = "site/search.json";
if (!fs.existsSync(file)) {
  console.warn(`   ${file} not found, nothing to prune`);
  process.exit(0);
}
const index = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(index.items)) {
  console.warn(`   ${file} has an unexpected shape, left untouched`);
  process.exit(0);
}
const before = index.items.length;
index.items = index.items.filter(
  (item) => !String(item.location ?? "").startsWith("fr/"),
);
fs.writeFileSync(file, JSON.stringify(index));
console.log(`   ${before - index.items.length} French entries removed`);
NODE

echo "==> Done: site/index.html and site/fr/index.html"
