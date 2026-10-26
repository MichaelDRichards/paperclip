import type { ModuleApi } from "./host-types.js";
import { createProtonPassProvider, readProtonPassSettings } from "./provider.js";

export {
  createProtonPassProvider,
  readProtonPassSettings,
  PROTON_PASS_ENV,
  PROTON_PASS_PROVIDER_ID,
  type ProtonPassSettings,
} from "./provider.js";
export { parsePassReference, parseVaultName, type PassReference } from "./refs.js";
export {
  isProtonId,
  parseInfoOutput,
  parseVaultList,
  PassCli,
  PassCliError,
  type PassAccountType,
  type PassSessionInfo,
  type PassVault,
} from "./pass-cli.js";

/**
 * Entry point for PAPERCLIP_SECRET_PROVIDER_MODULES. Paperclip calls this once
 * at startup with its provider registration API.
 */
export default function registerSecretProviders(api: ModuleApi): void {
  const settings = readProtonPassSettings();
  api.registerSecretProvider(
    createProtonPassProvider({
      settings,
      SecretProviderClientError: api.SecretProviderClientError,
      log: api.log,
    }),
  );
  if (!settings.token && !settings.tokenFile) {
    api.log.warn("Proton Pass provider registered without an access token; linked secrets will not resolve", {
      provider: "proton_pass",
    });
  }
}
