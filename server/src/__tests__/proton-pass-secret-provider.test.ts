import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { loadSecretProviderModules, resetLoadedSecretProviderModulesForTests } from "../secrets/provider-modules.js";
import { listSecretProviders, resetRegisteredSecretProvidersForTests } from "../secrets/provider-registry.js";
import { SecretProviderClientError, type SecretProviderModule } from "../secrets/types.js";
import { secretService } from "../services/secrets.js";
import { createProtonPassProvider } from "../../../packages/secret-provider-proton-pass/src/index.js";

// The Proton Pass provider package, loaded the way an operator would load it,
// against a fake pass-cli. Proves the package satisfies the host contract.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "../../../packages/secret-provider-proton-pass");
const fakeCli = path.join(packageDir, "src/__tests__/fixtures/fake-pass-cli.mjs");
const TOKEN = "pst_servertest::key";

// Compile-time check that the package's structural types match the host's.
const typeCheck: SecretProviderModule = createProtonPassProvider({
  settings: {
    token: TOKEN,
    tokenFile: null,
    cliPath: fakeCli,
    sessionDir: os.tmpdir(),
    timeoutMs: 1000,
    maxConcurrency: 1,
    keyProvider: "fs",
    encryptionKey: null,
    sessionMaxAgeMs: 1000,
  },
  SecretProviderClientError,
});
void typeCheck;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Proton Pass provider module in the secrets service", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const root = path.join(os.tmpdir(), `paperclip-proton-pass-${randomUUID()}`);
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
    "PAPERCLIP_PROTON_PASS_TOKEN_FILE",
    "PAPERCLIP_PROTON_PASS_CLI",
    "PAPERCLIP_PROTON_PASS_SESSION_DIR",
  ];

  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    for (const key of envKeys) savedEnv[key] = process.env[key];
    try {
      chmodSync(fakeCli, 0o755);
    } catch {
      // Already executable in a checkout (mode tracked in git).
    }
    writeFileSync(path.join(root, "token"), TOKEN, { mode: 0o600 });
    writeFileSync(
      path.join(root, "fake-pass.json"),
      JSON.stringify({ validToken: TOKEN, items: { "pass://Paperclip/GitHub/token": "ghp_from_proton" } }),
    );
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key");
    process.env.PAPERCLIP_PROTON_PASS_TOKEN_FILE = path.join(root, "token");
    process.env.PAPERCLIP_PROTON_PASS_CLI = fakeCli;
    process.env.PAPERCLIP_PROTON_PASS_SESSION_DIR = path.join(root, "session");
    const started = await startEmbeddedPostgresTestDatabase("proton-pass-secret-provider");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companies);
  });

  afterAll(async () => {
    resetRegisteredSecretProvidersForTests();
    resetLoadedSecretProviderModulesForTests();
    await stopDb?.();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("loads from PAPERCLIP_SECRET_PROVIDER_MODULES and resolves a linked item at runtime", async () => {
    await expect(
      loadSecretProviderModules({ specifiers: path.join(packageDir, "src/index.ts") }),
    ).resolves.toEqual(["proton_pass"]);
    expect(listSecretProviders().find((d) => d.id === "proton_pass")).toMatchObject({
      builtin: false,
      configured: true,
      supportsManagedValues: false,
    });

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Proton Co",
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "proton_pass",
      displayName: "Proton (test)",
      config: { vaultName: "Paperclip" },
    });

    await expect(
      svc.create(companyId, {
        name: "Outside vault",
        provider: "proton_pass",
        providerConfigId: vault.id,
        managedMode: "external_reference",
        externalRef: "pass://Personal/Bank/password",
      }),
    ).rejects.toThrow();
    await expect(
      svc.create(companyId, {
        name: "Managed value",
        provider: "proton_pass",
        providerConfigId: vault.id,
        value: "should-not-be-stored",
      }),
    ).rejects.toThrow();

    const secret = await svc.create(companyId, {
      name: "GitHub token",
      key: "GITHUB_TOKEN",
      provider: "proton_pass",
      providerConfigId: vault.id,
      managedMode: "external_reference",
      externalRef: "pass://Paperclip/GitHub/token",
    });
    const env = { GITHUB_TOKEN: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const } };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
    });
    expect(resolved.env.GITHUB_TOKEN).toBe("ghp_from_proton");

    const log = readFileSync(path.join(root, "fake-pass.log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const view = log.find((call: { args: string[] }) => call.args[0] === "item");
    expect(view.reason).toContain(`secret "${secret.key}" v1 (company ${companyId}, secret ${secret.id})`);
    // Paperclip's own secrets never reach pass-cli's environment.
    expect(view.envKeys).not.toContain("PAPERCLIP_SECRETS_MASTER_KEY_FILE");

    const versions = await db.select().from(companySecretVersions);
    expect(JSON.stringify(versions)).not.toContain("ghp_from_proton");
  });
});
