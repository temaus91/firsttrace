import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  renderSlackManifestChecks,
  validateSlackManifest,
  validateSlackManifestFile,
} from "../src/chat/slack/manifest-validator.js";

const manifest = ({
  scopes = ["app_mentions:read", "chat:write"],
  events = ["app_mention"],
}: {
  scopes?: string[];
  events?: string[];
} = {}) => ({
  oauth_config: {
    scopes: {
      bot: scopes,
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: events,
    },
  },
});

const messages = (checks: ReturnType<typeof validateSlackManifest>, level: "ERROR" | "PASS" | "WARN") =>
  checks.filter((item) => item.level === level).map((item) => item.message);

describe("Slack manifest validator", () => {
  it("passes the slack-minimal app mention profile", () => {
    const checks = validateSlackManifest(manifest());

    expect(messages(checks, "ERROR")).toEqual([]);
    expect(messages(checks, "WARN")).toEqual([]);
    expect(messages(checks, "PASS")).toEqual([
      "app_mentions:read is present.",
      "chat:write is present.",
      "app_mention event is compatible with slack-minimal.",
    ]);
  });

  it("errors when required minimal scopes or app mention event are missing", () => {
    const checks = validateSlackManifest(manifest({ scopes: ["app_mentions:read"], events: [] }));

    expect(messages(checks, "ERROR")).toEqual([
      "chat:write is required for the slack-minimal profile.",
      "app_mention bot event is required for the slack-minimal profile.",
    ]);
  });

  it("warns for broad optional history, reaction, and message trigger access", () => {
    const checks = validateSlackManifest(
      manifest({
        scopes: ["app_mentions:read", "chat:write", "channels:history", "reactions:read"],
        events: ["app_mention", "message.channels", "reaction_added"],
      }),
    );

    expect(messages(checks, "ERROR")).toEqual([]);
    expect(messages(checks, "WARN")).toEqual([
      "channels:history enables broader message/reaction access; require explicit opt-in outside slack-minimal.",
      "reactions:read enables broader message/reaction access; require explicit opt-in outside slack-minimal.",
      "message.channels is an advanced trigger and should not be enabled in slack-minimal.",
      "reaction_added is an advanced trigger and should not be enabled in slack-minimal.",
    ]);
  });

  it("errors for assistant, admin, and workflow scopes in the minimal profile", () => {
    const checks = validateSlackManifest(
      manifest({
        scopes: [
          "app_mentions:read",
          "chat:write",
          "assistant:write",
          "admin.conversations:read",
          "workflow.steps:execute",
        ],
      }),
    );

    expect(messages(checks, "ERROR")).toEqual([
      "assistant:write is not allowed by the slack-minimal profile.",
      "admin.conversations:read is not allowed by the slack-minimal profile.",
      "workflow.steps:execute is not allowed by the slack-minimal profile.",
    ]);
  });

  it("renders pass and fail summaries", () => {
    expect(renderSlackManifestChecks(validateSlackManifest(manifest())).split("\n")[0]).toBe(
      "Slack manifest validation: PASS",
    );
    expect(renderSlackManifestChecks(validateSlackManifest(manifest({ events: [] }))).split("\n")[0]).toBe(
      "Slack manifest validation: FAIL",
    );
  });

  it("fails clearly for unsupported profiles", () => {
    expect(() =>
      validateSlackManifest(manifest(), { profile: "slack-broad" as never }),
    ).toThrow("Unsupported Slack manifest profile: slack-broad");
  });

  it("validates YAML manifest files", () => {
    const dir = path.join(tmpdir(), `firsttrace-slack-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, "manifest.yaml");
    writeFileSync(
      manifestPath,
      [
        "oauth_config:",
        "  scopes:",
        "    bot:",
        "      - app_mentions:read",
        "      - chat:write",
        "settings:",
        "  event_subscriptions:",
        "    bot_events:",
        "      - app_mention",
      ].join("\n"),
    );

    expect(validateSlackManifestFile({ manifestPath })).toEqual(validateSlackManifest(manifest()));
  });
});
