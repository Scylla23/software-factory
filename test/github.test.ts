import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import { Publisher } from "../src/factory/github";
import type { Task } from "../src/factory/store";
import { RepoClient } from "../src/github/api";
import { type AppMetadata, appJwt, assertFresh, GitHubError, InstallationToken, loadAppKey, loadAppMetadata, mintInstallationToken, TOKEN_REFRESH_MARGIN_MS, TokenSource } from "../src/github/app";
import { commitFiles } from "../src/github/commit";
import { fetchCommits } from "../src/github/fetch";
import { ensureDraftPullRequest, listComments, postComment } from "../src/github/pulls";
import { EvidenceGateError, type EvidenceSummary, fenced, publishSummary, redact, StaleEvidenceError, summaryComment, summaryMarker } from "../src/github/summary";
import type { EvidenceRecord } from "../src/verify/evidence";
import { VIEWPORTS } from "../src/verify/evidence";
import { check } from "../src/verify/verdict";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const META: AppMetadata = { appId: 5820335, installationId: 183396381, slug: "software-factory-9f09" };
const TOKEN_VALUE = "ghs_FAKEtoken0123456789abcdefABCDEF0123";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake GitHub: `routes` maps "METHOD path" (path without query) to a status and body, or a function of the call. */
function fakeGitHub(routes: Record<string, (call: Call) => [number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const call: Call = { method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(url).pathname;
    const route = routes[`${call.method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: `no route ${call.method} ${path}` }), { status: 599 });
    const [status, body] = route(call);
    return new Response(body === null ? null : JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

const token = (repos = ["factory-pilot"]) => new InstallationToken(TOKEN_VALUE, new Date(Date.now() + 3_600_000), repos, { contents: "write" });
const tokens = (repos = ["factory-pilot"]) => ({ get: async () => token(repos) });
/** A clock fixed at the fake token responses' issue time. */
const NOW = Date.parse("2026-11-19T07:00:00Z");

describe("App auth", () => {
  test("appJwt is an RS256 JWT for the app, backdated for skew and short-lived", () => {
    const now = 1_800_000_000;
    const [h, p, sig] = appJwt(META.appId, privateKey, now).split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: now - 60, exp: now + 540, iss: "5820335" });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  test("loadAppKey decodes the base64 PEM from the keychain for the app id, and never echoes a bad secret", () => {
    const asked: string[][] = [];
    const key = loadAppKey(META, (service, account) => {
      asked.push([service, account]);
      return Buffer.from(PEM).toString("base64");
    });
    expect(key.asymmetricKeyType).toBe("rsa");
    expect(asked).toEqual([["software-factory.github-app.pem", "5820335"]]);
    let message = "";
    try {
      loadAppKey(META, () => "U0VDUkVULU5PVC1BLUtFWQ==");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("does not hold a base64 PEM private key");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("U0VDUkVU");
  });

  test("loadAppMetadata validates the file and refuses one others can write", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-meta-"));
    try {
      const f = join(dir, "github-app.json");
      writeFileSync(f, JSON.stringify({ id: 5820335, installation_id: 183396381, slug: "software-factory-9f09", client_id: "x" }), { mode: 0o600 });
      expect(loadAppMetadata(dir)).toEqual(META);
      chmodSync(f, 0o666);
      expect(() => loadAppMetadata(dir)).toThrow("group or world writable");
      writeFileSync(f, JSON.stringify({ id: "5820335", installation_id: 1, slug: "s" }), { mode: 0o600 });
      chmodSync(f, 0o600);
      expect(() => loadAppMetadata(dir)).toThrow("numeric id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mints a token scoped to the named repos and permissions, with the JWT as bearer", async () => {
    const gh = fakeGitHub({
      "POST /app/installations/183396381/access_tokens": () => [201, { token: TOKEN_VALUE, expires_at: "2026-11-19T08:00:00Z", permissions: { contents: "write", metadata: "read" } }],
    });
    const t = await mintInstallationToken(META, privateKey, { repositories: ["factory-pilot"], permissions: { contents: "write" } }, gh.fetchImpl, () => NOW);
    expect(t.secret()).toBe(TOKEN_VALUE);
    expect(t.repositories).toEqual(["factory-pilot"]);
    const call = gh.calls[0]!;
    expect(call.body).toEqual({ repositories: ["factory-pilot"], permissions: { contents: "write" } });
    const jwt = call.headers.Authorization!.replace(/^Bearer /, "");
    const [h, p, sig] = jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  test("refuses a token that lacks a requested permission, an unscoped request, and reports errors without bodies", async () => {
    const lacking = fakeGitHub({ "POST /app/installations/183396381/access_tokens": () => [201, { token: TOKEN_VALUE, expires_at: "2026-11-19T08:00:00Z", permissions: { contents: "read" } }] });
    const err = await mintInstallationToken(META, privateKey, { repositories: ["factory-pilot"], permissions: { contents: "write" } }, lacking.fetchImpl, () => NOW).catch((e) => e);
    expect(err.message).toContain("token lacks contents:write");
    expect(err.message).not.toContain(TOKEN_VALUE);
    await expect(mintInstallationToken(META, privateKey, { repositories: [], permissions: {} }, lacking.fetchImpl)).rejects.toThrow("named repositories");
    const denied = fakeGitHub({ "POST /app/installations/183396381/access_tokens": () => [422, { message: "permissions exceed installation", token: TOKEN_VALUE }] });
    const e2 = await mintInstallationToken(META, privateKey, { repositories: ["factory-pilot"], permissions: { contents: "write" } }, denied.fetchImpl, () => NOW).catch((e) => e);
    expect(e2).toBeInstanceOf(GitHubError);
    expect(e2.message).toBe("POST /app/installations/183396381/access_tokens -> 422: permissions exceed installation");
  });

  test("a token that is already expired, by the injected clock, is refused at minting", async () => {
    const gh = fakeGitHub({ "POST /app/installations/183396381/access_tokens": () => [201, { token: TOKEN_VALUE, expires_at: "2026-11-19T08:00:00Z", permissions: { contents: "write" } }] });
    await expect(mintInstallationToken(META, privateKey, { repositories: ["factory-pilot"], permissions: { contents: "write" } }, gh.fetchImpl, () => Date.parse("2026-11-19T08:00:01Z"))).rejects.toThrow("already expired");
    const jwt = (gh.calls[0]!.headers.Authorization ?? "").replace(/^Bearer /, "").split(".")[1]!;
    expect(JSON.parse(Buffer.from(jwt, "base64url").toString()).iat).toBe(Date.parse("2026-11-19T08:00:01Z") / 1000 - 60); // the JWT uses the same clock
  });

  test("TokenSource reuses a token until the refresh margin, then mints a new one; concurrent callers share one mint", async () => {
    let now = NOW;
    let minted = 0;
    const src = new TokenSource(async () => new InstallationToken(`t${++minted}`, new Date(now + 3_600_000), ["factory-pilot"], {}), () => now);
    const a = await src.get();
    now += 3_600_000 - TOKEN_REFRESH_MARGIN_MS - 1_000;
    expect(await src.get()).toBe(a);
    now += 2_000; // now inside the margin
    const [b, c] = await Promise.all([src.get(), src.get()]);
    expect(b).not.toBe(a);
    expect(b).toBe(c);
    expect(minted).toBe(2);
    const stale = new TokenSource(async () => new InstallationToken("x", new Date(now + 60_000), ["factory-pilot"], {}), () => now);
    await expect(stale.get()).rejects.toThrow("within the refresh margin");
  });

  test("an expired token is never used: not for git, and not for an API call", async () => {
    const expired = new InstallationToken(TOKEN_VALUE, new Date(NOW - 1), ["factory-pilot"], {});
    expect(() => assertFresh(expired, () => NOW)).toThrow("expired");
    expect(() => fetchCommits("/usr/bin/false", "/nonexistent", "Scylla23", "factory-pilot", [SHA(1)], expired, () => NOW)).toThrow("expired");
    const gh = fakeGitHub({});
    const c = new RepoClient("Scylla23", "factory-pilot", new TokenSource(async () => expired, () => NOW), gh.fetchImpl);
    await expect(c.request("GET", "/repos/Scylla23/factory-pilot/x")).rejects.toThrow("expired");
    expect(gh.calls).toHaveLength(0);
  });

  test("a token never prints: string, JSON, template, and inspect are all redacted", () => {
    const t = token();
    for (const shown of [String(t), JSON.stringify({ t }), `${t}`, inspect(t), inspect({ t })]) expect(shown).not.toContain(TOKEN_VALUE);
  });
});

describe("RepoClient", () => {
  test("refuses a repo the token is not scoped to, and errors carry GitHub's message but never the token", async () => {
    await expect(new RepoClient("Scylla23", "other", tokens()).request("GET", "/x")).rejects.toThrow("not scoped to other");
    const gh = fakeGitHub({
      "GET /repos/Scylla23/factory-pilot/x": () => [403, { message: "Resource not accessible by integration" }],
      "GET /repos/Scylla23/factory-pilot/y": () => [404, { message: "Not Found" }],
    });
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    const err = (await c.request("GET", "/repos/Scylla23/factory-pilot/x").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("GET /repos/Scylla23/factory-pilot/x -> 403: Resource not accessible by integration");
    expect(gh.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN_VALUE}`);
    expect(await c.request("GET", "/repos/Scylla23/factory-pilot/y", undefined, { allow404: true })).toBeNull();
    await expect(c.request("GET", "/repos/Scylla23/factory-pilot/y")).rejects.toThrow("-> 404: Not Found");
  });
});

