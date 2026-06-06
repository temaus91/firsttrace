import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("package and container guardrails", () => {
  it("keeps nested repository git history opt-in for OCI package builds", () => {
    const dockerignore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
    const buildScript = readFileSync(path.join(repoRoot, "deploy", "oci", "scripts", "build-and-push.sh"), "utf8");

    expect(dockerignore).toContain(".git");
    expect(dockerignore).toContain("!firsttrace-repos-context/**/.git");
    expect(dockerignore).toContain("!firsttrace-repos-context/**/.git/**");
    expect(buildScript).toContain("FIRSTTRACE_INCLUDE_REPO_GIT_HISTORY");
    expect(buildScript).toContain("firsttrace-repos-context");
  });
});
