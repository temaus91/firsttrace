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

  it("rejects non-allowlisted safe commands", async () => {
    const toolset = createInvestigationToolset(preparedConfig(tempRepo("safe-command")));

    await expect(toolset.execute("runSafeCommand", { command: "rm -rf ." })).rejects.toThrow("not allowlisted");
  });
});

describe("read-only investigation agent", () => {
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
    expect(result.warnings).toEqual([]);
  });
});