const SHA = (n: number) => n.toString(16).padStart(40, "0");

/** Git Data API routes for one branch, starting at `head` (null: absent). */
function gitRoutes(branch: string, state: { head: string | null; refUpdates: unknown[]; failNextUpdate?: boolean }) {
  let n = 100;
  const base = "/repos/Scylla23/factory-pilot";
  return {
    [`POST ${base}/git/blobs`]: () => [201, { sha: SHA(++n) }] as [number, unknown],
    [`GET ${base}/git/ref/heads/${branch}`]: () => (state.head ? [200, { object: { sha: state.head } }] : [404, { message: "Not Found" }]) as [number, unknown],
    [`GET ${base}/git/commits/${SHA(1)}`]: () => [200, { tree: { sha: SHA(11) } }] as [number, unknown],
    [`GET ${base}/git/commits/${SHA(2)}`]: () => [200, { tree: { sha: SHA(12) } }] as [number, unknown],
    [`POST ${base}/git/trees`]: () => [201, { sha: SHA(++n) }] as [number, unknown],
    [`POST ${base}/git/commits`]: () => [201, { sha: SHA(++n) }] as [number, unknown],
    [`PATCH ${base}/git/refs/heads/${branch}`]: (c: Call) => {
      state.refUpdates.push(c.body);
      if (state.failNextUpdate) {
        state.failNextUpdate = false;
        state.head = SHA(2); // someone else moved it
        return [422, { message: "Update is not a fast forward" }] as [number, unknown];
      }
      return [200, {}] as [number, unknown];
    },
    [`POST ${base}/git/refs`]: (c: Call) => {
      state.refUpdates.push(c.body);
      return [201, {}] as [number, unknown];
    },
  };
}

