import { classifyReport } from "./classify.js";
import { extractTerms } from "./terms.js";
import { searchCommits, searchDocs, searchFiles, searchIssueExports, sortEvidenceItems } from "./search.js";
import type { EvidenceItem, InvestigationResult, PreparedFirstTraceConfig } from "./types.js";

const likelyComponentFrom = (items: EvidenceItem[]) => {
  const topPath = items.find((item) => item.path)?.path;
  if (!topPath) return "unknown";
  const parts = topPath.split("/");
  return parts.length > 1 ? parts[0] ?? "unknown" : topPath;
};

const uniqueOwnersFrom = (items: EvidenceItem[]) => [
  ...new Set(items.flatMap((item) => (item.owner ? [item.owner] : []))),
];

const nextStepsFor = (
  suspiciousFiles: EvidenceItem[],
  relatedCommits: EvidenceItem[],
  relatedDocs: EvidenceItem[],
) => {
  const steps: string[] = [];
  const topFile = suspiciousFiles[0];
  const topOwner = uniqueOwnersFrom(suspiciousFiles)[0];
  const topCommit = relatedCommits[0];
  const topDoc = relatedDocs[0];

  if (topFile?.path) {
    steps.push(`Start by inspecting ${topFile.path}.`);
  } else {
    steps.push("Ask for exact error text, UI labels, file paths, or screenshots to improve matching.");
  }

  if (topOwner) {
    steps.push(`Route the first pass to ${topOwner}.`);
  }

  if (topCommit?.metadata?.date) {
    steps.push(`Review recent related commit ${topCommit.citations[0]?.commit ?? topCommit.title}.`);
  }

  if (topDoc?.path) {
    steps.push(`Compare against ${topDoc.path} for context.`);
  }

  return steps;
};

export const investigate = (report: string, config: PreparedFirstTraceConfig): InvestigationResult => {
  const searchTerms = extractTerms(report);
  const warnings: string[] = [];

  if (!searchTerms.length) {
    warnings.push("The report had too few searchable terms; add screen names, error text, IDs, or paths.");
  }

  const suspiciousFiles = sortEvidenceItems(
    config.repos.flatMap((repo) => searchFiles(repo, searchTerms, config)),
  ).slice(0, config.search.maxFiles);

  const relatedDocs = sortEvidenceItems(
    config.repos.flatMap((repo) => [
      ...searchDocs(repo, searchTerms, config),
      ...searchIssueExports(repo, searchTerms, config),
    ]),
  ).slice(0, config.search.maxFiles);

  const relatedCommits = sortEvidenceItems(
    config.repos.flatMap((repo) => searchCommits(repo, searchTerms, config)),
  ).slice(0, config.search.maxCommits);

  if (!suspiciousFiles.length && searchTerms.length) {
    warnings.push("No suspicious files matched the report terms.");
  }

  return {
    classification: classifyReport(report),
    likelyComponent: likelyComponentFrom(suspiciousFiles.length ? suspiciousFiles : relatedDocs),
    likelyOwners: uniqueOwnersFrom([...suspiciousFiles, ...relatedDocs]),
    relatedCommits,
    relatedDocs,
    report,
    searchTerms,
    suggestedNextSteps: nextStepsFor(suspiciousFiles, relatedCommits, relatedDocs),
    suspiciousFiles,
    warnings,
  };
};
