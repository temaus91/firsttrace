import type { MessageSubmitResult } from "../types.js";
import { renderJobSummary } from "../worker/render.js";

export const renderMessageSubmitResult = (result: MessageSubmitResult, filePath: string) => {
  const runCommand = "npm run firsttrace -- worker run --once";
  const statusCommand = `npm run firsttrace -- worker status --job ${result.job.id}`;

  return [
    "# FirstTrace Local Message Submitted",
    renderJobSummary(result.job),
    `Path: \`${filePath}\``,
    "Next:",
    `1. Run worker: \`${runCommand}\``,
    `2. Check status: \`${statusCommand}\``,
  ].join("\n\n");
};
