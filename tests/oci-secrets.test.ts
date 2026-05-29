import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOciVaultSecretsIntoEnv, ociVaultSecretsRequiredFromEnv } from "../src/oci/secrets.js";

vi.mock("oci-common", () => ({
  ConfigFileAuthenticationDetailsProvider: class ConfigFileAuthenticationDetailsProvider {},
  ResourcePrincipalAuthenticationDetailsProvider: {
    builder: () => ({}),
  },
}));

vi.mock("oci-secrets", () => ({
  requests: {
    GetSecretBundleByNameRequest: {
      Stage: {
        Current: "CURRENT",
      },
    },
  },
  SecretsClient: class SecretsClient {
    regionId?: string;

    async getSecretBundleByName({ secretName }: { secretName: string }) {
      if (secretName === "MISSING") {
        const error = new Error("missing") as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }
      return {
        secretBundle: {
          secretBundleContent: {
            content: Buffer.from(`${secretName.toLowerCase()}-value`, "utf8").toString("base64"),
          },
        },
      };
    }
  },
}));

describe("OCI Vault secret loading", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to requiring configured Vault secrets", () => {
    expect(ociVaultSecretsRequiredFromEnv({} as NodeJS.ProcessEnv)).toBe(true);
    expect(ociVaultSecretsRequiredFromEnv({ OCI_VAULT_SECRETS_REQUIRED: "false" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("fails closed on missing Vault secrets by default", async () => {
    await expect(
      loadOciVaultSecretsIntoEnv({
        OCI_RESOURCE_PRINCIPAL_VERSION: "2.2",
        OCI_VAULT_ID: "vault",
        OCI_VAULT_SECRET_NAMES: "PRESENT,MISSING",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow("OCI Vault secret MISSING is missing");
  });

  it("warns and continues when missing Vault secrets are optional", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = {
      OCI_RESOURCE_PRINCIPAL_VERSION: "2.2",
      OCI_VAULT_ID: "vault",
      OCI_VAULT_SECRET_NAMES: "PRESENT,MISSING",
      OCI_VAULT_SECRETS_REQUIRED: "false",
    } as NodeJS.ProcessEnv;

    await expect(loadOciVaultSecretsIntoEnv(env)).resolves.toEqual(["PRESENT"]);

    expect(env.PRESENT).toBe("present-value");
    expect(env.MISSING).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "WARN Missing OCI Vault secret MISSING; continuing because OCI_VAULT_SECRETS_REQUIRED=false.",
    );
  });
});
