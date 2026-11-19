/**
 * Plan step 2 repair: opens the draft pull request the verification spike runs against, so its before capture is the
 * PR's base and its after capture is the PR's head. Through the GitHub App, and idempotent: it creates the branch
 * `spike/verify-base` at the fixture's first commit, and a draft PR from the fixture branch into it, reusing either if
 * it exists (a base branch at any other commit is refused). Nothing else in the repository is touched.
 *
 *   bun scripts/spike-verify-pr.ts
 *
 * Undo: close the PR, then delete the branch `spike/verify-base`.
 * Prints commit ids and the PR URL only; the token never leaves `InstallationToken`.
 */
import { join } from "node:path";
import { userInfo } from "node:os";
import { RepoClient } from "../src/github/api";
import { loadAppKey, loadAppMetadata, mintInstallationToken, TokenSource } from "../src/github/app";
import { ensureDraftPullRequest } from "../src/github/pulls";

const OWNER = "Scylla23";
const REPO = "factory-pilot";
const HEAD = "spike/verify-fixture";
const BASE = "spike/verify-base";
/** The fixture's first commit (the app without the banner); the head branch adds the banner on top of it. */
const BASE_SHA = "683a16be19aee1f56b76ded5b5c461614f47591f";

const stateRoot = join(userInfo().homedir, ".software-factory");
const meta = loadAppMetadata(stateRoot);
const tokens = new TokenSource(() => mintInstallationToken(meta, loadAppKey(meta), { repositories: [REPO], permissions: { contents: "write", pull_requests: "write" } }));
const client = new RepoClient(OWNER, REPO, tokens);

const head = await client.request<{ object: { sha: string } }>("GET", `${client.base}/git/ref/heads/${HEAD}`);
const parents = await client.request<{ parents: { sha: string }[] }>("GET", `${client.base}/git/commits/${head!.object.sha}`);
if (!parents!.parents.some((p) => p.sha === BASE_SHA)) throw new Error(`${HEAD} at ${head!.object.sha} does not build on ${BASE_SHA}`);

const existing = await client.request<{ object: { sha: string } }>("GET", `${client.base}/git/ref/heads/${BASE}`, undefined, { allow404: true });
if (existing && existing.object.sha !== BASE_SHA) throw new Error(`${BASE} exists at ${existing.object.sha}, not ${BASE_SHA}; refusing to move it`);
if (!existing) await client.request("POST", `${client.base}/git/refs`, { ref: `refs/heads/${BASE}`, sha: BASE_SHA });
console.log(`${existing ? "found" : "created"} branch ${BASE} at ${BASE_SHA}`);

const { pull, created } = await ensureDraftPullRequest(client, {
  head: HEAD,
  base: BASE,
  title: "Spike: step 2 repair verification",
  body: [
    "<!-- factory:pr v1-step-2-repair -->",
    "Draft pull request opened by the software factory's GitHub App for the plan step 2 repair round.",
    "",
    `Its base is the fixture app without the banner (\`${BASE_SHA.slice(0, 12)}\`) and its head adds the banner, so verification captures the base as before and the head as after.`,
    "It is a spike fixture and is not meant to be merged.",
  ].join("\n"),
});
console.log(`${created ? "opened" : "found"} draft PR #${pull.number} ${pull.htmlUrl} base ${pull.baseRef} ${pull.baseSha} head ${pull.headSha} draft ${pull.draft}`);
