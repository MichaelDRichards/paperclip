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
  This requires an **agent** token (see [Auditing](#auditing)).
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
   **agent** token limited to that vault:

   ```sh
   pass-cli agent create paperclip --expiration 1y --vault "Paperclip"
   ```

   Use `agent create`, not `pat create`. Both commands produce a token of the
   same shape that reads the same vault, but only an agent token's reads are
   recorded in `pass-cli agent monitor`; a plain personal access token records
   nothing, and the two cannot be told apart afterwards except by the
   `[Agent]` marker in `pass-cli info`. See [Auditing](#auditing).

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
5. Check **Provider health**: it should report an audited agent token and
   list the vault you created among the vaults the token can see.
6. Link secrets with references such as
   `pass://Paperclip/<item ID>/token` (see [References](#references)), then
   bind them to agents. Prefer `delivery: "api"` for these bindings (see
   [Delivery](#delivery-env-or-api)).

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPERCLIP_PROTON_PASS_TOKEN_FILE` | — | File containing the access token. Re-read on every operation, so replacing the file takes effect on the next read, with no restart. Preferred. |
| `PAPERCLIP_PROTON_PASS_TOKEN` | — | The access token itself, if a file is not practical. |
| `PAPERCLIP_PROTON_PASS_CLI` | `pass-cli` | Path to the `pass-cli` binary. |
| `PAPERCLIP_PROTON_PASS_SESSION_DIR` | `$PAPERCLIP_HOME/proton-pass-session` | Isolated `pass-cli` session directory (created `0700`). |
| `PAPERCLIP_PROTON_PASS_KEY_PROVIDER` | `fs` | `pass-cli` local key storage: `fs` (in the session dir), `env`, or `keyring`. Headless servers usually have no keyring. |
| `PAPERCLIP_PROTON_PASS_ENCRYPTION_KEY` | — | Local key when the key provider is `env`. |
| `PAPERCLIP_PROTON_PASS_TIMEOUT_MS` | `20000` | Per-call timeout; `pass-cli` is killed when it is exceeded. `pass-cli`'s own network timeout is about 30 s, so at the default you see `provider_unavailable` rather than Proton's reason for the delay. |
| `PAPERCLIP_PROTON_PASS_MAX_CONCURRENCY` | `1` | Concurrent `pass-cli` calls. Calls share one session database. 2 and 4 were tested against a real vault with no errors and were about 3× faster; see [Run start cost](#run-start-cost). |

## References

A reference has the form `pass://<vault name>/<item>/<field>`. The vault is
always the Proton vault **name**, and must match the provider vault's
configured name. The item is either an item **ID** or an item **title**.

**Use item IDs for anything that matters.** This is Proton's own guidance:
names are for readability, and IDs are the only way to be sure which item is
read. Find an item's ID with:

```sh
pass-cli item list --vault-name "Paperclip"
# - [<item ID>]: GitHub (state=Active)
```

and link it as `pass://Paperclip/<item ID>/token`.

`pass-cli` itself only resolves an item ID when the vault is given as a
**share ID**, and a share ID belongs to the credential: it changes whenever
the token is replaced. So the stored reference keeps the vault name, and at
read time the provider looks up the current token's share ID for that vault
(`pass-cli vault list`, once per session, not audited). Rotating the token
does not break ID references.

**Titles are not unique, and title lookups are silent about it.** When
several items in the vault share a title, `pass-cli` returns the first match
in an undocumented order, with no error or warning. Trashed items are still
candidates. In particular:

- Deleting an item in the Proton Pass app moves it to the **trash**, and a
  trashed item still resolves by title. Deleting a duplicate therefore does
  not make a title unique, and if you trash the copy a reference was
  returning, the reference can keep returning the trashed value. Only
  emptying the trash (or deleting permanently) removes an item from title
  lookup.
- To change a value, edit the existing item in place. Creating a replacement
  with the same title and deleting the old one is the pattern most likely to
  leave Paperclip reading the old value.
- Paperclip records nothing when a title starts resolving to a different
  item, because it stores the reference, not a fingerprint of the value.

An ID reference avoids all of this. Note that an ID also keeps resolving if
the item is moved to the trash; empty the trash to stop it.

Other rules:

- Vault and item titles are case-sensitive; field names are not.
  `pass://Paperclip/GitHub/TOKEN` resolves, `pass://Paperclip/github/token`
  does not.
- `pass-cli` has no escaping for `/`, so no segment may contain one. Field
  names may be section-qualified (`Staging.password`).
- Values are returned exactly as stored, minus `pass-cli`'s trailing newline.
  A value that itself ends in a newline keeps it, and an empty field resolves
  to an empty value rather than an error.
- Linking a reference does not read the value; the first audited read happens
  at runtime. A wrong reference shows up as a `not_found` resolution error.

## Auditing

Every read passes a reason to Proton naming the Paperclip secret key, version,
company and secret id, and `pass-cli agent monitor` lists it. **This only
happens with an agent token.** With a plain personal access token (from
`pass-cli pat create`), reads work exactly the same and nothing is recorded;
Proton does not even require the reason.

The provider's health check reads the account type from `pass-cli info` and
reports `warn` when the configured credential is not an agent token. Check it
after every token rotation.

## Delivery: `env` or `api`

Prefer binding Proton Pass secrets with `delivery: "api"`.

- With `delivery: "env"`, the value is resolved when the run starts and put in
  the agent's process environment. If the agent ever prints it, it is written
  to the run log, and Paperclip's run-log API currently serves it
  **unredacted**: values projected into the environment are not registered for
  run-log redaction. Values resolved through the agent secrets API are. This
  is a Paperclip platform behaviour, not specific to this provider, but it
  undercuts the main reason to use an external vault.
- With `env` delivery, every bound secret is also read at every run start
  (see below), and a transient Proton failure during that projection fails the
  whole run before the agent starts, rather than failing one secret when it is
  used.

## Run start cost

`env`-bound secrets are read eagerly at run start, whether or not the run uses
them. At the default concurrency of 1, each read took about 2.5–3 s against a
real vault, so seven bound secrets added roughly 20 s to every run start.
Raise `PAPERCLIP_PROTON_PASS_MAX_CONCURRENCY` (2 or 4) once several secrets
are bound, or use `api` delivery.

## Troubleshooting

- **Every secret in a vault fails with `access_denied` saying the token
  cannot see the vault.** Proton reports a vault the token has no access to
  exactly like a vault that does not exist. The usual cause is that the
  token's grant on the vault was removed, re-shared or expired; the other is a
  vault renamed in Proton. `pass-cli vault list`, run as the token, shows what
  it can see, and so does the health check.
- **One secret fails with `not_found`.** The item or field does not exist, or
  a title or field name is misspelled (titles are case-sensitive).
- **Health is `warn` with "reads are not audited".** The token is a plain
  personal access token. Create an agent token and replace the token file; no
  restart is needed.
- **`provider_unavailable` with a timeout.** Proton did not answer within
  `PAPERCLIP_PROTON_PASS_TIMEOUT_MS`. Running `pass-cli` by hand with the same
  session directory shows Proton's own error.

## Operational notes

- `pass-cli` agent sessions last two hours. The provider logs in again 15
  minutes before that, and once more if a call reports a missing or
  invalidated session.
- `pass-cli` is started with a minimal environment (`PATH`, `HOME`, locale,
  proxy and CA variables). Paperclip's own secrets are not passed to it, and
  the token reaches it through the environment, never the command line.
- Removing a secret or vault in Paperclip never deletes anything in Proton.
