import type { AiInvestigationResult, EvalCase, EvalScore, EvidenceItem, InvestigationResult } from "../types.js";

const normalize = (value: string) => value.trim().toLowerCase();

const componentMatches = (actual: string, expected: string) => {
  const actualValue = normalize(actual);
  const expectedValue = normalize(expected);
  return actualValue === expectedValue || actualValue.includes(expectedValue) || expectedValue.includes(actualValue);
};

const filePathsFrom = (result: InvestigationResult, ai?: AiInvestigationResult) =>
  ai ? ai.likelyFiles.map((file) => file.path) : result.suspiciousFiles.flatMap((item) => (item.path ? [item.path] : []));

const ownersFrom = (result: InvestigationResult, ai?: AiInvestigationResult) =>
  ai ? ai.likelyOwners : result.likelyOwners;

const evidenceWithCitations = (items: EvidenceItem[]) =>
  items.length ? items.filter((item) => item.citations.length > 0).length / items.length : 1;

const aiCitationCoverage = (ai: AiInvestigationResult) => {
  const citationBearingItems = [...ai.likelyFiles, ...ai.implementerHints];
  return citationBearingItems.length
    ? citationBearingItems.filter((item) => item.citations.length > 0).length / citationBearingItems.length
    : 1;
};

const unsupportedAiCitationCount = (ai?: AiInvestigationResult) =>
  ai?.warnings.filter((warning) => warning.startsWith("AI returned unsupported citations")).length ?? 0;

const foundValues = (expected: string[], actual: string[]) => {
  const normalizedActual = new Set(actual.map(normalize));
  return expected.filter((value) => normalizedActual.has(normalize(value)));
};

const missingValues = (expected: string[], found: string[]) => {
  const normalizedFound = new Set(found.map(normalize));
  return expected.filter((value) => !normalizedFound.has(normalize(value)));
};

const usefulnessScore = ({
  citationCoverage,
  citationsPassed,
  classificationMatched,
  componentMatched,
  expectedFilesFound,
  expectedFilesTotal,
  expectedOwnersFound,
  expectedOwnersTotal,
  unsupportedCount,
}: {
  citationCoverage: number;
  citationsPassed: boolean;
  classificationMatched?: boolean;
  componentMatched?: boolean;
  expectedFilesFound: number;
  expectedFilesTotal: number;
  expectedOwnersFound: number;
  expectedOwnersTotal: number;
  unsupportedCount: number;
}) => {
  const classificationScore = classificationMatched === undefined ? 1 : Number(classificationMatched);
  const componentScore = componentMatched === undefined ? 1 : Number(componentMatched);
  const fileScore = expectedFilesTotal ? expectedFilesFound / expectedFilesTotal : 1;
  const ownerScore = expectedOwnersTotal ? expectedOwnersFound / expectedOwnersTotal : 1;
  const groundedScore = citationsPassed && unsupportedCount === 0 ? citationCoverage : 0;

  return Number(
    (
      classificationScore * 0.2 +
      componentScore * 0.2 +
      fileScore * 0.25 +
      ownerScore * 0.2 +
      groundedScore * 0.15
    ).toFixed(2),
  );
};

export const scoreEvalResult = (
  evalCase: EvalCase,
  result: InvestigationResult,
  ai?: AiInvestigationResult,
): EvalScore => {
  const actualFiles = filePathsFrom(result, ai);
  const actualOwners = ownersFrom(result, ai);
  const expectedFilesFound = foundValues(evalCase.expectedFiles, actualFiles);
  const expectedOwnersFound = foundValues(evalCase.expectedOwners, actualOwners);
  const expectedFilesMissing = missingValues(evalCase.expectedFiles, expectedFilesFound);
  const expectedOwnersMissing = missingValues(evalCase.expectedOwners, expectedOwnersFound);
  const classificationMatched =
    evalCase.expectedClassification === undefined
      ? undefined
      : result.classification === evalCase.expectedClassification;
  const componentMatched =
    evalCase.expectedComponent === undefined
      ? undefined
      : componentMatches(ai?.likelyComponent ?? result.likelyComponent, evalCase.expectedComponent);
  const citationCoverage = ai
    ? aiCitationCoverage(ai)
    : evidenceWithCitations([...result.suspiciousFiles, ...result.relatedCommits, ...result.relatedDocs]);
  const unsupportedCount = unsupportedAiCitationCount(ai);
  const citationsPassed = citationCoverage === 1 && unsupportedCount === 0;
  const expectedFieldsPassed =
    classificationMatched !== false &&
    componentMatched !== false &&
    expectedFilesMissing.length === 0 &&
    expectedOwnersMissing.length === 0;

  return {
    citationCoverage,
    citationsPassed,
    classificationMatched,
    componentMatched,
    expectedFilesFound,
    expectedFilesMissing,
    expectedOwnersFound,
    expectedOwnersMissing,
    passed: expectedFieldsPassed && citationsPassed,
    unsupportedAiCitationCount: unsupportedCount,
    usefulness: usefulnessScore({
      citationCoverage,
      citationsPassed,
      classificationMatched,
      componentMatched,
      expectedFilesFound: expectedFilesFound.length,
      expectedFilesTotal: evalCase.expectedFiles.length,
      expectedOwnersFound: expectedOwnersFound.length,
      expectedOwnersTotal: evalCase.expectedOwners.length,
      unsupportedCount,
    }),
  };
};
