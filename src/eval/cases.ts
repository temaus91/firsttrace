import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { Classification, EvalCase } from "../types.js";

const CLASSIFICATIONS = new Set<Classification>(["bug", "feature_request", "support_question", "unknown"]);

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const optionalString = (value: unknown, label: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const stringArray = (value: unknown, label: string, fallback: string[] = []) => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
};

const classification = (value: unknown, label: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CLASSIFICATIONS.has(value as Classification)) {
    throw new Error(`${label} must be one of: ${[...CLASSIFICATIONS].join(", ")}.`);
  }
  return value as Classification;
};

export const loadEvalCases = (casesPath: string): EvalCase[] => {
  const resolvedCasesPath = path.resolve(casesPath);
  if (!existsSync(resolvedCasesPath)) {
    throw new Error(`Eval cases file not found: ${resolvedCasesPath}`);
  }

  const raw = parse(readFileSync(resolvedCasesPath, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Eval cases file must be a non-empty YAML array.");
  }

  return raw.map((caseValue, index) => {
    const item = asObject(caseValue, `cases[${index}]`);
    const id = optionalString(item.id, `cases[${index}].id`);
    const report = optionalString(item.report, `cases[${index}].report`);
    if (!id) throw new Error(`cases[${index}].id is required.`);
    if (!report) throw new Error(`cases[${index}].report is required.`);
    const expectedClassification = classification(
      item.expected_classification,
      `cases[${index}].expected_classification`,
    );
    const expectedComponent = optionalString(item.expected_component, `cases[${index}].expected_component`);
    const expectedFiles = stringArray(item.expected_files, `cases[${index}].expected_files`);
    const expectedOwners = stringArray(item.expected_owners, `cases[${index}].expected_owners`);
    if (
      expectedClassification === undefined &&
      expectedComponent === undefined &&
      !expectedFiles.length &&
      !expectedOwners.length
    ) {
      throw new Error(`cases[${index}] must define at least one expected result field.`);
    }

    return {
      expectedClassification,
      expectedComponent,
      expectedFiles,
      expectedOwners,
      id,
      notes: optionalString(item.notes, `cases[${index}].notes`),
      report,
    };
  });
};
