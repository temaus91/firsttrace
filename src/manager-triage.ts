import { z } from "zod";

export const MANAGER_OWNER_TRIAGE_PROFILE = "manager-owner-triage";

export const ManagerOwnerTriageEvidenceSourceSchema = z.enum([
  "exact_line_blame",
  "introduced_pattern",
  "related_file_history",
  "provider_pr_author",
  "provider_pushed_by",
  "commit_author",
  "committer",
  "unknown",
]);

export const ManagerOwnerTriageConfidenceSchema = z.enum(["High", "Medium", "Low"]);

export const ManagerOwnerTriageEvidenceCommitSchema = z
  .object({
    commit_id: z.string().min(1),
    commit_time: z.string(),
    commit_title: z.string(),
    evidence_code: z.string(),
    file: z.string(),
    line: z.number().int().positive().nullable(),
    repo: z.string(),
    why_relevant: z.string(),
  })
  .strict();

export const ManagerOwnerTriageCandidateSchema = z
  .object({
    confidence: ManagerOwnerTriageConfidenceSchema,
    email: z.string(),
    evidence_commits: z.array(ManagerOwnerTriageEvidenceCommitSchema).min(1),
    evidence_source: ManagerOwnerTriageEvidenceSourceSchema,
    name: z.string(),
    rank: z.number().int().positive(),
    reason: z.string(),
  })
  .strict();

const candidateIdentity = (candidate: z.infer<typeof ManagerOwnerTriageCandidateSchema>) =>
  (candidate.email.trim() || candidate.name.trim()).toLowerCase();

export const ManagerOwnerTriageResultSchema = z
  .object({
    issue: z.string(),
    likely_owner_candidates: z.array(ManagerOwnerTriageCandidateSchema).max(2),
    likely_root_cause: z.string(),
    missing_info: z.array(z.string()),
    recommended_manager_action: z.string(),
    title: z.string(),
    user_impact: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, candidate] of value.likely_owner_candidates.entries()) {
      const identity = candidateIdentity(candidate);
      if (!identity) {
        ctx.addIssue({
          code: "custom",
          message: "Owner candidates must include a name or email.",
          path: ["likely_owner_candidates", index],
        });
        continue;
      }
      if (seen.has(identity)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate owner candidates must be grouped into one candidate.",
          path: ["likely_owner_candidates", index],
        });
      }
      seen.add(identity);
    }
  });

export type ManagerOwnerTriageEvidenceSource = z.infer<typeof ManagerOwnerTriageEvidenceSourceSchema>;
export type ManagerOwnerTriageEvidenceCommit = z.infer<typeof ManagerOwnerTriageEvidenceCommitSchema>;
export type ManagerOwnerTriageCandidate = z.infer<typeof ManagerOwnerTriageCandidateSchema>;
export type ManagerOwnerTriageResult = z.infer<typeof ManagerOwnerTriageResultSchema>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringFrom = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);

const nullablePositiveLineFrom = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const confidenceFrom = (value: unknown): ManagerOwnerTriageCandidate["confidence"] => {
  const normalized = stringFrom(value, "Low").trim().toLowerCase();
  if (normalized === "high") return "High";
  if (normalized === "medium") return "Medium";
  return "Low";
};

const evidenceSourceFrom = (value: unknown): ManagerOwnerTriageCandidate["evidence_source"] => {
  const parsed = ManagerOwnerTriageEvidenceSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
};

const stringArrayFrom = (value: unknown) =>
  Array.isArray(value) ? value.map((item) => stringFrom(item)).filter(Boolean) : [];

const evidenceCommitFrom = (
  value: Record<string, unknown>,
): ManagerOwnerTriageEvidenceCommit => ({
  commit_id: stringFrom(value.commit_id ?? value.commitId ?? value.commit),
  commit_time: stringFrom(value.commit_time ?? value.commitTime ?? value.time),
  commit_title: stringFrom(value.commit_title ?? value.commitTitle ?? value.title),
  evidence_code: stringFrom(value.evidence_code ?? value.evidenceCode ?? value.snippet ?? value.code),
  file: stringFrom(value.file ?? value.path),
  line: nullablePositiveLineFrom(value.line),
  repo: stringFrom(value.repo),
  why_relevant: stringFrom(value.why_relevant ?? value.whyRelevant ?? value.reason),
});

const candidateHasInlineCommit = (value: Record<string, unknown>) =>
  ["commit_id", "commitId", "commit", "commit_time", "commitTime", "commit_title", "commitTitle", "file", "path", "snippet"].some(
    (key) => value[key] !== undefined,
  );

