import type { AiInvestigationResult, AiReasonerRequest } from "../types.js";

const allowedCitationSet = (request: AiReasonerRequest) =>
  new Set(request.evidence.flatMap((item) => [item.id, ...item.citations]));

const groundedCitations = (
  citations: string[],
  allowedCitations: Set<string>,
  warnings: string[],
  label: string,
) => {
  const allowed = citations.filter((citation) => allowedCitations.has(citation));
  const rejected = citations.filter((citation) => !allowedCitations.has(citation));

  if (rejected.length) {
    warnings.push(`AI returned unsupported citations for ${label}: ${rejected.join(", ")}`);
  }

  if (!allowed.length) {
    warnings.push(`AI result for ${label} has no supported citation.`);
  }

  return allowed;
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
