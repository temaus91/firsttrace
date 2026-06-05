import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const tempConfigDir = (name: string) => {
  const dir = path.join(tmpdir(), `firsttrace-config-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("config loading", () => {
  it("accepts legacy local repo config and defaults provider to local", () => {
    const dir = tempConfigDir("local");
    const repoDir = path.join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      ["repos:", "  - name: local-repo", "    path: repo", "docs: []", "issue_exports: []"].join("\n"),
    );

    expect(loadConfig(configPath).repos).toEqual([
      {
        name: "local-repo",
        path: repoDir,
        provider: "local",
      },
    ]);
  });

  it("accepts GitHub repo config without requiring a local checkout", () => {
    const dir = tempConfigDir("github");
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      [
        "repos:",
        "  - name: app",
        "    provider: github",
        "    owner: exampleco",
        "    repo: web-app",
        "    default_branch: trunk",
        "docs: []",
        "issue_exports: []",
      ].join("\n"),
    );

    expect(loadConfig(configPath).repos).toEqual([
      {
        defaultBranch: "trunk",
        name: "app",
        owner: "exampleco",
        provider: "github",
        repo: "web-app",
      },
    ]);
  });

  it("accepts archive repo config without requiring the target path to exist yet", () => {
    const dir = tempConfigDir("archive");
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      [
        "repos:",
        "  - name: app",
        "    provider: archive",
        "    archive_command: ./scripts/download-app.sh",
        "    ref: refs/heads/main",
        "    path: repos/app",
        "docs: []",
        "issue_exports: []",
      ].join("\n"),
    );

    expect(loadConfig(configPath).repos).toEqual([
      {
        archiveCommand: "./scripts/download-app.sh",
        commandCwd: dir,
        name: "app",
        path: path.join(dir, "repos", "app"),
        provider: "archive",
        ref: "refs/heads/main",
      },
    ]);
  });

  it("loads optional investigation prompt overlay config", () => {
    const dir = tempConfigDir("prompt-overlay");
    const repoDir = path.join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      [
        "repos:",
        "  - name: local-repo",
        "    path: repo",
        "docs: []",
        "issue_exports: []",
        "investigation:",
        "  prompt:",
        "    profile: enterprise",
        "    overlay_files:",
        "      - prompts/company.md",
      ].join("\n"),
    );

    expect(loadConfig(configPath).investigation.prompt).toEqual({
      overlayFiles: [path.join(dir, "prompts", "company.md")],
      profile: "enterprise",
    });
  });

  it("defaults investigation prompt config", () => {
    const dir = tempConfigDir("prompt-default");
    const repoDir = path.join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      ["repos:", "  - name: local-repo", "    path: repo", "docs: []", "issue_exports: []"].join("\n"),
    );

    expect(loadConfig(configPath).investigation.prompt).toEqual({
      overlayFiles: [],
      profile: "manager-owner-triage",
    });
  });

  it("rejects invalid GitHub repo config with a clear error", () => {
    const dir = tempConfigDir("invalid-github");
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      ["repos:", "  - name: app", "    provider: github", "    owner: exampleco", "docs: []"].join("\n"),
    );

    expect(() => loadConfig(configPath)).toThrow("repos[0].repo must be a non-empty string for github repos.");
  });

  it("loads Slack channel configuration when present", () => {
    const dir = tempConfigDir("slack");
    const repoDir = path.join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      [
        "repos:",
        "  - name: local-repo",
        "    path: repo",
        "docs: []",
        "issue_exports: []",
        "chat:",
        "  provider: slack",
        "  channels:",
        "    - id: C0123456789",
        "      name: company-ai-triage",
        "      triggers:",
        "        - message",
        "        - app_mention",
        "      response: thread",
        "      ai_enabled: true",
        "      data_classification: confidential",
        "      include_thread_context: true",
        "      repositories:",
        "        - local-repo",
      ].join("\n"),
    );

    expect(loadConfig(configPath).chat).toEqual({
      channels: [
        {
          aiEnabled: true,
          dataClassification: "confidential",
          id: "C0123456789",
          includeThreadContext: true,
          name: "company-ai-triage",
          repositories: ["local-repo"],
          response: "thread",
          triggers: ["message", "app_mention"],
        },
      ],
      provider: "slack",
    });
  });
});
