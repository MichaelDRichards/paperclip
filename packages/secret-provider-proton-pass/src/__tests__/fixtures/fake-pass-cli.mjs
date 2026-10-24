#!/usr/bin/env node
// A stand-in for pass-cli used by the provider tests. It keeps its state next
// to PROTON_PASS_SESSION_DIR: fake-pass.json (behaviour) and fake-pass.log.jsonl
// (one line per invocation, so tests can assert argv, env, and reasons).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const sessionDir = process.env.PROTON_PASS_SESSION_DIR;
if (!sessionDir) {
  process.stderr.write("fake pass-cli: PROTON_PASS_SESSION_DIR is required\n");
  process.exit(2);
}
const root = path.dirname(sessionDir);
const config = JSON.parse(readFileSync(path.join(root, "fake-pass.json"), "utf8"));
const sessionFile = path.join(sessionDir, "fake-session.json");
const args = process.argv.slice(2);

appendFileSync(
  path.join(root, "fake-pass.log.jsonl"),
  `${JSON.stringify({
    args,
    envKeys: Object.keys(process.env).sort(),
    reason: process.env.PROTON_PASS_AGENT_REASON ?? null,
    keyProvider: process.env.PROTON_PASS_KEY_PROVIDER ?? null,
    pid: process.pid,
    at: Date.now(),
  })}\n`,
);

function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

function readSession() {
  if (!existsSync(sessionFile)) return null;
  return JSON.parse(readFileSync(sessionFile, "utf8"));
}

function requireSession() {
  const session = readSession();
  if (!session) {
    process.stderr.write("ERROR pass-cli/src/main.rs:335: Command is not logout there is no session\n");
    fail("This operation requires an authenticated client");
  }
  return session;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isId = (value) => value.length === 88 && value.endsWith("==");

// Vaults the token can see: config.visibleVaults, or every vault named in items.
// config.shareIds maps a vault name to its share ID for this token.
function visibleVaults() {
  const names =
    config.visibleVaults ??
    [...new Set(Object.keys(config.items ?? {}).map((key) => key.slice("pass://".length).split("/")[0]))];
  return names.map((name) => ({ name, vault_id: `vault-${name}`, share_id: config.shareIds?.[name] ?? `share-${name}` }));
}

// Resolve pass://vault/item/field the way pass-cli 2.4.2 does, failing with its
// verbatim wording: vault and item titles are case-sensitive, fields are not.
// Like the real binary, an ID lookup happens only when BOTH the vault and the
// item segments are IDs; config.itemIds maps an item ID to "Vault/Title".
function lookup(uri) {
  let [vault, item, field] = uri.slice("pass://".length).split("?")[0].split("/");
  if (isId(vault) && isId(item)) {
    const share = visibleVaults().find((v) => v.share_id === vault);
    const target = config.itemIds?.[item];
    // Real pass-cli 2.4.2 wording, observed against a live vault (Test Labs
    // TES-11): it reports the API's HTTP status and never says "not found".
    // 400 for an ID that is no Proton object; 422 for a real ID that is not an
    // item in that share (including a share ID this token cannot use).
    const byIdFailure = (status) =>
      fail(`Error retrieving item\n\nCaused by:\n    0: Error retrieving item by id\n    1: Error fetching item\n    2: Invalid status code: ${status}`);
    if (!target) byIdFailure("400 Bad Request");
    if (!share || target.split("/")[0] !== share.name) byIdFailure("422 Unprocessable Entity");
    vault = share.name;
    item = target.split("/")[1];
  }
  const entries = Object.entries(config.items ?? {}).map(([key, value]) => {
    const [v, i, f] = key.slice("pass://".length).split("/");
    return { v, i, f, value };
  });
  if (!visibleVaults().some((v) => v.name === vault) || !entries.some((e) => e.v === vault)) {
    fail(`Error retrieving item\n\nCaused by:\n    0: Error finding item by name\n    1: Error finding vault by name\n    2: Could not find vault ${vault}`);
  }
  if (!entries.some((e) => e.v === vault && e.i === item)) {
    fail(`Error retrieving item\n\nCaused by:\n    0: Error finding item by name\n    1: Could not find item with name ${item}`);
  }
  const match = entries.find((e) => e.v === vault && e.i === item && e.f.toLowerCase() === field.toLowerCase());
  if (!match) fail(`Field does not exist: ${field}`);
  return match.value;
}

if (args[0] === "--version") {
  process.stdout.write("Proton Pass CLI 2.4.2 (fake)\n");
  process.exit(0);
}

if (args[0] === "logout") {
  rmSync(sessionFile, { force: true });
  process.exit(0);
}

if (args[0] === "login") {
  if (args.length > 1) fail("fake pass-cli: token must come from the environment, not argv");
  const token = process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN;
  if (token !== config.validToken) fail("Error in personal access token login flow");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ reads: 0 }));
  process.exit(0);
}

// pass-cli 2.4.2's human `info` format; "[Agent] " marks an agent session.
if (args[0] === "info") {
  requireSession();
  const marker = (config.accountType ?? "agent") === "agent" ? "[Agent] " : "";
  process.stdout.write(`- Release track: stable\n- Personal Access Token: ${marker}paperclip-test\n- Session has lock: no\n`);
  process.exit(0);
}

if (args[0] === "vault" && args[1] === "list") {
  requireSession();
  if (args[2] !== "--output" || args[3] !== "json") fail("fake pass-cli: expected vault list --output json");
  process.stdout.write(`${JSON.stringify({ vaults: visibleVaults() }, null, 2)}\n`);
  process.exit(0);
}

if (args[0] === "item" && args[1] === "view") {
  const session = requireSession();
  const reason = process.env.PROTON_PASS_AGENT_REASON ?? "";
  if (!reason || reason.length > 300) fail("PROTON_PASS_AGENT_REASON must be set (max 300 chars)");
  if (args[2] !== "--" || !args[3]) fail("fake pass-cli: expected item view -- <uri>");
  if (config.sleepMs) await sleep(config.sleepMs);
  session.reads += 1;
  if (config.expireAfterReads && session.reads >= config.expireAfterReads) {
    rmSync(sessionFile, { force: true });
  } else {
    writeFileSync(sessionFile, JSON.stringify(session));
  }
  // Configured raw stderr, for faults that are not about the reference.
  if (config.stderrFor?.[args[3]]) fail(config.stderrFor[args[3]]);
  const value = lookup(args[3]);
  process.stdout.write(`${value}\n`);
  process.exit(0);
}

fail(`fake pass-cli: unsupported command ${args.join(" ")}`, 2);
