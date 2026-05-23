import type { AiInvestigationResult, AiReasonerRequest } from "../types.js";

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

const groundedCitations = (
  citations: string[],
  allowedCitations: Set<string>,
  warnings: string[],
  label: string,
) => {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const citation of citations) {
    if (allowedCitations.has(citation)) {
      allowed.push(citation);
      continue;
    }

    const normalized = allowedLineCitationsInRange(citation, allowedCitations);
    if (normalized.length) {
      allowed.push(...normalized);
      continue;
    }

    rejected.push(citation);
  }
  const uniqueAllowed = [...new Set(allowed)];

  if (rejected.length) {
    warnings.push(`AI returned unsupported citations for ${label}: ${rejected.join(", ")}`);
  }

  if (!uniqueAllowed.length) {
    warnings.push(`AI result for ${label} has no supported citation.`);
  }

  return uniqueAllowed;
};

export const groundAiResult = (
  result: AiInvestigationResult,
  request: AiReasonerRequest,
): AiInvestigationResult => {
  const allowedCitations = allowedCitationSet(request);
  const warnings = [...result.warnings];

  return {
    ...result,
    implementerHints: result.implementerHints.map((hint, index) => ({
      ...hint,
      citations: groundedCitations(
        hint.citations,
        allowedCitations,
        warnings,
        `implementer hint ${index + 1}`,
      ),
    })),
    likelyFiles: result.likelyFiles.map((file, index) => ({
      ...file,
      citations: groundedCitations(file.citations, allowedCitations, warnings, `likely file ${index + 1}`),
    })),
    warnings,
  };
};
