import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

const loadIfPresent = (filePath: string) => {
  if (!existsSync(filePath)) return;
  loadDotenv({ path: filePath, quiet: true });
};

export const loadLocalEnv = (cwd = process.cwd()) => {
  loadIfPresent(path.resolve(cwd, ".env.local"));
  loadIfPresent(path.resolve(cwd, ".env"));
};
