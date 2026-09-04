const isWordChar = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);

/**
 * Subsequence match with bonuses: +2 for a match at a word start, +1 for a match adjacent to the
 * previous one, +query.length when the query is a contiguous substring. `null` = no match; an empty
 * query matches everything with score 0.
 */
export const fuzzyScore = (query: string, text: string): number | null => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let pos = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const idx = t.indexOf(ch, pos);
    if (idx === -1) return null;
    score += 1;
    const before = idx === 0 ? '' : t.charAt(idx - 1);
    if (before === '' || !isWordChar(before)) score += 2;
    if (idx === prev + 1) score += 1;
    prev = idx;
    pos = idx + 1;
  }
  if (t.includes(q)) score += q.length;
  return score;
};

/** Best score across several fields (label, meta), or null when none match. */
export const fuzzyBest = (query: string, fields: readonly string[]): number | null => {
  let best: number | null = null;
  for (const f of fields) {
    const s = fuzzyScore(query, f);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
};
