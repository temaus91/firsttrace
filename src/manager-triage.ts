import { z } from "zod";

export const MANAGER_OWNER_TRIAGE_PROFILE = "manager-owner-triage";

export const ManagerOwnerTriageEvidenceSourceSchema = z.enum([
  "pushed_by",
  "pr_author",
  "committer",
  "commit_author",
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

export const parseManagerOwnerTriageResult = (value: unknown) =>
  ManagerOwnerTriageResultSchema.parse(value);

const lineValue = (line: number | null) => line?.toString() ?? "";

export const renderManagerOwnerTriage = (value: ManagerOwnerTriageResult) => {
  const result = parseManagerOwnerTriageResult(value);
  const pluralSuffix = result.likely_owner_candidates.length === 1 ? "" : "s";
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
    result.recommended_manager_action,
    ...(result.missing_info.length
      ? [
          "",
          "Missing Info",
          ...result.missing_info.map((item) => `- ${item}`),
        ]
      : []),
  ].join("\n");
};
