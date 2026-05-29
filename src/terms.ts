const STOP_WORDS = new Set(
  [
    "about",
    "actual",
    "after",
    "again",
    "also",
    "and",
    "any",
    "are",
    "because",
    "been",
    "but",
    "can",
    "cannot",
    "change",
    "changed",
    "changes",
    "could",
    "did",
    "does",
    "done",
    "expected",
    "for",
    "from",
    "had",
    "has",
    "have",
    "into",
    "issue",
    "just",
    "look",
    "more",
    "need",
    "not",
    "now",
    "observed",
    "only",
    "our",
    "please",
    "problem",
    "report",
    "should",
    "some",
    "steps",
    "than",
    "that",
    "the",
    "their",
    "then",
    "there",
    "these",
    "this",
    "those",
    "using",
    "was",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "with",
    "would",
  ].sort(),
);

export const extractTerms = (report: string, maxTerms = 14) => {
  const matches = report.match(/[a-z][a-z0-9_-]{2,}/gi) ?? [];
  const terms = new Set<string>();

  for (const match of matches) {
    const term = match.toLowerCase();
    if (STOP_WORDS.has(term) || /^\d+$/.test(term)) continue;
    terms.add(term);
    if (terms.size >= maxTerms) break;
  }

  return [...terms];
};

export const countTermHits = (text: string, terms: string[]) => {
  const haystack = text.toLowerCase();
  return terms.reduce((count, term) => {
    if (!term) return count;
    let hits = 0;
    let index = haystack.indexOf(term.toLowerCase());
    while (index !== -1) {
      hits += 1;
      index = haystack.indexOf(term.toLowerCase(), index + term.length);
    }
    return count + hits;
  }, 0);
};
