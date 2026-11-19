"""Run each step 3 mutation alone in a disposable checkout of the sources and tests."""
import argparse
import io
import json
from pathlib import Path
import tarfile
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CASES = []


def group(source, case, mutations, test_file="factory"):
    for before, after in mutations:
        CASES.append((source, test_file, case, before, after))


group("factory/github", "GitHub intake authorizes", [
    ("repo?.databaseId !== pilot.repoId", "false"),
    ("issue.author?.databaseId !== config.ownerId", "false"),
    ('if (!issue.labels.nodes.some((l) => l.name === "factory"))', "if (false)"),
    ('authorization?.event !== "labeled"', "false"),
    ("authorization.actor?.id !== config.ownerId", "false"),
    ("!(Date.parse(issue.lastEditedAt) < Date.parse(authorization.created_at))", "false"),
    (".includes(e.event)).at(-1)", ".includes(e.event)).at(0)"),
    ('e.event === "renamed" &&', "false &&"),
])
group("factory/gates", "stale, untrusted", [
    ('if (own || c.body.includes("<!-- factory:"))', 'if (c.body.includes("<!-- factory:"))'),
    ('if (own || c.body.includes("<!-- factory:"))', "if (own)"),
    ("if (c.authorId !== config.ownerId)", "if (false)"),
    ("sha !== task.spec", "false"),
])
group("factory/gates", "re-verification requires", [
    ("const reason = commandRefusal(c, own) ?? (", "const reason = ("),
    ("c.id <= announcement ?", "false ?"),
    ("sha !== task.head ?", "false ?"),
    ("prHead !== task.head", "false"),
    ("!store.canReverify(task)", "false"),
    ("""!c.body.startsWith("/reverify") || store.db.query("SELECT id FROM approvals WHERE kind='comment' AND id=?").get(c.id)""", """!c.body.startsWith("/reverify")"""),
    ("[...comments].sort((a, b) => a.id - b.id)", "comments"),
    ("if (!resolution) {", "if (true) {"),
    ("if (c.id === resolution?.id) continue;", ""),
])
group("factory/gates", "a later rejection", [
    ("r.user.id === config.ownerId &&", "true &&"),
    ("latest.commit_id === task.head", "true"),
    ('latest.state === "APPROVED"', "true"),
    (".at(-1);", ".at(0);"),
    ('Date.parse(latest.submitted_at ?? "") > Date.parse(readyAt)', "true"),
])
group("factory/store", "intent exists before", [
    ("if (row.intent !== json)", "if (false)"),
    ("if (this.task(task.id).visit !== task.visit)", "if (false)"),
    ("return { id: row.id, result: row.result, action, fresh };", "return { id, result: row.result, action, fresh };"),
])
group("factory/store", "active visits survive", [("if (busy) throw", "if (false) throw")])
group("factory/store", "re-verification requires", [('Object.keys(update).some((k) => k !== "reason")', "false")])
group("factory/store", "stale, untrusted", [
    ("if (approval && !this.record(task.id, approval))", "if (false && approval && !this.record(task.id, approval))"),
])
group("factory/store", "reverification authority", [
    ('result.verdict === "approve"', "true"),
    ('previous?.previous !== "verifying"', "false"),
    ("result.base === persisted.base", "true"),
    ("result.head === persisted.head", "true"),
    ('!persisted.reason.startsWith("failed verification:")', "false"),
    ("persisted.head !== task.head", "false"),
    ("persisted.base !== task.base", "false"),
])
group("factory/run", "one failed verification", [
    ("if (task.repairCount) return", "if (false) return"),
    ("evidence.pr !== task.pr || evidence.head !== task.head", "evidence.pr !== task.pr"),
])
group("factory/machine", "intent exists before", [("if (attempt.result !== null)", "if (false)")])
group("factory/machine", "restarting after SIGKILL", [("store.finish(attempt.id, result);", "void result;")], "factory-crash")
group("factory/run", "CLI routes only", [('!["approve", "changes"].includes(String(parsed.verdict))', "false")])
reader = (ROOT / "src/factory/verify.ts").read_text()
start = reader.index("  const lines =")
group("factory/verify", "Orca saved inventory rows", [(reader[start:reader.index("\n}", start)],
    r'''  const words = text.replace(/[|\s]+/g," ").trim();
  return rows.every(row => (" "+words+" ").includes(" "+row.name+" "+row[stage]+" "));''')])
