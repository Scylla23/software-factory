import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import { RepoClient } from "../src/github/api";
import { type AppMetadata, appJwt, GitHubError, InstallationToken, loadAppKey, loadAppMetadata, mintInstallationToken } from "../src/github/app";
import { commitFiles } from "../src/github/commit";
import { EVIDENCE_BRANCH, evidenceComment, type EvidenceSet, fenced, publishEvidence } from "../src/github/evidence";
import { ensureDraftPullRequest, postComment } from "../src/github/pulls";
import type { EvidenceRecord } from "../src/verify/evidence";
import { VIEWPORTS } from "../src/verify/evidence";

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
    const t = await mintInstallationToken(META, privateKey, { repositories: ["factory-pilot"], permissions: { contents: "write" } }, gh.fetchImpl);
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
    const err = await mintInstallationToken(META, privateKey, { repositories: ["factory-pilot"], permissions: { contents: "write" } }, lacking.fetchImpl).catch((e) => e);
    expect(err.message).toContain("token lacks contents:write");
    expect(err.message).not.toContain(TOKEN_VALUE);
    await expect(mintInstallationToken(META, privateKey, { repositories: [], permissions: {} }, lacking.fetchImpl)).rejects.toThrow("named repositories");
    const denied = fakeGitHub({ "POST /app/installations/183396381/access_tokens": () => [422, { message: "permissions exceed installation", token: TOKEN_VALUE }] });
    const e2 = await mintInstallationToken(META, privateKey, { repositories: ["factory-pilot"], permissions: { contents: "write" } }, denied.fetchImpl).catch((e) => e);
    expect(e2).toBeInstanceOf(GitHubError);
    expect(e2.message).toBe("POST /app/installations/183396381/access_tokens -> 422: permissions exceed installation");
  });

  test("a token never prints: string, JSON, template, and inspect are all redacted", () => {
    const t = token();
    for (const shown of [String(t), JSON.stringify({ t }), `${t}`, inspect(t), inspect({ t })]) expect(shown).not.toContain(TOKEN_VALUE);
  });
});

