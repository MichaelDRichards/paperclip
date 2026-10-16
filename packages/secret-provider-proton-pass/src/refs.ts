/**
 * Proton Pass secret references: pass://<vault>/<item>/<field>[?totp=code|uri]
 *
 * Vault and item may be names or ids. pass-cli has no escaping for "/" inside
 * names, so each segment must be slash-free. Field names may be
 * section-qualified ("Staging.password").
 */
export interface PassReference {
  vault: string;
  item: string;
  field: string;
  query: string | null;
  /** Normalized reference string passed to pass-cli. */
  uri: string;
}

const MAX_REF_LENGTH = 1024;
const ALLOWED_QUERIES = new Set(["totp=code", "totp=uri"]);

export function parsePassReference(raw: string): PassReference {
  const value = raw.trim();
  if (value.length === 0) throw new Error("Proton Pass reference is empty");
  if (value.length > MAX_REF_LENGTH) throw new Error("Proton Pass reference is too long");
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Proton Pass reference contains control characters");
  }
  if (!value.startsWith("pass://")) {
    throw new Error("Proton Pass reference must start with pass://");
  }
  const rest = value.slice("pass://".length);
  const queryIndex = rest.indexOf("?");
  const path = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? null : rest.slice(queryIndex + 1);
  if (query !== null && !ALLOWED_QUERIES.has(query)) {
    throw new Error("Proton Pass reference only supports ?totp=code or ?totp=uri");
  }
  const segments = path.split("/");
  if (segments.length !== 3 || segments.some((segment) => segment.trim().length === 0)) {
    throw new Error("Proton Pass reference must look like pass://<vault>/<item>/<field>");
  }
  const [vault, item, field] = segments as [string, string, string];
  if (segments.some((segment) => segment !== segment.trim())) {
    throw new Error("Proton Pass reference segments cannot start or end with spaces");
  }
  return {
    vault,
    item,
    field,
    query,
    uri: `pass://${vault}/${item}/${field}${query ? `?${query}` : ""}`,
  };
}

export function parseVaultName(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error("vaultName is required");
  if (value.length > 120) throw new Error("vaultName must be at most 120 characters");
  if (value.includes("/") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("vaultName cannot contain slashes or control characters");
  }
  return value;
}
