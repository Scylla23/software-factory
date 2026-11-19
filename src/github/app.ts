/**
 * GitHub App authentication: the private key from macOS Keychain, an RS256 app JWT, and short-lived installation
 * tokens scoped to the repositories and permissions one operation needs.
 *
 * Secrets never leave this module as plain values that print: the key is only ever a KeyObject, and a token is an
 * `InstallationToken` whose string, JSON, and inspect forms are redacted. Error messages carry GitHub's status and
 * message, never a request header or the token response body.
 */
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../dispatch/jsonl";

export const GITHUB_API = "https://api.github.com";
/** Keychain service that holds the App's private key, base64 encoded, with the app id as the account. */
export const KEYCHAIN_PEM_SERVICE = "software-factory.github-app.pem";
const SECURITY = "/usr/bin/security";
const KEYCHAIN_TIMEOUT_MS = 10_000;
export const GITHUB_TIMEOUT_MS = 30_000;

/** Non-secret App metadata from `<stateRoot>/github-app.json`. */
export interface AppMetadata {
  appId: number;
  installationId: number;
  slug: string;
}

export function loadAppMetadata(stateRoot: string): AppMetadata {
  const path = join(stateRoot, "github-app.json");
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.uid !== process.getuid!()) throw new Error(`${path} is owned by uid ${st.uid}`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${path} is group or world writable`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`${path}: not a JSON object`);
  const { id, installation_id, slug } = raw;
  if (!isPositiveInt(id) || !isPositiveInt(installation_id) || typeof slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(slug)) {
    throw new Error(`${path}: needs a numeric id and installation_id and a slug`);
  }
  return { appId: id, installationId: installation_id, slug };
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** Reads the base64 secret for `service`/`account`; injectable so tests never touch the owner's keychain. */
export type KeychainReader = (service: string, account: string) => string;

/** `security find-generic-password -w`, by absolute path, with a fixed env and a bound. The secret goes to a pipe only. */
export const readKeychain: KeychainReader = (service, account) => {
  const r = Bun.spawnSync([SECURITY, "find-generic-password", "-s", service, "-a", account, "-w"], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: KEYCHAIN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.exitedDueToTimeout) throw new Error(`keychain read of ${service} gave no answer within ${KEYCHAIN_TIMEOUT_MS}ms`);
  // stderr names the item and the failure, never the secret.
  if (r.exitCode !== 0) throw new Error(`keychain read of ${service} failed (exit ${r.exitCode}): ${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString().trim();
};

/** The App's private key, decoded from Keychain. Throws without echoing any of the secret. */
export function loadAppKey(meta: AppMetadata, keychain: KeychainReader = readKeychain): KeyObject {
  const encoded = keychain(KEYCHAIN_PEM_SERVICE, String(meta.appId));
  let key: KeyObject;
  try {
    key = createPrivateKey(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error(`keychain item ${KEYCHAIN_PEM_SERVICE} does not hold a base64 PEM private key`);
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error(`keychain item ${KEYCHAIN_PEM_SERVICE} is not an RSA key`);
  return key;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * The App JWT: RS256, issued 60 seconds in the past against clock skew, expiring after 9 minutes (GitHub caps it at 10).
 */
export function appJwt(appId: number, key: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const head = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }))}`;
  return `${head}.${b64url(sign("RSA-SHA256", Buffer.from(head), key))}`;
}

const REDACTED = "[redacted installation token]";

/** An installation token that cannot be printed by accident; `secret()` is the only way to the value. */
export class InstallationToken {
  readonly #value: string;
  constructor(value: string, readonly expiresAt: Date, readonly repositories: readonly string[], readonly permissions: Readonly<Record<string, string>>) {
    this.#value = value;
  }
  secret(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A failed GitHub call: method, path, status, and GitHub's own message only. */
export class GitHubError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/** GitHub's `message` field, or a placeholder; never the raw body, which for a token response holds the token. */
export async function githubMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && typeof body.message === "string") return body.message.slice(0, 300);
  } catch {
    // not JSON
  }
  return "(no message)";
}

export interface TokenRequest {
  /** Repository names (not owner/name) the token is limited to. */
  repositories: readonly string[];
  /** A subset of the App's permissions, such as `{ contents: "write" }`. */
  permissions: Readonly<Record<string, "read" | "write">>;
}

/**
 * Mints an installation token limited to the given repositories and permissions.
 * GitHub refuses a request for more than the installation has, so a narrower scope is never silently widened.
 */
export async function mintInstallationToken(meta: AppMetadata, key: KeyObject, request: TokenRequest, fetchImpl: Fetch = fetch): Promise<InstallationToken> {
  if (request.repositories.length === 0) throw new Error("an installation token must be limited to named repositories");
  for (const r of request.repositories) if (!/^[A-Za-z0-9._-]{1,100}$/.test(r)) throw new Error(`not a repository name: ${JSON.stringify(r)}`);
  const path = `/app/installations/${meta.installationId}/access_tokens`;
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: { ...baseHeaders(), Authorization: `Bearer ${appJwt(meta.appId, key)}` },
    body: JSON.stringify({ repositories: request.repositories, permissions: request.permissions }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    redirect: "error",
  });
  if (res.status !== 201) throw new GitHubError(`POST ${path} -> ${res.status}: ${await githubMessage(res)}`, res.status);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new GitHubError(`POST ${path}: unexpected token response shape`, res.status);
  }
  const expiresAt = new Date(body.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) throw new GitHubError(`POST ${path}: unreadable expires_at`, res.status);
  const permissions: Record<string, string> = {};
  if (isRecord(body.permissions)) for (const [k, v] of Object.entries(body.permissions)) if (typeof v === "string") permissions[k] = v;
  for (const [k, v] of Object.entries(request.permissions)) {
    if (permissions[k] !== v) throw new GitHubError(`POST ${path}: token lacks ${k}:${v}`, res.status);
  }
  return new InstallationToken(body.token, expiresAt, request.repositories, permissions);
}

export function baseHeaders(): Record<string, string> {
  return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "software-factory" };
}