describe("commitFiles", () => {
  test("creates a missing branch as an orphan when asked, with no parents and no base tree", async () => {
    const state = { head: null, refUpdates: [] as unknown[] };
    const gh = fakeGitHub(gitRoutes("some-branch", state));
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    const r = await commitFiles(c, { branch: "some-branch", message: "m", startFrom: null, files: [{ path: "pr-1/a.png", content: new Uint8Array([1, 2]) }] });
    expect(r.parentSha).toBeNull();
    const tree = gh.calls.find((x) => x.url.endsWith("/git/trees"))!.body as Record<string, unknown>;
    expect(tree.base_tree).toBeUndefined();
    expect((gh.calls.find((x) => x.url.endsWith("/git/commits") && x.method === "POST")!.body as Record<string, unknown>).parents).toEqual([]);
    expect(state.refUpdates).toEqual([{ ref: "refs/heads/some-branch", sha: r.commitSha }]);
    expect((gh.calls[0]!.body as Record<string, unknown>).content).toBe(Buffer.from([1, 2]).toString("base64"));
  });

  test("fast-forwards an existing branch, never forcing, and rebuilds once on the new head when it moved", async () => {
    const state = { head: SHA(1), refUpdates: [] as unknown[], failNextUpdate: true };
    const gh = fakeGitHub(gitRoutes("some-branch", state));
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    const r = await commitFiles(c, { branch: "some-branch", message: "m", startFrom: null, files: [{ path: "a.png", content: new Uint8Array([1]) }] });
    expect(r.parentSha).toBe(SHA(2));
    expect(state.refUpdates).toHaveLength(2);
    for (const u of state.refUpdates) expect((u as Record<string, unknown>).force).toBe(false);
    const commits = gh.calls.filter((x) => x.url.endsWith("/git/commits") && x.method === "POST").map((x) => (x.body as Record<string, unknown>).parents);
    expect(commits).toEqual([[SHA(1)], [SHA(2)]]);
    expect(gh.calls.filter((x) => x.url.endsWith("/git/blobs"))).toHaveLength(1); // blobs are not re-uploaded
  });

  test("expected parent forbids rebasing a publication after a 422", async () => {
    const state = { head: SHA(1), refUpdates: [] as unknown[], failNextUpdate: true };
    const gh = fakeGitHub(gitRoutes("b", state));
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    await expect(commitFiles(c, { branch: "b", message: "m", startFrom: SHA(1), expectedHead: SHA(1),
      files: [{ path: "a", content: new Uint8Array() }] })).rejects.toThrow("422");
    expect(state.refUpdates).toHaveLength(1);
    await expect(commitFiles(c, { branch: "b", message: "m", startFrom: SHA(1), expectedHead: SHA(1),
      files: [{ path: "a", content: new Uint8Array() }] })).rejects.toThrow("branch moved");
    expect(state.refUpdates).toHaveLength(1);
  });

  test("gives up after one rebuild instead of looping", async () => {
    const state = { head: SHA(1), refUpdates: [] as unknown[], failNextUpdate: true };
    const routes = gitRoutes("b", state);
    routes["PATCH /repos/Scylla23/factory-pilot/git/refs/heads/b"] = () => [422, { message: "Update is not a fast forward" }];
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), fakeGitHub(routes).fetchImpl);
    await expect(commitFiles(c, { branch: "b", message: "m", startFrom: null, files: [{ path: "a", content: new Uint8Array() }] })).rejects.toThrow("not a fast forward");
  });

  test("refuses unsafe paths and branch names before any call", async () => {
    const gh = fakeGitHub({});
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    for (const path of ["../x", "/abs", "a//b", "a/./b", "a b", "a/../b"]) {
      await expect(commitFiles(c, { branch: "b", message: "m", startFrom: null, files: [{ path, content: new Uint8Array() }] })).rejects.toThrow("plain repo path");
    }
    for (const branch of ["-x", "a..b", "a/", "a b"]) {
      await expect(commitFiles(c, { branch, message: "m", startFrom: null, files: [{ path: "a", content: new Uint8Array() }] })).rejects.toThrow("branch name");
    }
    expect(gh.calls).toHaveLength(0);
  });
});

