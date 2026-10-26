import type { SecretProvider } from "@paperclipai/shared";
import { isKnownSecretProvider } from "./provider-registry.js";

/**
 * The deployment's default secret provider: PAPERCLIP_SECRETS_PROVIDER when it
 * names a built-in provider or one registered at startup, else local_encrypted.
 */
export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  return configuredProvider && isKnownSecretProvider(configuredProvider)
    ? configuredProvider
    : "local_encrypted";
}
