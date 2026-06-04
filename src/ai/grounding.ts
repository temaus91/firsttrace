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
  const citationCoverage = qualityCounts.total
    ? Number((qualityCounts.supported / qualityCounts.total).toFixed(2))
    : 0;
  const foundExactFile = likelyFiles.some((file) => file.citations.length > 0);
  const foundOwner = implementerHints.some((hint) => hint.citations.length > 0 && hasHumanOwner(hint)) ||
    result.likelyOwners.some((owner) => !isTeamAlias(owner));
  const foundRelatedCommit = implementerHints.some((hint) => hint.commit && hint.citations.length > 0);

  return {
    ...result,
    implementerHints,
    likelyFiles,
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
