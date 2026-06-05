import { describe, expect, it } from "vitest";
import { buildAiReasonerRequest } from "../src/ai/evidence.js";
import { groundAiResult } from "../src/ai/grounding.js";
import { aiReadinessMetadataFromEnv } from "../src/ai/readiness.js";
import { buildSystemPrompt } from "../src/investigator/prompt-contract.js";
import { MANAGER_OWNER_TRIAGE_PROFILE } from "../src/manager-triage.js";
import {
  aiModelProviderFromEnv,
  createAiProviderFromEnv,
  DEFAULT_OPENAI_MODEL,
  ociGenAiConfigFromEnv,
  resolveChatModelFromEnv,
} from "../src/ai/provider-factory.js";
import { createInvestigatorProviderFromEnv } from "../src/investigator/provider-factory.js";
import type { InvestigationResult } from "../src/types.js";

const investigationResult = (): InvestigationResult => ({
  classification: "bug",
  likelyComponent: "src",
  likelyOwners: ["@core"],
  relatedCommits: [
    {
      citations: [{ commit: "abc123", label: "repo:abc123", repo: "repo" }],
      metadata: { author: "Dev Owner", date: "2026-05-21" },
      repo: "repo",
      score: 4,
      summary: "Fix investigation renderer",
      title: "abc123 Fix investigation renderer",
      type: "commit",
    },
  ],
  relatedDocs: [],
  report: "Renderer crashes on citations",
  searchTerms: ["renderer", "citations"],
  suggestedNextSteps: ["Inspect src/render.ts."],
  suspiciousFiles: [
    {
      citations: [{ label: "repo:src/render.ts:12", line: 12, path: "src/render.ts", repo: "repo" }],
      owner: "@core",
      path: "src/render.ts",
      repo: "repo",
      score: 12,
      summary: "Renderer handles citations",
      title: "src/render.ts",
      type: "file",
    },
  ],
  warnings: ["No issue exports configured."],
});

const ownerEvidence = () => ({
  candidates: [
    {
      confidence: "High" as const,
      email: "dev.owner@example.com",
      evidenceCommits: [
        {
          authorEmail: "dev.owner@example.com",
          authorName: "Dev Owner",
          authorTime: "2026-05-20T17:15:30Z",
          commitId: "abcdef1234567890abcdef1234567890abcdef12",
          commitTime: "2026-05-20T17:15:30Z",
          commitTitle: "Add renderer citation path",
          committerEmail: "dev.owner@example.com",
          committerName: "Dev Owner",
          committerTime: "2026-05-20T17:15:30Z",
          evidenceCode: "return renderCitation(citation)",
          evidenceKind: "exact_line_blame" as const,
          evidenceSource: "commit_author" as const,
          file: "src/render.ts",
          line: 12,
          repo: "repo",
          score: 100,
          whyRelevant: "Exact-line blame for the failing citation renderer.",
        },
      ],
      evidenceSource: "commit_author" as const,
      name: "Dev Owner",
      rank: 1,
      reason: "Exact-line blame points to src/render.ts:12.",
      score: 100,
    },
  ],
  missingInfo: ["No PR metadata provider is configured."],
  warnings: [],
  weakCommits: [],
});

