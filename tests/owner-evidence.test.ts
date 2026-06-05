import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { collectOwnerEvidence } from "../src/owner-evidence.js";
import type { EvidenceItem, SearchableRepoConfig } from "../src/types.js";

const gitAvailable = () => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const tempRepo = (name: string) => {
  const repoPath = path.join(tmpdir(), `firsttrace-owner-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  return repoPath;
};

const commitFile = ({
  content,
  date,
  email,
  filePath,
  message,
  name,
  repoPath,
}: {
  content: string;
  date: string;
  email: string;
  filePath: string;
  message: string;
  name: string;
  repoPath: string;
}) => {
  mkdirSync(path.dirname(path.join(repoPath, filePath)), { recursive: true });
  writeFileSync(path.join(repoPath, filePath), content);
  execFileSync("git", ["add", filePath], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_NAME: name,
      GIT_COMMITTER_DATE: date,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_NAME: name,
    },
    stdio: "ignore",
  });
};

const repoConfig = (repoPath: string): SearchableRepoConfig => ({
  name: "app",
  path: repoPath,
  provider: "local",
  sourceProvider: "local",
});

const suspiciousFile = (filePath: string, line: number, snippet: string, score = 100): EvidenceItem => ({
  citations: [
    {
      label: `app:${filePath}:${line}`,
      line,
      path: filePath,
      repo: "app",
      score,
      snippet,
      whyRelevant: "Exact route interpolation evidence.",
    },
  ],
  path: filePath,
  repo: "app",
  score,
  summary: snippet,
  title: filePath,
  type: "file",
});

describe("owner evidence collection", () => {
  it("uses exact-line blame to produce one owner candidate with full commit metadata", () => {
    if (!gitAvailable()) return;
    const repoPath = tempRepo("exact-line");
    const filePath = "src/components/EntityLinks.tsx";
    const snippet = "navigate(`/entities/${entity.id}/detail`)";
    commitFile({
      content: `export const open = () => ${snippet}\n`,
      date: "2026-05-20T17:15:30Z",
      email: "dev.owner@example.com",
      filePath,
      message: "Add entity detail links",
      name: "Dev Owner",
      repoPath,
    });

    const result = collectOwnerEvidence([repoConfig(repoPath)], [suspiciousFile(filePath, 1, snippet)]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: "High",
      email: "dev.owner@example.com",
      evidenceSource: "commit_author",
      name: "Dev Owner",
      rank: 1,
    });
    expect(result.candidates[0]?.evidenceCommits[0]).toMatchObject({
      authorEmail: "dev.owner@example.com",
      authorName: "Dev Owner",
      commitTime: "2026-05-20T17:15:30Z",
      commitTitle: "Add entity detail links",
      evidenceCode: snippet,
      evidenceKind: "exact_line_blame",
      file: filePath,
      line: 1,
      repo: "app",
    });
    expect(result.candidates[0]?.evidenceCommits[0]?.commitId).toMatch(/^[a-f0-9]{40}$/);
    expect(result.missingInfo).toEqual([]);
  });

  it("groups multiple exact-line commits by the same person into one candidate", () => {
    if (!gitAvailable()) return;
    const repoPath = tempRepo("same-person");
    const firstPath = "src/components/EntityLinks.tsx";
    const secondPath = "src/components/EntityDashboard.tsx";
    commitFile({
      content: "export const link = () => navigate(`/entities/${entity.id}/detail`)\n",
      date: "2026-05-20T17:15:30Z",
      email: "dev.owner@example.com",
      filePath: firstPath,
      message: "Add entity links",
      name: "Dev Owner",
      repoPath,
    });
    commitFile({
      content: "export const link = () => to(`/entities/${item.entityId}/detail`)\n",
      date: "2026-05-21T17:15:30Z",
      email: "dev.owner@example.com",
      filePath: secondPath,
      message: "Add dashboard entity links",
      name: "Dev Owner",
      repoPath,
    });

    const result = collectOwnerEvidence(
      [repoConfig(repoPath)],
      [
        suspiciousFile(firstPath, 1, "navigate(`/entities/${entity.id}/detail`)"),
        suspiciousFile(secondPath, 1, "to(`/entities/${item.entityId}/detail`)"),
      ],
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.evidenceCommits).toHaveLength(2);
  });

  it("returns at most two people when exact-line blame points to several authors", () => {
    if (!gitAvailable()) return;
    const repoPath = tempRepo("two-people");
    const files = [
      ["src/A.tsx", "First Owner", "first@example.com"],
      ["src/B.tsx", "Second Owner", "second@example.com"],
      ["src/C.tsx", "Third Owner", "third@example.com"],
    ] as const;
    files.forEach(([filePath, name, email], index) => {
      commitFile({
        content: `export const link${index} = () => navigate(\`/entities/\${entity.id}/detail\`)\n`,
        date: `2026-05-2${index}T17:15:30Z`,
        email,
        filePath,
        message: `Add route ${index}`,
        name,
        repoPath,
      });
    });

    const result = collectOwnerEvidence(
      [repoConfig(repoPath)],
      files.map(([filePath]) => suspiciousFile(filePath, 1, "navigate(`/entities/${entity.id}/detail`)")),
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
  });

  it("keeps file history as weak evidence when no exact line is available", () => {
    if (!gitAvailable()) return;
    const repoPath = tempRepo("weak-history");
    const filePath = "src/components/EntityLinks.tsx";
    commitFile({
      content: "export const open = () => navigate('/entities')\n",
      date: "2026-05-20T17:15:30Z",
      email: "dev.owner@example.com",
      filePath,
      message: "Add entity links",
      name: "Dev Owner",
      repoPath,
    });

    const result = collectOwnerEvidence(
      [repoConfig(repoPath)],
      [
        {
          citations: [{ label: `app:${filePath}`, path: filePath, repo: "app" }],
          path: filePath,
          repo: "app",
          score: 80,
          summary: "Entity route links may be relevant.",
          title: filePath,
          type: "file",
        },
      ],
    );

    expect(result.candidates).toEqual([]);
    expect(result.weakCommits).toHaveLength(1);
    expect(result.weakCommits[0]).toMatchObject({
      authorEmail: "dev.owner@example.com",
      evidenceKind: "file_history",
      file: filePath,
    });
    expect(result.missingInfo.join("\n")).toContain("No exact line blame evidence");
  });

  it("does not warn for unrelated repos without suspicious evidence", () => {
    if (!gitAvailable()) return;
    const repoPath = tempRepo("multi-repo");
    const unrelatedPath = path.join(tmpdir(), `firsttrace-owner-unrelated-${Date.now()}`);
    mkdirSync(unrelatedPath, { recursive: true });
    const filePath = "src/components/EntityLinks.tsx";
    const snippet = "navigate(`/entities/${entity.id}/detail`)";
    commitFile({
      content: `export const open = () => ${snippet}\n`,
      date: "2026-05-20T17:15:30Z",
      email: "dev.owner@example.com",
      filePath,
      message: "Add entity detail links",
      name: "Dev Owner",
      repoPath,
    });

    const result = collectOwnerEvidence(
      [
        repoConfig(repoPath),
        {
          name: "other",
          path: unrelatedPath,
          provider: "local",
          sourceProvider: "local",
        },
      ],
      [suspiciousFile(filePath, 1, snippet)],
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.missingInfo.join("\n")).not.toContain("other");
  });

  it("does not invent a person when git history is missing", () => {
    const repoPath = path.join(tmpdir(), `firsttrace-owner-no-git-${Date.now()}`);
    mkdirSync(path.join(repoPath, "src"), { recursive: true });
    const filePath = "src/EntityLinks.tsx";
    const snippet = "navigate(`/entities/${entity.id}/detail`)";
    writeFileSync(path.join(repoPath, filePath), `${snippet}\n`);

    const result = collectOwnerEvidence([repoConfig(repoPath)], [suspiciousFile(filePath, 1, snippet)]);

    expect(result.candidates).toEqual([]);
    expect(result.missingInfo.join("\n")).toContain("Git history is unavailable");
  });
});
