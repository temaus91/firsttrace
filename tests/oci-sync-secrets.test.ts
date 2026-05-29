import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  collectPromptSecretValues,
  loadEnvFileValues,
  parseSyncSecretsArgs,
  secretNamesFromEnv,
} from "../src/oci/sync-secrets.js";

const writableBuffer = () => {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as NodeJS.WriteStream;
  output.isTTY = false;
  return { chunks, output };
};

describe("OCI secret sync CLI helpers", () => {
  it("parses default, prompt, env-file, and help modes", () => {
    expect(parseSyncSecretsArgs([])).toEqual({ help: false, mode: "env" });
    expect(parseSyncSecretsArgs(["--prompt"])).toEqual({ help: false, mode: "prompt" });
    expect(parseSyncSecretsArgs(["--env-file", "secrets.env"])).toEqual({
      envFile: "secrets.env",
      help: false,
      mode: "env-file",
    });
    expect(parseSyncSecretsArgs(["--env-file=secrets.env"])).toEqual({
      envFile: "secrets.env",
      help: false,
      mode: "env-file",
    });
    expect(parseSyncSecretsArgs(["--help"])).toEqual({ help: true, mode: "env" });
  });

  it("rejects unsupported CLI options", () => {
    expect(() => parseSyncSecretsArgs(["--prompt", "--env-file", "secrets.env"])).toThrow(
      "--prompt and --env-file cannot be used together",
    );
    expect(() => parseSyncSecretsArgs(["--unknown"])).toThrow("Unknown option");
  });

  it("uses production runtime secret names by default and honors overrides", () => {
    expect(secretNamesFromEnv({} as NodeJS.ProcessEnv)).toEqual([
      "FIRSTTRACE_RECEIVER_TOKEN",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_INSTALLATION_ID",
    ]);
    expect(
      secretNamesFromEnv({
        OCI_VAULT_SECRET_NAMES: "OPENAI_API_KEY,FIRSTTRACE_INVESTIGATOR",
      } as NodeJS.ProcessEnv),
    ).toEqual(["OPENAI_API_KEY", "FIRSTTRACE_INVESTIGATOR"]);
  });

  it("loads an explicit env file without requiring a source checkout env file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "firsttrace-oci-env-"));
    const envFile = path.join(dir, "secrets.env");
    writeFileSync(envFile, "OPENAI_API_KEY=sk-test\nSLACK_BOT_TOKEN=xoxb-test\n");

    expect(loadEnvFileValues(envFile)).toMatchObject({
      OPENAI_API_KEY: "sk-test",
      SLACK_BOT_TOKEN: "xoxb-test",
    });
  });

  it("collects prompt secrets without writing values to output", async () => {
    const env = {
      OCI_COMPARTMENT_ID: "compartment",
      OCI_REGION: "us-sanjose-1",
      OCI_VAULT_ID: "vault",
      OCI_VAULT_KEY_ID: "key",
    } as NodeJS.ProcessEnv;
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const { chunks, output } = writableBuffer();

    const promise = collectPromptSecretValues(env, { input, output });
    for (const line of [
      "",
      "signing-secret",
      "xoxb-test",
      "12345",
      "-----BEGIN PRIVATE KEY-----",
      "private-body",
      "-----END PRIVATE KEY-----",
      "END",
      "67890",
      "yes",
    ]) {
      await new Promise((resolve) => setImmediate(resolve));
      input.write(`${line}\n`);
    }
    input.end();

    const values = await promise;

    expect(values.FIRSTTRACE_RECEIVER_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(values.SLACK_SIGNING_SECRET).toBe("signing-secret");
    expect(values.SLACK_BOT_TOKEN).toBe("xoxb-test");
    expect(values.GITHUB_APP_ID).toBe("12345");
    expect(values.GITHUB_APP_PRIVATE_KEY).toBe(
      "-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----",
    );
    expect(values.GITHUB_APP_INSTALLATION_ID).toBe("67890");
    const rendered = chunks.join("");
    expect(rendered).toContain("FirstTrace OCI secret setup");
    expect(rendered).toContain("Generated FIRSTTRACE_RECEIVER_TOKEN.");
    expect(rendered).not.toContain("signing-secret");
    expect(rendered).not.toContain("xoxb-test");
    expect(rendered).not.toContain("private-body");
  });
});
