import type { EvidenceItem, InvestigationResult } from "./types.js";

const empty = "_None found._";

const citationText = (item: EvidenceItem) =>
  item.citations
    .map((citation) => {
      if (citation.commit) return `commit ${citation.commit}`;
      if (citation.path && citation.line) return `${citation.path}:${citation.line}`;
      if (citation.path) return citation.path;
      return citation.label;
    })
    .join(", ");

const evidenceList = (items: EvidenceItem[]) =>
  items.length
    ? items
        .map((item, index) => {
          const owner = item.owner ? ` - ${item.owner}` : "";
          return `${index + 1}. \`${item.title}\`${owner} - score ${item.score}\n   ${item.summary}\n   Evidence: ${citationText(item)}`;
        })
        .join("\n")
    : empty;

const section = (title: string, content: string) => [`## ${title}`, content].join("\n");

export const renderInvestigation = (result: InvestigationResult) =>
  [
    "# FirstTrace Investigation",
    `Classification: \`${result.classification}\``,
    `Likely component: \`${result.likelyComponent}\``,
    `Search terms: ${
      result.searchTerms.length ? result.searchTerms.map((term) => `\`${term}\``).join(", ") : empty
    }`,
    `Likely owners: ${
      result.likelyOwners.length ? result.likelyOwners.map((owner) => `\`${owner}\``).join(", ") : empty
    }`,
    section("Suspicious Files", evidenceList(result.suspiciousFiles)),
    section("Related Commits", evidenceList(result.relatedCommits)),
    section("Related Docs And Issue Exports", evidenceList(result.relatedDocs)),
    section(
      "Suggested Next Steps",
      result.suggestedNextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n") || empty,
    ),
    result.warnings.length
      ? section("Warnings", result.warnings.map((warning) => `- ${warning}`).join("\n"))
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
