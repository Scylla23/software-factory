"""Run the step 4b controls in an isolated copy, one source change at a time."""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTANTS = [
    ("../../scripts/eval-budget", "eval-budget", "total.input + input > batchLimit.input", "false"),
    ("../../scripts/eval-budget", "eval-budget", "total.output + output > batchLimit.output", "false"),
    ("../../scripts/eval-budget", "eval-budget", "if (total.pending)", "if (false)"),
    ("../../scripts/eval-budget", "eval-budget", "model !== approvedModel", "false"),
    ("home-proof", "home-proof", "a.factoryLogin !== false", "false"),
    ("home-proof", "home-proof", "a.sourceLoaded !== control", "false"),
    ("../../scripts/batch-one-cases", "batch-one-cases", "output.includes(only.quote)", "true"),
    ("../../scripts/batch-one-cases", "batch-one-cases", "matching.length === 1", "true"),
    ("claude-writes", "claude-writes", "live.resultUuid === e.uuid", "true"),
    ("claude-writes", "claude-writes", "e.parent_tool_use_id !== stream.startCall", "false"),
    ("claude-writes", "claude-writes", "e.subagent_type !== identity.role", "false"),
    ("claude-writes", "claude-writes", "meta.id === c.tool_use_id", "true"),
    ("claude-writes", "claude-writes", "req.uuid !== e.sourceToolAssistantUUID", "false"),
    ("broker", "skill-broker", "Object.keys(args).length !== 1", "false"),
    ("broker", "skill-broker", 'writeFileSync(pending, name, {flag: "wx"', 'writeFileSync(pending, name, {flag: "w"'),
    ("../../scripts/proof-credentials", "proof-credentials", 'CLAUDE_CODE_OAUTH_TOKEN: token', 'CLAUDE_CODE_OAUTH_TOKEN: ""'),
    ("../../scripts/proof-credentials", "proof-credentials", 'rmSync(codexHome, { recursive: true, force: true });', ''),
    ("../../scripts/proof-credentials", "proof-credentials", 'if (result.status === 44)', 'if (false)'),
    ("../../scripts/probe-sources", "proof-credentials", 'if (homeSource && roots.shared)', 'if (false)'),
    ("../../scripts/eval-inputs", "eval-inputs", 'return [key,plan];', 'return [key,v];'),

    ("claude-writes", "claude-writes", "submitted.assistant !== e.sourceToolAssistantUUID", "false"),
    ("claude-writes", "claude-writes", "result.content === submitted.content", "true"),
    ("claude-writes", "claude-writes", "if (requests.size)", "if (false)"),
    ("../factory/skill-validation", "skill-validation", "document.taskRevision === task.revision", "true"),
    ("../factory/skill-validation", "skill-validation", "document.taskId === brief.taskId", "true"),
    ("../factory/skill-validation", "skill-validation", "v.covers.headSha === brief.headSha", "true"),
    ("../factory/skill-validation", "skill-validation", "testPassed && v.checks", "true && v.checks"),
    ("../factory/skill-validation", "skill-validation", "|| row.tested", "|| true"),
    ("../factory/skill-validation", "skill-validation", "if (!validate(parsed))", "if (false)"),
    ("codex-writes", "codex-writes", 'payload.thread_id !== identity.sessionId', 'false'),
    ("codex-writes", "codex-writes", 'item.status !== "completed"', 'false'),
    ("codex-writes", "codex-writes", 'writes.delete(rel);', ''),
    ("codex-writes", "codex-writes", 'payload.source !== "exec"', 'false'),
    ("bundle", "skill-bundle", 'if (parts.slice(0, -1).includes("evals")) continue;', ""),
    ("bundle", "skill-bundle", 'overlaps(source, realpathSync(root))', "false"),
    ("bundle", "skill-bundle", 'size > FILE_LIMIT', "false"),
    ("bundle", "skill-bundle", 'Buffer.byteLength(text) > MAX_INSTRUCTIONS_BYTES', "false"),
    ("bundle", "skill-bundle", '"-l", commit, "--", "skills"', '"-l", "HEAD", "--", "skills"'),
    ("output", "skill-output", "current.ino !== outputIdentity.ino", "false"),
    ("output", "skill-output", "write.taskId !== identity.taskId", "false"),
    ("output", "skill-output", "write.attemptId !== identity.attemptId", "false"),
    ("output", "skill-output", "write.sessionId !== author.sessionId", "false"),
    ("output", "skill-output", "write.role !== author.role", "false"),
    ("output", "skill-output", "writes.findLast(", "writes.find("),
    ("output", "skill-output", "outputDigest(bytes) !== write.sha256", "false"),
    ("regular-file", "skill-output", "stat.size > limit", "false"),
    ("skill-policy", "skill-policy", 'dirs.role === "builder"', 'true'),
    ("codex", "skill-policy", '"agents.enabled=false"', '"agents.enabled=true"'),
]


def run(directory, test):
    return subprocess.run(
        ["bun", "test", f"test/{test}.test.ts"], cwd=directory,
        capture_output=True, text=True, timeout=60,
    )


def main():
    # The attempt tests explicitly refuse directories below the system temp roots.
    state = ROOT / "test/.state"
    state.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=state, prefix="mutations-") as tmp:
        directory = Path(tmp)
        shutil.copy(ROOT / "factory.config.ts", directory)
        shutil.copytree(ROOT / "src", directory / "src")
        shutil.copytree(ROOT / "scripts", directory / "scripts")
        shutil.copytree(ROOT / "test", directory / "test", ignore=shutil.ignore_patterns(".state"))
        shutil.copytree(ROOT / "skills", directory / "skills")
        (directory / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for test in sorted({m[1] for m in MUTANTS}):
            result = run(directory, test)
            if result.returncode:
                raise RuntimeError(f"baseline failed for {test}\n{result.stderr}")
        failures = 0
        for source, test, original, mutated in MUTANTS:
            path = directory / f"src/dispatch/{source}.ts"
            before = path.read_text()
            if before.count(original) != 1:
                raise ValueError(f"{source}: expected one occurrence of {original}")
            try:
                path.write_text(before.replace(original, mutated))
                result = run(directory, test)
            finally:
                path.write_text(before)
            killed = result.returncode == 1 and "(fail)" in result.stderr and "expect(" in result.stderr
            print(f"{'KILLED' if killed else 'SURVIVED'} {source}: {original}", flush=True)
            if not killed:
                failures += 1
        print(f"{len(MUTANTS) - failures}/{len(MUTANTS)} killed")
        return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