function record(name: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    acId: "AC-1", name, commitSha: SHA(9), url: "http://127.0.0.1:4100/", origin: "http://127.0.0.1:4100", browserEgress: "unrestricted", externalOrigins: [], viewport: VIEWPORTS.desktop, screenshotPath: "/dev/null", screenshotSha256: "a".repeat(64), screenshotBytes: 1,
    consoleErrors: [], networkFailures: [], pageText: "", truncated: { console: false, network: false, pageText: false }, stabilized: null, capturedAt: "t", ...extra,
  };
}
const ATTEMPT = "0deacd2c-d259-4aa7-830e-93dd0ec2c2dd";
const BOT = "software-factory-9f09[bot]";
const summary = (extra: Partial<EvidenceSummary> = {}): EvidenceSummary => ({
  pr: 1,
  attemptId: ATTEMPT,
  base: SHA(8),
  head: SHA(9),
  checks: [check("canary probe", true, "all DENIED"), check("before and after differ", true)],
  captures: [record("before-desktop", { commitSha: SHA(8) }), record("after-desktop")],
  evidenceDir: `${require("node:os").homedir()}/.software-factory/evidence/${ATTEMPT}`,
  ...extra,
});

describe("evidence summary comment", () => {
  test("text only: the marker with the captured revisions, the checks, and per capture its commit, viewport, counts, and hash", () => {
    const body = summaryComment(summary());
    expect(body.startsWith(`<!-- factory:evidence pr=1 attempt=${ATTEMPT} base=${SHA(8)} head=${SHA(9)} capture=${SHA(9)} -->\n### Verification: passed\n`)).toBe(true);
    expect(body).toContain("| canary probe | pass |");
    expect(body).toContain(`| after-desktop | \`${SHA(9).slice(0, 12)}\` head | desktop 1440x900@1 | 0 | 0 | 0 | \`${"a".repeat(64)}\` |`);
    expect(body).toContain(`| before-desktop | \`${SHA(8).slice(0, 12)}\` base |`);
    expect(body).toContain(`\`~/.software-factory/evidence/${ATTEMPT}\``);
    expect(body).toContain("Browser egress during capture was unrestricted");
    expect(body).not.toContain(require("node:os").homedir());
    for (const bad of ["<img", "](http", "blob/", "?raw=true"]) expect(body).not.toContain(bad);
  });

  test("diagnostics are redacted and capped: no query strings, tokens, emails, or home path, and page text is bounded", () => {
    const home = require("node:os").homedir();
    const r = record("after-desktop", {
      url: "http://127.0.0.1:4100/?token=SECRETQUERY#frag",
      consoleErrors: [`failed https://api.example/v1?sig=SIGNEDURL ghp_${"A".repeat(36)} for me@example.com in ${home}/x`],
      networkFailures: [{ url: "https://cdn.example/a.js?k=QUERYKEY", method: "GET", status: 404 }],
      pageText: `key ${"Z9".repeat(30)} ${"word ".repeat(1_000)}`,
    });
    const body = summaryComment(summary({ captures: [record("before-desktop", { commitSha: SHA(8) }), r] }));
    for (const secret of ["SECRETQUERY", "frag", "SIGNEDURL", `ghp_${"A".repeat(36)}`, "me@example.com", home, "QUERYKEY", "Z9Z9Z9Z9"]) expect(body).not.toContain(secret);
    expect(body).toContain("http://127.0.0.1:4100/?[redacted]");
    expect(body).toContain("[email]");
    expect(body).toContain("more characters]");
    expect(body.length).toBeLessThan(20_000);
  });

  test("page-derived text stays inert inside a fence it cannot close: no mentions, links, markers, or approvals", () => {
    const hostile = ["```", "</details>", "@Scylla23 /approve abc", "<!-- factory:evidence pr=1 -->", "![x](https://evil.example/p.png)", "````` five"].join("\n");
    const body = summaryComment(summary({ captures: [record("before-desktop", { commitSha: SHA(8) }), record("after-desktop", { consoleErrors: [hostile], pageText: hostile })] }));
    const fence = body.match(/\n(`{3,})text\n/)![1]!;
    expect(fence.length).toBeGreaterThan(5);
    const start = body.indexOf(`${fence}text\n`);
    const end = body.indexOf(`\n${fence}\n`, start);
    const outside = body.slice(0, start) + body.slice(end + fence.length + 2);
    for (const bad of ["@Scylla23", "/approve", "evil.example"]) expect(outside).not.toContain(bad);
    expect(outside.match(/<!-- factory:/g)).toHaveLength(1);
    expect(fenced("x ```` y")).toBe("`````text\nx ```` y\n`````");
  });

  test("redact strips what it must and keeps plain words", () => {
    expect(redact("GET http://h:1/p?a=1")).toBe("GET http://h:1/p?[redacted]");
    expect(redact(`AKIA${"A".repeat(16)} eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl`)).toBe("[redacted] [redacted]");
    expect(redact("plain words stay")).toBe("plain words stay");
    const home = require("node:os").homedir();
    expect(redact(`DENIED ${home}/Library/Keychains/login.keychain-db`)).toBe("DENIED ~/Library/Keychains/login.keychain-db");
    const user = require("node:os").userInfo().username;
    expect(redact(`-rw------- 1 ${user} staff 12 x; ${user}.bak; me${user}`)).toBe("-rw------- 1 [user] staff 12 x; [user].bak; me[user]");
    expect(redact("ab ".repeat(100), 10)).toBe("ab ab ab a [... 290 more characters]");
  });

  test("captures must be bound to the recorded base or head, with at least one of the head", () => {
    expect(() => summaryComment(summary({ captures: [record("x", { commitSha: SHA(7) })] }))).toThrow("neither the recorded base nor head");
    expect(() => summaryComment(summary({ captures: [record("x", { commitSha: SHA(8) })] }))).toThrow("no capture is of the PR head");
    expect(() => summaryComment(summary({ captures: [record("a"), record("a")] }))).toThrow("duplicate capture");
    expect(() => summaryComment(summary({ captures: [record("A|b")] }))).toThrow("capture name");
    expect(() => summaryComment(summary({ head: "abc" }))).toThrow("full commit ids");
    expect(summaryMarker(summary())).toContain(`capture=${SHA(9)}`);
  });
});

/** A fake PR with comments, for publishSummary. */
function prRoutes(state: { head: string; base: string; comments: { id: number; body: string; user: { login: string } }[]; loseNextPost?: boolean }) {
  const base = "/repos/Scylla23/factory-pilot";
  let n = 500;
  return {
    [`GET ${base}/pulls/1`]: () => [200, { number: 1, html_url: "u", head: { sha: state.head }, base: { sha: state.base, ref: "spike/verify-base" }, draft: true }] as [number, unknown],
    [`GET ${base}/issues/1/comments`]: () => [200, state.comments.map((c) => ({ ...c, html_url: `u#${c.id}` }))] as [number, unknown],
    [`POST ${base}/issues/1/comments`]: (c: Call) => {
      const made = { id: ++n, body: (c.body as { body: string }).body, user: { login: BOT } };
      state.comments.push(made);
      if (state.loseNextPost) {
        state.loseNextPost = false;
        return [502, { message: "Bad Gateway" }] as [number, unknown]; // created, but the answer is lost
      }
      return [201, { ...made, html_url: `u#${made.id}` }] as [number, unknown];
    },
    ...Object.fromEntries(
      [7, 501].map((id) => [
        `PATCH ${base}/issues/comments/${id}`,
        (c: Call) => {
          const hit = state.comments.find((x) => x.id === id)!;
          hit.body = (c.body as { body: string }).body;
          return [200, { ...hit, html_url: `u#${id}` }] as [number, unknown];
        },
      ]),
    ),
  };
}

describe("publishSummary", () => {
  test("a failed required check prevents publishing: no GitHub call at all", async () => {
    const gh = fakeGitHub({});
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    const s = summary({ checks: [check("canary probe", false, "READABLE ~/.ssh/id"), check("before and after differ", true)] });
    await expect(publishSummary(c, s, { botLogin: BOT })).rejects.toBeInstanceOf(EvidenceGateError);
    await expect(publishSummary(c, summary({ checks: [] }), { botLogin: BOT })).rejects.toThrow("no checks ran");
    expect(gh.calls).toHaveLength(0);
  });

  test("a PR whose head or base moved since capture gets nothing", async () => {
    const state = { head: SHA(10), base: SHA(8), comments: [] };
    const gh = fakeGitHub(prRoutes(state));
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    await expect(publishSummary(c, summary(), { botLogin: BOT })).rejects.toBeInstanceOf(StaleEvidenceError);
    state.head = SHA(9);
    state.base = SHA(3);
    await expect(publishSummary(c, summary(), { botLogin: BOT })).rejects.toThrow("moved since capture");
    expect(gh.calls.some((x) => x.method !== "GET")).toBe(false);
  });

  test("posts once; a retry after a lost answer updates that comment instead of adding another", async () => {
    const state = { head: SHA(9), base: SHA(8), comments: [] as { id: number; body: string; user: { login: string } }[], loseNextPost: true };
    const gh = fakeGitHub(prRoutes(state));
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    await expect(publishSummary(c, summary(), { botLogin: BOT })).rejects.toThrow("502");
    const r = await publishSummary(c, summary(), { botLogin: BOT });
    expect(r).toEqual({ id: 501, htmlUrl: "u#501", updated: true });
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]!.body.startsWith(summaryMarker(summary()))).toBe(true);
  });

  test("only the App's own comment for this attempt is updated; a copied marker by someone else is ignored", async () => {
    const state = {
      head: SHA(9),
      base: SHA(8),
      comments: [
        { id: 7, body: `${summaryMarker(summary())}\nforged`, user: { login: "Scylla23" } },
        { id: 8, body: summaryMarker({ ...summary(), attemptId: "11111111-2222-4333-8444-555555555555" }), user: { login: BOT } },
      ],
    };
    const gh = fakeGitHub(prRoutes(state));
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    const r = await publishSummary(c, summary(), { botLogin: BOT });
    expect(r.updated).toBe(false);
    expect(state.comments.map((x) => x.id)).toEqual([7, 8, 501]);
    expect(state.comments[0]!.body).toContain("forged");
  });

  test("listComments reads every page and refuses a PR too long to read whole", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, html_url: "u", body: "", user: { login: "x" } }));
    let pages = 0;
    const gh = fakeGitHub({ "GET /repos/Scylla23/factory-pilot/issues/1/comments": () => [200, ++pages < 3 ? page(100) : page(5)] });
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    expect(await listComments(c, 1)).toHaveLength(205);
    const endless = fakeGitHub({ "GET /repos/Scylla23/factory-pilot/issues/1/comments": () => [200, page(100)] });
    await expect(listComments(new RepoClient("Scylla23", "factory-pilot", tokens(), endless.fetchImpl), 1)).rejects.toThrow("more than 2000 comments");
    expect(endless.calls).toHaveLength(20);
  });
});

