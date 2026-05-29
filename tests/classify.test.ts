import { describe, expect, it } from "vitest";
import { classifyReport } from "../src/classify.js";

describe("classifyReport", () => {
  it("detects bug reports", () => {
    expect(classifyReport("Checkout fails with an exception after retry")).toBe("bug");
  });

  it("detects feature requests", () => {
    expect(classifyReport("Feature request: can we add support for GitHub Issues?")).toBe(
      "feature_request",
    );
  });

  it("detects support questions", () => {
    expect(classifyReport("How do I configure the owners file?")).toBe("support_question");
  });

  it("falls back to unknown", () => {
    expect(classifyReport("README deployment plan")).toBe("unknown");
  });
});
