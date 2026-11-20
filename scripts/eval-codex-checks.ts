import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import * as ts from "typescript";
import { checkoutSnapshot, createAttempt } from "../src/dispatch/attempt";
import { prepareBroker } from "../src/dispatch/broker";
import type { BriefInput } from "../src/dispatch/brief";
import type { DispatchConfig } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { readRegularFile } from "../src/dispatch/regular-file";
import { isRecord, readJsonl } from "../src/dispatch/jsonl";
import { assertRepoPath } from "../src/github/commit";
import { evalCheckout } from "./eval-checkout";

export interface TrialSetup {
  id: string;
  key: string;
  trial: number;
  root: string;
  worktree: string;
  skills: string;
  task: string;
  refs: { base: string; head: string };
  initialRefs: string;
  pin: string;
  role: string;
  stage: string;
  brief: BriefInput;
}
function suiteTests(text: string) {
  const source = ts.createSourceFile("test.ts", text, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((s) => {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) return [];
    const call = s.expression,
      name = call.arguments[0];
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "test" || !name || !ts.isStringLiteral(name)) return [];
    return [{ name: name.text, body: s.getText(source) }];
  });
}

export function redBeforeFix(events: readonly { productionEdit?: boolean; red?: boolean; unclassifiedWrite?: boolean }[]) {
  const first = events.findIndex((e) => e.productionEdit || e.unclassifiedWrite);
  return first >= 0 && events[first]?.productionEdit === true && events.slice(0, first).some((e) => e.red);
}

async function editHistory(rollout: string, name: string, cwd: string) {
  const events: { productionEdit?: boolean; red?: boolean; unclassifiedWrite?: boolean }[] = [];
  let reset = false;
  for await (const row of readJsonl(rollout)) {
    if (row.kind !== "record") throw new Error("invalid builder event history");
    const p = row.value.payload;
    if (!isRecord(p)) continue;
    const commandRecord =
      row.value.type === "event_msg" && p.type === "item_completed" && isRecord(p.item) && p.item.type === "CommandExecution"
        ? p.item
        : row.value.type === "event_msg" && p.type === "exec_command_end"
          ? p
          : null;
    if (commandRecord) {
      const command = Array.isArray(commandRecord.command) ? commandRecord.command.at(-1) : "";
      reset ||= /\bgit\b[^;&|]*\b(?:checkout|reset|restore)\b/.test(command);
      const output = String(commandRecord.aggregated_output ?? commandRecord.formatted_output ?? "");
      if (
        /\bbun\s+test\b/.test(command) &&
        typeof commandRecord.exit_code === "number" &&
        commandRecord.exit_code !== 0 &&
        name &&
        output.includes("(fail) " + name)
      )
        events.push({ red: true });
      if (/\b(?:sed\s+-i|perl\s+-[ip]|tee|cp|mv|rm|touch|python\d?|node|ruby|apply_patch)\b|(?:^|[^>])>{1,2}/.test(command))
        events.push({ unclassifiedWrite: true });
    }
    if (
      row.value.type === "event_msg" &&
      p.type === "item_completed" &&
      isRecord(p.item) &&
      p.item.type === "FileChange" &&
      p.item.status === "completed" &&
      isRecord(p.item.changes)
    ) {
      if (Object.keys(p.item.changes).some((path) => path.startsWith(cwd + "/src/") && !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)))
        events.push({ productionEdit: true });
    }
  }
  return { red: redBeforeFix(events), reset };
}

