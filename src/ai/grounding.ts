import {
  MANAGER_OWNER_TRIAGE_PROFILE,
  parseManagerOwnerTriageResult,
  type ManagerOwnerTriageCandidate,
  type ManagerOwnerTriageEvidenceCommit,
  type ManagerOwnerTriageResult,
} from "../manager-triage.js";
import type { AiImplementerHint, AiInvestigationResult, AiReasonerRequest } from "../types.js";

const allowedCitationSet = (request: AiReasonerRequest) =>
  new Set(request.evidence.flatMap((item) => [item.id, ...item.citations]));

const parseLineSpec = (citation: string) => {
  const match = /^(.+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(citation);
  if (!match) return undefined;

  const ranges = (match[2] ?? "").split(",").flatMap((segment) => {
    const [startRaw, endRaw] = segment.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw ?? startRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return [];
    }
    return [{ end, start }];
  });

  return ranges.length ? { path: match[1] ?? "", ranges } : undefined;
};

const allowedLineCitationsInRange = (citation: string, allowedCitations: Set<string>) => {
  const parsed = parseLineSpec(citation);
  if (!parsed || parsed.ranges.every((range) => range.start === range.end)) return [];

  return [...allowedCitations]
    .filter((allowedCitation) => {
      const allowed = /^(.+):(\d+)$/.exec(allowedCitation);
      if (!allowed || allowed[1] !== parsed.path) return false;
      const line = Number(allowed[2]);
      return parsed.ranges.some((range) => line >= range.start && line <= range.end);
    })
    .slice(0, 5);
};

const allowedFileCitationForLine = (citation: string, allowedCitations: Set<string>) => {
  const parsed = parseLineSpec(citation);
  if (!parsed || !allowedCitations.has(parsed.path)) return [];
  return [parsed.path];
};

const groundedCitations = (
  citations: string[],
  allowedCitations: Set<string>,
  warnings: string[],
  label: string,
  quality: { supported: number; total: number },
) => {
  quality.total += citations.length;
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const citation of citations) {
    if (allowedCitations.has(citation)) {
      allowed.push(citation);
      continue;
    }

    const normalized = [
      ...allowedLineCitationsInRange(citation, allowedCitations),
      ...allowedFileCitationForLine(citation, allowedCitations),
    ];
    if (normalized.length) {
      allowed.push(...normalized);
      continue;
    }

    rejected.push(citation);
  }
  const uniqueAllowed = [...new Set(allowed)];
  quality.supported += Math.min(uniqueAllowed.length, citations.length);

  if (rejected.length) {
    warnings.push(`AI returned unsupported citations for ${label}: ${rejected.join(", ")}`);
  }

  if (!uniqueAllowed.length) {
    warnings.push(`AI result for ${label} has no supported citation.`);
  }

  return uniqueAllowed;
};

const isTeamAlias = (value: string | null | undefined) => Boolean(value?.trim().startsWith("@"));

const hasHumanOwner = (hint: AiImplementerHint) => Boolean((hint.name && !isTeamAlias(hint.name)) || hint.email);

const ownerEvidenceCandidatesFrom = (request: AiReasonerRequest) =>
  request.evidence.flatMap((item) => item.ownerCandidate ? [item.ownerCandidate] : []);

const ownerEvidenceMissingInfoFrom = (request: AiReasonerRequest) =>
  request.evidence.flatMap((item) => item.missingInfo ?? []);

const ownerIdentity = (candidate: Pick<ManagerOwnerTriageCandidate, "email" | "name">) =>
  (candidate.email.trim() || candidate.name.trim()).toLowerCase();

const uniqueStrings = (items: string[]) => [...new Set(items.filter(Boolean))];

const uniqueEvidenceCommits = (commits: ManagerOwnerTriageEvidenceCommit[]) => {
  const byCommit = new Map<string, ManagerOwnerTriageEvidenceCommit>();
  for (const commit of commits) {
    const key = `${commit.commit_id}\t${commit.repo}\t${commit.file}\t${commit.line ?? ""}`;
    if (!byCommit.has(key)) byCommit.set(key, commit);
  }
  return [...byCommit.values()];
};

