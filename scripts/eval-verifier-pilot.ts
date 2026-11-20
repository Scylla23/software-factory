import { existsSync, mkdirSync, mkdtempSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readRegularFile } from "../src/dispatch/regular-file";
import { basename, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { redact } from "../src/github/summary";
import { config } from "../factory.config";
import { checkoutSnapshot } from "../src/dispatch/attempt";
import type { DispatchConfig } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { outputDigest } from "../src/dispatch/output";
import { withVerificationProfile } from "../src/verify/browser";
import { VIEWPORTS } from "../src/verify/evidence";
import { loadVerifyConfig, startPreview } from "../src/verify/preview";
import { openEvidenceStore } from "../src/verify/store";
import { evalCheckout } from "./eval-checkout";

const file = "verification/evidence/index.json";
// All displayed values come from the three declared rows in the pinned case.
const server = [
  'import {sortTasks,formatDue} from "./src/task-list/sort";',
  'const tasks=[20,10,2].map((n,i)=>({id:i+1,ownerId:1,title:["File report","Review draft","Send notes"][i]!,due:"2026-11-"+String(n).padStart(2,"0")}));',
  'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT??3000),fetch(request){',
  '  const u=new URL(request.url); if(u.pathname==="/health")return new Response("ok");',
  '  if(u.pathname!=="/tasks")return new Response("missing",{status:404});',
  '  const rows=sortTasks(tasks,u.searchParams.get("sort")==="due"?"due":"title",u.searchParams.get("dir")==="desc"?"desc":"asc");',
  '  const html=rows.map(r=>"<tr><td>"+r.title+"</td><td>"+formatDue(r.due)+"</td></tr>").join("");',
  '  return new Response(\'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasks</title><style>body{font:16px system-ui;margin:24px;color:#182026}main{max-width:920px;overflow:hidden}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd}td:first-child{width:67%}/*viewport*/</style><main><h1>Tasks</h1><table><thead><tr><th>Task</th><th>Due</th></tr></thead><tbody>\'+html+\'</tbody></table></main><!--load-->\',{headers:{"Content-Type":"text/html"}});',
  "}});",
].join("\n");
export function verifierPilot(git: string, factory: string, pin: string, root: string, project: string) {
  const source = join(root, "ui-project"),
    manifest = join(root, "ui-project.json");
  if (!existsSync(manifest)) {
    mkdirSync(source, { mode: 0o700 });
    const old = evalCheckout(git, factory, pin, source, root, "sort-fix-good.patch");
    const cmd = (...args: string[]) => runGit(git, source, args).toString().trim();
    const commit = () => {
      cmd("add", "-A");
      cmd("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Project revision");
      return cmd("rev-parse", "HEAD");
    };
    cmd("checkout", "--detach", old.base);
    writeFileSync(join(source, "server.ts"), server, { flag: "wx" });
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    pkg.scripts.dev = "bun server.ts";
    writeFileSync(join(source, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    const base = commit();
    cmd("checkout", old.head, "--", "src/task-list/sort.ts", "src/task-list/sort.test.ts");
    writeFileSync(
      join(source, "server.ts"),
      server
        .replace("/*viewport*/", "@media(max-width:600px){table{min-width:840px}}")
        .replace("<!--load-->", '<script>console.error("Task list layout update failed")</script>'),
    );
    const head = commit();
    writeFileSync(manifest, JSON.stringify({ base, head }), { flag: "wx", mode: 0o600 });
  }
  const refs = JSON.parse(readFileSync(manifest, "utf8")) as { base: string; head: string };
  checkoutSnapshot(git, source, refs.head, project);
  return refs;
}

interface TestRecord {
  name: string;
  file: string;
  status: "pass" | "fail" | "skip";
  failure: string | null;
}
function recordedTests(path: string): TestRecord[] {
  const input = readRegularFile(path, 256 * 1024);
  if (/<!DOCTYPE|<!ENTITY/i.test(input.toString())) throw new Error("unexpected JUnit declaration");
  const extract = [
    "import json, sys, xml.etree.ElementTree as ET",
    "root = ET.fromstring(sys.stdin.buffer.read())",
    "assert root.tag == 'testsuites'",
    "rows = []",
    "for t in root.findall('./testsuite/testcase'):",
    "    failure = t.find('failure')",
    "    status = 'fail' if failure is not None or t.find('error') is not None else 'skip' if t.find('skipped') is not None else 'pass'",
    "    rows.append(dict(name=t.attrib['name'], file=t.attrib['file'], status=status, failure=failure.get('type') if failure is not None else None))",
    "print(json.dumps(rows))",
  ].join("\n");
  const r = spawnSync("/usr/bin/python3", ["-I", "-c", extract], { input, encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 });
  if (r.status !== 0) throw new Error("invalid JUnit report");
  return JSON.parse(r.stdout);
}

/** Capture the approved plan from both real commits and reuse the frozen records across judge trials. */
export async function stageUiEvidence(
  d: DispatchConfig,
  root: string,
  dir: string,
  refs: { base: string; head: string },
  planBytes: Buffer,
  factory: string,
  project: string,
) {
  const plan = JSON.parse(planBytes.toString());
  const ajv = new Ajv2020({ strictTypes: false, allowUnionTypes: true });
  const schema = (name: string) => JSON.parse(readFileSync(join(factory, "skills/verifier", name + ".schema.json"), "utf8"));
  if (!Boolean(ajv.validate(schema("plan"), plan)) || plan.baseSha !== refs.base || plan.headSha !== refs.head)
    throw new Error("invalid or unbound UI plan");
  const planned = plan.criteria.find((r: any) => r.acId === "AC-4")?.captures;
  if (!Array.isArray(planned) || !planned.length || planned.some((c) => c.fixture !== "seeded-tasks" || !c.sides.includes("base")))
    throw new Error("unbound UI capture plan");
  const path = join(root, "ui-evidence-" + outputDigest(planBytes)),
    cached = join(path, "index.json");
  const validate = ajv.compile(schema("evidence-index"));
  if (!existsSync(cached)) {
    const work = mkdtempSync(join(root, ".ui-capture-"));
    const id = crypto.randomUUID(),
      store = openEvidenceStore(d.stateRoot, id);
    const verify = loadVerifyConfig(d, {
      toolDirs: config.pilot.toolDirs,
      toolRoots: config.pilot.toolDirs,
      agentWriteRoots: [config.workspaceRoot],
    });
    const captures: object[] = [],
      testRuns: any[] = [];
    try {
      await withVerificationProfile({ orcaPath: d.executables.orca, worktree: "path:" + factory, attemptId: id }, async (browser) => {
        for (const side of ["base", "head"] as const) {
          const logDir = join(work, side);
          mkdirSync(logDir, { mode: 0o700 });
          const preview = await startPreview(
            {
              id: crypto.randomUUID(),
              taskKey: id,
              repo: project,
              sha: refs[side],
              logDir,
              project: { setup: [], egress: [], preview: ["bun", "run", "dev"], readyPath: "/health", portRange: [4100, 4199] },
              setupTimeoutMs: 30000,
              readyTimeoutMs: 30000,
              maxLifetimeMs: 180000,
            },
            verify,
          );
          try {
            for (const c of planned) {
              const url = new URL(c.route, preview.origin);
              if (url.origin !== preview.origin || url.pathname !== "/tasks") throw new Error("unbound task-list route");
              for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
                const record = await browser.capture({
                  url: url.href,
                  viewport,
                  store,
                  name: c.name + "-" + side + "-" + viewport.name,
                  acId: "AC-4",
                  commitSha: refs[side],
                  serving: preview.serving,
                });
                const { screenshotPath, screenshotBytes, ...rest } = record;
                const png = readFileSync(screenshotPath),
                  name = basename(screenshotPath);
                if (
                  outputDigest(png) !== rest.screenshotSha256 ||
                  rest.externalOrigins.length > 0 ||
                  rest.networkFailures.length ||
                  (side === "head"
                    ? !rest.consoleErrors.some((e) => e.includes("Task list layout update failed"))
                    : rest.consoleErrors.length > 0)
                )
                  throw new Error("unexpected UI capture conditions");
                writeFileSync(join(work, name), png, { flag: "wx", mode: 0o600 });
                captures.push({
                  ...rest,
                  pageText: redact(rest.pageText, 262144),
                  consoleErrors: rest.consoleErrors.map((e) => redact(e)),
                  planId: c.id,
                  side,
                  screenshotFile: name,
                });
              }
            }
            if (side === "base")
              writeFileSync(
                join(preview.worktree, "src/task-list/sort.test.ts"),
                runGit(d.executables.git, join(root, "ui-project"), ["show", refs.head + ":src/task-list/sort.test.ts"]),
              );
            const command = ["bun", "test", "--reporter=junit", "--reporter-outfile=case-tests.xml"];
            const checked = await preview.run(command, { name: "case-tests", network: "none", timeoutMs: 30000 });
            if (checked.quarantineReasons.length || checked.stopped) throw new Error("unclean verification test run");
            const log = redact(readFileSync(checked.logPath, "utf8"), 32000);
            const records = recordedTests(join(preview.worktree, "case-tests.xml"));
            const tests = plan.criteria.flatMap((r: any) =>
              (r.tests ?? []).map((t: any) => {
                const matches = records.filter((record) => record.file === t.file && record.name === t.name);
                if (matches.length !== 1) throw new Error("missing or ambiguous planned JUnit result");
                const row = matches[0]!;
                if (row.status !== (side === "base" ? "fail" : "pass") || (row.status === "fail" && row.failure !== "AssertionError"))
                  throw new Error("unexpected fixture test disposition");
                const failure =
                  row.status === "fail"
                    ? { failure: { kind: "assertion", excerpt: "JUnit AssertionError: " + redact(row.name, 300), truncated: false } }
                    : {};
                return { planId: t.id, name: row.name, file: row.file, status: row.status, ...failure };
              }),
            );
            testRuns.push({
              side: side === "base" ? "base-with-head-tests" : "head",
              commitSha: refs[side],
              testFilesSha: refs.head,
              command: command.join(" "),
              exitCode: checked.exitCode,
              stopped: checked.stopped,
              tests,
              logTail: log.slice(-1000),
            });
          } finally {
            if (!(await preview.stop()).removed) throw new Error("UI preview quarantine");
          }
        }
      });
      const index = {
        schemaVersion: 1,
        taskId: plan.taskId,
        attemptId: id,
        baseSha: refs.base,
        headSha: refs.head,
        planSha256: outputDigest(planBytes),
        textRedacted: true,
        testRuns,
        captures,
        notExecuted: [],
      };
      if (!validate(index)) throw new Error("invalid captured evidence: " + JSON.stringify(validate.errors));
      writeFileSync(join(work, "index.json"), JSON.stringify(index), { flag: "wx", mode: 0o600 });
      renameSync(work, path);
    } finally {
      await verify.egress.close();
    }
  }
  const index = JSON.parse(readFileSync(cached, "utf8"));
  if (
    !Boolean(validate(index)) ||
    index.planSha256 !== outputDigest(planBytes) ||
    index.baseSha !== refs.base ||
    index.headSha !== refs.head
  )
    throw new Error("invalid cached UI evidence");
  const evidence = join(dir, "verification", "evidence");
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "verification", "plan.json"), planBytes, { flag: "wx", mode: 0o400 });
  for (const rec of index.captures) {
    const b = readFileSync(join(path, rec.screenshotFile));
    if (outputDigest(b) !== rec.screenshotSha256) throw new Error("cached PNG differs");
    writeFileSync(join(evidence, rec.screenshotFile), b, { flag: "wx", mode: 0o400 });
  }
  writeFileSync(join(dir, file), readFileSync(cached), { flag: "wx", mode: 0o400 });
  return index.attemptId as string;
}