describe("pulls", () => {
  test("ensureDraftPullRequest reuses an open PR from the branch and otherwise opens a draft", async () => {
    const pr = { number: 1, html_url: "u", head: { sha: SHA(3) }, base: { sha: SHA(4), ref: "main" }, draft: true };
    let open: unknown[] = [pr];
    const gh = fakeGitHub({
      "GET /repos/Scylla23/factory-pilot/pulls": () => [200, open],
      "POST /repos/Scylla23/factory-pilot/pulls": () => [201, { ...pr, number: 2 }],
    });
    const c = new RepoClient("Scylla23", "factory-pilot", tokens(), gh.fetchImpl);
    expect(await ensureDraftPullRequest(c, { head: "b", base: "main", title: "t", body: "x" })).toEqual({ pull: { number: 1, htmlUrl: "u", headSha: SHA(3), baseSha: SHA(4), baseRef: "main", draft: true }, created: false });
    expect(new URL(gh.calls[0]!.url).searchParams.get("head")).toBe("Scylla23:b");
    open = [];
    const r = await ensureDraftPullRequest(c, { head: "b", base: "main", title: "t", body: "x" });
    expect(r.created).toBe(true);
    expect((gh.calls.at(-1)!.body as { draft: boolean }).draft).toBe(true);
    await expect(postComment(c, 1, "x".repeat(65_001))).rejects.toThrow("65536");
  });
});

