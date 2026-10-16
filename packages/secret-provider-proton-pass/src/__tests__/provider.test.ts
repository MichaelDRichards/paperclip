import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerSecretProviders, {
  createProtonPassProvider,
  parsePassReference,
  readProtonPassSettings,
  type ProtonPassSettings,
} from "../index.js";
import type { ModuleApi, ProviderClientErrorOptions, ProviderModule, VaultRuntimeConfig } from "../host-types.js";

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pass-cli.mjs");
const TOKEN = "pst_testtoken::testkey";

class TestClientError extends Error {
  readonly code: string;
  readonly provider: string;
  readonly operation: string;
  readonly rawMessage: string | null;
  constructor(options: ProviderClientErrorOptions) {
    super(options.message);
    this.name = "SecretProviderClientError";
    this.code = options.code;
    this.provider = options.provider;
    this.operation = options.operation;
    this.rawMessage = options.rawMessage ?? null;
  }
}

const vault = (vaultName = "Paperclip"): VaultRuntimeConfig => ({
  id: "vault-1",
  provider: "proton_pass",
  status: "ready",
  config: { vaultName },
});

const context = { companyId: "company-1", secretId: "secret-1", secretKey: "GITHUB_TOKEN", version: 3 };

interface FakeConfig {
  validToken: string;
  items: Record<string, string>;
  expireAfterReads?: number;
  sleepMs?: number;
}