describe("RepoClient", () => {
  test("refuses a repo the token is not scoped to, and errors carry GitHub's message but never the token", async () => {
    expect(() => new RepoClient("Scylla23", "other", token())).toThrow("not scoped to other");
    const gh = fakeGitHub({
      "GET /repos/Scylla23/factory-pilot/x": () => [403, { message: "Resource not accessible by integration" }],
      "GET /repos/Scylla23/factory-pilot/y": () => [404, { message: "Not Found" }],
    });
    const c = new RepoClient("Scylla23", "factory-pilot", token(), gh.fetchImpl);
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
    const gh = fakeGitHub(gitRoutes(EVIDENCE_BRANCH, state));
    const c = new RepoClient("Scylla23", "factory-pilot", token(), gh.fetchImpl);
    const r = await commitFiles(c, { branch: EVIDENCE_BRANCH, message: "m", startFrom: null, files: [{ path: "pr-1/a.png", content: new Uint8Array([1, 2]) }] });
    expect(r.parentSha).toBeNull();
    const tree = gh.calls.find((x) => x.url.endsWith("/git/trees"))!.body as Record<string, unknown>;
    expect(tree.base_tree).toBeUndefined();
    expect((gh.calls.find((x) => x.url.endsWith("/git/commits") && x.method === "POST")!.body as Record<string, unknown>).parents).toEqual([]);
    expect(state.refUpdates).toEqual([{ ref: `refs/heads/${EVIDENCE_BRANCH}`, sha: r.commitSha }]);
    expect((gh.calls[0]!.body as Record<string, unknown>).content).toBe(Buffer.from([1, 2]).toString("base64"));
  });

  test("fast-forwards an existing branch, never forcing, and rebuilds once on the new head when it moved", async () => {
    const state = { head: SHA(1), refUpdates: [] as unknown[], failNextUpdate: true };
    const gh = fakeGitHub(gitRoutes(EVIDENCE_BRANCH, state));
    const c = new RepoClient("Scylla23", "factory-pilot", token(), gh.fetchImpl);
    const r = await commitFiles(c, { branch: EVIDENCE_BRANCH, message: "m", startFrom: null, files: [{ path: "a.png", content: new Uint8Array([1]) }] });
    expect(r.parentSha).toBe(SHA(2));
    expect(state.refUpdates).toHaveLength(2);
    for (const u of state.refUpdates) expect((u as Record<string, unknown>).force).toBe(false);
    const commits = gh.calls.filter((x) => x.url.endsWith("/git/commits") && x.method === "POST").map((x) => (x.body as Record<string, unknown>).parents);
    expect(commits).toEqual([[SHA(1)], [SHA(2)]]);
    expect(gh.calls.filter((x) => x.url.endsWith("/git/blobs"))).toHaveLength(1); // blobs are not re-uploaded
  });

  test("gives up after one rebuild instead of looping", async () => {
    const state = { head: SHA(1), refUpdates: [] as unknown[], failNextUpdate: true };
    const routes = gitRoutes("b", state);
    routes["PATCH /repos/Scylla23/factory-pilot/git/refs/heads/b"] = () => [422, { message: "Update is not a fast forward" }];
    const c = new RepoClient("Scylla23", "factory-pilot", token(), fakeGitHub(routes).fetchImpl);
    await expect(commitFiles(c, { branch: "b", message: "m", startFrom: null, files: [{ path: "a", content: new Uint8Array() }] })).rejects.toThrow("not a fast forward");
  });

  test("refuses unsafe paths and branch names before any call", async () => {
    const gh = fakeGitHub({});
    const c = new RepoClient("Scylla23", "factory-pilot", token(), gh.fetchImpl);
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
    acId: "AC-1", name, commitSha: SHA(7), url: "http://127.0.0.1:4100/", viewport: VIEWPORTS.desktop, screenshotPath: "/dev/null", screenshotSha256: "0".repeat(64),
    consoleErrors: [], networkFailures: [], pageText: "", truncated: { console: false, network: false, pageText: false }, profileId: "p", stabilized: null, capturedAt: "t", ...extra,
  };
}
const set = (records: EvidenceRecord[]): EvidenceSet => ({ pr: 1, headSha: SHA(9), attemptId: "0deacd2c-d259-4aa7-830e-93dd0ec2c2dd", groups: [{ title: "After (abc)", records }] });
const client = { owner: "Scylla23", repo: "factory-pilot" };

describe("evidence comment", () => {
  test("starts with the hidden factory marker and links images at the evidence commit with blob ?raw=true", () => {
    const body = evidenceComment(client, set([record("after-desktop")]), SHA(5));
    expect(body.startsWith(`<!-- factory:evidence pr=1 head=${SHA(9)} attempt=0deacd2c-d259-4aa7-830e-93dd0ec2c2dd evidence=${SHA(5)} -->\n`)).toBe(true);
    expect(body).toContain(`<img src="https://github.com/Scylla23/factory-pilot/blob/${SHA(5)}/pr-1/0deacd2c-d259-4aa7-830e-93dd0ec2c2dd/after-desktop.png?raw=true"`);
  });

  test("page-derived text stays inert inside a fence it cannot close: no mentions, links, markers, or approvals", () => {
    const hostile = ["```", "</details>", "@Scylla23 /approve abc", "<!-- factory:evidence pr=1 -->", "![x](https://evil.example/p.png)", "````` five"].join("\n");
    const body = evidenceComment(client, set([record("after-desktop", { consoleErrors: [hostile], pageText: hostile, url: "http://127.0.0.1:4100/?q=```" })]), SHA(5));
    const fenceMatch = body.match(/\n(`{3,})text\n/);
    expect(fenceMatch).not.toBeNull();
    const fence = fenceMatch![1]!;
    expect(fence.length).toBeGreaterThan(5);
    const start = body.indexOf(`${fence}text\n`);
    const end = body.indexOf(`\n${fence}\n`, start);
    const outside = body.slice(0, start) + body.slice(end + fence.length + 2);
    for (const bad of ["@Scylla23", "/approve", "evil.example"]) expect(outside).not.toContain(bad);
    expect(outside.match(/<!-- factory:/g)).toHaveLength(1);
  });

  test("fenced truncates long text and never lets a backtick run close it", () => {
    expect(fenced("a".repeat(10), 4)).toBe("```text\naaaa\n[... 6 more characters]\n```");
    expect(fenced("x ```` y")).toBe("`````text\nx ```` y\n`````");
  });

  test("refuses untrusted titles, duplicate names, and a short head", () => {
    expect(() => evidenceComment(client, { ...set([record("a")]), groups: [{ title: "<img src=x>", records: [record("a")] }] }, SHA(5))).toThrow("plain words");
    expect(() => evidenceComment(client, set([record("a"), record("a")]), SHA(5))).toThrow("duplicate evidence name");
    expect(() => evidenceComment(client, { ...set([record("a")]), headSha: "abc" }, SHA(5))).toThrow("full commit id");
  });
});

describe("publishEvidence and pulls", () => {
  test("commits screenshots and the manifest to the evidence branch, then comments with that commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-ev-"));
    try {
      const png = join(dir, "a.png");
      writeFileSync(png, Buffer.from([0x89, 0x50]));
      const state = { head: null, refUpdates: [] as unknown[] };
      let comment = "";
      const gh = fakeGitHub({
        ...gitRoutes(EVIDENCE_BRANCH, state),
        "POST /repos/Scylla23/factory-pilot/issues/1/comments": (c) => {
          comment = (c.body as { body: string }).body;
          return [201, { id: 42, html_url: "https://github.com/Scylla23/factory-pilot/pull/1#issuecomment-42" }];
        },
      });
      const c = new RepoClient("Scylla23", "factory-pilot", token(), gh.fetchImpl);
      const r = await publishEvidence(c, set([record("after-desktop", { screenshotPath: png })]));
      const tree = gh.calls.find((x) => x.url.endsWith("/git/trees"))!.body as { tree: { path: string }[] };
      expect(tree.tree.map((t) => t.path)).toEqual(["pr-1/0deacd2c-d259-4aa7-830e-93dd0ec2c2dd/after-desktop.png", "pr-1/0deacd2c-d259-4aa7-830e-93dd0ec2c2dd/evidence.json"]);
      const manifest = JSON.parse(Buffer.from((gh.calls[1]!.body as { content: string }).content, "base64").toString());
      expect(manifest.groups[0].records[0].screenshotPath).toBe("pr-1/0deacd2c-d259-4aa7-830e-93dd0ec2c2dd/after-desktop.png");
      expect(comment).toContain(r.evidenceCommit);
      expect(r.imageUrls).toEqual([`https://github.com/Scylla23/factory-pilot/blob/${r.evidenceCommit}/pr-1/0deacd2c-d259-4aa7-830e-93dd0ec2c2dd/after-desktop.png?raw=true`]);
      expect(r.commentId).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ensureDraftPullRequest reuses an open PR from the branch and otherwise opens a draft", async () => {
    const pr = { number: 1, html_url: "u", head: { sha: SHA(3) }, draft: true };
    let open: unknown[] = [pr];
    const gh = fakeGitHub({
      "GET /repos/Scylla23/factory-pilot/pulls": () => [200, open],
      "POST /repos/Scylla23/factory-pilot/pulls": () => [201, { ...pr, number: 2 }],
    });
    const c = new RepoClient("Scylla23", "factory-pilot", token(), gh.fetchImpl);
    expect(await ensureDraftPullRequest(c, { head: "b", base: "main", title: "t", body: "x" })).toEqual({ pull: { number: 1, htmlUrl: "u", headSha: SHA(3), draft: true }, created: false });
    expect(new URL(gh.calls[0]!.url).searchParams.get("head")).toBe("Scylla23:b");
    open = [];
    const r = await ensureDraftPullRequest(c, { head: "b", base: "main", title: "t", body: "x" });
    expect(r.created).toBe(true);
    expect((gh.calls.at(-1)!.body as { draft: boolean }).draft).toBe(true);
    await expect(postComment(c, 1, "x".repeat(65_001))).rejects.toThrow("65536");
  });
});
