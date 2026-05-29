export type AiSafetyMode = "off" | "redact" | "reject";

export type AiSafetyResult = {
  allowed: boolean;
  blockedReasons: string[];
  redactions: string[];
  report: string;
  warnings: string[];
};

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp; replacement: string }> = [
  { label: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_OPENAI_KEY]" },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  {
    label: "password assignment",
    pattern: /\b(password|passwd|pwd|secret|token)\s*[:=]\s*([^\s,;]+)/gi,
    replacement: "$1=[REDACTED_SECRET]",
  },
  {
    label: "private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
];

const BLOCK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "possible PHI", pattern: /\b(patient|diagnosis|medical record|mrn|hipaa)\b/i },
  { label: "legal or dispute marker", pattern: /\b(attorney-client|lawsuit|legal dispute|subpoena|settlement)\b/i },
  { label: "customer production data marker", pattern: /\b(customer production data|production customer|prod customer|customer pii)\b/i },
  { label: "possible SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
];

const digitsOnly = (value: string) => value.replace(/\D/g, "");

const luhnValid = (digits: string) => {
  let sum = 0;
  let doubleNext = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number.parseInt(digits[index]!, 10);
    if (doubleNext) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleNext = !doubleNext;
  }
  return sum > 0 && sum % 10 === 0;
};

const containsPaymentCard = (report: string) =>
  [...report.matchAll(/\b(?:\d[ -]*?){13,19}\b/g)].some((match) => {
    const digits = digitsOnly(match[0]);
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });

export const aiSafetyModeFromEnv = (env: NodeJS.ProcessEnv = process.env): AiSafetyMode => {
  const mode = (env.FIRSTTRACE_AI_SAFETY_MODE ?? "redact").trim().toLowerCase();
  if (mode === "off" || mode === "redact" || mode === "reject") return mode;
  throw new Error("FIRSTTRACE_AI_SAFETY_MODE must be off, redact, or reject.");
};

export const aiDryRunFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  (env.FIRSTTRACE_AI_DRY_RUN ?? "false").trim().toLowerCase() === "true";

export const sanitizeReportForAi = (report: string, mode: AiSafetyMode = "redact"): AiSafetyResult => {
  if (mode === "off") {
    return { allowed: true, blockedReasons: [], redactions: [], report, warnings: [] };
  }

  let sanitized = report;
  const redactions: string[] = [];
  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(sanitized)) {
      redactions.push(secret.label);
      sanitized = sanitized.replace(secret.pattern, secret.replacement);
    }
    secret.pattern.lastIndex = 0;
  }

  const blockedReasons = BLOCK_PATTERNS.filter((item) => item.pattern.test(report)).map((item) => item.label);
  if (containsPaymentCard(report)) blockedReasons.push("possible PCI payment card");
  if (mode === "reject" && redactions.length) blockedReasons.push(...redactions.map((item) => `sensitive ${item}`));

  const warnings = [
    ...redactions.map((item) => `AI safety redacted ${item}.`),
    ...blockedReasons.map((item) => `AI safety blocked ${item}.`),
  ];

  return {
    allowed: blockedReasons.length === 0,
    blockedReasons,
    redactions,
    report: sanitized,
    warnings,
  };
};