const findSupportedOwnerCandidate = (
  candidate: ManagerOwnerTriageCandidate,
  supportedCandidates: ManagerOwnerTriageCandidate[],
) => {
  const identity = ownerIdentity(candidate);
  const byIdentity = supportedCandidates.find((supported) => ownerIdentity(supported) === identity);
  if (byIdentity) return byIdentity;

  const candidateCommitIds = new Set(candidate.evidence_commits.map((commit) => commit.commit_id));
  return supportedCandidates.find((supported) =>
    supported.evidence_commits.some((commit) => candidateCommitIds.has(commit.commit_id)),
  );
};

const weakManagerTriageFrom = (
  result: AiInvestigationResult,
  request: AiReasonerRequest,
  missingInfo: string[],
): ManagerOwnerTriageResult => {
  const ownerCandidates = ownerEvidenceCandidatesFrom(request)
    .slice(0, 2)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const firstCandidate = ownerCandidates[0];

  return parseManagerOwnerTriageResult({
    issue: result.explanation || request.report,
    likely_owner_candidates: ownerCandidates,
    likely_root_cause: result.explanation || "FirstTrace could not validate a likely root cause from supported evidence.",
    missing_info: uniqueStrings([
      ...missingInfo,
      ...ownerEvidenceMissingInfoFrom(request),
      "The provider did not return the strict manager-owner triage payload; FirstTrace normalized only supported evidence.",
    ]),
    recommended_manager_action: firstCandidate
      ? `Route the first pass to ${firstCandidate.name || firstCandidate.email}, but treat this as a weak normalized handoff because the provider did not return managerTriage.`
      : "Do not assign a person yet. Collect exact-line blame, PR metadata, or pushed-by provider metadata, then rerun triage.",
    title: "Bug Triage",
    user_impact: result.userImpact ?? "User impact needs confirmation from the report and supported evidence.",
  });
};

const normalizeManagerTriage = (
  result: AiInvestigationResult,
  request: AiReasonerRequest,
  warnings: string[],
): ManagerOwnerTriageResult | undefined => {
  if (!result.managerTriage && result.promptProfile !== MANAGER_OWNER_TRIAGE_PROFILE) return undefined;
  if (!result.managerTriage) {
    warnings.push("Provider did not return managerTriage for the manager-owner-triage profile.");
    return weakManagerTriageFrom(result, request, ["Provider returned a simplified answer without managerTriage."]);
  }

  const supportedCandidates = ownerEvidenceCandidatesFrom(request);
  const grouped = new Map<string, ManagerOwnerTriageCandidate>();
  const missingInfo = [...result.managerTriage.missing_info];

  for (const candidate of result.managerTriage.likely_owner_candidates) {
    const supported = findSupportedOwnerCandidate(candidate, supportedCandidates);
    if (!supported) {
      warnings.push(`Removed unsupported manager owner candidate: ${candidate.name || candidate.email || "unknown"}.`);
      missingInfo.push(`Removed unsupported person owner candidate ${candidate.name || candidate.email || "unknown"} because no matching owner evidence was available.`);
      continue;
    }

    const supportedCommits = new Map(supported.evidence_commits.map((commit) => [commit.commit_id, commit]));
    const evidenceCommits = uniqueEvidenceCommits(
      candidate.evidence_commits.flatMap((commit) => {
        const supportedCommit = supportedCommits.get(commit.commit_id);
        if (supportedCommit) return [supportedCommit];
        warnings.push(`Removed unsupported manager owner evidence commit: ${commit.commit_id}.`);
        return [];
      }),
    );
    if (!evidenceCommits.length) {
      warnings.push(`Removed manager owner candidate without supported evidence commits: ${candidate.name || candidate.email || "unknown"}.`);
      missingInfo.push(`Removed ${candidate.name || candidate.email || "unknown"} because none of its evidence commits were supported.`);
      continue;
    }

    const normalized: ManagerOwnerTriageCandidate = {
      confidence: supported.confidence,
      email: supported.email,
      evidence_commits: evidenceCommits,
      evidence_source: supported.evidence_source,
      name: supported.name,
      rank: 0,
      reason: candidate.reason || supported.reason,
    };
    const identity = ownerIdentity(normalized);
    const existing = grouped.get(identity);
    if (existing) {
      grouped.set(identity, {
        ...existing,
        evidence_commits: uniqueEvidenceCommits([...existing.evidence_commits, ...normalized.evidence_commits]),
      });
    } else {
      grouped.set(identity, normalized);
    }
  }

  const likelyOwnerCandidates = [...grouped.values()]
    .slice(0, 2)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  if (!likelyOwnerCandidates.length && result.managerTriage.likely_owner_candidates.length) {
    missingInfo.push("No evidence-backed person owner candidate remained after validation.");
  }

  return parseManagerOwnerTriageResult({
    ...result.managerTriage,
    likely_owner_candidates: likelyOwnerCandidates,
    missing_info: uniqueStrings([...missingInfo, ...ownerEvidenceMissingInfoFrom(request)]),
  });
};

