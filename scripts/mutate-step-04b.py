"""Run the step 4b controls in an isolated copy, one source change at a time."""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTANTS = [
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
        shutil.copytree(ROOT / "src", directory / "src")
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
