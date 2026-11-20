import { createHash } from "node:crypto";
import { config, pilotBase } from "../../factory.config";
import { publishSummary, type EvidenceSummary } from "../github/summary";
import { RepoClient } from "../github/api";
import { runGit } from "../dispatch/git";
import { loadAppKey, loadAppMetadata, mintInstallationToken, TokenSource, type Fetch } from "../github/app";
import { commitFiles, type FileToCommit } from "../github/commit";
import { fetchCommits } from "../github/fetch";
import { ensureDraftPullRequest, getPullRequest, listComments, postComment } from "../github/pulls";
import type { Task, Issue } from "./store";

const pilot = config.pilot;
const shaPattern = /^[a-f0-9]{40}$/;
export function issueNumber(url: string) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(url);
  if (
    !match ||
    match[1]?.toLowerCase() !== pilot.owner.toLowerCase() ||
    match[2]?.toLowerCase() !== pilot.repo ||
    !Number.isSafeInteger(Number(match[3]))
  )
    throw new Error("expected a registered project's GitHub issue URL");
  return Number(match[3]);
}

export async function readIssue(client: RepoClient, number: number): Promise<Issue> {
  type IssueData = {
    databaseId: number;
    title: string;
    body: string;
    url: string;
    lastEditedAt: string | null;
    author: { databaseId: number };
    labels: { nodes: { name: string }[] };
  };
  type Graph = { data?: { repository: { databaseId: number; issue: IssueData | null } } };
  const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){databaseId
      issue(number:$number){databaseId title body url lastEditedAt author{... on User{databaseId}} labels(first:100){nodes{name}}}}}`;
  const graph = await client.request<Graph>("POST", "/graphql", {
    query,
    variables: { owner: pilot.owner, repo: pilot.repo, number },
  });
  const repo = graph?.data?.repository;
  const issue = repo?.issue;
  if (
    repo?.databaseId !== pilot.repoId ||
    !issue ||
    !Number.isSafeInteger(issue.databaseId) ||
    issue.databaseId <= 0 ||
    issue.author?.databaseId !== config.ownerId ||
    issueNumber(issue.url) !== number ||
    typeof issue.title !== "string" ||
    typeof issue.body !== "string"
  )
    throw new Error("issue identity or sender is unauthorized");
  if (!issue.labels.nodes.some((l) => l.name === "factory")) throw new Error("missing owner factory label");
  type Event = { event: string; label?: { name: string }; actor: { id: number } | null; created_at: string };
  const events = await pages<Event>(client, `/issues/${number}/events`);
  const authorization = events.filter((e) => e.label?.name === "factory" && ["labeled", "unlabeled"].includes(e.event)).at(-1);
  if (
    authorization?.event !== "labeled" ||
    authorization.actor?.id !== config.ownerId ||
    !Number.isFinite(Date.parse(authorization.created_at)) ||
    events.some((e) => e.event === "renamed" && !(Date.parse(e.created_at) < Date.parse(authorization.created_at))) ||
    (issue.lastEditedAt !== null && !(Date.parse(issue.lastEditedAt) < Date.parse(authorization.created_at)))
  ) {
    throw new Error("the owner must reapply the factory label to authorize this issue revision");
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([issue.title, issue.body, issue.lastEditedAt]))
    .digest("hex");
  return {
    source: "github",
    repoId: pilot.repoId,
    issueId: issue.databaseId,
    number,
    title: issue.title,
    body: issue.body,
    sender: issue.author.databaseId,
    revision,
    url: issue.url,
  };
}

async function pages<T>(client: RepoClient, path: string, signal?: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const more = await client.request<T[]>("GET", `${client.base}${path}?per_page=100&page=${page}`, undefined, { signal });
    if (!Array.isArray(more)) throw new Error("unexpected GitHub page");
    rows.push(...more);
    if (more.length < 100) return rows;
  }
  throw new Error("GitHub pagination limit exceeded");
}

function appConnection() {
  const meta = loadAppMetadata(config.stateRoot);
  const key = loadAppKey(meta);
  return { slug: meta.slug, tokens: (permissions: Record<string, "read" | "write">): Pick<TokenSource, "get"> =>
    new TokenSource(() => mintInstallationToken(meta, key, { repositories: [pilot.repo], permissions })) };
}

export class Publisher {
  private readonly readTokens;
  private readonly read;
  private readonly pulls;
  private readonly drafts;
  private readonly contents;
  private readonly readyClient;

  constructor(private readonly app = appConnection(), private readonly repoPath = pilot.path, transport?: Fetch) {
    const client = (p: Record<string, "read" | "write">) => new RepoClient(pilot.owner, pilot.repo, app.tokens(p), transport);
    this.readTokens = app.tokens({ contents: "read", issues: "read", pull_requests: "read" });
    this.read = new RepoClient(pilot.owner, pilot.repo, this.readTokens, transport);
    this.pulls = client({ pull_requests: "write" });
    this.drafts = client({ contents: "read", pull_requests: "write" });
    this.contents = client({ contents: "write" });
    this.readyClient = client({ contents: "write", pull_requests: "write" });
  }
  basePaths(base: string) {
    return new Set(runGit("/usr/bin/git", this.repoPath, ["ls-tree", "-rz", "--name-only", base]).toString().split("\0"));
  }
  reproduction(head: string, file: string) {
    return runGit("/usr/bin/git", this.repoPath, ["show", `${head}:${file}`]).toString("base64");
  }
  summary(evidence: EvidenceSummary) {
    return publishSummary(this.pulls, evidence, { botLogin: `${this.app.slug}[bot]` });
  }
  issue(number: number) {
    return readIssue(this.read, number);
  }
  pages<T>(path: string, signal?: AbortSignal) {
    return pages<T>(this.read, path, signal);
  }

  async ref(branch: string) {
    const r = await this.read.request<{ object: { sha: string } }>(
      "GET",
      `${this.read.base}/git/ref/heads/${branch}`,
      undefined,
      { allow404: true },
    );
    if (r && !shaPattern.test(r.object.sha)) throw new Error("invalid branch head");
    return r?.object.sha ?? null;
  }
  async fetch(sha: string) {
    fetchCommits("/usr/bin/git", this.repoPath, pilot.owner, pilot.repo, [sha], await this.readTokens.get());
  }
  branch(task: Task) {
    return `factory/issue-${task.issue.number}`;
  }

  async commit(task: Task, id: string, subject: string, files: FileToCommit[], parent: string | null) {
    const branch = this.branch(task);
    const tip = await this.ref(branch);
    const message = `${subject}\n\nFactory-Task: github-${task.issue.issueId}\nFactory-Agent: ${task.state === "spec_drafting" ? "spec" : "builder"}\nFactory-Attempt: ${id}`;
    if (tip && tip !== parent) {
      const commit = await this.read.request<{ message: string; parents: { sha: string }[] }>(
        "GET",
        `${this.read.base}/git/commits/${tip}`,
      );
      if (commit?.message === message && commit.parents.length === 1 && commit.parents[0]?.sha === (parent ?? task.base)) {
        await this.fetch(tip);
        const git = (args: string[]) => runGit("/usr/bin/git", this.repoPath, args).toString();
        const paths = new Set(files.map((f) => f.path));
        const diff = git(["diff-tree", "-r", "--no-renames", "--no-commit-id", "--name-only", "-z", parent ?? task.base, tip])
          .split("\0")
          .filter(Boolean);
        const matches = files.every((f) => {
          const blob = createHash("sha1").update(`blob ${f.content.byteLength}\0`).update(f.content).digest("hex");
          return git(["ls-tree", "-z", tip, "--", f.path]) === `100644 blob ${blob}\t${f.path}\0`;
        });
        if (matches && diff.every((path) => paths.has(path))) return tip;
      }
      throw new Error(`foreign branch tip prevents publishing ${id}`);
    }
    return (await commitFiles(this.contents, { branch, startFrom: parent ?? task.base, expectedHead: parent, message, files }))
      .commitSha;
  }

  async draft(task: Task, id: string, head: string) {
    const marker = `<!-- factory:pr attempt=${id} -->`;
    const { pull } = await ensureDraftPullRequest(this.drafts, {
      head: this.branch(task),
      base: pilotBase(task.issue.number),
      title: task.issue.title,
      body: `${marker}\nFixes #${task.issue.number}.`,
    });
    const remote = await this.read.request<{ body: string; user: { login: string } }>(
      "GET",
      `${this.read.base}/pulls/${pull.number}`,
    );
    if (
      remote?.user.login !== `${this.app.slug}[bot]` ||
      !remote.body.startsWith(marker) ||
      pull.headSha !== head ||
      pull.baseSha !== task.base ||
      !pull.draft
    )
      throw new Error("draft PR identity or revisions changed");
    return pull.number;
  }
  pull(number: number) {
    return getPullRequest(this.read, number);
  }
  async reviewBoundary(task: Task, commentId: number) {
    const events = await this.pages<{ event: string; created_at: string }>(`/issues/${task.pr}/timeline`);
    const ready = events.filter((e) => e.event === "ready_for_review").at(-1);
    const summary = await this.read.request<{ updated_at: string }>("GET", `${this.read.base}/issues/comments/${commentId}`);
    const boundary = Math.max(Date.parse(ready?.created_at ?? ""), Date.parse(summary?.updated_at ?? ""));
    if (!Number.isFinite(boundary)) throw new Error("waiting for GitHub ready and evidence timestamps");
    return new Date(boundary).toISOString();
  }
  async ready(task: Task) {
    const bound = await this.boundPull(task);
    if (!bound.draft) return;
    const pr = await this.read.request<{ node_id: string }>("GET", `${this.read.base}/pulls/${task.pr}`);
    const query = "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft headRefOid}}}";
    const updated = await this.readyClient.request<{
      data?: { markPullRequestReadyForReview: { pullRequest: { isDraft: boolean; headRefOid: string } } | null };
      errors?: { type?: string; message: string }[];
    }>("POST", "/graphql", { query, variables: { id: pr?.node_id } });
    if (updated?.errors?.length) throw new Error(`GitHub ready mutation failed: ${updated.errors[0]?.message.slice(0, 300)}`);
    const result = updated?.data?.markPullRequestReadyForReview?.pullRequest;
    if (!result || result.isDraft || result.headRefOid !== task.head)
      throw new Error("GitHub did not confirm the verified head ready");
  }
  async boundPull(task: Task) {
    // After a ref update the PR endpoint can still report its previous head.
    for (let read = 0; read < 6; read++) {
      const pull = await this.pull(task.pr);
      if (
        pull.state !== "open" ||
        pull.baseRef !== pilotBase(task.issue.number) ||
        pull.baseSha !== task.base ||
        (await this.ref(this.branch(task))) !== task.head
      )
        throw new Error("PR revisions moved");
      if (pull.headSha === task.head) return pull;
      if (read < 5) await Bun.sleep(400);
    }
    throw new Error("PR head does not match the intended revision");
  }
  async comments(number: number) {
    const comments = await listComments(this.read, number);
    const commands = comments.filter((c) => /^\/(?:approve|respec|reverify|resume)\b/.test(c.body));
    // REST timestamps have one-second resolution. An explicit null lastEditedAt also rules out a same-second edit.
    for (let i = 0; i < commands.length; i += 100) {
      const page = commands.slice(i, i + 100);
      const ids = page.map((c) => c.nodeId);
      if (ids.some((id) => !id)) throw new Error("missing GitHub command identity");
      type Node = { id: string; body: string; lastEditedAt: string | null };
      const result = await this.read.request<{ data?: { nodes: (Node | null)[] }; errors?: unknown[] }>("POST", "/graphql", {
        query: "query($ids:[ID!]!){nodes(ids:$ids){id ... on IssueComment{body lastEditedAt}}}",
        variables: { ids },
      });
      if (!result?.data || result.errors?.length) throw new Error("cannot verify GitHub command edit history");
      const nodes = new Map(result.data.nodes.map((n) => [n?.id, n]));
      for (const c of page) {
        const node = nodes.get(c.nodeId);
        if (node?.body === c.body) c.lastEditedAt = node.lastEditedAt;
      }
    }
    return comments;
  }
  async comment(number: number, id: string, text: string) {
    const marker = `<!-- factory:comment attempt=${id} -->`;
    const existing = (await this.comments(number)).filter(
      (c) => c.author === `${this.app.slug}[bot]` && c.body.startsWith(marker),
    );
    if (existing.length > 1) throw new Error("duplicate App comment for attempt");
    return (existing[0] ?? (await postComment(this.pulls, number, `${marker}\n${text}`))).id;
  }
}
