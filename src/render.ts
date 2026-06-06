import { citationListText } from "./citations.js";
import { renderManagerOwnerTriage } from "./manager-triage.js";
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

const renderTriageQuality = (ai: AiInvestigationResult) => {
  const quality = ai.quality;
  if (!quality) return "";

  return section(
    "Triage Quality",
    [
      `execution_status: \`${quality.executionStatus}\``,
      `triage_quality: \`${quality.triageQuality}\``,
      `found_exact_file: \`${quality.foundExactFile}\``,
      `found_exact_line: \`${quality.foundExactLine}\``,
      `found_person_owner: \`${quality.foundPersonOwner}\``,
      `found_commit_evidence: \`${quality.foundCommitEvidence}\``,
      `used_team_fallback: \`${quality.usedTeamFallback}\``,
      `citation_coverage: \`${quality.citationCoverage.toFixed(2)}\``,
      `actionability: \`${quality.actionability.toFixed(2)}\``,
      quality.evidenceWarnings.length
        ? section("Evidence Warnings", quality.evidenceWarnings.map((warning) => `- ${warning}`).join("\n"))
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
};

const renderAiReasoning = (ai: AiInvestigationResult) =>
  section(
    "AI Reasoning",
    [
      `Provider: \`${ai.provider}\``,
      ai.promptVersion ? `Prompt: \`${ai.promptVersion}\` / \`${ai.promptProfile ?? "default"}\`` : "",
      `Confidence: \`${ai.confidence.toFixed(2)}\``,
      ai.confidenceRationale ? `Confidence rationale: ${ai.confidenceRationale}` : "",
      ai.bugLikelihood ? `Bug likelihood: \`${ai.bugLikelihood}\`` : "",
      ai.userImpact ? `User impact: ${ai.userImpact}` : "",
      `Likely component: \`${ai.likelyComponent}\``,
      ai.firstContact ? `First contact: \`${ai.firstContact}\`` : "",
      ai.relatedChange ? `Related change: ${ai.relatedChange}` : "",
      ai.quality
        ? `Quality: execution_status=\`${ai.quality.executionStatus}\`, triage_quality=\`${ai.quality.triageQuality}\`, exact_file=\`${ai.quality.foundExactFile}\`, exact_line=\`${ai.quality.foundExactLine}\`, person_owner=\`${ai.quality.foundPersonOwner}\`, commit_evidence=\`${ai.quality.foundCommitEvidence}\`, team_fallback=\`${ai.quality.usedTeamFallback}\`, citation_coverage=\`${ai.quality.citationCoverage.toFixed(2)}\`, actionability=\`${ai.quality.actionability.toFixed(2)}\``
        : "",
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

export const renderInvestigation = (result: InvestigationResult) => {
  if (result.ai?.managerTriage) {
    return [renderManagerOwnerTriage(result.ai.managerTriage), renderTriageQuality(result.ai)]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
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
};
