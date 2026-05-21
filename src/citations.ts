import type { Citation } from "./types.js";

export const citationText = (citation: Citation) => {
  if (citation.commit) return `commit ${citation.commit}`;
  if (citation.path && citation.line) return `${citation.path}:${citation.line}`;
  if (citation.path) return citation.path;
  return citation.label;
};

export const citationListText = (citations: Citation[]) => citations.map(citationText).join(", ");
