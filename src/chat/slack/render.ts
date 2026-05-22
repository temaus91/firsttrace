import { citationListText } from "../../citations.js";
import type { EvidenceItem, InvestigationResult } from "../../types.js";

const empty = "_None found._";

const topEvidence = (items: EvidenceItem[], limit: number) =>
  items
    .slice(0, limit)
    .map((item, index) => {
      const owner = item.owner ? ` (${item.owner})` : "";
      return `${index + 1}. \`${item.title}\`${owner}: ${item.summary}\n   Evidence: ${citationListText(item.citations)}`;
    })
    .join("\n");

export const renderSlackInvestigationReply = (result: InvestigationResult) =>
  [
    "*FirstTrace investigation*",
    `Classification: \`${result.classification}\``,
    `Likely component: \`${result.ai?.likelyComponent ?? result.likelyComponent}\``,
    `Likely owners: ${
      (result.ai?.likelyOwners.length ? result.ai.likelyOwners : result.likelyOwners)
        .map((owner) => `\`${owner}\``)
        .join(", ") || empty
    }`,
    result.ai ? `AI confidence: \`${result.ai.confidence.toFixed(2)}\`` : "",
    "",
    "*Suspicious files*",
    topEvidence(result.suspiciousFiles, 3) || empty,
    "",
    "*Suggested next steps*",
    result.suggestedNextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n") || empty,
    result.warnings.length ? `\n*Warnings*\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
