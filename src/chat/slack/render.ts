import { citationListText } from "../../citations.js";
import type { AiFileFinding, AiImplementerHint, EvidenceItem, InvestigationResult } from "../../types.js";

const empty = "_None found._";

const textList = (items: string[]) => items.join(", ") || empty;

const topEvidence = (items: EvidenceItem[], limit: number) =>
  items
    .slice(0, limit)
    .map((item, index) => {
      const owner = item.owner ? ` (${item.owner})` : "";
      return `${index + 1}. \`${item.title}\`${owner}: ${item.summary}\n   Evidence: ${citationListText(item.citations)}`;
    })
    .join("\n");

const aiFileEvidence = (items: AiFileFinding[], limit: number) =>
  items
    .slice(0, limit)
    .map(
      (item, index) =>
        `${index + 1}. \`${item.path}\` in \`${item.repo}\` - confidence ${item.confidence.toFixed(2)}\n   ${item.reason}\n   Evidence: ${textList(item.citations)}`,
    )
    .join("\n");

const relatedCommitSignals = (items: EvidenceItem[], limit: number) =>
  items
    .slice(0, limit)
    .map((item, index) => {
      const author = typeof item.metadata?.author === "string" ? item.metadata.author : undefined;
      const date = typeof item.metadata?.date === "string" ? item.metadata.date : undefined;
      const attribution = [author, date].filter(Boolean).join(", ");
      return `${index + 1}. \`${item.citations[0]?.commit ?? item.title}\`${attribution ? ` (${attribution})` : ""}\n   ${item.summary}\n   Evidence: ${citationListText(item.citations)}`;
    })
    .join("\n");

const implementerHints = (items: AiImplementerHint[], limit: number) =>
  items
    .slice(0, limit)
    .map((item, index) => {
      const name = item.name ?? item.email ?? item.commit ?? "unknown";
      return `${index + 1}. \`${name}\`${item.commit ? ` - commit ${item.commit}` : ""}\n   ${item.reason}\n   Evidence: ${textList(item.citations)}`;
    })
    .join("\n");

const nextChecks = (result: InvestigationResult) => {
  const questions = result.ai?.missingInfoQuestions.map((question) => `Ask: ${question}`) ?? [];
  return [...result.suggestedNextSteps, ...questions].slice(0, 4).map((step, index) => `${index + 1}. ${step}`).join("\n");
};

export const renderSlackInvestigationReply = (result: InvestigationResult) =>
  [
    "*FirstTrace investigation*",
    `Classification: \`${result.classification}\``,
    `Likely component: \`${result.ai?.likelyComponent ?? result.likelyComponent}\``,
    `Likely owners: ${textList(
      (result.ai?.likelyOwners.length ? result.ai.likelyOwners : result.likelyOwners).map((owner) => `\`${owner}\``),
    )}`,
    result.ai ? `AI confidence: \`${result.ai.confidence.toFixed(2)}\`` : "",
    "",
    "*Best fault-location lead*",
    result.ai?.likelyFiles.length ? aiFileEvidence(result.ai.likelyFiles, 3) : topEvidence(result.suspiciousFiles, 3) || empty,
    result.ai?.explanation ? ["", "*Why this is suspicious*", result.ai.explanation].join("\n") : "",
    "",
    "*Implementer / commit signals*",
    result.ai?.implementerHints.length
      ? implementerHints(result.ai.implementerHints, 3)
      : relatedCommitSignals(result.relatedCommits, 3) || empty,
    "",
    "*Next checks*",
    nextChecks(result) || empty,
    result.warnings.length ? `\n*Warnings*\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