describe("factory publisher", () => {
  const root = "/repos/Scylla23/factory-pilot";
  const app = { slug: "fixture", tokens };
  const task = { id: 1, issue: { number: 4, issueId: 22, title: "stock" }, pr: 5, base: SHA(1), head: SHA(2), state: "building" } as Task;
  test("adopts exactly its commit tree, parent and marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-publisher-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["/usr/bin/git", "-C", dir, "-c", "user.name=Fixture", "-c", "user.email=t@example.invalid", ...args]);
      if (r.exitCode) throw Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    try {
      git("init", "-q"); git("commit", "--allow-empty", "-qm", "base");
      const parent = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "app.ts"), "fixed"); git("add", "app.ts"); git("commit", "-qm", "patch");
      const match = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "extra"), "unplanned"); git("add", "extra"); git("commit", "--amend", "--no-edit", "-q");
      const extra = git("rev-parse", "HEAD");
      let tip = match, remoteParent = parent;
      const message = "fix: stock\n\nFactory-Task: github-22\nFactory-Agent: builder\nFactory-Attempt: attempt";
      let remoteMessage = message;
      const commit = (): [number, unknown] => [200, { message: remoteMessage, parents: [{ sha: remoteParent }] }];
      const gh = fakeGitHub({ [`GET ${root}/git/ref/heads/factory/issue-4`]: () => [200, { object: { sha: tip } }],
        [`GET ${root}/git/commits/${match}`]: commit, [`GET ${root}/git/commits/${extra}`]: commit });
      const publisher = new Publisher({ ...app, tokens: () => tokens() }, dir, gh.fetchImpl);
      publisher.fetch = async () => {}; // Both immutable trees are already in this private checkout.
      const adopt = (content = "fixed") => publisher.commit(task, "attempt", "fix: stock", [{ path: "app.ts", content: Buffer.from(content) }], parent);
      expect(await adopt()).toBe(match);
      await expect(adopt("wrong blob")).rejects.toThrow("foreign");
      tip = extra; await expect(adopt()).rejects.toThrow("foreign");
      tip = match; remoteParent = extra; await expect(adopt()).rejects.toThrow("foreign");
      remoteParent = parent; remoteMessage = "foreign tip"; await expect(adopt()).rejects.toThrow("foreign");
      expect(gh.calls.every(c => c.method === "GET")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("adopts an existing marked draft, comment and already-ready head", async () => {
    const pull = { number: 5, html_url: "url", state: "open", draft: true, head: { sha: task.head }, base: { ref: "main", sha: task.base },
      user: { login: "fixture[bot]" }, body: "" };
    const remote: typeof pull[] = [];
    const comments: {id: number; html_url: string; body: string; user: { login: string }}[] = [];
    const gh = fakeGitHub({
      [`GET ${root}/pulls`]: () => [200, remote],
      [`POST ${root}/pulls`]: c => { pull.body = (c.body as {body:string}).body; remote.push(pull); return [201, pull]; },
      [`GET ${root}/pulls/5`]: () => [200, pull],
      [`GET ${root}/git/ref/heads/factory/issue-4`]: () => [200, { object: { sha: task.head } }],
      [`GET ${root}/issues/5/comments`]: () => [200, comments],
      [`POST ${root}/issues/5/comments`]: c => {
        const item = { id: 70, html_url: "url", body: (c.body as {body:string}).body, user: pull.user }; comments.push(item); return [201,item];
      },
    });
    const publisher = new Publisher({ ...app, tokens: () => tokens() }, "/unused", gh.fetchImpl);
    expect(await publisher.draft(task, "one", task.head)).toBe(5);
    expect(pull.body).toContain("Fixes #4");
    expect(await publisher.draft(task, "one", task.head)).toBe(5);
    await expect(publisher.draft(task, "foreign", task.head)).rejects.toThrow("identity");
    expect(await publisher.comment(5, "two", "hello")).toBe(70);
    expect(await publisher.comment(5, "two", "hello")).toBe(70);
    pull.draft = false;
    await publisher.ready(task);
    expect(gh.calls.filter(c => c.method !== "GET")).toHaveLength(2);
    expect(comments).toHaveLength(1);
  });
  test("the GitHub review boundary uses the later of ready and the published evidence", async () => {
    let ready = "2026-01-01T00:00:00Z";
    const summary = "2026-01-02T00:00:00Z";
    const gh = fakeGitHub({
      [`GET ${root}/issues/5/timeline`]: () => [200, [{ event: "ready_for_review", created_at: ready }]],
      [`GET ${root}/issues/comments/72`]: () => [200, { updated_at: summary }],
    });
    const publisher = new Publisher({ ...app, tokens: () => tokens() }, "/unused", gh.fetchImpl);
    expect(Date.parse(await publisher.reviewBoundary(task,72))).toBe(Date.parse(summary));
    ready = "2026-01-03T00:00:00Z";
    expect(Date.parse(await publisher.reviewBoundary(task,72))).toBe(Date.parse(ready));
    ready = ""; await expect(publisher.reviewBoundary(task,72)).rejects.toThrow("timestamps");
  });
  test("command comment edit history includes same-second edits and fails closed on disagreement", async () => {
    const date = "2026-01-01T00:00:00Z";
    const command = { id: 72, node_id: "node1", body: "/approve " + task.head, html_url: "url",
      created_at: date, updated_at: date, user: { id: 7, login: "fixture" } };
    let body = command.body;
    const gh = fakeGitHub({ [`GET ${root}/issues/5/comments`]: () => [200, [command]],
      "POST /graphql": () => [200, { data: { nodes: [{ id: command.node_id, body, lastEditedAt: date }] } }] });
    const publisher = new Publisher({ ...app, tokens: () => tokens() }, "/unused", gh.fetchImpl);
    expect((await publisher.comments(5))[0]?.lastEditedAt).toBe(date);
    body = "different"; expect((await publisher.comments(5))[0]?.lastEditedAt).toBeUndefined();
  });
});
