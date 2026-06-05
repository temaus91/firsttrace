import { describe, expect, it } from "vitest";
import {
  ManagerOwnerTriageResultSchema,
  MANAGER_OWNER_TRIAGE_PROFILE,
  parseManagerOwnerTriageResult,
  renderManagerOwnerTriage,
} from "../src/manager-triage.js";
import type { ManagerOwnerTriageResult } from "../src/manager-triage.js";

const managerTriage = (): ManagerOwnerTriageResult => ({
  issue: "Entity detail links fail for IDs containing '/'.",
  likely_owner_candidates: [
    {
      confidence: "High",
      email: "dev.owner@example.com",
      evidence_commits: [
        {
          commit_id: "0123456789abcdef0123456789abcdef01234567",
          commit_time: "2026-05-20T17:15:30Z",
          commit_title: "Add entity detail links",
          evidence_code: "navigate(`/entities/${entity.id}/detail`)",
          file: "src/components/EntityLinks.tsx",
          line: 42,
          repo: "web-app",
          why_relevant: "This inserts a slash-containing entity ID directly into the route path.",
        },
        {
          commit_id: "abcdef0123456789abcdef0123456789abcdef01",
          commit_time: "2026-05-21T09:10:11Z",
          commit_title: "Reuse detail link in dashboard",
          evidence_code: "to={`/entities/${item.entityId}/detail`}",
          file: "src/components/EntityDashboard.tsx",
          line: 17,
          repo: "web-app",
          why_relevant: "This repeats the same raw route interpolation pattern.",
        },
      ],
      evidence_source: "commit_author",
      name: "Dev Owner",
      rank: 1,
      reason: "Exact code and commit evidence point to the raw route interpolation owner.",
    },
  ],
  likely_root_cause: "Entity IDs are inserted directly into route paths without URL encoding.",
  missing_info: [],
  recommended_manager_action: "Route first to Dev Owner and ask for route encoding verification.",
  title: "Bug Triage",
  user_impact: "Users cannot reliably open entity detail pages from affected links.",
});

describe("manager owner triage contract", () => {
  it("exports the built-in manager owner triage profile name", () => {
    expect(MANAGER_OWNER_TRIAGE_PROFILE).toBe("manager-owner-triage");
  });

  it("validates a manager triage payload and groups multiple commits under one person", () => {
    const parsed = parseManagerOwnerTriageResult(managerTriage());

    expect(parsed.likely_owner_candidates).toHaveLength(1);
    expect(parsed.likely_owner_candidates[0]?.evidence_commits).toHaveLength(2);
  });

  it("rejects more than two owner candidates", () => {
    const payload = managerTriage();
    payload.likely_owner_candidates = [
      payload.likely_owner_candidates[0]!,
      { ...payload.likely_owner_candidates[0]!, email: "two@example.com", name: "Second Owner", rank: 2 },
      { ...payload.likely_owner_candidates[0]!, email: "three@example.com", name: "Third Owner", rank: 3 },
    ];

    expect(() => ManagerOwnerTriageResultSchema.parse(payload)).toThrow();
  });

  it("rejects duplicate people instead of allowing duplicate candidate slots", () => {
    const payload = managerTriage();
    payload.likely_owner_candidates = [
      payload.likely_owner_candidates[0]!,
      { ...payload.likely_owner_candidates[0]!, rank: 2 },
    ];

    expect(() => ManagerOwnerTriageResultSchema.parse(payload)).toThrow(/Duplicate owner candidates/);
  });

  it("rejects candidates without evidence commits", () => {
    const payload = managerTriage();
    payload.likely_owner_candidates[0] = {
      ...payload.likely_owner_candidates[0]!,
      evidence_commits: [],
    };

    expect(() => ManagerOwnerTriageResultSchema.parse(payload)).toThrow();
  });

  it("renders stable manager markdown", () => {
    expect(renderManagerOwnerTriage(managerTriage())).toMatchInlineSnapshot(`
      "Bug Triage

      Issue
      Entity detail links fail for IDs containing '/'.

      Likely Owner Candidate

      1. Dev Owner
         Email: dev.owner@example.com
         Confidence: High
         Reason: Exact code and commit evidence point to the raw route interpolation owner.
         Evidence source: commit_author

         Evidence commits:
         - Commit: 0123456789abcdef0123456789abcdef01234567
           Commit time: 2026-05-20T17:15:30Z
           Commit title: Add entity detail links
           Repo: web-app
           File: src/components/EntityLinks.tsx
           Line: 42
           Evidence: navigate(\`/entities/\${entity.id}/detail\`)
           Why relevant: This inserts a slash-containing entity ID directly into the route path.
         - Commit: abcdef0123456789abcdef0123456789abcdef01
           Commit time: 2026-05-21T09:10:11Z
           Commit title: Reuse detail link in dashboard
           Repo: web-app
           File: src/components/EntityDashboard.tsx
           Line: 17
           Evidence: to={\`/entities/\${item.entityId}/detail\`}
           Why relevant: This repeats the same raw route interpolation pattern.

      Likely Root Cause
      Entity IDs are inserted directly into route paths without URL encoding.

      User Impact
      Users cannot reliably open entity detail pages from affected links.

      Recommended Manager Action
      Route first to Dev Owner and ask for route encoding verification."
    `);
  });

  it("renders missing info when no person-level evidence is available", () => {
    const payload = {
      ...managerTriage(),
      likely_owner_candidates: [],
      missing_info: ["Collect Git blame for src/components/EntityLinks.tsx:42."],
      recommended_manager_action: "Do not assign a person yet.",
    };

    const rendered = renderManagerOwnerTriage(payload);

    expect(rendered).toContain("Likely Owner Candidates");
    expect(rendered).toContain("Recommended Manager Action\nDo not assign a person yet.");
    expect(rendered).toContain("Missing Info\n- Collect Git blame for src/components/EntityLinks.tsx:42.");
  });
});
