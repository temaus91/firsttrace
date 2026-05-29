import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type SlackManifestProfile = "slack-minimal";
export type SlackManifestCheckLevel = "ERROR" | "PASS" | "WARN";

export type SlackManifestCheck = {
  level: SlackManifestCheckLevel;
  message: string;
};

const MINIMAL_BOT_SCOPES = new Set(["app_mentions:read", "chat:write"]);
const MINIMAL_BOT_EVENTS = new Set(["app_mention"]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const botScopesFromManifest = (manifest: unknown) => {
  const root = asRecord(manifest);
  const oauth = asRecord(root.oauth_config);
  const scopes = asRecord(oauth.scopes);
  return stringArray(scopes.bot);
};

const botEventsFromManifest = (manifest: unknown) => {
  const root = asRecord(manifest);
  const settings = asRecord(root.settings);
  const subscriptions = asRecord(settings.event_subscriptions);
  return stringArray(subscriptions.bot_events);
};

const requestUrlFromManifest = (manifest: unknown) => {
  const root = asRecord(manifest);
  const settings = asRecord(root.settings);
  const subscriptions = asRecord(settings.event_subscriptions);
  return typeof subscriptions.request_url === "string" ? subscriptions.request_url : undefined;
};

const socketModeEnabledFromManifest = (manifest: unknown) => {
  const root = asRecord(manifest);
  const settings = asRecord(root.settings);
  return settings.socket_mode_enabled === true;
};

const check = (level: SlackManifestCheckLevel, message: string): SlackManifestCheck => ({ level, message });

export const validateSlackManifest = (
  manifest: unknown,
  { profile = "slack-minimal" }: { profile?: SlackManifestProfile } = {},
): SlackManifestCheck[] => {
  if (profile !== "slack-minimal") {
    throw new Error(`Unsupported Slack manifest profile: ${profile}`);
  }

  const scopes = botScopesFromManifest(manifest);
  const events = botEventsFromManifest(manifest);
  const requestUrl = requestUrlFromManifest(manifest);
  const checks: SlackManifestCheck[] = [];

  for (const required of ["app_mentions:read", "chat:write"]) {
    checks.push(
      scopes.includes(required)
        ? check("PASS", `${required} is present.`)
        : check("ERROR", `${required} is required for the slack-minimal profile.`),
    );
  }

  for (const scope of scopes) {
    if (MINIMAL_BOT_SCOPES.has(scope)) continue;
    if (scope === "assistant:write" || scope.includes("admin") || scope.includes("workflow")) {
      checks.push(check("ERROR", `${scope} is not allowed by the slack-minimal profile.`));
      continue;
    }
    if (scope.endsWith(":history") || scope === "reactions:read") {
      checks.push(
        check("WARN", `${scope} enables broader message/reaction access; require explicit opt-in outside slack-minimal.`),
      );
      continue;
    }
    checks.push(check("WARN", `${scope} is outside the slack-minimal profile; verify it is required.`));
  }

  for (const event of events) {
    if (MINIMAL_BOT_EVENTS.has(event)) {
      checks.push(check("PASS", `${event} event is compatible with slack-minimal.`));
      continue;
    }
    if (event.startsWith("message.") || event === "reaction_added") {
      checks.push(check("WARN", `${event} is an advanced trigger and should not be enabled in slack-minimal.`));
      continue;
    }
    checks.push(check("WARN", `${event} event is outside the slack-minimal profile.`));
  }

  if (!events.includes("app_mention")) {
    checks.push(check("ERROR", "app_mention bot event is required for the slack-minimal profile."));
  }

  if (requestUrl) {
    const normalizedUrl = requestUrl.toLowerCase();
    if (
      normalizedUrl.startsWith("http://") ||
      normalizedUrl.includes("localhost") ||
      normalizedUrl.includes("127.0.0.1") ||
      normalizedUrl.includes("[::1]")
    ) {
      checks.push(check("WARN", "Slack request_url should be a public HTTPS hosted endpoint, not a local URL."));
    }
  }

  if (socketModeEnabledFromManifest(manifest)) {
    checks.push(check("WARN", "Socket Mode is not required for hosted FirstTrace deployments and should be off by default."));
  }

  return checks;
};

export const validateSlackManifestFile = ({
  manifestPath,
  profile = "slack-minimal",
}: {
  manifestPath: string;
  profile?: SlackManifestProfile;
}) => validateSlackManifest(parse(readFileSync(manifestPath, "utf8")), { profile });

export const renderSlackManifestChecks = (checks: SlackManifestCheck[]) => {
  const status = checks.some((item) => item.level === "ERROR") ? "FAIL" : "PASS";
  return [
    `Slack manifest validation: ${status}`,
    "",
    ...checks.map((item) => `${item.level} ${item.message}`),
  ].join("\n");
};
