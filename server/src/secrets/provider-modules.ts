import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerSecretProvider } from "./provider-registry.js";
import {
  SecretProviderClientError,
  type SecretProviderModuleApi,
  type SecretProviderModuleRegistration,
} from "./types.js";

export const SECRET_PROVIDER_MODULES_ENV = "PAPERCLIP_SECRET_PROVIDER_MODULES";

type ModuleLog = SecretProviderModuleApi["log"];

// startServer() can run more than once per process (tests, restarts after a
// cloud identity restore); each module registers its providers only once.
const loadedSpecifiers = new Set<string>();

/** Test-only: forget which modules were loaded. */
export function resetLoadedSecretProviderModulesForTests(): void {
  loadedSpecifiers.clear();
}

export interface LoadSecretProviderModulesOptions {
  /** Comma-separated module specifiers. Defaults to PAPERCLIP_SECRET_PROVIDER_MODULES. */
  specifiers?: string | null;
  /** Base directory for relative paths. Defaults to process.cwd(). */
  cwd?: string;
  log?: ModuleLog;
  /** Injectable for tests. */
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
}

export function parseSecretProviderModuleSpecifiers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const specifiers: string[] = [];
  for (const part of raw.split(",")) {
    const specifier = part.trim();
    if (!specifier || seen.has(specifier)) continue;
    seen.add(specifier);
    specifiers.push(specifier);
  }
  return specifiers;
}

function toImportSpecifier(specifier: string, cwd: string): string {
  // Filesystem paths are resolved against cwd; bare specifiers resolve through
  // normal package resolution from the server package.
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(cwd, specifier)).href;
  }
  return specifier;
}

function findRegistration(loaded: Record<string, unknown>): SecretProviderModuleRegistration | null {
  const candidates = [loaded.registerSecretProviders, loaded.default];
  for (const candidate of candidates) {
    if (typeof candidate === "function") return candidate as SecretProviderModuleRegistration;
    // CommonJS-style default wrapping: { default: { registerSecretProviders } }
    if (candidate && typeof candidate === "object") {
      const nested = (candidate as Record<string, unknown>).registerSecretProviders;
      if (typeof nested === "function") return nested as SecretProviderModuleRegistration;
    }
  }
  return null;
}

/**
 * Load trusted secret provider modules named by PAPERCLIP_SECRET_PROVIDER_MODULES
 * and register the providers they contribute. Runs once at startup, before the
 * server reads its config or accepts requests.
 *
 * Modules run in-process with full server privileges, so only operators can
 * name them (via the process environment). A module that fails to load or
 * register stops startup: secrets that depend on it would otherwise fail later
 * at resolve time with a less obvious error.
 */
export async function loadSecretProviderModules(
  options: LoadSecretProviderModulesOptions = {},
): Promise<string[]> {
  const specifiers = parseSecretProviderModuleSpecifiers(
    options.specifiers === undefined ? process.env[SECRET_PROVIDER_MODULES_ENV] : options.specifiers,
  );
  if (specifiers.length === 0) return [];
  const cwd = options.cwd ?? process.cwd();
  const log: ModuleLog = options.log ?? {
    info: () => {},
    warn: () => {},
  };
  const importModule =
    options.importModule ?? ((specifier: string) => import(specifier) as Promise<Record<string, unknown>>);

  const registeredIds: string[] = [];
  for (const specifier of specifiers) {
    if (loadedSpecifiers.has(specifier)) continue;
    let loaded: Record<string, unknown>;
    try {
      loaded = await importModule(toImportSpecifier(specifier, cwd));
    } catch (error) {
      throw new Error(
        `Failed to load secret provider module "${specifier}" from ${SECRET_PROVIDER_MODULES_ENV}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    const register = findRegistration(loaded);
    if (!register) {
      throw new Error(
        `Secret provider module "${specifier}" must export a registerSecretProviders(api) function (named or default)`,
      );
    }
    const idsFromModule: string[] = [];
    const api: SecretProviderModuleApi = {
      registerSecretProvider(module) {
        registerSecretProvider(module);
        idsFromModule.push(module.id);
      },
      SecretProviderClientError,
      log,
    };
    try {
      await register(api);
    } catch (error) {
      throw new Error(
        `Secret provider module "${specifier}" failed to register: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (idsFromModule.length === 0) {
      log.warn("Secret provider module registered no providers", { module: specifier });
    } else {
      log.info("Registered secret provider module", { module: specifier, providers: idsFromModule });
    }
    loadedSpecifiers.add(specifier);
    registeredIds.push(...idsFromModule);
  }
  return registeredIds;
}
