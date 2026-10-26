# Proton Pass secret provider for Paperclip

Let your [Paperclip](https://github.com/paperclipai/paperclip) agents use
secrets that you keep in [Proton Pass](https://proton.me/pass), without copying
them into Paperclip.

Paperclip stores only a reference such as `pass://Paperclip/<item ID>/token`.
Each time an agent needs the value, the provider reads it from Proton Pass
through Proton's `pass-cli`. The value is never written to Paperclip's
database, and every read is recorded in Proton's agent audit log.

- **Read-only.** Paperclip can link and read Proton Pass items. It cannot
  create, change or delete them.
- **Scoped.** Each Paperclip provider vault is tied to one Proton vault, and
  references outside it are refused.
- **Audited.** Every read names the Paperclip secret, version and company in
  `pass-cli agent monitor`.

## Requirements

| | |
| --- | --- |
| Paperclip | A build that supports secret provider modules (`PAPERCLIP_SECRET_PROVIDER_MODULES`). See [Compatibility](#compatibility). |
| Proton plan | One that includes Pass CLI and access tokens: Pass Plus, Family, Professional, Unlimited or Workspace. The free plan does not. |
| `pass-cli` | 2.4 or newer, installed on the Paperclip server. Tested with 2.4.2. |
| Node.js | 24, the version Paperclip itself needs. |

## Quick start

1. **Make a vault.** In Proton Pass, create a vault for Paperclip (for example
   `Paperclip`) and put the items your agents need in it.
2. **Make an agent token for that vault.** On a computer where you are logged
   in to `pass-cli` as yourself:

   ```sh
   pass-cli agent create paperclip --expiration 1y --vault "Paperclip"
   ```

   Use `agent create`, not `pat create`, or reads are not audited (see
   [Auditing](#auditing)). The token is shown once.
3. **Store the token on the server**, readable only by the user that runs
   Paperclip:

   ```sh
   install -m 600 /dev/null ~/.paperclip/proton-pass-token
   # paste the token into the file
   ```

4. **Build the provider and tell Paperclip to load it** (see
   [Installation](#installation)), then set:

   ```sh
   PAPERCLIP_SECRET_PROVIDER_MODULES=/path/to/secret-provider-proton-pass/dist/index.js
   PAPERCLIP_PROTON_PASS_TOKEN_FILE=~/.paperclip/proton-pass-token
   ```

5. **Restart Paperclip.** In **Company Settings → Secrets → Provider vaults**,
   add a **Proton Pass** vault and enter the Proton vault name (`Paperclip`).
6. **Check Provider health.** It should say the token is an audited agent
   token and list `Paperclip` among the vaults the token can see.
7. **Link and bind secrets.** Create a secret that links
   `pass://Paperclip/<item ID>/<field>` (see [References](#references)), then
   bind it to an agent. Prefer `api` delivery (see
   [Delivery](#delivery-env-or-api)).

## Installation

The provider is a trusted platform module: Paperclip imports it into the
server process at startup. It is not a Paperclip plugin, and you do not
install it from the Paperclip UI. Only someone who controls the server's
environment can add it.

It has no runtime dependencies. Build it once and point
`PAPERCLIP_SECRET_PROVIDER_MODULES` at the built entry file:

```sh
cd secret-provider-proton-pass
npm install        # development tools only: TypeScript and Vitest
npm run build      # writes dist/
```

```sh
PAPERCLIP_SECRET_PROVIDER_MODULES=/absolute/path/to/secret-provider-proton-pass/dist/index.js
```

A relative path is resolved against the directory the server starts in. To
load more than one module, separate the entries with commas. If a module
cannot be loaded, Paperclip does not start, and the error names the module.

When you run Paperclip from source with `pnpm dev`, you can point at
`src/index.ts` instead and skip the build.

### Compatibility

Support for secret provider modules is in
[MichaelDRichards/paperclip](https://github.com/MichaelDRichards/paperclip)
(branch `feat/secret-provider-registry`) and has been proposed for Paperclip
itself. Until a Paperclip release includes it, run a build of that branch.
The provider id is `proton_pass`.

## Settings

All settings are environment variables on the Paperclip server. None of them
are stored in Paperclip's database or shown in its UI.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPERCLIP_PROTON_PASS_TOKEN_FILE` | — | File that holds the access token. Recommended. It is read again on every operation, so replacing the file takes effect on the next read, with no restart. |
| `PAPERCLIP_PROTON_PASS_TOKEN` | — | The access token itself, when a file is not practical. |
| `PAPERCLIP_PROTON_PASS_CLI` | `pass-cli` | Path to the `pass-cli` binary. |
| `PAPERCLIP_PROTON_PASS_SESSION_DIR` | `$PAPERCLIP_HOME/proton-pass-session` | Private `pass-cli` session directory (created with mode `0700`). Keep it on persistent storage. |
| `PAPERCLIP_PROTON_PASS_KEY_PROVIDER` | `fs` | Where `pass-cli` keeps its local key: `fs` (in the session directory), `env` or `keyring`. Headless servers usually have no keyring. |
| `PAPERCLIP_PROTON_PASS_ENCRYPTION_KEY` | — | The local key, when the key provider is `env`. |
| `PAPERCLIP_PROTON_PASS_TIMEOUT_MS` | `20000` | Time limit for each `pass-cli` call. `pass-cli`'s own network timeout is about 30 s, so at the default you see `provider_unavailable` rather than Proton's reason. |
| `PAPERCLIP_PROTON_PASS_MAX_CONCURRENCY` | `1` | How many `pass-cli` calls may run at once. 2 and 4 worked against a real vault and were about 3× faster; see [Run start cost](#run-start-cost). |

## References

A reference has the form `pass://<vault name>/<item>/<field>`.

- **Vault:** always the Proton vault **name**, exactly as configured on the
  Paperclip provider vault.
- **Item:** an item **ID** (recommended) or an item **title**.
- **Field:** the field name, for example `token` or `password`. A field inside
  a section can be written as `Section.field`.

### Use item IDs

Proton recommends IDs: titles are for people, IDs say exactly which item to
read. Find an item's ID with:

```sh
pass-cli item list --vault-name "Paperclip"
# - [<item ID>]: GitHub (state=Active)
```

and link it as `pass://Paperclip/<item ID>/token`.

ID references keep working when you replace or rotate the token, or when the
vault is shared with the token again.

### If you use titles

Titles are not unique, and `pass-cli` does not warn when two items share one.
It silently returns one of them. Items in the trash still count. So:

- Keep titles unique within the vault.
- To change a value, **edit the existing item**. Creating a new item with the
  same title and deleting the old one can leave Paperclip reading the old
  value, because a deleted item stays in the trash and still matches.
- Only emptying the trash, or deleting permanently, removes an item from
  title lookups.

Paperclip records nothing when a title starts to match a different item,
because it stores the reference, not a fingerprint of the value. Item IDs
avoid all of this. (An ID reference to an item in the trash also keeps
working until the trash is emptied.)

### Other rules

- Vault names and item titles are case-sensitive; field names are not.
  `pass://Paperclip/GitHub/TOKEN` resolves, `pass://Paperclip/github/token`
  does not.
- A segment cannot contain `/`. `pass-cli` percent-decodes each segment, so
  avoid `%` in vault names and item titles too, or use an item ID.
- Values come back exactly as stored. A value that ends in a newline keeps it,
  and an empty field resolves to an empty value, not an error.
- Linking a secret does not read it. A wrong reference shows up the first time
  an agent uses it, as a `not_found` error.

## Delivery: `env` or `api`

Bind Proton Pass secrets with `delivery: "api"` when you can.

- With `env` delivery, Paperclip reads the value when a run starts and puts it
  in the agent's environment. If the agent prints it, it is written to the run
  log, and current Paperclip versions show `env` values in the run log
  **without redaction**. Values read through the agent secrets API (`api`
  delivery) are redacted. This is Paperclip behaviour, not specific to this
  provider.
- With `env` delivery, every bound secret is read at every run start, and a
  short Proton outage during that step fails the whole run before the agent
  starts.

## Run start cost

`env` secrets are all read at run start, whether or not the run uses them. At
the default concurrency of 1, each read took about 2.5–3 s against a real
vault, so seven bound secrets added about 20 s to each run start. Set
`PAPERCLIP_PROTON_PASS_MAX_CONCURRENCY` to 2 or 4 once you bind several
secrets, or use `api` delivery.

## Auditing

Every read sends Proton a reason that names the Paperclip secret key, version,
company and secret id, and `pass-cli agent monitor` lists it.

**This only works with an agent token.** A plain personal access token
(`pass-cli pat create`) reads the vault the same way, but Proton records
nothing. The two kinds of token look the same; from your own account,
`pass-cli agent list` shows which tokens are agents.

Provider health reports `warn` when the configured token is not an agent
token. Check it after every token change. The check looks for the `[Agent]`
marker in `pass-cli info`, so do not give tokens names that start with
`[Agent]`.

## Rotating the token

1. Create a new agent token for the same vault (Quick start, step 2).
2. Replace the contents of the token file. No restart is needed.
3. Check Provider health.
4. Revoke the old token in Proton Pass.

## Troubleshooting

- **Every secret in a vault fails with `access_denied`, saying the token
  cannot see the vault.** Proton reports a vault the token has no access to
  in the same way as a vault that does not exist. Usually the token's access
  to the vault was removed or has expired; otherwise the vault was renamed.
  Provider health, or `pass-cli vault list` run as the token, shows which
  vaults it can see.
- **One secret fails with `not_found`.** The item or field does not exist, a
  title or field name is misspelled (titles are case-sensitive), or the item ID
  is wrong or belongs to a permanently deleted item. Compare the ID with
  `pass-cli item list --vault-name "<vault>"`.
- **A secret fails with `provider_error` ("Proton Pass request failed").**
  Something other than a bad reference went wrong in `pass-cli`. The error's
  raw message has `pass-cli`'s own wording, with any token removed, which
  usually names the cause. If it looks like a reference problem, the provider
  does not recognise that wording yet; please report it.
- **Provider health is `warn`: "reads are not audited".** The token is a
  plain personal access token. Create an agent token and replace the token
  file.
- **`provider_unavailable` with a timeout.** Proton did not answer within
  `PAPERCLIP_PROTON_PASS_TIMEOUT_MS`. Run `pass-cli` by hand with the same
  session directory to see Proton's own error.
  - Right after a restart or a token change, Proton may be limiting **new
    logins**. In testing, about nine new sessions for one token within a
    quarter of an hour made further logins hang until they timed out, while
    existing sessions kept working; it cleared by itself within about seven
    minutes. A normal server logs in about every 105 minutes and never gets
    close. A restart loop, a session directory on temporary storage, or
    several servers sharing one token can. Keep the session directory on
    persistent storage and give each server its own token.

## How it works

- `pass-cli` agent sessions last two hours. The provider logs in again 15
  minutes before that, and once more if a call reports a missing or
  invalidated session. Sessions are reused across server restarts.
- `pass-cli` runs with a minimal environment (`PATH`, `HOME`, locale, proxy
  and CA variables) and a private session directory. Paperclip's own secrets
  are not passed to it, and the token is passed through the environment,
  never on the command line. A call that runs past the time limit is killed.
- `pass-cli` only accepts an item ID when the vault is given as a **share
  ID**, and share IDs belong to the token, so they change when the token
  changes. The stored reference therefore keeps the vault name. To read by ID,
  the provider looks up the current token's share ID with `pass-cli vault
  list` (which is not audited), keeps it for the session, and looks it up
  again when a read comes back not found.
- After a `not_found`, the provider checks whether the token can still see the
  vault, so a lost vault grant is reported as `access_denied`.
- Removing a secret or a provider vault in Paperclip never deletes anything in
  Proton Pass.

## Development

```sh
npm install
npm run typecheck
npm test
```

The tests use a fake `pass-cli` (`src/__tests__/fixtures/fake-pass-cli.mjs`)
that reproduces the real binary's output and error wording. When you change
how errors are classified, check the wording against a real `pass-cli` first:
a fake with invented wording passes its tests while the real binary fails.

## License

MIT
