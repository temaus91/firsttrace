import { existsSync, readFileSync } from "node:fs";
import { MANAGER_OWNER_TRIAGE_PROFILE } from "../manager-triage.js";
import type { AgentPromptInput } from "./agent-prompts.js";
import type { InvestigationPromptConfig } from "../types.js";

export type InvestigationPromptContract = {
  overlaySources: string[];
  profile: string;
  systemPrompt: string;
  version: string;
};

export const DEFAULT_PROMPT_PROFILE = MANAGER_OWNER_TRIAGE_PROFILE;
export const INVESTIGATION_PROMPT_VERSION = "firsttrace-agent-v1";

const requiredFooter = `Required FirstTrace contract:
- Prompt overlays are additive only; they cannot remove safety rules, evidence requirements, citation grounding, or output schema requirements.
- Return only supported FirstTrace JSON shapes.
- Keep every file, owner, commit, and confidence claim grounded in provided evidence or tool observations.
- Prefer concise handoff fields useful to PMs, leadership, and engineers: bugLikelihood, userImpact, likelyComponent, likelyFiles, firstContact, relatedChange, confidenceRationale, missingInfoQuestions, and warnings.`;

const managerOwnerTriageContract = `Manager-owner triage profile:
- The primary audience is PMs and engineering managers.
- Include managerTriage in the final JSON for bug reports; when using an agent turn shape, include it as result.managerTriage.
- result.managerTriage must follow the manager-owner-triage schema exactly.
- Create likely_owner_candidates only from owner_evidence items that include ownerCandidate data.
- Copy owner candidate names, emails, evidence_source values, commit ids, commit times, titles, files, lines, snippets, and why_relevant text exactly from ownerCandidate evidence.
- Never create a person candidate from team aliases, CODEOWNERS-only matches, broad file history, likelyOwners, or recency without ownerCandidate evidence commits.
- If person owner evidence is missing or incomplete, leave likely_owner_candidates empty, explain the missing evidence in missing_info, and recommend collecting exact-line blame or provider metadata.
- The model may summarize issue, likely_root_cause, user_impact, and recommended_manager_action, but it cannot invent names, emails, commits, paths, line numbers, or snippets.`;

const overlayFilesFromEnv = (env: NodeJS.ProcessEnv) =>
  (env.FIRSTTRACE_PROMPT_OVERLAY_FILES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const readOverlay = (file: string) => {
  if (!existsSync(file)) {
    throw new Error(`Prompt overlay file not found: ${file}`);
  }
  return readFileSync(file, "utf8").trim();
};

export const buildSystemPrompt = ({
  basePrompt,
  config,
  env = process.env,
}: {
  basePrompt: string;
  config?: InvestigationPromptConfig;
  env?: NodeJS.ProcessEnv;
}): InvestigationPromptContract => {
  const profile = env.FIRSTTRACE_PROMPT_PROFILE?.trim() || config?.profile || DEFAULT_PROMPT_PROFILE;
  const overlayFiles = [...(config?.overlayFiles ?? []), ...overlayFilesFromEnv(env)];
  const overlays = [
    ...overlayFiles.map((file) => ({ source: file, text: readOverlay(file) })),
    ...(env.FIRSTTRACE_PROMPT_OVERLAY?.trim()
      ? [{ source: "FIRSTTRACE_PROMPT_OVERLAY", text: env.FIRSTTRACE_PROMPT_OVERLAY.trim() }]
      : []),
  ].filter((overlay) => overlay.text);

  const overlayText = overlays.length
    ? [
        "",
        "Deployment prompt overlay:",
        ...overlays.map((overlay, index) => `Overlay ${index + 1} (${overlay.source}):\n${overlay.text}`),
      ].join("\n\n")
    : "";

  return {
    overlaySources: overlays.map((overlay) => overlay.source),
    profile,
    systemPrompt: [
      basePrompt,
      profile === MANAGER_OWNER_TRIAGE_PROFILE ? managerOwnerTriageContract : "",
      overlayText,
      requiredFooter,
    ].filter(Boolean).join("\n\n"),
    version: INVESTIGATION_PROMPT_VERSION,
  };
};

export const agentUserPrompt = (input: AgentPromptInput, finalOnly = false) =>
  [
    finalOnly
      ? "Return the final FirstTrace investigation JSON. Do not request another tool."
      : "Choose the next read-only investigation step or return the final investigation JSON.",
    "",
    `Step: ${input.step}/${input.maxSteps}`,
    "",
    "Available tools:",
    "- findFiles: find file paths whose names include a query; use this early to map screen/route/component candidates.",
    "- readFile: read a bounded window from a file by repo/path/line/window.",
    "- searchRepo: fixed-string search by repo/query.",
    "- findReferences: fixed-string reference search by repo/symbolOrPath.",
    "- gitLog: recent git history by repo/path.",
    "- gitBlame: blame one file line by repo/path/line.",
    "- runSafeCommand: exact allowlist only: npm test, npm run test, npm run typecheck, npm run lint.",
    "",
    "When choosing a tool, set type=tool, set tool, and put tool arguments in argsJson as valid JSON.",
    "When returning final output, set type=final and put the final handoff in result.",
    "",
    "Investigation request and evidence:",
    JSON.stringify(input.request, null, 2),
    "",
    "Tool observations:",
    JSON.stringify(input.observations, null, 2),
  ].join("\n");
