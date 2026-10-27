import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import {
  loadSecretProviderModules,
  parseSecretProviderModuleSpecifiers,
  resetLoadedSecretProviderModulesForTests,
} from "../secrets/provider-modules.js";
import {
  getSecretProvider,
  isKnownSecretProvider,
  listSecretProviders,
  registerSecretProvider,
  resetRegisteredSecretProvidersForTests,
} from "../secrets/provider-registry.js";
import type {
  PreparedSecretVersion,
  SecretProviderModule,
  SecretProviderRuntimeContext,
  SecretProviderVaultRuntimeConfig,
} from "../secrets/types.js";
import { secretService } from "../services/secrets.js";

interface ResolveCall {
  externalRef: string | null;
  context?: SecretProviderRuntimeContext;
  providerConfig?: SecretProviderVaultRuntimeConfig | null;
}

function fakeExternalProvider(
  id = "fake_external",
  values: Record<string, string> = {},
): SecretProviderModule & { resolveCalls: ResolveCall[] } {
  const resolveCalls: ResolveCall[] = [];
  function prepare(externalRef: string): PreparedSecretVersion {
    const fingerprint = createHash("sha256").update(`${id}:${externalRef}`).digest("hex");
    return {
      material: { scheme: "external_reference_v1", provider: id, externalRef },
      valueSha256: fingerprint,
      fingerprintSha256: fingerprint,
      externalRef,
      providerVersionRef: null,
    };
  }
  return {
    id,
    resolveCalls,
    descriptor: () => ({
      id,
      label: "Fake external",
      requiresExternalRef: true,
      supportsManagedValues: false,
      supportsExternalReferences: true,
      configured: true,
      vaultConfigFields: [{ key: "vaultName", label: "Vault", required: true }],
    }),
    parseVaultConfig(config) {
      const vaultName = typeof config.vaultName === "string" ? config.vaultName.trim() : "";
      if (!vaultName) throw new Error("vaultName is required");
      const extra = Object.keys(config).filter((key) => key !== "vaultName" && key !== "leak");
      if (extra.length > 0) throw new Error(`Unknown config keys: ${extra.join(", ")}`);
      return config.leak ? { vaultName, token: String(config.leak) } : { vaultName };
    },
    validateConfig: async () => ({ ok: true, warnings: [] }),
    createSecret: async () => {
      throw new Error("read-only");
    },
    createVersion: async () => {
      throw new Error("read-only");
    },
    linkExternalSecret: async (input) => prepare(input.externalRef.trim()),
    resolveVersion: async (input) => {
      resolveCalls.push({
        externalRef: input.externalRef,
        context: input.context,
        providerConfig: input.providerConfig,
      });
      const value = input.externalRef ? values[input.externalRef] : undefined;
      if (value === undefined) throw new Error("not found");
      return value;
    },
    deleteOrArchive: async () => {},
    healthCheck: async () => ({ provider: id, status: "ok", message: "fake ok" }),
  };
}

