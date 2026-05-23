import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createAgentInvestigator, type AgentModelClient } from "../src/investigator/agent-provider.js";
import { createInvestigationToolset } from "../src/investigator/tools.js";
import { runCommand } from "../src/shell.js";
import type { InvestigationResult, PreparedFirstTraceConfig } from "../src/types.js";

const tempRepo = (name: string) => {
  const repoPath = path.join(tmpdir(), `firsttrace-investigator-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(repoPath, "src"), { recursive: true });
  writeFileSync(
    path.join(repoPath, "src", "render.ts"),
    ["export const render = () => {", "  return 'citations';", "};", ""].join("\n"),
  );
  mkdirSync(path.join(repoPath, "lib"), { recursive: true });
  writeFileSync(path.join(repoPath, "lib", "app-context.tsx"), "export const isAppBootstrapReady = false\n");
  mkdirSync(path.join(repoPath, "lib", "server"), { recursive: true });
  writeFileSync(
    path.join(repoPath, "lib", "server", "receipt-email.ts"),
    [
      "import { claimReceiptNotification, markReceiptNotificationFailed } from './receipt-store'",
      "",
      "export const sendReceiptEmail = async () => {",
      "  if (!process.env.RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY')",
      "  const claim = await claimReceiptNotification()",
      "  if (!claim.shouldSend) return { status: 'skipped' }",
      "  try {",
      "    return { status: 'sent' }",
      "  } catch (error) {",
      "    await markReceiptNotificationFailed()",
      "    return { status: 'failed' }",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(repoPath, "lib", "server", "receipt-store.ts"),
    [
      "export const claimReceiptNotification = async () => {",
      "  try {",
      "    await db.from('sale_notifications').insert({ delivery_status: 'SENDING' })",
      "    return { notification: {}, shouldSend: true }",
      "  } catch (error) {",
      "    if (error.code === '23505') {",
      "      const existing = await db.from('sale_notifications').select('*').single()",
      "      return { notification: existing, shouldSend: false }",
      "    }",
      "    throw error",
      "  }",
      "}",
      "",
      "export const markReceiptNotificationFailed = async () => {",
      "  await db.from('sale_notifications').update({ delivery_status: 'FAILED' })",
      "}",
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(repoPath, "components"), { recursive: true });
  writeFileSync(path.join(repoPath, "components", "profile-tab.tsx"), "export function ProfileTab() { return null }\n");
  writeFileSync(path.join(repoPath, "components", "reservation-detail.tsx"), "export function ReservationDetail() { return null }\n");
  mkdirSync(path.join(repoPath, "app"), { recursive: true });
  writeFileSync(
    path.join(repoPath, "app", "page.tsx"),
    [
      "const activeTab = 'profile'",
      "const renderScreen = (screen, reservations) => {",
      "  switch (screen.type) {",
      "    case 'reservation-detail': {",
      "      const activeReservation = reservations.find((item) => item.id === screen.reservationId)",
      "      if (!activeReservation) return null",
      "      return activeReservation",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  runCommand(repoPath, "git", ["init"]);
  runCommand(repoPath, "git", ["config", "user.email", "dev@example.com"]);
  runCommand(repoPath, "git", ["config", "user.name", "Dev Owner"]);
  runCommand(repoPath, "git", ["add", "."]);
  runCommand(repoPath, "git", ["commit", "-m", "Add renderer"]);
  return repoPath;
};

const preparedConfig = (repoPath: string): PreparedFirstTraceConfig => ({
  configPath: path.join(repoPath, "firsttrace.config.yaml"),
  docs: [],
  issueExports: [],
  owners: [],
  repos: [
    {
      name: "repo",
      path: repoPath,
      provider: "local",
      sourceProvider: "local",
    },
  ],
  search: {
    maxCommits: 8,
    maxEvidencePerFile: 3,
    maxFiles: 10,
  },
});

const investigationResult = (): InvestigationResult => ({
  classification: "bug",
  likelyComponent: "src",
  likelyOwners: [],
  relatedCommits: [],
  relatedDocs: [],
  report: "Renderer citation output is wrong",
  searchTerms: ["renderer", "citation"],
  suggestedNextSteps: ["Inspect src/render.ts."],
  suspiciousFiles: [
    {
      citations: [{ label: "repo:src/render.ts:1", line: 1, path: "src/render.ts", repo: "repo" }],
      path: "src/render.ts",
      repo: "repo",
      score: 12,
      summary: "Renderer handles citation output.",
      title: "src/render.ts",
      type: "file",
    },
  ],
  warnings: [],
});

describe("investigation agent tools", () => {
  it("denies path traversal and reads only inside repo roots", async () => {
    const toolset = createInvestigationToolset(preparedConfig(tempRepo("path")));

    await expect(toolset.execute("readFile", { path: "../outside" })).rejects.toThrow("outside");
    await expect(toolset.execute("readFile", { path: "src/render.ts", line: 1, window: 2 })).resolves.toMatchObject({
      citations: ["src/render.ts:1", "src/render.ts:2"],
    });
  });

  it("returns grounded file, commit, and blame citations", async () => {
    const toolset = createInvestigationToolset(preparedConfig(tempRepo("citations")));

    const search = await toolset.execute("searchRepo", { query: "citations" });
    const log = await toolset.execute("gitLog", { path: "src/render.ts" });
    const blame = await toolset.execute("gitBlame", { line: 1, path: "src/render.ts" });

    expect(search.citations).toContain("src/render.ts:2");
    expect(log.citations[0]).toMatch(/^commit [a-f0-9]{7}$/);
    expect(blame.citations).toContain("src/render.ts:1");
    expect(blame.citations.find((citation) => citation.startsWith("commit "))).toBeTruthy();
  });

  it("finds file paths by query", async () => {
    const toolset = createInvestigationToolset(preparedConfig(tempRepo("find-files")));

    await expect(toolset.execute("findFiles", { query: "profile" })).resolves.toMatchObject({
      citations: ["components/profile-tab.tsx"],
    });
  });

  it("rejects non-allowlisted safe commands", async () => {
    const toolset = createInvestigationToolset(preparedConfig(tempRepo("safe-command")));

    await expect(toolset.execute("runSafeCommand", { command: "rm -rf ." })).rejects.toThrow("not allowlisted");
  });
});

describe("read-only investigation agent", () => {
  it("seeds UI journey file path candidates before the model loop", async () => {
    const modelClient: AgentModelClient = {
      async next({ observations }) {
        expect(observations.some((item) => item.tool === "findFiles" && item.summary.includes("profile-tab.tsx"))).toBe(true);
        expect(observations.some((item) => item.tool === "searchRepo" && item.summary.includes("ProfileTab"))).toBe(true);
        expect(observations.some((item) => item.tool === "searchRepo" && item.title.includes("isAppBootstrapReady"))).toBe(true);
        return {
          result: {
            confidence: 0.83,
            explanation: "The authenticated profile tab is the best lead.",
            implementerHints: [],
            likelyComponent: "components/profile-tab.tsx",
            likelyFiles: [
              {
                citations: ["components/profile-tab.tsx"],
                confidence: 0.83,
                path: "components/profile-tab.tsx",
                reason: "The journey mentions login and the profile screen.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final({ observations }) {
        expect(observations.some((item) => item.title.includes("Bootstrap state correction"))).toBe(true);
        return {
          confidence: 0.83,
          explanation: "The authenticated profile tab and app bootstrap state are the best leads.",
          implementerHints: [],
          likelyComponent: "components/profile-tab.tsx",
          likelyFiles: [
            {
              citations: ["components/profile-tab.tsx"],
              confidence: 0.83,
              path: "components/profile-tab.tsx",
              reason: "The journey mentions login and the profile screen.",
              repo: "repo",
            },
            {
              citations: ["lib/app-context.tsx:1"],
              confidence: 0.7,
              path: "lib/app-context.tsx",
              reason: "The app context owns bootstrap readiness.",
              repo: "repo",
            },
          ],
          likelyOwners: [],
          missingInfoQuestions: [],
          warnings: [],
        };
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("journey-seed")),
      result: {
        ...investigationResult(),
        report: "When I login and go to profile page it looks empty.",
        searchTerms: ["login", "profile", "page", "empty"],
      },
    });

    expect(result.likelyFiles[0]?.path).toBe("components/profile-tab.tsx");
    expect(result.likelyFiles.map((item) => item.path)).toContain("lib/app-context.tsx");
    expect(result.warnings).toEqual([]);
  });

  it("reconsiders public dynamic routes for authenticated screen journeys", async () => {
    let usedCorrection = false;
    const modelClient: AgentModelClient = {
      async next() {
        return {
          result: {
            confidence: 0.9,
            explanation: "The public detail route is the likely source.",
            implementerHints: [],
            likelyComponent: "app/users/[userId]/page.tsx",
            likelyFiles: [
              {
                citations: ["app/users/[userId]/page.tsx:1"],
                confidence: 0.9,
                path: "app/users/[userId]/page.tsx",
                reason: "It is a dynamic public route.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final({ observations }) {
        usedCorrection = observations.some((item) => item.title.includes("Journey correction"));
        return {
          confidence: 0.84,
          explanation: "The authenticated profile tab is the better match.",
          implementerHints: [],
          likelyComponent: "components/profile-tab.tsx",
          likelyFiles: [
            {
              citations: ["components/profile-tab.tsx"],
              confidence: 0.84,
              path: "components/profile-tab.tsx",
              reason: "The report describes a login journey to the profile screen.",
              repo: "repo",
            },
          ],
          likelyOwners: [],
          missingInfoQuestions: [],
          warnings: [],
        };
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("journey-correction")),
      result: {
        ...investigationResult(),
        report: "When I login and go to profile page it looks empty.",
        searchTerms: ["login", "profile", "page", "empty"],
      },
    });

    expect(usedCorrection).toBe(true);
    expect(result.likelyFiles[0]?.path).toBe("components/profile-tab.tsx");
    expect(result.warnings).toEqual([]);
  });

  it("keeps rendered tab components in authenticated shell investigations", async () => {
    let usedCorrection = false;
    const modelClient: AgentModelClient = {
      async next() {
        return {
          result: {
            confidence: 0.86,
            explanation: "The authenticated shell bootstrap is the strongest lead.",
            implementerHints: [],
            likelyComponent: "app/page.tsx",
            likelyFiles: [
              {
                citations: ["app/page.tsx:1"],
                confidence: 0.86,
                path: "app/page.tsx",
                reason: "The app shell handles tab routing.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final({ observations }) {
        usedCorrection = observations.some((item) => item.title.includes("Rendered surface correction"));
        expect(observations.some((item) => item.title.includes("Bootstrap state correction"))).toBe(true);
        return {
          confidence: 0.86,
          explanation: "The shell is primary, with the rendered profile tab and bootstrap state as secondary surfaces.",
          implementerHints: [],
          likelyComponent: "app/page.tsx",
          likelyFiles: [
            {
              citations: ["app/page.tsx:1"],
              confidence: 0.86,
              path: "app/page.tsx",
              reason: "The app shell handles tab routing.",
              repo: "repo",
            },
            {
              citations: ["components/profile-tab.tsx"],
              confidence: 0.72,
              path: "components/profile-tab.tsx",
              reason: "The report names the profile tab and seeded evidence found the rendered component.",
              repo: "repo",
            },
            {
              citations: ["lib/app-context.tsx:1"],
              confidence: 0.64,
              path: "lib/app-context.tsx",
              reason: "The report is about auth/bootstrap readiness and the context owns the readiness flag.",
              repo: "repo",
            },
          ],
          likelyOwners: [],
          missingInfoQuestions: [],
          warnings: [],
        };
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("rendered-tab-correction")),
      result: {
        ...investigationResult(),
        report: "When I login and open profile it looks empty.",
        searchTerms: ["login", "profile", "empty"],
      },
    });

    expect(usedCorrection).toBe(true);
    expect(result.likelyFiles.map((item) => item.path)).toContain("components/profile-tab.tsx");
    expect(result.likelyFiles.map((item) => item.path)).toContain("lib/app-context.tsx");
    expect(result.warnings).toEqual([]);
  });

  it("reconsiders leaf detail components for missing entity blank screens", async () => {
    let usedCorrection = false;
    const modelClient: AgentModelClient = {
      async next({ observations }) {
        expect(observations.some((item) => item.summary.includes("activeReservation"))).toBe(true);
        expect(observations.some((item) => item.summary.includes("return null"))).toBe(true);
        return {
          result: {
            confidence: 0.88,
            explanation: "The reservation detail component is the likely source.",
            implementerHints: [],
            likelyComponent: "components/reservation-detail.tsx",
            likelyFiles: [
              {
                citations: ["components/reservation-detail.tsx"],
                confidence: 0.88,
                path: "components/reservation-detail.tsx",
                reason: "The report mentions reservation detail.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final({ observations }) {
        usedCorrection = observations.some((item) => item.title.includes("Missing entity correction"));
        return {
          confidence: 0.86,
          explanation: "The parent shell returns null before the detail component can render.",
          implementerHints: [],
          likelyComponent: "app/page.tsx",
          likelyFiles: [
            {
              citations: ["app/page.tsx:5", "app/page.tsx:6"],
              confidence: 0.86,
              path: "app/page.tsx",
              reason: "The shell looks up the reservation id and returns null when it is missing.",
              repo: "repo",
            },
          ],
          likelyOwners: [],
          missingInfoQuestions: [],
          warnings: [],
        };
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("missing-detail-correction")),
      result: {
        ...investigationResult(),
        report: "When I open an old reservation detail after it disappeared from my list, the screen goes blank.",
        searchTerms: ["open", "old", "reservation", "detail", "disappeared", "list", "screen", "blank"],
      },
    });

    expect(usedCorrection).toBe(true);
    expect(result.likelyFiles[0]?.path).toBe("app/page.tsx");
    expect(result.warnings).toEqual([]);
  });

  it("seeds retry/idempotency state-machine evidence before the model loop", async () => {
    const modelClient: AgentModelClient = {
      async next({ observations }) {
        expect(observations.some((item) => item.summary.includes("shouldSend"))).toBe(true);
        expect(observations.some((item) => item.summary.includes("delivery_status"))).toBe(true);
        expect(observations.some((item) => item.summary.includes("23505"))).toBe(true);
        return {
          result: {
            confidence: 0.84,
            explanation: "The receipt store owns retry eligibility.",
            implementerHints: [],
            likelyComponent: "lib/server/receipt-store.ts",
            likelyFiles: [
              {
                citations: ["lib/server/receipt-store.ts:1", "lib/server/receipt-store.ts:6"],
                confidence: 0.84,
                path: "lib/server/receipt-store.ts",
                reason: "The store owns the claim and duplicate handling path.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final() {
        throw new Error("final fallback should not be used");
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("retry-state-seed")),
      result: {
        ...investigationResult(),
        report: "Receipt email failed when RESEND_API_KEY was missing. After configuring it, retry is skipped for the same sale.",
        searchTerms: ["receipt", "email", "failed", "resend_api_key", "missing", "retry", "skipped", "sale"],
      },
    });

    expect(result.likelyFiles[0]?.path).toBe("lib/server/receipt-store.ts");
    expect(result.warnings).toEqual([]);
  });

  it("reconsiders entry routes and senders for retry state-machine bugs", async () => {
    let usedCorrection = false;
    const modelClient: AgentModelClient = {
      async next() {
        return {
          result: {
            confidence: 0.88,
            explanation: "The receipt email sender returns skipped.",
            implementerHints: [],
            likelyComponent: "lib/server/receipt-email.ts",
            likelyFiles: [
              {
                citations: ["lib/server/receipt-email.ts:6"],
                confidence: 0.88,
                path: "lib/server/receipt-email.ts",
                reason: "The sender returns skipped when shouldSend is false.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final({ observations }) {
        usedCorrection = observations.some((item) => item.title.includes("Retry state correction"));
        return {
          confidence: 0.87,
          explanation: "The persisted claim state makes failed notifications non-retryable.",
          implementerHints: [],
          likelyComponent: "lib/server/receipt-email.ts",
          likelyFiles: [
            {
              citations: ["lib/server/receipt-email.ts:6"],
              confidence: 0.88,
              path: "lib/server/receipt-email.ts",
              reason: "The sender surfaces the skipped result from the store claim.",
              repo: "repo",
            },
            {
              citations: ["lib/server/receipt-store.ts:1", "lib/server/receipt-store.ts:6", "lib/server/receipt-store.ts:8"],
              confidence: 0.87,
              path: "lib/server/receipt-store.ts",
              reason: "The store maps duplicate notification rows to shouldSend false regardless of failed status.",
              repo: "repo",
            },
          ],
          likelyOwners: [],
          missingInfoQuestions: [],
          warnings: [],
        };
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("retry-state-correction")),
      result: {
        ...investigationResult(),
        report: "Receipt email failed when RESEND_API_KEY was missing. After configuring it, retry is skipped for the same sale.",
        searchTerms: ["receipt", "email", "failed", "resend_api_key", "missing", "retry", "skipped", "sale"],
      },
    });

    expect(usedCorrection).toBe(true);
    expect(result.likelyComponent).toBe("lib/server/receipt-store.ts");
    expect(result.likelyFiles[0]?.path).toBe("lib/server/receipt-store.ts");
    expect(result.warnings).toEqual([]);
  });

  it("keeps investigating after a rejected tool call", async () => {
    let observedToolError = false;
    const modelClient: AgentModelClient = {
      async next({ observations }) {
        if (!observations.length) {
          return {
            args: { path: "src/render.ts", line: 1, window: 500 },
            reason: "Try reading the renderer with too much context.",
            tool: "readFile",
            type: "tool",
          };
        }

        observedToolError = observations[0]?.title === "readFile failed";
        return {
          result: {
            confidence: 0.7,
            explanation: "The deterministic renderer evidence remains the best supported location.",
            implementerHints: [],
            likelyComponent: "src/render.ts",
            likelyFiles: [
              {
                citations: ["src/render.ts:1"],
                confidence: 0.7,
                path: "src/render.ts",
                reason: "The initial evidence points at the renderer entrypoint.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final() {
        throw new Error("final fallback should not be used");
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("agent-tool-error")),
      result: investigationResult(),
    });

    expect(observedToolError).toBe(true);
    expect(result.provider).toBe("agent");
    expect(result.likelyFiles[0]?.citations).toEqual(["src/render.ts:1"]);
  });

  it("runs a tool step and grounds the final structured result", async () => {
    const modelClient: AgentModelClient = {
      async next({ observations }) {
        if (!observations.length) {
          return {
            args: { path: "src/render.ts", line: 1, window: 2 },
            reason: "Read the top renderer candidate.",
            tool: "readFile",
            type: "tool",
          };
        }

        return {
          result: {
            confidence: 0.82,
            explanation: "The renderer file is the best supported location.",
            implementerHints: [],
            likelyComponent: "src/render.ts",
            likelyFiles: [
              {
                citations: ["src/render.ts:1"],
                confidence: 0.82,
                path: "src/render.ts",
                reason: "The readFile observation includes the renderer entrypoint.",
                repo: "repo",
              },
            ],
            likelyOwners: [],
            missingInfoQuestions: [],
            warnings: [],
          },
          type: "final",
        };
      },
      async final() {
        throw new Error("final fallback should not be used");
      },
    };

    const provider = createAgentInvestigator({ model: "test-model", modelClient });
    const result = await provider.investigate({
      preparedConfig: preparedConfig(tempRepo("agent-loop")),
      result: investigationResult(),
    });

    expect(result.provider).toBe("agent");
    expect(result.likelyFiles[0]?.citations).toEqual(["src/render.ts:1"]);
    expect(result.implementerHints[0]?.name).toBe("Dev Owner");
    expect(result.warnings).toEqual([]);
  });
});
