import type { MessageSubmitResult } from "../types.js";
import { renderJobSummary } from "../worker/render.js";

export const renderMessageSubmitResult = (result: MessageSubmitResult, location?: string, queueProvider = "filesystem") => {
  const runCommand = `npm run firsttrace -- worker run --once --queue ${queueProvider}`;
  const statusCommand = `npm run firsttrace -- worker status --queue ${queueProvider} --job ${result.job.id}`;

  return [
    "# FirstTrace Local Message Submitted",
    renderJobSummary(result.job),
    location ? `Storage: \`${location}\`` : "",
    "Next:",
    `1. Run worker: \`${runCommand}\``,
    `2. Check status: \`${statusCommand}\``,
  ]
    .filter(Boolean)
    .join("\n\n");
};
