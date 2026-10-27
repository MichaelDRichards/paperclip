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

const loadedSpecifiers = new Set<string>();

export function resetLoadedSecretProviderModulesForTests(): void {
  loadedSpecifiers.clear();
}

export interface LoadSecretProviderModulesOptions {
  specifiers?: string | null;
  cwd?: string;
  log?: ModuleLog;
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
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(cwd, specifier)).href;
  }
  return specifier;
}

function findRegistration(loaded: Record<string, unknown>): SecretProviderModuleRegistration | null {
  const candidates = [loaded.registerSecretProviders, loaded.default];
  for (const candidate of candidates) {
    if (typeof candidate === "function") return candidate as SecretProviderModuleRegistration;
    if (candidate && typeof candidate === "object") {
      const nested = (candidate as Record<string, unknown>).registerSecretProviders;
      if (typeof nested === "function") return nested as SecretProviderModuleRegistration;
    }
  }
  return null;
}

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