const computeActionability = ({
  citationCoverage,
  confidence,
  foundExactFile,
  foundOwner,
  foundRelatedCommit,
}: {
  citationCoverage: number;
  confidence: number;
  foundExactFile: boolean;
  foundOwner: boolean;
  foundRelatedCommit: boolean;
}) =>
  Math.min(
    1,
    Number(
      (
        (foundExactFile ? 0.35 : 0) +
        (foundOwner ? 0.25 : 0) +
        (foundRelatedCommit ? 0.2 : 0) +
        Math.min(0.1, citationCoverage * 0.1) +
        Math.min(0.1, confidence * 0.1)
      ).toFixed(2),
    ),
  );

export const groundAiResult = (
  result: AiInvestigationResult,
  request: AiReasonerRequest,
): AiInvestigationResult => {
  const allowedCitations = allowedCitationSet(request);
  const warnings = [...result.warnings];
  const qualityCounts = { supported: 0, total: 0 };

  const implementerHints = result.implementerHints.map((hint, index) => ({
    ...hint,
    citations: groundedCitations(
      hint.citations,
      allowedCitations,
      warnings,
      `implementer hint ${index + 1}`,
      qualityCounts,
    ),
  }));
  const likelyFiles = result.likelyFiles.map((file, index) => ({
    ...file,
    citations: groundedCitations(
      file.citations,
      allowedCitations,
      warnings,
      `likely file ${index + 1}`,
      qualityCounts,
    ),
  }));
  const managerTriage = normalizeManagerTriage(result, request, warnings);
  const managerOwnerNames = managerTriage?.likely_owner_candidates.map((candidate) => candidate.name || candidate.email) ?? [];
  const likelyOwners = result.promptProfile === MANAGER_OWNER_TRIAGE_PROFILE && managerTriage
    ? managerOwnerNames
    : result.likelyOwners;
  const citationCoverage = qualityCounts.total
    ? Number((qualityCounts.supported / qualityCounts.total).toFixed(2))
    : 0;
  const foundExactFile = likelyFiles.some((file) => file.citations.length > 0);
  const foundOwner = implementerHints.some((hint) => hint.citations.length > 0 && hasHumanOwner(hint)) ||
    managerOwnerNames.length > 0 ||
    likelyOwners.some((owner) => !isTeamAlias(owner));
  const foundRelatedCommit = implementerHints.some((hint) => hint.commit && hint.citations.length > 0) ||
    Boolean(managerTriage?.likely_owner_candidates.some((candidate) => candidate.evidence_commits.length > 0));

  return {
    ...result,
    implementerHints,
    likelyOwners,
    likelyFiles,
    managerTriage,
    quality: {
      actionability: computeActionability({
        citationCoverage,
        confidence: result.confidence,
        foundExactFile,
        foundOwner,
        foundRelatedCommit,
      }),
      citationCoverage,
      foundExactFile,
      foundOwner,
      foundRelatedCommit,
    },
    warnings,
  };
};
