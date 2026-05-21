import path from "node:path";
import type { OwnerRule } from "./types.js";

export const toPosixPath = (value: string) =>
  value.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/+$/, "");

const escapeRegex = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const globToRegExp = (glob: string) => {
  const normalized = toPosixPath(glob);
  let pattern = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        pattern += "(?:.*\\/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    pattern += escapeRegex(char ?? "");
  }

  return new RegExp(`${pattern}$`);
};

export const matchesOwnerPath = (rulePath: string, filePath: string) => {
  const rule = toPosixPath(rulePath);
  const file = toPosixPath(filePath);

  if (!rule.includes("*")) {
    return file === rule || file.startsWith(`${rule}/`);
  }

  return globToRegExp(rule).test(file);
};

export const resolveOwners = (filePath: string, rules: OwnerRule[]) => {
  const owners = rules
    .filter((rule) => matchesOwnerPath(rule.path, filePath))
    .sort((a, b) => b.path.length - a.path.length)
    .map((rule) => rule.owner);

  return [...new Set(owners)];
};
