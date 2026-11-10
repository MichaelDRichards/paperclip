import {
  SECRET_PROVIDER_ID_PATTERN,
  isBuiltinSecretProvider,
  type SecretProvider,
  type SecretProviderDescriptor,
} from "@paperclipai/shared";
import { awsSecretsManagerProvider } from "./aws-secrets-manager-provider.js";
import { localEncryptedProvider } from "./local-encrypted-provider.js";
import {
  gcpSecretManagerProvider,
  vaultProvider,
} from "./external-stub-providers.js";
import type { SecretProviderHealthCheck, SecretProviderModule } from "./types.js";
import { unprocessable } from "../errors.js";

const builtinProviders: SecretProviderModule[] = [
  localEncryptedProvider,
  awsSecretsManagerProvider,
  gcpSecretManagerProvider,
  vaultProvider,
];

const builtinProviderById = new Map<SecretProvider, SecretProviderModule>(
  builtinProviders.map((provider) => [provider.id, provider]),
);

const registeredProviderById = new Map<SecretProvider, SecretProviderModule>();

const REQUIRED_MODULE_METHODS = [
  "descriptor",
  "validateConfig",
  "createSecret",
  "createVersion",
  "linkExternalSecret",
  "resolveVersion",
  "deleteOrArchive",
  "healthCheck",
] as const;

export function registerSecretProvider(module: SecretProviderModule): void {
  const id = typeof module?.id === "string" ? module.id : "";
  if (!SECRET_PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `Secret provider id "${id}" is invalid; ids must match ${SECRET_PROVIDER_ID_PATTERN.source}`,
    );
  }
  if (isBuiltinSecretProvider(id)) {
    throw new Error(`Secret provider "${id}" is built in and cannot be replaced by a registered module`);
  }
  if (registeredProviderById.has(id)) {
    throw new Error(`Secret provider "${id}" is already registered`);
  }
  for (const method of REQUIRED_MODULE_METHODS) {
    if (typeof module[method] !== "function") {
      throw new Error(`Secret provider "${id}" is missing required method ${method}()`);
    }
  }
  const descriptor = module.descriptor();
  if (descriptor.id !== id) {
    throw new Error(`Secret provider "${id}" descriptor reports a different id ("${descriptor.id}")`);
  }
  registeredProviderById.set(id, module);
}

export function resetRegisteredSecretProvidersForTests(): void {
  registeredProviderById.clear();
}

export function isRegisteredSecretProvider(id: string): boolean {
  return registeredProviderById.has(id);
}

export function isKnownSecretProvider(id: string): boolean {
  return builtinProviderById.has(id) || registeredProviderById.has(id);
}

export function getSecretProvider(id: SecretProvider): SecretProviderModule {
  const provider = builtinProviderById.get(id) ?? registeredProviderById.get(id);
  if (!provider) throw unprocessable(`Unsupported secret provider: ${id}`);
  return provider;
}

function allProviders(): SecretProviderModule[] {
  return [...builtinProviders, ...registeredProviderById.values()];
}

export function listSecretProviders(): SecretProviderDescriptor[] {
  return allProviders().map((provider) => ({
    ...provider.descriptor(),
    builtin: builtinProviderById.has(provider.id),
  }));
}

export async function checkSecretProviders(): Promise<SecretProviderHealthCheck[]> {
  return Promise.all(allProviders().map((provider) => provider.healthCheck()));
}
