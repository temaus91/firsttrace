import { describe, expect, it } from "vitest";
import { countTermHits, extractTerms } from "../src/terms.js";

describe("terms", () => {
  it("removes stop words and keeps useful identifiers", () => {
    expect(extractTerms("The checkout retry fails in resumeSaleId route")).toEqual([
      "checkout",
      "retry",
      "fails",
      "resumesaleid",
      "route",
    ]);
  });

  it("counts repeated term hits case-insensitively", () => {
    expect(countTermHits("README readme deployment", ["readme", "deployment"])).toBe(3);
  });
});