group("factory/gates", "edited commands", [
    ("c.updatedAt !== c.createdAt", "false"), ("c.lastEditedAt !== null", "false"),
])
group("factory/checks", "Bun JUnit requires", [
    ("count(//testcase)=1", "count(//testcase)>=1"),  # Root count is changed as well below.
    ("@assertions>0", "true()"),
    ("(@name='AC-1' or starts-with(@name,'AC-1 '))", "true()"),
], "factory-reproduction")
group("factory/run", "real stages stop on infra", [
    ("  requireHealthyInfrastructure(result.checks);", ""),
], "factory-crash")
group("factory/github", "adopts exactly its commit", [
    ("if (matches && diff.every((path) => paths.has(path)))", "if (matches)"),
    ("if (matches && diff.every((path) => paths.has(path)))", "if (diff.every((path) => paths.has(path)))"),
    ("commit.parents[0]?.sha === (parent ?? task.base)", "true"),
    ("commit?.message === message", "!!commit"),
], "github")
group("github/commit", "expected parent forbids", [
    ("req.expectedHead === undefined && attempt === 0", "attempt === 0"),
], "github")
group("factory/worker", "builder changes to commands", [
    ("if (protectsChecks(name))", "if (false)"),
], "factory-worker")
group("factory/worker", "worker, project check and capture receipts", [
    ("result.runId !== attempt.id", "false"),
], "factory-receipts")


def run(directory, test_file, case):
    return subprocess.run(["bun", "test", f"test/{test_file}.test.ts", "--test-name-pattern", case],
                          cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, timeout=75)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", action="store_true", help="Replay the 38 pre-review mutants against 2d923bb")
    opts = parser.parse_args()
    cases = json.loads((ROOT / "scripts/mutations/step-03-original.json").read_text()) if opts.original else CASES
    failures = []
    with tempfile.TemporaryDirectory(prefix="factory-step3-mutations-") as scratch:
        directory = Path(scratch)
        if opts.original:
            archive = subprocess.check_output(["git", "archive", "2d923bb", "src", "test", "factory.config.ts"], cwd=ROOT)
            with tarfile.open(fileobj=io.BytesIO(archive)) as files:
                files.extractall(directory, filter="data")
        else:
            shutil.copytree(ROOT / "src", directory / "src")
            shutil.copytree(ROOT / "test", directory / "test", ignore=shutil.ignore_patterns(".state"))
            shutil.copy(ROOT / "factory.config.ts", directory)
        for test_file, case in sorted({(t, c) for _, t, c, _, _ in cases}):
            baseline = run(directory, test_file, case)
            if baseline.returncode or not any("(pass)" in l and case in l for l in baseline.stdout.splitlines()):
                raise RuntimeError(f"baseline did not pass: {case}\n{baseline.stdout}")
        for n, (source, test_file, case, before, after) in enumerate(cases, 1):
            path = directory / "src" / (source + ".ts")
            original = path.read_text()
            if original.count(before) != 1:
                raise RuntimeError(f"mutation {n} needs exactly one anchor: {before}")
            changed = original.replace(before, after)
            if before == "count(//testcase)=1":
                changed = changed.replace("/testsuites[@tests=1", "/testsuites[@tests>=1")
            try:
                path.write_text(changed)
                result = run(directory, test_file, case)
            finally:
                path.write_text(original)
            killed = result.returncode == 1 and any("(fail)" in l and case in l for l in result.stdout.splitlines())
            print(f"{n:02} {'KILLED' if killed else 'SURVIVED'} {source}: {before} [{case}]")
            if not killed:
                failures.append(n)
    print(f"{len(cases)-len(failures)}/{len(cases)} killed; survivors {failures}")
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
