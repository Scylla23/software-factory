import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changes } from "../src/factory/worker";
import { Uncertain } from "../src/factory/machine";

function withRepo(check: (dir: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-worker-")));
  try {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["/usr/bin/git", "-c", "user.name=Fixture", "-c", "user.email=t@example.invalid", ...args], { cwd: dir });
      if (result.exitCode) throw new Error(result.stderr.toString());
    };
    git("init", "-q");
    writeFileSync(join(dir, "app.ts"), "original");
    git("add", "app.ts");
    git("commit", "-qm", "base");
    check(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("deleting a tracked file requests escalation", () => withRepo((dir) => {
  rmSync(join(dir, "app.ts"));
  expect(() => changes(dir)).toThrow(Uncertain);
}));

test("builder changes to commands, test discovery, compiler or lint configuration escalate", () => withRepo((dir) => {
  for (const name of ["package.json", "bunfig.toml", "tsconfig.build.json", "biome.jsonc", ".eslintrc.json", "bun.lock","src/CLAUDE.local.md","sub/.agents/skills/note","lib/.CODEX/config.toml",".claude/commands/note.md","docs/Agents.Override.md"]) {
    mkdirSync(dirname(join(dir,name)),{recursive:true});
    writeFileSync(join(dir, name), "{}");
    expect(() => changes(dir)).toThrow(Uncertain);
    rmSync(join(dir, name));
  }
  writeFileSync(join(dir, "app.ts"), "fixed");
  expect(changes(dir).map((f) => f.path)).toEqual(["app.ts"]);
}));
