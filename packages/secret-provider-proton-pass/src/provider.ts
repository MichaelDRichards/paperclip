import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  HealthCheck,
  ModuleLog,
  PreparedVersion,
  ProviderClientErrorClass,
  ProviderErrorCode,
  ProviderModule,
  RuntimeContext,
  VaultRuntimeConfig,
} from "./host-types.js";
import { PassCli, PassCliError } from "./pass-cli.js";
import { parsePassReference, parseVaultName } from "./refs.js";

export const PROTON_PASS_PROVIDER_ID = "proton_pass";

/**
 * Deployment settings. These come from the server's process environment, never
 * from stored vault config, because the access token is a bootstrap credential
 * (the same trust model as the AWS provider's IAM credentials).
 */
export interface ProtonPassSettings {
  /** Access token value. Prefer tokenFile in production. */
  token: string | null;
  /** File holding the access token; read at each login so it can be rotated. */
  tokenFile: string | null;
  cliPath: string;
  sessionDir: string;
  timeoutMs: number;
  maxConcurrency: number;
  keyProvider: "fs" | "env" | "keyring";
  encryptionKey: string | null;
  sessionMaxAgeMs: number;
}

export const PROTON_PASS_ENV = {
  token: "PAPERCLIP_PROTON_PASS_TOKEN",
  tokenFile: "PAPERCLIP_PROTON_PASS_TOKEN_FILE",
  cliPath: "PAPERCLIP_PROTON_PASS_CLI",
  sessionDir: "PAPERCLIP_PROTON_PASS_SESSION_DIR",
  timeoutMs: "PAPERCLIP_PROTON_PASS_TIMEOUT_MS",
  maxConcurrency: "PAPERCLIP_PROTON_PASS_MAX_CONCURRENCY",
  keyProvider: "PAPERCLIP_PROTON_PASS_KEY_PROVIDER",
  encryptionKey: "PAPERCLIP_PROTON_PASS_ENCRYPTION_KEY",
} as const;

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

export function readProtonPassSettings(env: NodeJS.ProcessEnv = process.env): ProtonPassSettings {
  const keyProviderRaw = env[PROTON_PASS_ENV.keyProvider]?.trim();
  const keyProvider = keyProviderRaw === "env" || keyProviderRaw === "keyring" ? keyProviderRaw : "fs";
  const paperclipHome = env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  return {
    token: env[PROTON_PASS_ENV.token]?.trim() || null,
    tokenFile: env[PROTON_PASS_ENV.tokenFile]?.trim() ? expandHome(env[PROTON_PASS_ENV.tokenFile]!.trim()) : null,
    cliPath: env[PROTON_PASS_ENV.cliPath]?.trim() || "pass-cli",
    sessionDir: expandHome(
      env[PROTON_PASS_ENV.sessionDir]?.trim() || path.join(expandHome(paperclipHome), "proton-pass-session"),
    ),
    timeoutMs: positiveInt(env[PROTON_PASS_ENV.timeoutMs], 20_000, 120_000),
    maxConcurrency: positiveInt(env[PROTON_PASS_ENV.maxConcurrency], 1, 8),
    keyProvider,
    encryptionKey: env[PROTON_PASS_ENV.encryptionKey]?.trim() || null,
    // pass-cli agent/PAT sessions last 2 hours; re-login 15 minutes early.
    sessionMaxAgeMs: 105 * 60 * 1000,
  };
}

function externalFingerprint(uri: string): string {
  return createHash("sha256").update(`${PROTON_PASS_PROVIDER_ID}:${uri}`).digest("hex");
}

function buildReason(context: RuntimeContext | undefined): string {
  if (!context) return "Paperclip resolving a linked secret";
  return `Paperclip resolving secret "${context.secretKey}" v${context.version} (company ${context.companyId}, secret ${context.secretId})`;
}

export interface CreateProtonPassProviderOptions {
  settings?: ProtonPassSettings;
  SecretProviderClientError: ProviderClientErrorClass;
  log?: ModuleLog;
  /** Injectable for tests. */
  passCli?: PassCli;
}

