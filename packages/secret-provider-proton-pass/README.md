# Proton Pass secret provider for Paperclip

A read-only secret provider that lets Paperclip agents use items stored in
[Proton Pass](https://proton.me/pass). Paperclip stores only a `pass://`
reference; the value is read from Proton Pass through `pass-cli` each time a
run needs it, and never written to Paperclip's database.

It is a trusted platform module loaded through
`PAPERCLIP_SECRET_PROVIDER_MODULES` (see PLUGIN_SPEC.md §6.1), not a plugin.

## How it works

- One Proton Pass access token per Paperclip server, created for a dedicated
  vault. The token is a deployment credential: it lives in a file or the
  server environment, never in Paperclip's UI or database.
- Each Paperclip **provider vault** names one Proton vault. Secrets linked
  through it can only reference items in that vault, even if the token can
  reach more.
- Every read passes an audit reason to Proton
  (`PROTON_PASS_AGENT_REASON`) naming the Paperclip secret key, version,
  company and secret id, so `pass-cli agent monitor` shows who read what.
- Read-only: Paperclip cannot create, rotate or delete Proton items. Create
  items in Proton Pass and link them.

## Requirements

- A Proton plan that includes Pass CLI and access tokens (Pass Plus, Family,
  Professional, Unlimited, or Workspace).
- `pass-cli` 2.4 or newer on the Paperclip server, on `PATH` or set with
  `PAPERCLIP_PROTON_PASS_CLI`.

## Setup

1. Create a vault for Paperclip in Proton Pass (for example `Paperclip`) and
   put the items agents need in it.
2. On a machine where you are logged in to `pass-cli` as yourself, create an
   agent token limited to that vault:

   ```sh
   pass-cli agent create paperclip --expiration 1y --vault "Paperclip"
   ```

   The token is printed once. Save it to a file readable only by the
   Paperclip service user:

   ```sh
   install -m 600 /dev/null ~/.paperclip/proton-pass-token
   # paste the token into the file
   ```

3. Build the package and point Paperclip at it:

   ```sh
   pnpm --filter @paperclipai/secret-provider-proton-pass build
   ```

   ```sh
   PAPERCLIP_SECRET_PROVIDER_MODULES=/path/to/paperclip/packages/secret-provider-proton-pass/dist/index.js
   PAPERCLIP_PROTON_PASS_TOKEN_FILE=~/.paperclip/proton-pass-token
   ```

   When running Paperclip from source with `pnpm dev`, the `src/index.ts`
   entry also works.

4. Restart Paperclip. In **Company Settings → Secrets → Provider vaults**, add
   a Proton Pass vault and enter the Proton vault name.
5. Link secrets with references such as `pass://Paperclip/GitHub/token`, then
   bind them to agents as usual.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPERCLIP_PROTON_PASS_TOKEN_FILE` | — | File containing the access token. Re-read at each login, so replacing the file rotates the token. Preferred. |
| `PAPERCLIP_PROTON_PASS_TOKEN` | — | The access token itself, if a file is not practical. |
| `PAPERCLIP_PROTON_PASS_CLI` | `pass-cli` | Path to the `pass-cli` binary. |
| `PAPERCLIP_PROTON_PASS_SESSION_DIR` | `$PAPERCLIP_HOME/proton-pass-session` | Isolated `pass-cli` session directory (created `0700`). |
| `PAPERCLIP_PROTON_PASS_KEY_PROVIDER` | `fs` | `pass-cli` local key storage: `fs` (in the session dir), `env`, or `keyring`. Headless servers usually have no keyring. |
| `PAPERCLIP_PROTON_PASS_ENCRYPTION_KEY` | — | Local key when the key provider is `env`. |
| `PAPERCLIP_PROTON_PASS_TIMEOUT_MS` | `20000` | Per-call timeout; `pass-cli` is killed when it is exceeded. |
| `PAPERCLIP_PROTON_PASS_MAX_CONCURRENCY` | `1` | Concurrent `pass-cli` calls. Calls share one session database, so raise this only after testing. |

## Operational notes

- `pass-cli` agent sessions last two hours. The provider logs in again before
  that, and once more if a call reports a missing session.
- `pass-cli` is started with a minimal environment (`PATH`, `HOME`, locale,
  proxy and CA variables). Paperclip's own secrets are not passed to it.
- Values are returned exactly as stored, minus `pass-cli`'s trailing newline.
- Vault and item names in a reference are case-sensitive; field names are not.
  `pass://Paperclip/GitHub/TOKEN` resolves, `pass://Paperclip/github/token` does
  not. A missing vault, item or field is reported as `not_found`.
- Linking a reference does not read the value; the first audited read happens
  at runtime. A wrong reference shows up as a `not_found` resolution error.
- Removing a secret or vault in Paperclip never deletes anything in Proton.
