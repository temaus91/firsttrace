import type { EvalCaseResult, EvalRunResult, EvalScore } from "../types.js";

const empty = "_None_";

const passFail = (passed: boolean) => (passed ? "PASS" : "FAIL");

const optionalCheck = (label: string, value?: boolean) =>
  value === undefined ? `${label}: n/a` : `${label}: ${passFail(value)}`;

const list = (values: string[]) => (values.length ? values.map((value) => `\`${value}\``).join(", ") : empty);

const renderScore = (title: string, score: EvalScore) =>
  [
    `### ${title}: ${passFail(score.passed)}`,
    `Usefulness: \`${score.usefulness.toFixed(2)}\``,
    optionalCheck("Classification", score.classificationMatched),
    optionalCheck("Component", score.componentMatched),
    `Expected files found: ${list(score.expectedFilesFound)}`,
    `Expected files missing: ${list(score.expectedFilesMissing)}`,
    `Expected owners found: ${list(score.expectedOwnersFound)}`,
    `Expected owners missing: ${list(score.expectedOwnersMissing)}`,
    `Citation coverage: \`${score.citationCoverage.toFixed(2)}\``,
    `Unsupported AI citations: \`${score.unsupportedAiCitationCount}\``,
  ].join("\n");

const renderWarnings = (warnings: string[]) =>
  warnings.length ? [`### Warnings`, warnings.map((warning) => `- ${warning}`).join("\n")].join("\n") : "";

const casePassed = (result: EvalCaseResult, aiEnabled: boolean) =>
  aiEnabled
    ? result.deterministicScore.passed && Boolean(result.aiScore?.passed)
    : result.deterministicScore.passed;

const renderCase = (result: EvalCaseResult, aiEnabled: boolean) =>
  [
    `## ${result.case.id}: ${passFail(casePassed(result, aiEnabled))}`,
    `Report: ${result.case.report}`,
    result.case.notes ? `Notes: ${result.case.notes}` : "",
    renderScore("Deterministic", result.deterministicScore),
    result.aiScore ? renderScore("AI-Assisted", result.aiScore) : "",
    aiEnabled && !result.aiScore ? "### AI-Assisted: FAIL\nAI result unavailable." : "",
    renderWarnings(result.deterministicResult.warnings),
  ]
    .filter(Boolean)
    .join("\n\n");

export const renderEvalRun = (result: EvalRunResult) =>
  [
    "# FirstTrace Eval Run",
    `Status: ${passFail(result.passed)}`,
    `AI enabled: \`${result.aiEnabled}\``,
    `Cases: \`${result.summary.passed}/${result.summary.total}\` passed, \`${result.summary.failed}\` failed`,
    ...result.caseResults.map((caseResult) => renderCase(caseResult, result.aiEnabled)),
  ].join("\n\n");
