"""Check the usage mutations in an isolated copy using the targeted Bun regression test."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
cases = json.loads((root / "scripts/mutations/step-08.json").read_text())


def run(directory, suite, test, mark):
    result = subprocess.run(["bun", "test", f"test/{suite}.test.ts", "--test-name-pattern", test],
                            cwd=directory, capture_output=True, text=True, timeout=60)
    if result.returncode != int(mark == "(fail)") or not any(
            mark in line and test in line for line in (result.stdout + result.stderr).splitlines()):
        raise RuntimeError(f"expected {mark} {test}\n{result.stdout}{result.stderr}")


with tempfile.TemporaryDirectory(prefix="factory-usage-mutations-") as tmp:
    directory = Path(tmp)
    shutil.copytree(root / "src", directory / "src")
    shutil.copytree(root / "test", directory / "test", ignore=shutil.ignore_patterns(".state"))
    shutil.copy(root / "factory.config.ts", directory)
    (directory / "docs").mkdir()
    shutil.copy(root / "docs/design.md", directory / "docs")
    for suite, test in sorted({(suite, test) for _, suite, test, _, _ in cases}):
        run(directory, suite, test, "(pass)")
    for source, suite, test, before, after in cases:
        path = directory / "src" / (source + ".ts")
        original = path.read_text()
        if original.count(before) != 1:
            raise ValueError(f"expected one anchor in {source}: {before}")
        path.write_text(original.replace(before, after))
        run(directory, suite, test, "(fail)")
        path.write_text(original)
        print(f"KILLED {source} / {test}: {before}")
    print(f"{len(cases)}/{len(cases)} killed")