describe("AI provider support", () => {
  it("builds a bounded cited evidence bundle", () => {
    const request = buildAiReasonerRequest(investigationResult());

    expect(request.report).toBe("Renderer crashes on citations");
    expect(request.evidence.map((item) => item.id)).toEqual(["file-1", "commit-1", "warning-1"]);
    expect(request.evidence[0]).toMatchObject({
      citations: ["src/render.ts:12"],
      kind: "suspicious_file",
      owner: "@core",
      path: "src/render.ts",
      summary: "Renderer handles citations",
    });
    expect(request.evidence[1]).toMatchObject({
      citations: ["commit abc123"],
      kind: "related_commit",
      metadata: { author: "Dev Owner", date: "2026-05-21" },
    });
  });

  it("feeds structured owner evidence to the model", () => {
    const request = buildAiReasonerRequest({
      ...investigationResult(),
      ownerEvidence: ownerEvidence(),
    });

    expect(request.evidence.map((item) => item.id)).toEqual(["file-1", "commit-1", "owner-1", "owner-missing-1", "warning-1"]);
    expect(request.evidence[2]).toMatchObject({
      citations: ["commit abcdef1234567890abcdef1234567890abcdef12"],
      kind: "owner_evidence",
      ownerCandidate: {
        email: "dev.owner@example.com",
        evidence_commits: [
          {
            commit_id: "abcdef1234567890abcdef1234567890abcdef12",
            evidence_code: "return renderCitation(citation)",
            file: "src/render.ts",
            line: 12,
          },
        ],
        evidence_source: "commit_author",
        name: "Dev Owner",
      },
    });
    expect(request.evidence[3]).toMatchObject({
      kind: "owner_evidence",
      missingInfo: ["No PR metadata provider is configured."],
    });
  });

  it("adds the built-in manager-owner profile contract to prompts", () => {
    const prompt = buildSystemPrompt({ basePrompt: "Base prompt", env: {} });

    expect(prompt.profile).toBe(MANAGER_OWNER_TRIAGE_PROFILE);
    expect(prompt.systemPrompt).toContain("Include managerTriage in the final JSON");
    expect(prompt.systemPrompt).toContain("Create likely_owner_candidates only from owner_evidence items");
    expect(prompt.systemPrompt).toContain("ownerCandidate evidence");
  });

  it("requires an OpenAI API key for the default provider", () => {
    expect(() => createAiProviderFromEnv({ FIRSTTRACE_AI_PROVIDER: "openai" })).toThrow(
      "OPENAI_API_KEY is required",
    );
  });

  it("reports AI readiness only when the active provider can run", () => {
    expect(aiReadinessMetadataFromEnv({ FIRSTTRACE_AI_ENABLED: "false" })).toMatchObject({
      aiEnabled: false,
      aiProvider: "openai",
      aiReady: false,
      investigator: "agent",
      model: "gpt-5.4-mini",
      slackAiGate: "disabled",
    });

    expect(aiReadinessMetadataFromEnv({ FIRSTTRACE_AI_ENABLED: "true" })).toMatchObject({
      aiEnabled: true,
      aiProvider: "openai",
      aiReady: false,
      investigator: "agent",
      slackAiGate: "enabled",
      warning: "OPENAI_API_KEY is required when --ai is enabled.",
    });
  });

  it("uses gpt-5.4-mini as the default shared OpenAI model", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-5.4-mini");
    expect(createAiProviderFromEnv({ FIRSTTRACE_AI_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }).model).toBe(
      "gpt-5.4-mini",
    );
  });

  it("defaults --ai to the read-only investigation agent", () => {
    const provider = createInvestigatorProviderFromEnv({ OPENAI_API_KEY: "test-key" });
    expect(provider.name).toBe("agent");
    expect(provider.model).toBe("gpt-5.4-mini");
  });

  it("uses the provided env instead of ambient process investigator mode", () => {
    const previous = process.env.FIRSTTRACE_INVESTIGATOR;
    process.env.FIRSTTRACE_INVESTIGATOR = "codex-cli";
    try {
      const provider = createInvestigatorProviderFromEnv({ OPENAI_API_KEY: "test-key" });
      expect(provider.name).toBe("agent");
    } finally {
      if (previous === undefined) {
        delete process.env.FIRSTTRACE_INVESTIGATOR;
      } else {
        process.env.FIRSTTRACE_INVESTIGATOR = previous;
      }
    }
  });

  it("honors OPENAI_MODEL_CHAT for agent and evidence modes", () => {
    const agent = createInvestigatorProviderFromEnv({
      FIRSTTRACE_INVESTIGATOR: "agent",
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL_CHAT: "custom-model",
    });
    const evidence = createInvestigatorProviderFromEnv({
      FIRSTTRACE_INVESTIGATOR: "evidence",
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL_CHAT: "custom-model",
    });

    expect(agent.model).toBe("custom-model");
    expect(evidence.model).toBe("custom-model");
  });

  it("uses FIRSTTRACE_MODEL_CHAT as the provider-neutral model selector", () => {
    expect(resolveChatModelFromEnv({
      FIRSTTRACE_MODEL_CHAT: "shared-model",
      OPENAI_MODEL_CHAT: "legacy-model",
    })).toBe("shared-model");

    const provider = createInvestigatorProviderFromEnv({
      FIRSTTRACE_MODEL_CHAT: "shared-model",
      OPENAI_API_KEY: "test-key",
    });
    expect(provider.model).toBe("shared-model");
  });

  it("supports OCI GenAI without requiring OPENAI_API_KEY", () => {
    const env = {
      FIRSTTRACE_AI_PROVIDER: "oracle-genai",
      FIRSTTRACE_INVESTIGATOR: "agent",
      FIRSTTRACE_MODEL_CHAT: "openai.gpt-oss-120b",
      OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..test",
      OCI_REGION: "us-chicago-1",
    };

    expect(aiModelProviderFromEnv(env)).toBe("oci-genai");
    const agent = createInvestigatorProviderFromEnv(env);
    const evidence = createInvestigatorProviderFromEnv({
      ...env,
      FIRSTTRACE_AI_PROVIDER: "oci",
      FIRSTTRACE_INVESTIGATOR: "evidence",
    });

    expect(agent.name).toBe("agent");
    expect(agent.model).toBe("openai.gpt-oss-120b");
    expect(evidence.name).toBe("evidence");
    expect(evidence.model).toBe("openai.gpt-oss-120b");
  });

  it("allows OCI GenAI region to differ from the runtime region", () => {
    expect(
      ociGenAiConfigFromEnv({
        FIRSTTRACE_AI_PROVIDER: "oci-genai",
        OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..test",
        OCI_GENAI_REGION: "us-chicago-1",
        OCI_REGION: "us-sanjose-1",
      }).region,
    ).toBe("us-chicago-1");

    expect(
      ociGenAiConfigFromEnv({
        FIRSTTRACE_AI_PROVIDER: "oci-genai",
        OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..test",
        OCI_REGION: "us-sanjose-1",
      }).region,
    ).toBe("us-sanjose-1");
  });

  it("fails clearly when OCI GenAI model or compartment config is missing", () => {
    expect(() =>
      createInvestigatorProviderFromEnv({
        FIRSTTRACE_AI_PROVIDER: "oci-genai",
        OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..test",
      }),
    ).toThrow("FIRSTTRACE_MODEL_CHAT or OCI_GENAI_MODEL_ID is required");

    expect(() =>
      createInvestigatorProviderFromEnv({
        FIRSTTRACE_AI_PROVIDER: "oci-genai",
        FIRSTTRACE_MODEL_CHAT: "openai.gpt-oss-120b",
      }),
    ).toThrow("OCI_COMPARTMENT_ID is required");
  });

  it("recognizes codex-cli as a future investigator adapter", async () => {
    const provider = createInvestigatorProviderFromEnv({
      FIRSTTRACE_INVESTIGATOR: "codex-cli",
      OPENAI_MODEL_CHAT: "custom-model",
    });

    expect(provider.name).toBe("codex-cli");
    expect(provider.model).toBe("custom-model");
    await expect(provider.investigate({} as never)).rejects.toThrow("codex-cli investigator is not implemented yet");
  });

  it("rejects unknown investigator modes", () => {
    expect(() =>
      createInvestigatorProviderFromEnv({
        FIRSTTRACE_INVESTIGATOR: "unknown",
        OPENAI_API_KEY: "test-key",
      }),
    ).toThrow("Unsupported investigator provider");
  });

  it("keeps the AI provider selection explicit", () => {
    expect(() =>
      createAiProviderFromEnv({
        FIRSTTRACE_AI_PROVIDER: "unknown",
        OPENAI_API_KEY: "test-key",
      }),
    ).toThrow("Unsupported AI provider");
  });

  it("flags AI citations that were not in the evidence bundle", () => {
    const request = buildAiReasonerRequest(investigationResult());
    const grounded = groundAiResult(
      {
        confidence: 0.7,
        explanation: "Renderer evidence points at the bug.",
        implementerHints: [
          {
            citations: ["commit abc123", "made-up-commit"],
            commit: "abc123",
            email: null,
            name: "Dev Owner",
            reason: "Recent commit is related.",
          },
        ],
        likelyComponent: "src",
        likelyFiles: [
          {
            citations: ["src/render.ts:12", "unknown.ts:1"],
            confidence: 0.8,
            path: "src/render.ts",
            reason: "Renderer evidence matches.",
            repo: "repo",
          },
        ],
        likelyOwners: ["@core"],
        missingInfoQuestions: [],
        provider: "test",
        warnings: [],
      },
      request,
    );

    expect(grounded.likelyFiles[0]?.citations).toEqual(["src/render.ts:12"]);
    expect(grounded.implementerHints[0]?.citations).toEqual(["commit abc123"]);
    expect(grounded.warnings.join("\n")).toContain("unsupported citations");
    expect(grounded.quality).toMatchObject({
      foundExactFile: true,
      foundOwner: true,
      foundRelatedCommit: true,
    });
    expect(grounded.quality?.citationCoverage).toBe(0.5);
    expect(grounded.quality?.actionability).toBeGreaterThan(0.7);
  });

  it("normalizes AI line ranges to supported evidence citations", () => {
    const request = buildAiReasonerRequest(investigationResult());
    const grounded = groundAiResult(
      {
        confidence: 0.7,
        explanation: "Renderer evidence points at the bug.",
        implementerHints: [],
        likelyComponent: "src",
        likelyFiles: [
          {
            citations: ["src/render.ts:10-20"],
            confidence: 0.8,
            path: "src/render.ts",
            reason: "Renderer evidence matches.",
            repo: "repo",
          },
        ],
        likelyOwners: ["@core"],
        missingInfoQuestions: [],
        provider: "test",
        warnings: [],
      },
      request,
    );

    expect(grounded.likelyFiles[0]?.citations).toEqual(["src/render.ts:12"]);
    expect(grounded.warnings.join("\n")).not.toContain("unsupported citations");
  });

  it("normalizes AI line citations to supported file-path evidence citations", () => {
    const request = {
      ...buildAiReasonerRequest(investigationResult()),
      evidence: [
        ...buildAiReasonerRequest(investigationResult()).evidence,
        {
          citations: ["components/profile-tab.tsx"],
          id: "tool-1",
          kind: "agent_observation" as const,
          summary: "components/profile-tab.tsx",
          title: "Find profile files",
        },
      ],
    };
    const grounded = groundAiResult(
      {
        confidence: 0.7,
        explanation: "Profile tab evidence points at the bug.",
        implementerHints: [],
        likelyComponent: "components/profile-tab.tsx",
        likelyFiles: [
          {
            citations: ["components/profile-tab.tsx:1"],
            confidence: 0.8,
            path: "components/profile-tab.tsx",
            reason: "Profile tab evidence matches.",
            repo: "repo",
          },
        ],
        likelyOwners: ["@core"],
        missingInfoQuestions: [],
        provider: "test",
        warnings: [],
      },
      request,
    );

    expect(grounded.likelyFiles[0]?.citations).toEqual(["components/profile-tab.tsx"]);
    expect(grounded.warnings.join("\n")).not.toContain("unsupported citations");
  });

  it("normalizes manager owner candidates against structured owner evidence", () => {
    const request = buildAiReasonerRequest({
      ...investigationResult(),
      ownerEvidence: ownerEvidence(),
    });
    const grounded = groundAiResult(
      {
        confidence: 0.82,
        explanation: "The renderer line is the likely source.",
        implementerHints: [],
        likelyComponent: "src/render.ts",
        likelyFiles: [
          {
            citations: ["src/render.ts:12"],
            confidence: 0.82,
            path: "src/render.ts",
            reason: "Renderer evidence matches.",
            repo: "repo",
          },
        ],
        likelyOwners: ["Invented Owner"],
        managerTriage: {
          issue: "Renderer crashes on citations.",
          likely_owner_candidates: [
            {
              confidence: "Low",
              email: "invented@example.com",
              evidence_commits: [
                {
                  commit_id: "abcdef1234567890abcdef1234567890abcdef12",
                  commit_time: "wrong",
                  commit_title: "wrong",
                  evidence_code: "wrong",
                  file: "wrong.ts",
                  line: 99,
                  repo: "repo",
                  why_relevant: "wrong",
                },
              ],
              evidence_source: "unknown",
              name: "Invented Owner",
              rank: 1,
              reason: "This commit is the strongest owner evidence.",
            },
            {
              confidence: "High",
              email: "other@example.com",
              evidence_commits: [
                {
                  commit_id: "madeup",
                  commit_time: "2026-05-21T00:00:00Z",
                  commit_title: "Made up",
                  evidence_code: "made up",
                  file: "made-up.ts",
                  line: 1,
                  repo: "repo",
                  why_relevant: "Made up.",
                },
              ],
              evidence_source: "commit_author",
              name: "Other Owner",
              rank: 2,
              reason: "Unsupported candidate.",
            },
          ],
          likely_root_cause: "Raw citation rendering path is failing.",
          missing_info: [],
          recommended_manager_action: "Route to the supported owner.",
          title: "Bug Triage",
          user_impact: "Users cannot read citations.",
        },
        missingInfoQuestions: [],
        promptProfile: MANAGER_OWNER_TRIAGE_PROFILE,
        provider: "test",
        warnings: [],
      },
      request,
    );

    expect(grounded.likelyOwners).toEqual(["Dev Owner"]);
    expect(grounded.managerTriage?.likely_owner_candidates).toHaveLength(1);
    expect(grounded.managerTriage?.likely_owner_candidates[0]).toMatchObject({
      confidence: "High",
      email: "dev.owner@example.com",
      evidence_commits: [
        {
          commit_id: "abcdef1234567890abcdef1234567890abcdef12",
          commit_time: "2026-05-20T17:15:30Z",
          evidence_code: "return renderCitation(citation)",
          file: "src/render.ts",
          line: 12,
        },
      ],
      evidence_source: "commit_author",
      name: "Dev Owner",
      rank: 1,
    });
    expect(grounded.managerTriage?.missing_info.join("\n")).toContain("No PR metadata provider is configured");
    expect(grounded.warnings.join("\n")).toContain("Removed unsupported manager owner candidate");
  });

  it("renders weak manager triage when the default profile receives a simplified answer", () => {
    const request = buildAiReasonerRequest(investigationResult());
    const grounded = groundAiResult(
      {
        confidence: 0.55,
        explanation: "Renderer evidence is suspicious but owner evidence is missing.",
        implementerHints: [],
        likelyComponent: "src/render.ts",
        likelyFiles: [
          {
            citations: ["src/render.ts:12"],
            confidence: 0.55,
            path: "src/render.ts",
            reason: "Renderer evidence matches.",
            repo: "repo",
          },
        ],
        likelyOwners: ["Invented Owner"],
        missingInfoQuestions: [],
        promptProfile: MANAGER_OWNER_TRIAGE_PROFILE,
        provider: "test",
        userImpact: "Users cannot read citations.",
        warnings: [],
      },
      request,
    );

    expect(grounded.likelyOwners).toEqual([]);
    expect(grounded.managerTriage).toMatchObject({
      likely_owner_candidates: [],
      recommended_manager_action: "Do not assign a person yet. Collect exact-line blame, PR metadata, or pushed-by provider metadata, then rerun triage.",
      user_impact: "Users cannot read citations.",
    });
    expect(grounded.managerTriage?.missing_info.join("\n")).toContain("Provider returned a simplified answer without managerTriage");
    expect(grounded.warnings.join("\n")).toContain("Provider did not return managerTriage");
  });

  it("preserves deterministic owner evidence when normalizing a simplified manager answer", () => {
    const request = buildAiReasonerRequest({
      ...investigationResult(),
      ownerEvidence: ownerEvidence(),
    });
    const grounded = groundAiResult(
      {
        confidence: 0.62,
        explanation: "Renderer evidence is suspicious.",
        implementerHints: [],
        likelyComponent: "src/render.ts",
        likelyFiles: [
          {
            citations: ["src/render.ts:12"],
            confidence: 0.62,
            path: "src/render.ts",
            reason: "Renderer evidence matches.",
            repo: "repo",
          },
        ],
        likelyOwners: [],
        missingInfoQuestions: [],
        promptProfile: MANAGER_OWNER_TRIAGE_PROFILE,
        provider: "test",
        warnings: [],
      },
      request,
    );

    expect(grounded.likelyOwners).toEqual(["Dev Owner"]);
    expect(grounded.managerTriage?.likely_owner_candidates[0]).toMatchObject({
      email: "dev.owner@example.com",
      evidence_commits: [
        {
          commit_id: "abcdef1234567890abcdef1234567890abcdef12",
          file: "src/render.ts",
          line: 12,
        },
      ],
      name: "Dev Owner",
      rank: 1,
    });
    expect(grounded.managerTriage?.recommended_manager_action).toContain("weak normalized handoff");
  });
});
