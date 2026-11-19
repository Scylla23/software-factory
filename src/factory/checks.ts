import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../factory.config";
import { loadDispatchConfig } from "../dispatch";
import { commandCheck, teardownCheck } from "../verify/checks";
import { loadVerifyConfig, PreviewError, startPreview, tail, type Preview, type VerifyConfig } from "../verify/preview";
import { check, type Check } from "../verify/verdict";
import type { Attempt, Task } from "./store";
import { Uncertain } from "./machine";

/** Works on persisted results as well as fresh checks. Infrastructure failures require owner attention. */
export function requireHealthyInfrastructure(checks: readonly Check[]) {
  for (const c of checks) {
    if (c.pass) continue;
    if (/teardown$|^complete browser verification$|verification profile signed out$|install same reproduction/.test(c.name) ||
        /^(exit (126|127)\b|killed by a signal|timed_out|cancelled)|; left behind:|operation not permitted|permission denied|command not found|sandbox(?:-exec)?:.*deny/i.test(c.detail))
      throw new Uncertain(`factory infrastructure failed during ${c.name}: ${c.detail.slice(0, 800)}`);
  }
}

/** Evaluate Bun's JUnit document independently of the test's stdout and stderr. */
export function junitReproduction(xml: string, base: boolean) {
  if (!xml || Buffer.byteLength(xml) > 65_536 || /<!/.test(xml)) return false;
  const failure = base ? "count(failure)=1 and failure/@type='AssertionError'" : "not(failure)";
  const one = "count(//testcase)=1 and count(//testsuite)=1 and not(//error | //skipped)";
  const testcase = `/testsuites[@tests=1 and @failures=${Number(base)} and @skipped=0]/testsuite/testcase[` +
    `@file='repro.test.ts' and (@name='AC-1' or starts-with(@name,'AC-1 ')) and @assertions>0 and ${failure}]`;
  const result = Bun.spawnSync(["/usr/bin/xmllint", "--nonet", "--xpath", `boolean(${one} and ${testcase})`, "-"], {
    stdin: Buffer.from(xml), stdout: "pipe", stderr: "pipe", timeout: 3_000,
  });
  return result.exitCode === 0 && result.stdout.toString().trim() === "true";
}

export function previewId(attemptId: string, name: string) {
  const hex = createHash("sha256").update(`${attemptId}/${name}`).digest("hex").slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function checkAbandonedPreviews(root: string, attempt: string) {
  const ids = ["test", "before", "after"].map((phase) => previewId(attempt, phase));
  for (const id of ids) if (existsSync(join(root, "previews", id))) throw new Error(`preview ${id} still needs teardown`);
  const ports = join(root, "ports");
  if (existsSync(ports)) for (const file of readdirSync(ports).filter((f) => f.endsWith(".lease"))) {
    const lease = JSON.parse(readFileSync(join(ports, file), "utf8"));
    if (ids.includes(lease.attempt)) throw new Error(`preview lease ${file} still needs teardown`);
  }
}

export class ProjectChecks {
  constructor(readonly stateRoot = config.stateRoot) {}
  private runtime?: VerifyConfig;
  get verify() {
    if (!this.runtime) {
      const agentWriteRoots = [config.workspaceRoot];
      const toolDirs = config.pilot.toolDirs;
      this.runtime = loadVerifyConfig(loadDispatchConfig({ agentWriteRoots }), {
        toolDirs,
        toolRoots: toolDirs,
        agentWriteRoots,
      });
    }
    return this.runtime;
  }
  close() {
    this.runtime?.egress.close();
  }

  async preview(
    task: Task,
    attemptId: string,
    revision: string,
    name: string,
    checks: Check[],
    use: (preview: Preview) => Promise<void>,
  ) {
    const logDir = join(this.stateRoot, "project-logs", attemptId);
    mkdirSync(logDir, { mode: 0o700, recursive: true });
    const id = previewId(attemptId, name);
    const p = await startPreview(
      {
        id,
        taskKey: String(task.id),
        repo: config.pilot.path,
        sha: revision,
        logDir,
        project: config.pilot.commands,
        setupTimeoutMs: 120_000,
        readyTimeoutMs: 30_000,
        maxLifetimeMs: 300_000,
      },
      this.verify,
    );
    try {
      await use(p);
    } finally {
      checks.push(teardownCheck(`${name} teardown`, await p.stop()));
    }
  }

  async test(task: Task, attempt: Attempt, baseTest?: string) {
    const sha = baseTest ? task.base : task.head;
    const checks: Check[] = [];
    const logs = join(this.stateRoot, "project-logs", attempt.id);
    const receipt = join(logs, "completed.json");
    if (!attempt.fresh && existsSync(logs)) {
      if (!existsSync(receipt)) throw new Uncertain(`interrupted project check ${attempt.id}`);
      const stored = JSON.parse(readFileSync(receipt, "utf8")) as { base: string; head: string; tested: string; checks: Check[] };
      if (stored.base !== task.base || stored.head !== task.head || stored.tested !== sha)
        throw new Uncertain("project check receipt moved");
      return stored;
    }
    try {
      await this.preview(task, attempt.id, sha, "test", checks, async (p) => {
        if (baseTest) {
          // Write only inside the project-command sandbox. No trusted write follows a path a preview could replace.
          const prep = await p.run(
            [
              "bun",
              "-e",
              'require("fs").writeFileSync("repro.test.ts",Buffer.from(process.argv[1],"base64"),{flag:"wx"})',
              baseTest,
            ],
            { name: "install-reproduction", network: "none", timeoutMs: 10_000 },
          );
          checks.push(commandCheck("install same reproduction on base", prep));
          if (!checks[0]?.pass) return;
        }
        const report = `factory-junit-${crypto.randomUUID()}.xml`;
        const result = await p.run(["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, "./repro.test.ts"], {
          name: "reproduction",
          network: "none",
          timeoutMs: 30_000,
        });
        const output = tail(result.logPath, 24_000);
        requireHealthyInfrastructure([commandCheck("run reproduction", result)]);
        // Read project-controlled paths only in the project sandbox. Its separate capped log contains just the report.
        const read = await p.run(["/bin/cat", report], { name: "read-junit", network: "none", timeoutMs: 5_000 });
        requireHealthyInfrastructure([commandCheck("read JUnit", read)]);
        const xml = read.exitCode === 0 && statSync(read.logPath).size <= 65_536 ? readFileSync(read.logPath, "utf8") : "";
        const assertion = /error: expect\(/.test(output);
        const ok = read.exitCode === 0 && junitReproduction(xml, !!baseTest) &&
          (baseTest ? result.exitCode === 1 && assertion : result.exitCode === 0);
        checks.push(check(baseTest ? "AC-1 fails on base" : "AC-1 passes on head", ok,
          `exit ${result.exitCode}; JUnit ${ok ? "confirmed" : "did not confirm"} the required AC-1 result\n${output}`));
        if (!baseTest) {
          for (const name of ["test", "lint", "typecheck"] as const) {
            const result = await p.run(config.pilot.commands[name], { network: "none", name, timeoutMs: 60_000 });
            checks.push(commandCheck(name, result));
          }
        }
      });
    } catch (e) {
      if (e instanceof Uncertain) throw e;
      throw new Uncertain(`project check infrastructure: ${e instanceof PreviewError ? e.message : String(e)}`);
    }
    const result = { base: task.base, head: task.head, tested: sha, checks };
    writeFileSync(`${receipt}.tmp`, JSON.stringify(result), { mode: 0o600, flag: "wx" });
    renameSync(`${receipt}.tmp`, receipt);
    return result;
  }
}
