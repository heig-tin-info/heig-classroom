/**
 * Tiny fuzzy matcher for the search fields: subsequence match with a score
 * favoring consecutive hits and word starts. Good enough for rosters and
 * classroom lists; no dependency.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const t = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === " ") {
      streak = 0;
      continue;
    }
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    streak = found === ti ? streak + 1 : 1;
    score += streak; // consecutive characters weigh more
    if (found === 0 || t[found - 1] === " " || t[found - 1] === "-") score += 2;
    ti = found + 1;
  }
  return score;
}

/** Filters and sorts by descending score; empty query keeps the input order. */
export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string): T[] {
  if (query.trim() === "") return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((r): r is { item: T; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}
