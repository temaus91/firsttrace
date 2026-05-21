import { describe, expect, it } from "vitest";
import { matchesOwnerPath, resolveOwners } from "../src/owners.js";

describe("owners", () => {
  it("matches exact paths and glob paths", () => {
    expect(matchesOwnerPath("README.md", "README.md")).toBe(true);
    expect(matchesOwnerPath("docs/**", "docs/PRODUCT_PLAN.md")).toBe(true);
    expect(matchesOwnerPath("src/**/*.ts", "src/core/types.ts")).toBe(true);
  });

  it("resolves owners by path", () => {
    expect(
      resolveOwners("docs/PRODUCT_PLAN.md", [
        { owner: "@docs", path: "docs/**" },
        { owner: "@src", path: "src/**" },
      ]),
    ).toEqual(["@docs"]);
  });
});
