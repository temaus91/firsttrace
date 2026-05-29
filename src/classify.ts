import type { Classification } from "./types.js";

const FEATURE_PATTERNS = [
  /\bfeature request\b/i,
  /\benhancement\b/i,
  /\badd support\b/i,
  /\bcan we add\b/i,
  /\bwould like\b/i,
  /\bnew feature\b/i,
];

const SUPPORT_PATTERNS = [
  /\bhow do i\b/i,
  /\bhow can i\b/i,
  /\bquestion\b/i,
  /\bcan someone explain\b/i,
  /\bwhere do i\b/i,
  /\bwhat is\b/i,
  /\bwhy does\b/i,
];

const BUG_PATTERNS = [
  /\bbug\b/i,
  /\berror\b/i,
  /\bexception\b/i,
  /\bcrash(?:es|ed|ing)?\b/i,
  /\bfail(?:s|ed|ing|ure)?\b/i,
  /\bbroken\b/i,
  /\bregression\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bnot working\b/i,
  /\bcannot\b/i,
  /\bcan't\b/i,
  /\bstuck\b/i,
  /\btimeout\b/i,
];

const score = (report: string, patterns: RegExp[]) =>
  patterns.reduce((total, pattern) => total + (pattern.test(report) ? 1 : 0), 0);

export const classifyReport = (report: string): Classification => {
  const scores: Record<Classification, number> = {
    bug: score(report, BUG_PATTERNS),
    feature_request: score(report, FEATURE_PATTERNS),
    support_question: score(report, SUPPORT_PATTERNS),
    unknown: 0,
  };

  const ranked = (Object.entries(scores) as [Classification, number][])
    .filter(([classification]) => classification !== "unknown")
    .sort((a, b) => b[1] - a[1]);

  return ranked[0] && ranked[0][1] > 0 ? ranked[0][0] : "unknown";
};
