import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { config } from "../../factory.config";
import { loadDispatchConfig, runAgent, type RunResult } from "../dispatch";
import { assertPrivateDir } from "../dispatch/config";
import { runGit } from "../dispatch/git";
import { PROJECT_INSTRUCTION_PATHS } from "../dispatch/instructions";
import { assertRepoPath } from "../github/commit";
import { createWorktree, removeWorktree } from "../orca/worktree";
import type { Attempt, Store, Task } from "./store";
import { AgentFailed, Uncertain } from "./machine";

type Role = keyof typeof config.agents;
interface Job {
  id: string;
  role: Role;
  head: string;
  base: string;
  prompt: string;
  agent?: (typeof config.agents)[Role];
}
export interface WorkerOutput {
  result: RunResult;
  files: { path: string; content: string }[];
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function jobDir(id: string) {
  if (!uuid.test(id)) throw new Error("invalid worker attempt id");
  return join(config.stateRoot, "jobs", id);
}

function changes(path: string): WorkerOutput["files"] {
  const list = (...args: string[]) => runGit("/usr/bin/git", path, args).toString().split("\0").filter(Boolean);
  if (list("diff", "--diff-filter=D", "--name-only", "-z", "HEAD").length) throw new Error("file deletion requires escalation");
  const paths = [
    ...new Set([...list("diff", "--name-only", "-z", "HEAD"), ...list("ls-files", "--others", "--exclude-standard", "-z")]),
  ];
  if (paths.length > 40) throw new Error("unexpected number of builder files");
  let size = 0;
  return paths.map((name) => {
    assertRepoPath(name);
    if (
      name.split("/").some((p) => p.startsWith(".")) ||
      name.startsWith("docs/specs/") ||
      name === "AGENTS.md" ||
      name === "CLAUDE.md"
    )
      throw new Error(`builder changed a protected path: ${name}`);
    const file = join(path, name);
    const st = lstatSync(file);
    size += st.size;
    if (realpathSync(file) !== file || !st.isFile() || st.nlink !== 1 || size > 1_048_576)
      throw new Error(`unsafe builder output ${name}`);
    return { path: name, content: readFileSync(file).toString("base64") };
  });
}

async function work(id: string) {
  const dir = jobDir(id);
  assertPrivateDir(dir, config.stateRoot);
  // An exclusive claim survives controller death and two concurrent launchers.
  writeFileSync(join(dir, "claim"), String(process.pid), { flag: "wx", mode: 0o600 });
  const finish = (value: unknown) => {
    writeFileSync(join(dir, "result.tmp"), JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(join(dir, "result.tmp"), join(dir, "result.json"));
  };
  try {
    const job: Job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
    const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
    const wt = await createWorktree(dispatch.executables.orca, `factory-${id}`, config.pilot.path, job.head);
    let quarantine = true;
    let output: WorkerOutput;
    try {
      const current = runGit(dispatch.executables.git, wt.path, ["rev-parse", "HEAD"]).toString().trim();
      if (current !== job.head) throw new Error("Orca checkout does not match intended head");
      const result = await runAgent(
        {
          ...(job.agent ?? config.agents[job.role]),
          runId: id,
          worktreePath: wt.path,
          logDir: dir,
          prompt: job.prompt,
          readOnlyWorktree: job.role !== "builder",
          instructions: { repo: config.pilot.path, baseSha: job.base, paths: PROJECT_INSTRUCTION_PATHS },
        },
        dispatch,
      );
      quarantine = result.quarantineWorktree;
      output = { result, files: job.role === "builder" && result.outcome === "completed" && !quarantine ? changes(wt.path) : [] };
    } finally {
      if (!quarantine) await removeWorktree(dispatch.executables.orca, wt.id);
    }
    finish({ output });
  } catch (e) {
    finish({ error: String(e) });
  }
}

export class WorkerLoginError extends Error {}
export async function dispatchWorker(
  store: Store,
  task: Task,
  attempt: Attempt,
  role: Role,
  prompt: string,
  observe: (event: string, id: string) => void,
): Promise<WorkerOutput> {
  const dir = jobDir(attempt.id);
  const job: Job = { id: attempt.id, role, base: task.base, head: task.head, prompt, agent: config.agents[role] };
  if (attempt.fresh || !existsSync(dir)) {
    mkdirSync(join(config.stateRoot, "jobs"), { mode: 0o700, recursive: true });
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "job.json"), JSON.stringify(job), { flag: "wx", mode: 0o600 });
    const fd = openSync(join(dir, "supervisor.log"), "wx", 0o600);
    try {
      const owner = userInfo();
      const worker = spawn(process.execPath, [import.meta.path, attempt.id], {
        detached: true,
        cwd: config.stateRoot,
        env: { PATH: "/usr/bin:/bin", HOME: owner.homedir, USER: owner.username, LOGNAME: owner.username },
        stdio: ["ignore", fd, fd],
      });
      worker.unref();
    } finally {
      closeSync(fd);
    }
  } else {
    observe("recover-worker", attempt.id);
  }
  const start = Date.now();
  const timeout = config.agents[role].timeoutMs + 120_000;
  let sawStart = false;
  for (;;) {
    const stdout = join(dir, `${attempt.id}.stdout.jsonl`);
    if (!sawStart && existsSync(stdout) && lstatSync(stdout).size > 0) {
      sawStart = true;
      if (attempt.fresh) observe("dispatched", attempt.id);
    }
    if (existsSync(join(dir, "result.json"))) break;
    if (Date.now() - start > timeout) throw new Uncertain(`worker completion is uncertain for ${attempt.id}`);
    if (Date.now() - start > 5000) {
      if (!existsSync(join(dir, "claim"))) throw new Uncertain(`worker startup is uncertain for ${attempt.id}`);
      const pid = Number(readFileSync(join(dir, "claim"), "utf8"));
      try {
        process.kill(pid, 0);
      } catch {
        if (!existsSync(join(dir, "result.json"))) throw new Uncertain(`unsettled worker disappeared: ${attempt.id}`);
      }
    }
    await Bun.sleep(150);
  }
  const reply: { output?: WorkerOutput; error?: string } = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  if (!reply.output) throw new AgentFailed(reply.error ?? "missing worker result");
  const { result } = reply.output;
  store.db.run("INSERT OR IGNORE INTO audit VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [
    attempt.id,
    task.id,
    task.state,
    result.sessionId,
    result.requestedModel,
    result.observedModel,
    config.agents[role].effort,
    createHash("sha256").update(prompt).digest("hex"),
    task.base,
    task.head,
    result.outcome,
    JSON.stringify(result.usage),
  ]);
  if (result.outcome === "failed" && !result.quarantineWorktree && result.resultText?.startsWith("Not logged in"))
    throw new WorkerLoginError("factory harness needs its dedicated login");
  if (result.quarantineWorktree || result.outcome === "timed_out")
    throw new Uncertain(`worker ${attempt.id} needs inspection, see ${dir}`);
  if (result.outcome !== "completed" || !result.resultText)
    throw new AgentFailed(`worker ${attempt.id} ${result.outcome}, see ${dir}`);
  return reply.output;
}
if (import.meta.main) await work(process.argv[2] ?? "");
