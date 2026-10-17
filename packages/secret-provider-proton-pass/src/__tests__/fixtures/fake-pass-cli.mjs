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

// Resolve pass://vault/item/field the way pass-cli 2.4.2 does, failing with its
// verbatim wording: vault and item titles are case-sensitive, fields are not.
function lookup(uri) {
  const [vault, item, field] = uri.slice("pass://".length).split("/");
  const entries = Object.entries(config.items ?? {}).map(([key, value]) => {
    const [v, i, f] = key.slice("pass://".length).split("/");
    return { v, i, f, value };
  });
  if (!entries.some((e) => e.v === vault)) {
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

if (args[0] === "info") {
  requireSession();
  process.stdout.write("Logged in with personal access token: paperclip-test\n");
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