export function createProtonPassProvider(options: CreateProtonPassProviderOptions): ProviderModule {
  const settings = options.settings ?? readProtonPassSettings();
  const ClientError = options.SecretProviderClientError;
  const id = PROTON_PASS_PROVIDER_ID;

  async function readToken(): Promise<string | null> {
    if (settings.tokenFile) {
      return (await readFile(settings.tokenFile, "utf8")).trim() || null;
    }
    return settings.token;
  }

  const passCli =
    options.passCli ??
    new PassCli({
      cliPath: settings.cliPath,
      sessionDir: settings.sessionDir,
      readToken,
      timeoutMs: settings.timeoutMs,
      maxConcurrency: settings.maxConcurrency,
      keyProvider: settings.keyProvider,
      encryptionKey: settings.encryptionKey,
      sessionMaxAgeMs: settings.sessionMaxAgeMs,
    });

  const tokenConfigured = () => Boolean(settings.token || settings.tokenFile);

  function clientError(code: ProviderErrorCode, operation: string, message: string, cause?: unknown): Error {
    return new ClientError({
      code,
      provider: id,
      operation,
      message,
      rawMessage: cause instanceof PassCliError ? cause.stderr || null : null,
      cause,
    });
  }

  function mapPassCliError(error: unknown, operation: string): Error {
    if (!(error instanceof PassCliError)) {
      return clientError("provider_error", operation, "Proton Pass request failed", error);
    }
    switch (error.kind) {
      case "not_found":
        return clientError("not_found", operation, "Proton Pass vault, item or field was not found; check the reference, including letter case", error);
      case "not_authenticated":
        return clientError(
          "access_denied",
          operation,
          "Proton Pass rejected the access token; check that it is valid, unexpired, and has access to this vault",
          error,
        );
      case "timeout":
        return clientError("provider_unavailable", operation, "Proton Pass did not respond in time", error);
      case "cli_missing":
        return clientError("provider_unavailable", operation, "pass-cli is not installed on the Paperclip server", error);
      default:
        return clientError("provider_error", operation, "Proton Pass request failed", error);
    }
  }

  /** The vault this Paperclip provider vault is scoped to. */
  function scopedVaultName(providerConfig: VaultRuntimeConfig | null | undefined, operation: string): string {
    if (!providerConfig) {
      throw clientError(
        "invalid_request",
        operation,
        "Proton Pass secrets must be linked through a Proton Pass provider vault",
      );
    }
    try {
      return parseVaultName(providerConfig.config.vaultName);
    } catch (error) {
      throw clientError("invalid_request", operation, (error as Error).message, error);
    }
  }

  function parseScopedReference(
    raw: string | null | undefined,
    providerConfig: VaultRuntimeConfig | null | undefined,
    operation: string,
  ) {
    const vaultName = scopedVaultName(providerConfig, operation);
    let reference;
    try {
      reference = parsePassReference(raw ?? "");
    } catch (error) {
      throw clientError("invalid_request", operation, (error as Error).message, error);
    }
    // A single access token may reach several Proton vaults; each Paperclip
    // provider vault only resolves references into its own Proton vault.
    if (reference.vault !== vaultName) {
      throw clientError(
        "access_denied",
        operation,
        `Reference vault "${reference.vault}" is outside this provider vault's Proton vault "${vaultName}"`,
      );
    }
    return reference;
  }

  function readOnly(operation: string): never {
    throw clientError(
      "invalid_request",
      operation,
      "Proton Pass is read-only in Paperclip. Create the item in Proton Pass and link it with a pass:// reference.",
    );
  }

  return {
    id,
    descriptor() {
      return {
        id,
        label: "Proton Pass",
        description:
          "End-to-end encrypted Proton Pass vault, read through pass-cli with a vault-scoped access token. Read-only: link existing items by reference.",
        requiresExternalRef: true,
        supportsManagedValues: false,
        supportsExternalReferences: true,
        supportsExternalValueWrites: false,
        configured: tokenConfigured(),
        vaultConfigFields: [
          {
            key: "vaultName",
            label: "Proton vault name",
            required: true,
            placeholder: "Paperclip",
            help: "Linked references must point into this Proton Pass vault. The access token itself is configured on the server, not here.",
          },
        ],
        externalRefLabel: "Proton Pass reference",
        externalRefPlaceholder: "pass://Paperclip/GitHub/token",
        externalRefHelp: "pass://<vault name>/<item title>/<field>. Item titles must be unique in the vault; duplicates resolve silently to one item.",
      };
    },
    parseVaultConfig(config) {
      const unknownKeys = Object.keys(config).filter((key) => key !== "vaultName");
      if (unknownKeys.length > 0) {
        throw new Error(`Unsupported Proton Pass vault settings: ${unknownKeys.join(", ")}`);
      }
      return { vaultName: parseVaultName(config.vaultName) };
    },
    async validateConfig() {
      const warnings: string[] = [];
      if (!tokenConfigured()) {
        warnings.push(
          `Set ${PROTON_PASS_ENV.tokenFile} (preferred) or ${PROTON_PASS_ENV.token} on the Paperclip server to resolve Proton Pass secrets.`,
        );
      }
      return { ok: warnings.length === 0, warnings };
    },
    async createSecret() {
      return readOnly("createSecret");
    },
    async createVersion() {
      return readOnly("createVersion");
    },
    async linkExternalSecret(input): Promise<PreparedVersion> {
      // Validation only: linking never reads the value, so it is not an
      // audited Proton access. Health checks cover authentication.
      const reference = parseScopedReference(input.externalRef, input.providerConfig, "linkExternalSecret");
      const fingerprint = externalFingerprint(reference.uri);
      return {
        material: { scheme: "proton_pass_reference_v1", uri: reference.uri },
        valueSha256: fingerprint,
        fingerprintSha256: fingerprint,
        externalRef: reference.uri,
        providerVersionRef: null,
      };
    },
    async resolveVersion(input) {
      const raw =
        input.externalRef ??
        (typeof input.material?.uri === "string" ? (input.material.uri as string) : null);
      const reference = parseScopedReference(raw, input.providerConfig, "resolveVersion");
      try {
        return await passCli.readField(reference.uri, buildReason(input.context));
      } catch (error) {
        throw mapPassCliError(error, "resolveVersion");
      }
    },
    async deleteOrArchive() {
      // Never deletes anything in Proton Pass; Paperclip only drops its link.
    },
    async healthCheck(): Promise<HealthCheck> {
      if (!tokenConfigured()) {
        return {
          provider: id,
          status: "warn",
          message: "Proton Pass access token is not configured on this server",
          warnings: [`Set ${PROTON_PASS_ENV.tokenFile} or ${PROTON_PASS_ENV.token}.`],
        };
      }
      if (settings.tokenFile) {
        try {
          await access(settings.tokenFile, fsConstants.R_OK);
        } catch {
          return {
            provider: id,
            status: "error",
            message: `Proton Pass token file is not readable: ${settings.tokenFile}`,
          };
        }
      }
      try {
        const { version } = await passCli.checkSession();
        return {
          provider: id,
          status: "ok",
          message: "Proton Pass session is active",
          details: { cliVersion: version, sessionDir: settings.sessionDir },
        };
      } catch (error) {
        const mapped = mapPassCliError(error, "healthCheck");
        options.log?.warn("Proton Pass health check failed", { message: mapped.message });
        return { provider: id, status: "error", message: mapped.message };
      }
    },
  };
}
