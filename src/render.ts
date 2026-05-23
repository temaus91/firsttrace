import { citationListText } from "./citations.js";
import type { AiInvestigationResult, EvidenceItem, InvestigationResult } from "./types.js";

const empty = "_None found._";

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

const citationText = (item: EvidenceItem) => citationListText(item.citations);

const aiList = (items: string[]) =>
  items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : empty;

const aiNextSteps = (ai: AiInvestigationResult) =>
  [
    ai.likelyFiles[0] ? `Inspect ${ai.likelyFiles[0].path} first.` : undefined,
    ai.implementerHints[0]?.name ? `Route the first pass to ${ai.implementerHints[0].name}.` : undefined,
    ai.implementerHints[0]?.commit ? `Review related commit ${ai.implementerHints[0].commit}.` : undefined,
    ...ai.missingInfoQuestions.map((question) => `Ask: ${question}`),
  ]
    .filter((step): step is string => Boolean(step))
    .slice(0, 4);

const renderAiReasoning = (ai: AiInvestigationResult) =>
  section(
    "AI Reasoning",
    [
      `Provider: \`${ai.provider}\``,
      `Confidence: \`${ai.confidence.toFixed(2)}\``,
      `Likely component: \`${ai.likelyComponent}\``,
      `Likely owners: ${
        ai.likelyOwners.length ? ai.likelyOwners.map((owner) => `\`${owner}\``).join(", ") : empty
      }`,
      section(
        "AI Likely Files",
        ai.likelyFiles.length
          ? ai.likelyFiles
              .map(
                (file, index) =>
                  `${index + 1}. \`${file.path}\` in \`${file.repo}\` - confidence ${file.confidence.toFixed(2)}\n   ${file.reason}\n   Evidence: ${file.citations.join(", ") || empty}`,
              )
              .join("\n")
          : empty,
      ),
      section(
        "AI Implementer Hints",
        ai.implementerHints.length
          ? ai.implementerHints
              .map((hint, index) => {
                const name = hint.name ?? hint.email ?? hint.commit ?? "unknown";
                return `${index + 1}. \`${name}\`${hint.commit ? ` - commit ${hint.commit}` : ""}\n   ${hint.reason}\n   Evidence: ${hint.citations.join(", ") || empty}`;
              })
              .join("\n")
          : empty,
      ),
      section("AI Explanation", ai.explanation || empty),
      section("AI Missing Information Questions", aiList(ai.missingInfoQuestions)),
      ai.warnings.length ? section("AI Warnings", ai.warnings.map((warning) => `- ${warning}`).join("\n")) : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );

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
    result.ai ? renderAiReasoning(result.ai) : "",
    section("Suspicious Files", evidenceList(result.suspiciousFiles)),
    section("Related Commits", evidenceList(result.relatedCommits)),
    section("Related Docs And Issue Exports", evidenceList(result.relatedDocs)),
    section(
      "Suggested Next Steps",
      (result.ai ? aiNextSteps(result.ai) : result.suggestedNextSteps).map((step, index) => `${index + 1}. ${step}`).join("\n") || empty,
    ),
    result.warnings.length
      ? section("Warnings", result.warnings.map((warning) => `- ${warning}`).join("\n"))
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
