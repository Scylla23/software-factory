/**
 * Plan step 2 spike: publishes the factory-pilot fixture through the GitHub App, as two commits on a branch, and opens
 * the draft pull request that holds the verification evidence. Idempotent: an existing branch or PR is reused.
 *
 *   bun scripts/spike-fixture.ts <dir with commit-1 files> <dir with commit-2 files>
 *
 * Prints commit ids and the PR URL only; the token never leaves `InstallationToken`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { RepoClient } from "../src/github/api";
import { loadAppKey, loadAppMetadata, mintInstallationToken } from "../src/github/app";
import { commitFiles } from "../src/github/commit";
import { ensureDraftPullRequest } from "../src/github/pulls";

const OWNER = "Scylla23";
const REPO = "factory-pilot";
const BRANCH = "spike/verify-fixture";
const TRAILERS = "\n\nFactory-Task: v1-step-2\nFactory-Agent: builder";

const [v1Dir, v2Dir] = process.argv.slice(2);
if (!v1Dir || !v2Dir) throw new Error("usage: spike-fixture.ts <v1 dir> <v2 dir>");

const stateRoot = join(userInfo().homedir, ".software-factory");
const meta = loadAppMetadata(stateRoot);
const token = await mintInstallationToken(meta, loadAppKey(meta), { repositories: [REPO], permissions: { contents: "write", pull_requests: "write" } });
console.log(`token minted, expires ${token.expiresAt.toISOString()}, permissions ${JSON.stringify(token.permissions)}`);
const client = new RepoClient(OWNER, REPO, token);

const main = await client.request<{ object: { sha: string } }>("GET", `${client.base}/git/ref/heads/main`);
const mainSha = main!.object.sha;
const existing = await client.request<{ object: { sha: string } }>("GET", `${client.base}/git/ref/heads/${BRANCH}`, undefined, { allow404: true });
if (existing) {
  console.log(`branch ${BRANCH} already at ${existing.object.sha}; not recommitting`);
} else {
  const files = (dir: string, names: string[]) => names.map((path) => ({ path, content: readFileSync(join(dir, path)) }));
  const c1 = await commitFiles(client, {
    branch: BRANCH,
    startFrom: mainSha,
    message: `feat: add the spike fixture app${TRAILERS}`,
    files: files(v1Dir, ["package.json", "bun.lock", "server.ts", "README.md"]),
  });
  console.log(`commit 1 (before) ${c1.commitSha} on ${BRANCH}, from main ${mainSha}`);
  const c2 = await commitFiles(client, { branch: BRANCH, startFrom: null, message: `feat: add a visible banner${TRAILERS}`, files: files(v2Dir, ["server.ts"]) });
  console.log(`commit 2 (after)  ${c2.commitSha}, parent ${c2.parentSha}`);
}

const { pull, created } = await ensureDraftPullRequest(client, {
  head: BRANCH,
  base: "main",
  title: "Spike: verification fixture (plan step 2)",
  body: [
    "<!-- factory:pr v1-step-2 -->",
    "Draft pull request opened by the software factory's GitHub App to hold plan step 2 verification evidence.",
    "",
    "The branch adds a one-page Bun app, and its second commit adds one visible change (a banner).",
    "It is a spike fixture and is not meant to be merged.",
  ].join("\n"),
});
console.log(`${created ? "opened" : "found"} draft PR #${pull.number} ${pull.htmlUrl} head ${pull.headSha} draft ${pull.draft}`);
