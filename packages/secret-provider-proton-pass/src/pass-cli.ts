import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Runs pass-cli for the provider: one isolated session directory, logged in
 * with an access token, with calls queued so concurrent secret resolutions do
 * not race on pass-cli's local session database.
 */

export type PassCliFailureKind =
  | "not_authenticated"
  | "not_found"
  | "timeout"
  | "cli_missing"
  | "failed";

export class PassCliError extends Error {
  readonly kind: PassCliFailureKind;
  readonly stderr: string;

  constructor(kind: PassCliFailureKind, message: string, stderr = "") {
    super(message);
    this.name = "PassCliError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

export interface PassCliOptions {
  cliPath: string;
  sessionDir: string;
  /** Returns the access token at login time, so file-based tokens can rotate. */
  readToken: () => Promise<string | null>;
  timeoutMs: number;
  maxConcurrency: number;
  /** pass-cli PROTON_PASS_KEY_PROVIDER; "fs" keeps the session key in sessionDir. */
  keyProvider: "fs" | "env" | "keyring";
  encryptionKey?: string | null;
  /** Re-login before pass-cli's 2-hour agent session lifetime runs out. */
  sessionMaxAgeMs: number;
  now?: () => number;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

// Environment passed through to pass-cli. Everything else (including
// Paperclip's own secrets such as the master key) stays out of the child.
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

const SENTINEL_FILE = ".paperclip-token-fingerprint";
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_REASON_LENGTH = 300;

const NOT_AUTHENTICATED_PATTERNS = [
  /requires an authenticated client/i,
  /there is no session/i,
  /session (has )?expired/i,
  /not logged in/i,
  /unauthori[sz]ed/i,
  /invalid session/i,
];
const NOT_FOUND_PATTERNS = [/not found/i, /no (such )?(item|vault|share|field)/i, /does not exist/i];

export function redactPassCliOutput(text: string): string {
  return text
    .replace(/pst_[A-Za-z0-9_-]+(::[A-Za-z0-9+/=_-]+)?/g, "pst_***")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .slice(0, 500);
}

export function sanitizeReason(reason: string): string {
  const collapsed = reason.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return (collapsed || "Paperclip secret access").slice(0, MAX_REASON_LENGTH);
}

function classifyFailure(stderr: string): PassCliFailureKind {
  if (NOT_AUTHENTICATED_PATTERNS.some((pattern) => pattern.test(stderr))) return "not_authenticated";
  if (NOT_FOUND_PATTERNS.some((pattern) => pattern.test(stderr))) return "not_found";
  return "failed";
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A small FIFO limiter; pass-cli is a subprocess per call. */
class Queue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class PassCli {
  private readonly queue: Queue;
  private loginInFlight: Promise<void> | null = null;
  private loggedInAt: number | null = null;
  private loggedInFingerprint: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: PassCliOptions) {
    this.queue = new Queue(Math.max(1, options.maxConcurrency));
    this.now = options.now ?? Date.now;
  }

  private childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSTHROUGH_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.PROTON_PASS_SESSION_DIR = this.options.sessionDir;
    env.PROTON_PASS_KEY_PROVIDER = this.options.keyProvider;
    if (this.options.keyProvider === "env" && this.options.encryptionKey) {
      env.PROTON_PASS_ENCRYPTION_KEY = this.options.encryptionKey;
    }
    env.PROTON_PASS_NO_UPDATE_CHECK = "1";
    env.PROTON_PASS_DISABLE_TELEMETRY = "1";
    return { ...env, ...extra };
  }

  private exec(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.options.cliPath,
        args,
        {
          env: this.childEnv(extraEnv),
          timeout: this.options.timeoutMs,
          // SIGKILL so a hung network call cannot outlive the timeout.
          killSignal: "SIGKILL",
          maxBuffer: MAX_STDOUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr });
            return;
          }
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (err.code === "ENOENT") {
            reject(new PassCliError("cli_missing", `pass-cli not found at "${this.options.cliPath}"`));
            return;
          }
          if (err.killed || err.signal === "SIGKILL") {
            reject(new PassCliError("timeout", `pass-cli timed out after ${this.options.timeoutMs}ms`));
            return;
          }
          const detail = redactPassCliOutput(stderr || stdout || "");
          reject(new PassCliError(classifyFailure(detail), detail || `pass-cli exited with ${String(err.code)}`, detail));
        },
      );
    });
  }

  private async ensureSessionDir(): Promise<void> {
    await mkdir(this.options.sessionDir, { recursive: true, mode: 0o700 });
  }

  private sentinelPath(): string {
    return path.join(this.options.sessionDir, SENTINEL_FILE);
  }

  private async storedFingerprint(): Promise<string | null> {
    try {
      return (await readFile(this.sentinelPath(), "utf8")).trim() || null;
    } catch {
      return null;
    }
  }

  private async sessionAgeMs(): Promise<number | null> {
    try {
      const info = await stat(this.sentinelPath());
      return this.now() - info.mtimeMs;
    } catch {
      return null;
    }
  }

  /** Log in with the configured token. Concurrent callers share one login. */
  async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const token = (await this.options.readToken())?.trim();
      if (!token) {
        throw new PassCliError("not_authenticated", "No Proton Pass access token is configured");
      }
      await this.ensureSessionDir();
      // Clear any stale session first; failure here is not interesting.
      await this.exec(["logout", "--force"]).catch(() => undefined);
      // The token goes through the environment, never argv (visible in ps).
      try {
        await this.exec(["login"], { PROTON_PASS_PERSONAL_ACCESS_TOKEN: token });
      } catch (error) {
        // A rejected login means the token is the problem, whatever pass-cli's
        // wording; keep timeouts and a missing binary distinct.
        if (error instanceof PassCliError && (error.kind === "timeout" || error.kind === "cli_missing")) throw error;
        throw new PassCliError(
          "not_authenticated",
          error instanceof PassCliError ? error.message : "Proton Pass login failed",
          error instanceof PassCliError ? error.stderr : "",
        );
      }
      const tokenFingerprint = fingerprint(token);
      await writeFile(this.sentinelPath(), tokenFingerprint, { encoding: "utf8", mode: 0o600 });
      this.loggedInAt = this.now();
      this.loggedInFingerprint = tokenFingerprint;
    })();
    try {
      await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
  }

  /**
   * Log in when there is no session for the current token, or when the session
   * is close to pass-cli's lifetime limit. A failed call that reports a missing
   * session still triggers one re-login and retry (see `withSession`).
   */
  private async ensureSession(): Promise<void> {
    const token = (await this.options.readToken())?.trim();
    if (!token) throw new PassCliError("not_authenticated", "No Proton Pass access token is configured");
    const currentFingerprint = fingerprint(token);
    if (this.loggedInFingerprint === currentFingerprint && this.loggedInAt !== null) {
      if (this.now() - this.loggedInAt < this.options.sessionMaxAgeMs) return;
      await this.login();
      return;
    }
    // First use in this process: reuse a session from a previous run when it
    // belongs to the same token and is still young enough.
    const stored = await this.storedFingerprint();
    const age = await this.sessionAgeMs();
    if (stored === currentFingerprint && age !== null && age < this.options.sessionMaxAgeMs) {
      this.loggedInFingerprint = currentFingerprint;
      this.loggedInAt = this.now() - age;
      return;
    }
    await this.login();
  }

  private async withSession<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureSession();
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof PassCliError) || error.kind !== "not_authenticated") throw error;
      await this.login();
      return operation();
    }
  }

  /** Read one field. Returns the raw value without pass-cli's trailing newline. */
  async readField(uri: string, reason: string): Promise<string> {
    return this.queue.run(() =>
      this.withSession(async () => {
        const { stdout } = await this.exec(["item", "view", "--", uri], {
          PROTON_PASS_AGENT_REASON: sanitizeReason(reason),
        });
        return stdout.replace(/\r?\n$/, "");
      }),
    );
  }

  /** Confirms the CLI runs and the session is usable. */
  async checkSession(): Promise<{ version: string }> {
    return this.queue.run(async () => {
      const { stdout } = await this.exec(["--version"]);
      await this.withSession(() => this.exec(["info"]));
      return { version: stdout.trim() };
    });
  }
}