describe("secret provider registration", () => {
  afterEach(() => {
    resetRegisteredSecretProvidersForTests();
    resetLoadedSecretProviderModulesForTests();
  });

  it("registers a provider and lists it as non-built-in", () => {
    registerSecretProvider(fakeExternalProvider());
    expect(isKnownSecretProvider("fake_external")).toBe(true);
    expect(getSecretProvider("fake_external").id).toBe("fake_external");
    const descriptors = listSecretProviders();
    expect(descriptors.find((d) => d.id === "fake_external")).toMatchObject({ builtin: false });
    expect(descriptors.find((d) => d.id === "local_encrypted")).toMatchObject({ builtin: true });
  });

  it("rejects invalid, duplicate, built-in, and incomplete providers", () => {
    expect(() => registerSecretProvider(fakeExternalProvider("Bad-Id"))).toThrow(/invalid/);
    expect(() => registerSecretProvider(fakeExternalProvider("local_encrypted"))).toThrow(/built in/);
    registerSecretProvider(fakeExternalProvider());
    expect(() => registerSecretProvider(fakeExternalProvider())).toThrow(/already registered/);
    const incomplete = { ...fakeExternalProvider("half_done"), resolveVersion: undefined };
    expect(() => registerSecretProvider(incomplete as unknown as SecretProviderModule)).toThrow(/resolveVersion/);
    const mismatched = fakeExternalProvider("mismatch_a");
    const descriptor = mismatched.descriptor();
    mismatched.descriptor = () => ({ ...descriptor, id: "mismatch_b" });
    expect(() => registerSecretProvider(mismatched)).toThrow(/different id/);
  });

  it("uses a registered provider as the deployment default only once registered", () => {
    const previous = process.env.PAPERCLIP_SECRETS_PROVIDER;
    try {
      process.env.PAPERCLIP_SECRETS_PROVIDER = "fake_external";
      expect(getConfiguredSecretProvider()).toBe("local_encrypted");
      registerSecretProvider(fakeExternalProvider());
      expect(getConfiguredSecretProvider()).toBe("fake_external");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_SECRETS_PROVIDER;
      else process.env.PAPERCLIP_SECRETS_PROVIDER = previous;
    }
  });

  it("parses module specifiers, ignoring blanks and duplicates", () => {
    expect(parseSecretProviderModuleSpecifiers(" ./a.mjs, ,@scope/b,./a.mjs ")).toEqual(["./a.mjs", "@scope/b"]);
    expect(parseSecretProviderModuleSpecifiers(undefined)).toEqual([]);
  });

  describe("module loading from disk", () => {
    const dir = path.join(os.tmpdir(), `paperclip-provider-modules-${randomUUID()}`);
    beforeAll(() => mkdirSync(dir, { recursive: true }));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function writeModule(name: string, body: string) {
      writeFileSync(path.join(dir, name), body, "utf8");
      return name;
    }

    const minimalProvider = (id: string) => `{
      id: "${id}",
      descriptor: () => ({ id: "${id}", label: "${id}", requiresExternalRef: true, supportsManagedValues: false, supportsExternalReferences: true }),
      validateConfig: async () => ({ ok: true, warnings: [] }),
      createSecret: async () => { throw new api.SecretProviderClientError({ code: "invalid_request", provider: "${id}", operation: "createSecret", message: "read-only" }); },
      createVersion: async () => { throw new Error("read-only"); },
      linkExternalSecret: async ({ externalRef }) => ({ material: { externalRef }, valueSha256: "x", externalRef }),
      resolveVersion: async () => "value",
      deleteOrArchive: async () => {},
      healthCheck: async () => ({ provider: "${id}", status: "ok", message: "ok" }),
    }`;

    it("loads a default-exported registration from a relative path", async () => {
      const file = writeModule(
        "default-export.mjs",
        `export default function register(api) { api.registerSecretProvider(${minimalProvider("disk_default")}); }`,
      );
      const infos: string[] = [];
      const ids = await loadSecretProviderModules({
        specifiers: `./${file}`,
        cwd: dir,
        log: { info: (message) => infos.push(message), warn: () => {} },
      });
      expect(ids).toEqual(["disk_default"]);
      expect(isKnownSecretProvider("disk_default")).toBe(true);
      expect(infos).toContain("Registered secret provider module");
      await expect(getSecretProvider("disk_default").createSecret({ value: "x" })).rejects.toMatchObject({
        name: "SecretProviderClientError",
        code: "invalid_request",
      });
      await expect(loadSecretProviderModules({ specifiers: `./${file}`, cwd: dir })).resolves.toEqual([]);
    });

    it("loads a named registerSecretProviders export from an absolute path", async () => {
      const file = writeModule(
        "named-export.mjs",
        `export async function registerSecretProviders(api) { api.registerSecretProvider(${minimalProvider("disk_named")}); }`,
      );
      await expect(
        loadSecretProviderModules({ specifiers: path.join(dir, file) }),
      ).resolves.toEqual(["disk_named"]);
    });

    it("stops startup with a clear error when a module is missing or malformed", async () => {
      await expect(
        loadSecretProviderModules({ specifiers: "./does-not-exist.mjs", cwd: dir }),
      ).rejects.toThrow(/Failed to load secret provider module "\.\/does-not-exist\.mjs"/);
      const noExport = writeModule("no-export.mjs", "export const nothing = 1;");
      await expect(
        loadSecretProviderModules({ specifiers: `./${noExport}`, cwd: dir }),
      ).rejects.toThrow(/must export a registerSecretProviders/);
      const badProvider = writeModule(
        "bad-provider.mjs",
        `export default (api) => api.registerSecretProvider({ id: "Not Valid" });`,
      );
      await expect(
        loadSecretProviderModules({ specifiers: `./${badProvider}`, cwd: dir }),
      ).rejects.toThrow(/failed to register: Secret provider id "Not Valid" is invalid/);
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("secretService with a registered provider", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-registered-provider-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("registered-secret-provider");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    resetRegisteredSecretProvidersForTests();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Registered Co",
      issuePrefix: `R${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("validates vault config through the module and resolves linked secrets at runtime", async () => {
    const provider = fakeExternalProvider("fake_external", {
      "pass://paperclip-test/GitHub/token": "ghp_runtime_value",
    });
    registerSecretProvider(provider);
    const companyId = await seedCompany();
    const svc = secretService(db);

    await expect(
      svc.createProviderConfig(companyId, { provider: "fake_external", displayName: "Fake", config: {} }),
    ).rejects.toThrow(/Invalid provider vault config/);
    await expect(
      svc.createProviderConfig(companyId, {
        provider: "fake_external",
        displayName: "Fake",
        config: { vaultName: "paperclip-test", leak: "pst_should_not_store" },
      }),
    ).rejects.toThrow(/Invalid provider vault config/);

    const vault = await svc.createProviderConfig(companyId, {
      provider: "fake_external",
      displayName: "Fake test vault",
      config: { vaultName: " paperclip-test " },
    });
    expect(vault.config).toEqual({ vaultName: "paperclip-test" });
    expect(vault.status).toBe("ready");

    const secret = await svc.create(companyId, {
      name: `github-${randomUUID()}`,
      provider: "fake_external",
      providerConfigId: vault.id,
      managedMode: "external_reference",
      externalRef: "pass://paperclip-test/GitHub/token",
    });
    expect(secret.provider).toBe("fake_external");

    const env = {
      GITHUB_TOKEN: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.GITHUB_TOKEN).toBe("ghp_runtime_value");
    expect(provider.resolveCalls).toHaveLength(1);
    expect(provider.resolveCalls[0]).toMatchObject({
      externalRef: "pass://paperclip-test/GitHub/token",
      context: { companyId, secretId: secret.id },
      providerConfig: { id: vault.id, provider: "fake_external", config: { vaultName: "paperclip-test" } },
    });
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(JSON.stringify(events)).not.toContain("ghp_runtime_value");
  });

  it("fails resolution while a provider module is not loaded, and recovers once it is", async () => {
    const provider = fakeExternalProvider("fake_unloaded", {
      "pass://paperclip-test/GitHub/token": "ghp_recovered_value",
    });
    registerSecretProvider(provider);
    const companyId = await seedCompany();
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "fake_unloaded",
      displayName: "Unloaded test vault",
      config: { vaultName: "paperclip-test" },
    });
    const secret = await svc.create(companyId, {
      name: `github-${randomUUID()}`,
      provider: "fake_unloaded",
      providerConfigId: vault.id,
      managedMode: "external_reference",
      externalRef: "pass://paperclip-test/GitHub/token",
    });
    const env = {
      GITHUB_TOKEN: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    const consumer = { consumerType: "agent", consumerId: "agent-1", actorType: "agent", actorId: "agent-1" } as const;

    resetRegisteredSecretProvidersForTests();
    await expect(svc.resolveEnvBindings(companyId, env, consumer)).rejects.toThrow(
      /Unsupported secret provider: fake_unloaded/,
    );
    expect(provider.resolveCalls).toHaveLength(0);
    expect((await svc.getProviderConfigById(vault.id))?.provider).toBe("fake_unloaded");

    registerSecretProvider(provider);
    const resolved = await svc.resolveEnvBindings(companyId, env, consumer);
    expect(resolved.env.GITHUB_TOKEN).toBe("ghp_recovered_value");
  });

  it("rejects secrets for providers that are not registered", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    await expect(
      svc.createProviderConfig(companyId, {
        provider: "not_registered",
        displayName: "Ghost",
        config: {},
      }),
    ).rejects.toThrow(/Unsupported secret provider: not_registered/);
  });
});
