import type { SecretProvider } from "@paperclipai/shared";
import { isKnownSecretProvider } from "./provider-registry.js";

export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  return configuredProvider && isKnownSecretProvider(configuredProvider)
    ? configuredProvider
    : "local_encrypted";
}
