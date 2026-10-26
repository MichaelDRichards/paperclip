/**
 * Structural copies of the Paperclip secret provider module contract
 * (server/src/secrets/types.ts). Kept local so this package has no build-time
 * dependency on the server; the server checks required methods when the module
 * registers, and the server test suite registers this package directly.
 */

export type ProviderErrorCode =
  | "access_denied"
  | "throttled"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "provider_unavailable"
  | "provider_error";

export interface ProviderClientErrorOptions {
  code: ProviderErrorCode;
  provider: string;
  operation: string;
  message: string;
  status?: number;
  rawMessage?: string | null;
  cause?: unknown;
}

export type ProviderClientErrorClass = new (options: ProviderClientErrorOptions) => Error;

export interface VaultConfigField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  requiresExternalRef: boolean;
  supportsManagedValues?: boolean;
  supportsExternalReferences?: boolean;
  supportsExternalValueWrites?: boolean;
  configured?: boolean;
  description?: string;
  vaultConfigFields?: VaultConfigField[];
  externalRefLabel?: string;
  externalRefPlaceholder?: string;
  externalRefHelp?: string;
}

export interface PreparedVersion {
  material: Record<string, unknown>;
  valueSha256: string;
  fingerprintSha256?: string;
  externalRef: string | null;
  providerVersionRef?: string | null;
}

export interface RuntimeContext {
  companyId: string;
  secretId: string;
  secretKey: string;
  version: number;
}

export interface WriteContext {
  companyId: string;
  secretKey: string;
  secretName: string;
  version: number;
}

export interface VaultRuntimeConfig {
  id: string;
  provider: string;
  status: string;
  config: Record<string, unknown>;
}

export interface HealthCheck {
  provider: string;
  status: "ok" | "warn" | "error";
  message: string;
  warnings?: string[];
  details?: Record<string, unknown>;
}

export interface ProviderModule {
  id: string;
  descriptor(): ProviderDescriptor;
  parseVaultConfig?(config: Record<string, unknown>): Record<string, unknown>;
  validateConfig(input?: {
    providerConfig?: VaultRuntimeConfig | null;
  }): Promise<{ ok: boolean; warnings: string[] }>;
  createSecret(input: {
    value: string;
    externalRef?: string | null;
    context?: WriteContext;
    providerConfig?: VaultRuntimeConfig | null;
  }): Promise<PreparedVersion>;
  createVersion(input: {
    value: string;
    externalRef?: string | null;
    context?: WriteContext;
    providerConfig?: VaultRuntimeConfig | null;
  }): Promise<PreparedVersion>;
  linkExternalSecret(input: {
    externalRef: string;
    providerVersionRef?: string | null;
    context?: WriteContext;
    providerConfig?: VaultRuntimeConfig | null;
  }): Promise<PreparedVersion>;
  resolveVersion(input: {
    material: Record<string, unknown>;
    externalRef: string | null;
    providerVersionRef?: string | null;
    context?: RuntimeContext;
    providerConfig?: VaultRuntimeConfig | null;
  }): Promise<string>;
  deleteOrArchive(input: {
    material?: Record<string, unknown> | null;
    externalRef: string | null;
    context?: WriteContext;
    mode: "archive" | "delete";
    providerConfig?: VaultRuntimeConfig | null;
  }): Promise<void>;
  healthCheck(input?: {
    providerConfig?: VaultRuntimeConfig | null;
  }): Promise<HealthCheck>;
}

export interface ModuleLog {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface ModuleApi {
  registerSecretProvider(module: ProviderModule): void;
  SecretProviderClientError: ProviderClientErrorClass;
  log: ModuleLog;
}
