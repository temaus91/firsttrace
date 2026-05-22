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

  it("rejects invalid GitHub repo config with a clear error", () => {
    const dir = tempConfigDir("invalid-github");
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      ["repos:", "  - name: app", "    provider: github", "    owner: exampleco", "docs: []"].join("\n"),
    );

    expect(() => loadConfig(configPath)).toThrow("repos[0].repo must be a non-empty string for github repos.");
  });
});