function safeText(dir: string, path: string) {
  assertRepoPath(path);
  return readRegularFile(join(dir, path), 1024 * 1024).toString();
}
export async function checkCodexOutput(
  dispatch: DispatchConfig,
  factory: string,
  trialDir: string,
  s: TrialSetup,
  submission: Record<string, string>,
  rollout: string,
) {
  const git = dispatch.executables.git;
  const cmd = (...args: string[]) => runGit(git, s.worktree, args).toString();
  const builder = s.role === "builder",
    repair = s.stage === "repair",
    api = s.key.includes("02-security");
  const rel = builder ? "build-report.json" : "verdicts/security-auditor.json";
  const d = JSON.parse(submission[rel]!);
  const schema = JSON.parse(safeText(s.skills, builder ? "builder/build-report.schema.json" : "_shared/verdict.schema.json"));
  const valid = Boolean(new Ajv2020({ strictTypes: false, allowUnionTypes: true }).compile(schema)(d));
  const grade: Record<string, boolean> = { schema: valid };
  const candidate = { ...submission };
  if (!valid) return { grade, candidate };
  const previous = (path: string) => JSON.parse(safeText(s.task, path));
  const status = cmd("status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean);
  if (!builder) {
    const first = s.brief.round === 1,
      threats = d.checks?.threatModel;
    const prior = first ? null : previous("archive/spec/round-1/verdicts/security-auditor.json");
    grade.identity =
      d.role === s.role &&
      d.taskId === s.brief.taskId &&
      d.round === s.brief.round &&
      d.stage === "spec" &&
      !Object.hasOwn(d.covers, "headSha") &&
      d.covers.specSetSha256 === s.brief.specSet?.sha256 &&
      (!prior || prior.covers.specSetSha256 !== d.covers.specSetSha256);
    grade.verdict = d.verdict === "changes";
    grade.finding = d.findings.some(
      (f: any) => f.blocking === true && f.category === "security" && ["spec.md", "threat-model.md"].includes(f.location.file),
    );
    grade.unmitigated =
      threats?.unmitigated?.includes("T-3") &&
      (!first || (threats.present === true && ["T-1", "T-2"].every((n) => !threats.unmitigated.includes(n))));
    grade["files-untouched"] = status.length === 0 && Object.keys(submission).length === 1;
    if (!first) {
      const r = d.resolutions?.[0];
      grade.resolution =
        d.resolutions?.length === 1 &&
        r.round === 1 &&
        r.n === 1 &&
        r.status === "unresolved" &&
        d.findings.some((f: { n: number }) => f.n === r.carriedAs);
    }
    return { grade, candidate };
  }
  const prefix = api ? "src/api/tasks" : "src/task-list/sort";
  const changed = status.map((line) => line.slice(3)).sort();
  const head = s.refs.head;
  const indexClean = cmd("diff", "--cached", "--name-only") === "";
  grade["no-git-writes"] = cmd("rev-parse", "HEAD").trim() === head && indexClean && cmd("show-ref", "--head") === s.initialRefs;
  const getHead = (path: string) => runGit(git, join(trialDir, "project"), ["show", head + ":" + path]).toString();
  const testFile = prefix + ".test.ts",
    codeFile = prefix + ".ts";
  const currentTests = suiteTests(safeText(s.worktree, testFile));
  const oldTests = suiteTests(getHead(testFile));
  const intact =
    oldTests.length > 0 && oldTests.every((old) => currentTests.filter((t) => t.name === old.name && t.body === old.body).length === 1);
  const changes = new Map<string, Buffer | null>();
  if (changed.length > 64) throw new Error("oversize contestant diff");
  for (const path of changed) {
    assertRepoPath(path);
    if (path.split("/").some((p) => p.startsWith("."))) throw new Error("unexpected hidden contestant path");
    const bytes = existsSync(join(s.worktree, path)) ? readRegularFile(join(s.worktree, path), 1024 * 1024) : null;
    changes.set(path, bytes);
    if (bytes) candidate[path] = bytes.toString();
  }
  for (const path of [testFile, codeFile]) candidate[path] = safeText(s.worktree, path);
  const history = await editHistory(rollout, d.reproduction?.test?.name ?? "", s.worktree);
  if (repair) {
    grade.mode =
      d.taskId === s.brief.taskId &&
      d.mode === "repair" &&
      d.round === 2 &&
      d.status === "complete" &&
      d.inputSha === head &&
      d.inputSha !== s.refs.base;
    grade["starts-from-head"] = !history.reset && intact && ["AC-1", "AC-2"].every((ac) => oldTests.some((t) => t.name.startsWith(ac)));
    grade["reproduction-kept"] = isDeepStrictEqual(d.reproduction, previous("archive/code/round-1/build-report.json").reproduction);
    const rows = d.findingsAddressed;
    grade.addressed =
      rows.length === 2 &&
      ["fixed", "disputed"].every((action, i) =>
        rows.some((f: any) => f.source === "code-reviewer" && f.action === action && f.ref === "round 1 finding " + (i + 1)),
      );
    grade.scope = isDeepStrictEqual(changed, [codeFile, testFile].sort());
    grade["tests-intact"] = intact;
  } else {
    grade.status =
      d.taskId === s.brief.taskId &&
      d.mode === "build" &&
      d.status === "complete" &&
      d.inputSha === s.refs.base &&
      d.baseSha === s.refs.base &&
      d.specSetSha256 === s.brief.specSet?.sha256 &&
      isDeepStrictEqual(
        d.acceptanceCriteria.map((c: any) => c.id),
        previous("spec-lead.json").acceptanceCriteria.map((c: any) => c.id),
      ) &&
      d.acceptanceCriteria.every((c: any) => c.implemented === true && c.tests.length > 0) &&
      (!api || d.reproduction === null);
    grade["existing-tests-intact"] = intact && (api || !d.existingTestsChanged.length);
    if (api)
      grade["no-dependency"] =
        !changed.some((p) => p === "package.json" || /(^|\/)(?:[^/]*lock(?:\.json|b|\.yaml)?|yarn\.lock)$/.test(p)) &&
        !d.dependenciesAdded.length;
    else {
      grade.reproduction =
        d.reproduction?.acId === "AC-1" && d.reproduction.exitCodeBeforeFix !== 0 && d.reproduction.exitCodeAfterFix === 0;
      grade["red-before-fix"] = history.red;
      grade.scope = changed.every((p) => p.startsWith("src/task-list/")) && isDeepStrictEqual(changed, [...d.filesChanged].sort());
    }
  }
  const trustedDir = join(trialDir, "project");
  const good = join(trialDir, "hidden-" + crypto.randomUUID());
  mkdirSync(good, { mode: 0o700 });
  evalCheckout(git, factory, s.pin, good, trialDir, api ? "api-task-by-id-safe.patch" : "sort-fix-good.patch");
  const run = async (mode: "green" | "red" | "hidden") => {
    const id = crypto.randomUUID();
    const dirs = createAttempt({
      attemptId: id,
      role: "code-reviewer",
      stage: "code",
      stateRoot: dispatch.stateRoot,
      accountHome: dispatch.accountHome,
      project: trustedDir,
      runRoot: join(s.root, "runs"),
    });
    const repo = dirs.scratchRepo!;
    checkoutSnapshot(git, trustedDir, head, repo);
    checkoutSnapshot(git, trustedDir, head, dirs.worktree);
    for (const [path, bytes] of changes) {
      const dest = join(repo, path);
      if (bytes) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
      } else rmSync(dest, { force: true });
    }
    if (mode === "red") writeFileSync(join(repo, codeFile), runGit(git, trustedDir, ["show", s.refs.base + ":" + codeFile]));
    if (mode === "hidden") writeFileSync(join(repo, dirname(testFile), "factory-hidden.test.ts"), safeText(good, testFile), { flag: "wx" });
    const log = join(trialDir, "check-" + id);
    mkdirSync(log, { mode: 0o700 });
    const checked = await prepareBroker(dirs, dispatch, log, s.refs.base, head).runTest();
    writeFileSync(join(log, "result.json"), JSON.stringify(checked), { mode: 0o600, flag: "wx" });
    return checked;
  };
  const green = await run("green");
  const hidden = await run("hidden");
  grade["tests-pass"] =
    green.exitCode === 0 && (api || repair || d.commands.some((c: any) => c.command === "bun test" && c.exitCode === 0));
  grade["hidden-acceptance"] =
    hidden.exitCode === 0 && hidden.output.includes("factory-hidden.test.ts") && hidden.output.includes("(pass) AC-3");
  if (repair) grade["ac3-tested"] = green.output.includes("(pass) AC-3");
  else if (!api) {
    const red = await run("red");
    grade["reproduction-real"] =
      red.exitCode !== null &&
      red.exitCode !== 0 &&
      d.reproduction?.test?.name &&
      red.output.includes("(fail) " + d.reproduction.test.name) &&
      /expect\(|Expected:/.test(red.output) &&
      !/SyntaxError|Cannot find module/.test(red.output);
    grade["tests-named"] = d.acceptanceCriteria.every((c: any) =>
      c.tests.every((t: any) => t.name.startsWith(c.id) && green.output.includes("(pass) " + t.name)),
    );
  }
  return { grade, candidate };
}
