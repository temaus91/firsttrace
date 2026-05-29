import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { renderSetupValidation, validateFirstTraceSetup } from "../src/diagnostics/setup-validation.js";

const tempConfigDir = (name: string) => {
  const dir = path.join(tmpdir(), `firsttrace-setup-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const writeConfig = (dir: string, lines: string[]) => {
  const configPath = path.join(dir, "firsttrace.config.yaml");
  writeFileSync(configPath, lines.join("\n"));
  return configPath;
};

const localConfig = (dir: string, repoPath = "repos/app") => {
  mkdirSync(path.join(dir, repoPath), { recursive: true });
  return writeConfig(dir, [
    "repos:",
    "  - name: app",
    "    provider: local",
    `    path: ${repoPath}`,
    "docs:",
    "  - README.md",
    "issue_exports: []",
    "chat:",
    "  provider: slack",
    "  channels:",
    "    - id: C0123456789",
    "      name: triage",
    "      triggers:",
    "        - app_mention",
    "      response: thread",
    "      ai_enabled: false",
    "      repositories:",
    "        - app",
  ]);
};

describe("setup validation", () => {
  it("reports Slack receiver and reply availability clearly", () => {
    const dir = tempConfigDir("slack-missing");
    const configPath = localConfig(dir);

    const result = validateFirstTraceSetup({
      configPath,
      env: {},
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      level: "FAIL",
      message: "Receiver unavailable: SLACK_SIGNING_SECRET is required to verify Slack Events.",
      name: "Slack receiver",
    });
    expect(result.checks).toContainEqual({
      level: "WARN",
      message: "Replies unavailable: SLACK_BOT_TOKEN is required to post Slack thread replies.",
      name: "Slack replies",
    });
  });

  it("passes deterministic setup with Slack env and warns when OpenAI AI is unavailable", () => {
    const dir = tempConfigDir("deterministic");
    const configPath = localConfig(dir);

    const result = validateFirstTraceSetup({
      configPath,
      env: {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_SIGNING_SECRET: "signing-secret",
      },
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual({
      level: "WARN",
      message: "OpenAI AI is unavailable because OPENAI_API_KEY is missing; deterministic investigation still works.",
      name: "AI provider",
    });
  });

  it("fails missing OpenAI API key when AI validation is requested", () => {
    const dir = tempConfigDir("ai-required");
    const configPath = localConfig(dir);

    const result = validateFirstTraceSetup({
      aiRequested: true,
      configPath,
      env: {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_SIGNING_SECRET: "signing-secret",
      },
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      level: "FAIL",
      message: "OpenAI AI is unavailable because OPENAI_API_KEY is missing; deterministic investigation still works.",
      name: "AI provider",
    });
  });

  it("fails with the exact missing local repository path", () => {
    const dir = tempConfigDir("missing-path");
    const missingPath = path.join(dir, "repos", "missing-app");
    const configPath = writeConfig(dir, [
      "repos:",
      "  - name: missing-app",
      "    provider: local",
      "    path: repos/missing-app",
      "docs: []",
      "issue_exports: []",
    ]);

    const result = validateFirstTraceSetup({ configPath, env: {} });

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual([
      {
        level: "FAIL",
        message: `repos[0].path for local repo "missing-app" does not exist or is not a directory: ${missingPath}`,
        name: "Config",
      },
    ]);
  });

  it("requires repository credentials for GitHub repos", () => {
    const dir = tempConfigDir("github");
    const configPath = writeConfig(dir, [
      "repos:",
      "  - name: app",
      "    provider: github",
      "    owner: example",
      "    repo: app",
      "docs: []",
      "issue_exports: []",
    ]);

    const result = validateFirstTraceSetup({ configPath, env: {} });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      level: "FAIL",
      message:
        "GitHub repos require either GITHUB_TOKEN or GitHub App env vars: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY.",
      name: "GitHub repositories",
    });
  });

  it("renders a compact checklist", () => {
    const rendered = renderSetupValidation({
      checks: [{ level: "PASS", message: "Loaded config.", name: "Config" }],
      passed: true,
    });

    expect(rendered).toBe(["FirstTrace setup validation: PASS", "", "PASS Config: Loaded config."].join("\n"));
  });
});
