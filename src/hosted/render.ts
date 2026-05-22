import type { HostedVerifyCheck, HostedVerifyResult } from "../types.js";

const statusLabel = (status: HostedVerifyCheck["status"]) => status.toUpperCase();

const checksText = (checks: HostedVerifyCheck[]) =>
  checks
    .map((check) => {
      const required = check.required ? "required" : "optional";
      return `- ${statusLabel(check.status)} ${check.name} (${required}): ${check.message}`;
    })
    .join("\n");

export const renderHostedVerify = (result: HostedVerifyResult) =>
  [
    "# FirstTrace Hosted Verification",
    `Status: ${result.passed ? "PASS" : "FAIL"}`,
    `Queue provider: \`${result.queueProvider}\``,
    `Config: \`${result.configPath}\``,
    result.channelId ? `Slack channel: \`${result.channelName ?? result.channelId}\` (${result.channelId})` : "",
    result.job ? `Job: \`${result.job.id}\`` : "",
    result.job ? `Job status: \`${result.job.status}\`` : "",
    result.job?.result ? `Result component: \`${result.job.result.likelyComponent}\`` : "",
    result.job?.result?.likelyOwners.length
      ? `Result owners: ${result.job.result.likelyOwners.map((owner) => `\`${owner}\``).join(", ")}`
      : "",
    result.slackReplyText ? `Captured Slack reply: ${result.slackReplyText.split("\n")[0]}` : "",
    "## Checks",
    checksText(result.checks),
  ]
    .filter(Boolean)
    .join("\n\n");