describe("Proton Pass references", () => {
  it("parses and normalizes valid references", () => {
    expect(parsePassReference(" pass://Paperclip/GitHub/token ")).toMatchObject({
      vault: "Paperclip",
      item: "GitHub",
      field: "token",
      uri: "pass://Paperclip/GitHub/token",
    });
    expect(parsePassReference("pass://My Vault/Deploy Targets/Staging.password").field).toBe("Staging.password");
    expect(parsePassReference("pass://Work/GitHub/totp?totp=uri").uri).toBe("pass://Work/GitHub/totp?totp=uri");
  });

  it("rejects malformed references", () => {
    for (const bad of [
      "",
      "https://Paperclip/GitHub/token",
      "pass://Paperclip/GitHub",
      "pass://Paperclip/GitHub/",
      "pass://Paperclip//token",
      "pass://Paperclip/Git/Hub/token",
      "pass://Paperclip/GitHub/token?show=all",
      "pass://Paperclip/GitHub/tok\nen",
      "pass://Paperclip/ GitHub/token",
    ]) {
      expect(() => parsePassReference(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("Proton Pass provider", () => {
  let root: string;
  let settings: ProtonPassSettings;
  let provider: ProviderModule;

  function writeFake(config: FakeConfig) {
    writeFileSync(path.join(root, "fake-pass.json"), JSON.stringify(config));
  }

  function calls(): Array<{ args: string[]; envKeys: string[]; reason: string | null; keyProvider: string | null; at: number }> {
    const file = path.join(root, "fake-pass.log.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "proton-pass-provider-"));
    try {
      chmodSync(FAKE_CLI, 0o755);
    } catch {
      // Already executable in a checkout (mode tracked in git).
    }
    const tokenFile = path.join(root, "token");
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    settings = {
      ...readProtonPassSettings({}),
      token: null,
      tokenFile,
      cliPath: FAKE_CLI,
      sessionDir: path.join(root, "session"),
      timeoutMs: 5_000,
    };
    writeFake({
      validToken: TOKEN,
      items: {
        "pass://Paperclip/GitHub/token": "ghp_value_with_trailing_space ",
        "pass://Paperclip/Multi/note": "line one\nline two",
      },
    });
    provider = createProtonPassProvider({ settings, SecretProviderClientError: TestClientError });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("describes itself as a read-only external-reference provider", () => {
    expect(provider.descriptor()).toMatchObject({
      id: "proton_pass",
      supportsManagedValues: false,
      supportsExternalReferences: true,
      configured: true,
      vaultConfigFields: [expect.objectContaining({ key: "vaultName", required: true })],
    });
  });

  it("validates vault config and rejects anything but vaultName", () => {
    expect(provider.parseVaultConfig!({ vaultName: " Paperclip " })).toEqual({ vaultName: "Paperclip" });
    expect(() => provider.parseVaultConfig!({})).toThrow(/vaultName is required/);
    expect(() => provider.parseVaultConfig!({ vaultName: "a/b" })).toThrow(/slashes/);
    expect(() => provider.parseVaultConfig!({ vaultName: "Paperclip", token: TOKEN })).toThrow(/Unsupported/);
  });

  it("links references into its own vault without contacting Proton", async () => {
    const prepared = await provider.linkExternalSecret({
      externalRef: "pass://Paperclip/GitHub/token",
      providerConfig: vault(),
    });
    expect(prepared.externalRef).toBe("pass://Paperclip/GitHub/token");
    expect(prepared.material).toEqual({ scheme: "proton_pass_reference_v1", uri: "pass://Paperclip/GitHub/token" });
    expect(calls()).toHaveLength(0);

    await expect(
      provider.linkExternalSecret({ externalRef: "pass://Personal/Bank/password", providerConfig: vault() }),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(
      provider.linkExternalSecret({ externalRef: "pass://Paperclip/GitHub/token", providerConfig: null }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      provider.linkExternalSecret({ externalRef: "nope", providerConfig: vault() }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses to create or rotate managed values", async () => {
    await expect(provider.createSecret({ value: "x", providerConfig: vault() })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/read-only/),
    });
    await expect(provider.createVersion({ value: "x", providerConfig: vault() })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("logs in once, resolves values exactly, and sends an audited reason", async () => {
    const value = await provider.resolveVersion({
      material: {},
      externalRef: "pass://Paperclip/GitHub/token",
      context,
      providerConfig: vault(),
    });
    expect(value).toBe("ghp_value_with_trailing_space ");
    const multi = await provider.resolveVersion({
      material: { uri: "pass://Paperclip/Multi/note" },
      externalRef: null,
      context,
      providerConfig: vault(),
    });
    expect(multi).toBe("line one\nline two");

    const log = calls();
    expect(log.map((call) => call.args[0])).toEqual(["logout", "login", "item", "item"]);
    const view = log.find((call) => call.args[0] === "item")!;
    expect(view.args).toEqual(["item", "view", "--", "pass://Paperclip/GitHub/token"]);
    expect(view.reason).toBe(
      'Paperclip resolving secret "GITHUB_TOKEN" v3 (company company-1, secret secret-1)',
    );
    expect(view.keyProvider).toBe("fs");
    // The token never appears in argv, and nothing from the server env leaks in.
    expect(JSON.stringify(log.map((call) => call.args))).not.toContain(TOKEN);
    for (const call of log) {
      for (const key of call.envKeys) {
        expect(
          key.startsWith("PROTON_PASS_") || ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].includes(key) || /proxy|SSL_CERT/i.test(key),
          key,
        ).toBe(true);
      }
    }
    expect(log.find((call) => call.args[0] === "login")!.envKeys).toContain("PROTON_PASS_PERSONAL_ACCESS_TOKEN");
    expect(view.envKeys).not.toContain("PROTON_PASS_PERSONAL_ACCESS_TOKEN");
  });

  it("re-logs in once and retries when the session has expired", async () => {
    writeFake({ validToken: TOKEN, items: { "pass://Paperclip/GitHub/token": "v" }, expireAfterReads: 1 });
    const read = () =>
      provider.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() });
    await expect(read()).resolves.toBe("v");
    await expect(read()).resolves.toBe("v");
    const commands = calls().map((call) => call.args.slice(0, 2).join(" "));
    expect(commands).toEqual(["logout --force", "login", "item view", "item view", "logout --force", "login", "item view"]);
  });

  it("reuses a session left by a previous process for the same token", async () => {
    await provider.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() });
    const restarted = createProtonPassProvider({ settings, SecretProviderClientError: TestClientError });
    await restarted.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() });
    expect(calls().filter((call) => call.args[0] === "login")).toHaveLength(1);
  });

  it("logs in again when the token file is rotated", async () => {
    await provider.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() });
    const rotated = "pst_rotated::newkey";
    writeFake({ validToken: rotated, items: { "pass://Paperclip/GitHub/token": "after-rotation" } });
    writeFileSync(settings.tokenFile!, rotated);
    await expect(
      provider.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() }),
    ).resolves.toBe("after-rotation");
    expect(calls().filter((call) => call.args[0] === "login")).toHaveLength(2);
  });

  it("maps failures to client error codes without leaking the token", async () => {
    await expect(
      provider.resolveVersion({ material: {}, externalRef: "pass://Paperclip/Missing/token", context, providerConfig: vault() }),
    ).rejects.toMatchObject({ code: "not_found" });

    writeFileSync(settings.tokenFile!, "pst_wrong::key");
    const wrongToken = createProtonPassProvider({
      settings: { ...settings, sessionDir: path.join(root, "session-wrong") },
      SecretProviderClientError: TestClientError,
    });
    const failure = await wrongToken
      .resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() })
      .then(
        () => null,
        (error: unknown) => error as TestClientError,
      );
    expect(failure).toBeInstanceOf(TestClientError);
    if (!failure) throw new Error("expected a failure");
    expect(failure.code).toBe("access_denied");
    expect(JSON.stringify({ message: failure.message, raw: failure.rawMessage })).not.toContain("pst_wrong");

    const missingCli = createProtonPassProvider({
      settings: { ...settings, cliPath: path.join(root, "no-such-pass-cli") },
      SecretProviderClientError: TestClientError,
    });
    await expect(
      missingCli.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("kills pass-cli at the timeout and keeps later calls working", async () => {
    writeFake({ validToken: TOKEN, items: { "pass://Paperclip/GitHub/token": "v" }, sleepMs: 3_000 });
    const slow = createProtonPassProvider({
      settings: { ...settings, timeoutMs: 400 },
      SecretProviderClientError: TestClientError,
    });
    const started = Date.now();
    await expect(
      slow.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(Date.now() - started).toBeLessThan(2_500);

    writeFake({ validToken: TOKEN, items: { "pass://Paperclip/GitHub/token": "v" } });
    await expect(
      slow.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() }),
    ).resolves.toBe("v");
  });

  it("serializes concurrent resolutions behind a single login", async () => {
    writeFake({ validToken: TOKEN, items: { "pass://Paperclip/GitHub/token": "v" }, sleepMs: 150 });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        provider.resolveVersion({ material: {}, externalRef: "pass://Paperclip/GitHub/token", context, providerConfig: vault() }),
      ),
    );
    expect(results).toEqual(["v", "v", "v", "v"]);
    const log = calls();
    expect(log.filter((call) => call.args[0] === "login")).toHaveLength(1);
    const views = log.filter((call) => call.args[0] === "item").map((call) => call.at);
    for (let index = 1; index < views.length; index += 1) {
      expect(views[index]! - views[index - 1]!).toBeGreaterThanOrEqual(140);
    }
  });

  it("reports health from the CLI and the session", async () => {
    await expect(provider.healthCheck()).resolves.toMatchObject({
      status: "ok",
      details: { cliVersion: "Proton Pass CLI 2.4.2 (fake)" },
    });
    const unconfigured = createProtonPassProvider({
      settings: { ...settings, tokenFile: null, token: null },
      SecretProviderClientError: TestClientError,
    });
    await expect(unconfigured.healthCheck()).resolves.toMatchObject({ status: "warn" });
    expect(unconfigured.descriptor().configured).toBe(false);
    await expect(unconfigured.validateConfig()).resolves.toMatchObject({ ok: false });
  });

  it("registers through the module entry point", () => {
    const registered: ProviderModule[] = [];
    const warnings: string[] = [];
    const api: ModuleApi = {
      registerSecretProvider: (module) => registered.push(module),
      SecretProviderClientError: TestClientError,
      log: { info: () => {}, warn: (message) => warnings.push(message) },
    };
    const previousToken = process.env.PAPERCLIP_PROTON_PASS_TOKEN;
    const previousFile = process.env.PAPERCLIP_PROTON_PASS_TOKEN_FILE;
    delete process.env.PAPERCLIP_PROTON_PASS_TOKEN;
    delete process.env.PAPERCLIP_PROTON_PASS_TOKEN_FILE;
    try {
      registerSecretProviders(api);
    } finally {
      if (previousToken !== undefined) process.env.PAPERCLIP_PROTON_PASS_TOKEN = previousToken;
      if (previousFile !== undefined) process.env.PAPERCLIP_PROTON_PASS_TOKEN_FILE = previousFile;
    }
    expect(registered.map((module) => module.id)).toEqual(["proton_pass"]);
    expect(warnings[0]).toMatch(/without an access token/);
  });
});
