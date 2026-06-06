import { citationText } from "../citations.js";
import type { AiEvidenceItem, EvidenceItem, InvestigationResult } from "../types.js";
import type { OwnerEvidenceCandidate } from "../owner-evidence.js";

const MAX_SUMMARY_LENGTH = 500;

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

const evidenceFromItems = (
  kind: AiEvidenceItem["kind"],
  prefix: string,
  items: EvidenceItem[],
): AiEvidenceItem[] =>
  items.map((item, index) => ({
    citations: item.citations.map(citationText),
    id: `${prefix}-${index + 1}`,
    kind,
    metadata: item.metadata,
    owner: item.owner,
    path: item.path,
    repo: item.repo,
    score: item.score,
    summary: truncate(item.summary, MAX_SUMMARY_LENGTH),
    title: item.title,
    type: item.type,
  }));

const ownerCandidateFrom = (candidate: OwnerEvidenceCandidate) => ({
  confidence: candidate.confidence,
  email: candidate.email,
  evidence_commits: candidate.evidenceCommits.map((commit) => ({
    commit_id: commit.commitId,
    commit_time: commit.commitTime,
    commit_title: commit.commitTitle,
    evidence_code: commit.evidenceCode,
    file: commit.file,
    line: commit.line,
    repo: commit.repo,
    why_relevant: commit.whyRelevant,
  })),
  evidence_source: candidate.evidenceSource,
  name: candidate.name,
  rank: candidate.rank,
  reason: candidate.reason,
});

const ownerEvidenceFrom = (result: InvestigationResult): AiEvidenceItem[] =>
  [
    ...(result.ownerEvidence?.candidates.map((candidate, index) => {
      const ownerCandidate = ownerCandidateFrom(candidate);
      return {
        citations: candidate.evidenceCommits.map((commit) => `commit ${commit.commitId}`),
        id: `owner-${index + 1}`,
        kind: "owner_evidence" as const,
        metadata: {
          confidence: candidate.confidence,
          email: candidate.email,
          evidenceSource: candidate.evidenceSource,
          name: candidate.name,
          rank: candidate.rank,
        },
        ownerCandidate,
        summary: truncate(candidate.reason, MAX_SUMMARY_LENGTH),
        title: `Owner evidence: ${candidate.name || candidate.email}`,
      };
    }) ?? []),
    ...(result.ownerEvidence?.missingInfo.map((item, index) => ({
      citations: [],
      id: `owner-missing-${index + 1}`,
      kind: "owner_evidence" as const,
      missingInfo: [item],
      summary: truncate(item, MAX_SUMMARY_LENGTH),
      title: "Owner evidence missing",
    })) ?? []),
  ];

export const buildAiReasonerRequest = (result: InvestigationResult) => ({
  classification: result.classification,
  evidence: [
    ...evidenceFromItems("suspicious_file", "file", result.suspiciousFiles),
    ...evidenceFromItems("related_commit", "commit", result.relatedCommits),
    ...ownerEvidenceFrom(result),
    ...evidenceFromItems("related_doc", "doc", result.relatedDocs),
    ...result.warnings.map((warning, index) => ({
      citations: [],
      id: `warning-${index + 1}`,
      kind: "warning" as const,
      summary: warning,
      title: "Investigation warning",
    })),
  ],
  likelyComponent: result.likelyComponent,
  likelyOwners: result.likelyOwners,
  report: result.report,
  searchTerms: result.searchTerms,
  warnings: result.warnings,
});