const evidenceCommitsFrom = (value: Record<string, unknown>) => {
  const nested = Array.isArray(value.evidence_commits) ? value.evidence_commits : [];
  const commits = nested.flatMap((item) => isObject(item) ? [evidenceCommitFrom(item)] : []);
  if (!commits.length && candidateHasInlineCommit(value)) {
    commits.push(evidenceCommitFrom(value));
  }
  return commits;
};

const candidateFrom = (
  value: unknown,
  index: number,
): ManagerOwnerTriageCandidate | undefined => {
  if (!isObject(value)) return undefined;
  const candidate = {
    confidence: confidenceFrom(value.confidence),
    email: stringFrom(value.email),
    evidence_commits: evidenceCommitsFrom(value),
    evidence_source: evidenceSourceFrom(value.evidence_source ?? value.evidenceSource),
    name: stringFrom(value.name ?? value.owner ?? value.owner_name),
    rank: Number.isInteger(value.rank) && Number(value.rank) > 0 ? Number(value.rank) : index + 1,
    reason: stringFrom(value.reason ?? value.why_relevant ?? value.whyRelevant),
  };
  return ManagerOwnerTriageCandidateSchema.parse(candidate);
};

export const normalizeManagerOwnerTriageResult = (value: unknown): ManagerOwnerTriageResult => {
  const strict = ManagerOwnerTriageResultSchema.safeParse(value);
  if (strict.success) return strict.data;
  if (!isObject(value)) return ManagerOwnerTriageResultSchema.parse(value);

  const issue = stringFrom(value.issue);
  const candidates = (Array.isArray(value.likely_owner_candidates) ? value.likely_owner_candidates : [])
    .flatMap((candidate, index) => {
      try {
        const normalized = candidateFrom(candidate, index);
        return normalized ? [normalized] : [];
      } catch {
        return [];
      }
    })
    .slice(0, 2);

  return ManagerOwnerTriageResultSchema.parse({
    issue,
    likely_owner_candidates: candidates,
    likely_root_cause: stringFrom(value.likely_root_cause ?? value.likelyRootCause),
    missing_info: stringArrayFrom(value.missing_info ?? value.missingInfo),
    recommended_manager_action: stringFrom(value.recommended_manager_action ?? value.recommendedManagerAction),
    title: stringFrom(value.title, issue ? issue.slice(0, 80) : "Bug Triage"),
    user_impact: stringFrom(value.user_impact ?? value.userImpact),
  });
};

export const parseManagerOwnerTriageResult = (value: unknown) =>
  ManagerOwnerTriageResultSchema.parse(value);

const lineValue = (line: number | null) => line?.toString() ?? "";

const noPersonOwnerAction =
  "Do not assign a person yet. Collect exact-line blame, commit history, PR metadata, or provider pushed-by metadata for the suspected files.";

export const renderManagerOwnerTriage = (value: ManagerOwnerTriageResult) => {
  const result = parseManagerOwnerTriageResult(value);
  const pluralSuffix = result.likely_owner_candidates.length === 1 ? "" : "s";
  const recommendedManagerAction = result.likely_owner_candidates.length
    ? result.recommended_manager_action
    : noPersonOwnerAction;
  const candidateBlocks = result.likely_owner_candidates.map((candidate) => {
    const commits = candidate.evidence_commits
      .map((commit) =>
        [
          `   - Commit: ${commit.commit_id}`,
          `     Commit time: ${commit.commit_time}`,
          `     Commit title: ${commit.commit_title}`,
          `     Repo: ${commit.repo}`,
          `     File: ${commit.file}`,
          `     Line: ${lineValue(commit.line)}`,
          `     Evidence: ${commit.evidence_code}`,
          `     Why relevant: ${commit.why_relevant}`,
        ].join("\n"),
      )
      .join("\n");

    return [
      `${candidate.rank}. ${candidate.name}`,
      `   Email: ${candidate.email}`,
      `   Confidence: ${candidate.confidence}`,
      `   Reason: ${candidate.reason}`,
      `   Evidence source: ${candidate.evidence_source}`,
      "",
      "   Evidence commits:",
      commits,
    ].join("\n");
  });

  return [
    result.title || "Bug Triage",
    "",
    "Issue",
    result.issue,
    "",
    `Likely Owner Candidate${pluralSuffix}`,
    "",
    ...candidateBlocks.flatMap((block) => [block, ""]),
    "Likely Root Cause",
    result.likely_root_cause,
    "",
    "User Impact",
    result.user_impact,
    "",
    "Recommended Manager Action",
    recommendedManagerAction,
    ...(result.missing_info.length
      ? [
          "",
          "Missing Info",
          ...result.missing_info.map((item) => `- ${item}`),
        ]
      : []),
  ].join("\n");
};
