import type { HostedVerifyCheck, HostedVerifyResult } from "../types.js";
import type { HostedAcceptCheck, HostedAcceptResult } from "./accept.js";

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

const acceptChecksText = (checks: HostedAcceptCheck[]) =>
  checks.map((check) => `- ${check.status.toUpperCase()} ${check.name}: ${check.message}`).join("\n");

export const renderHostedAccept = (result: HostedAcceptResult) =>
  [
    "# FirstTrace Hosted Acceptance",
    `Status: ${result.passed ? "PASS" : "FAIL"}`,
    `Backend: \`${result.backend}\``,
    `Base URL: \`${result.baseUrl}\``,
    result.buildRef ? `Build ref: \`${result.buildRef}\`` : "",
    result.queueProvider ? `Queue provider: \`${result.queueProvider}\`` : "",
    `Slack channel: \`${result.channelId}\``,
    result.seedMessageTs ? `Slack seed thread: \`${result.seedMessageTs}\`` : "",
    result.jobId ? `Job: \`${result.jobId}\`` : "",
    result.jobStatus ? `Job status: \`${result.jobStatus}\`` : "",
    result.processingReplyCount !== undefined ? `Processing replies: \`${result.processingReplyCount}\`` : "",
    result.finalReplyCount !== undefined ? `Final replies: \`${result.finalReplyCount}\`` : "",
    result.redelivery?.queueName ? `Redelivery probe queue: \`${result.redelivery.queueName}\`` : "",
    "## Checks",
    acceptChecksText(result.checks),
  ]
    .filter(Boolean)
    .join("\n\n");
