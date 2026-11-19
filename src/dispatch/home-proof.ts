import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateDir } from "./config";
import { isRecord } from "./jsonl";
import { readRegularFile } from "./regular-file";
import type { Harness } from "./types";

export const homeSources = ["S1-config", "S1-home-claude", "S1-home-agents"] as const;
export const pinnedVersions = { claude: "2.1.325 (Claude Code)", codex: "codex-cli 0.169.0" } as const;
export function qualifiesHomeProof(harness: Harness, raw: unknown) {
  if (
    !isRecord(raw) ||
    raw.harness !== harness ||
    raw.version !== pinnedVersions[harness] ||
    !Array.isArray(raw.failures) ||
    raw.failures.length !== 0 ||
    !Array.isArray(raw.arms) ||
    raw.arms.length !== homeSources.length * 2
  )
    return false;
  const ids = new Set<string>();
  const arms = raw.arms;
  return homeSources.every((test) =>
    [true, false].every((control) => {
      const matches = arms.filter((a) => isRecord(a) && a.test === test && a.control === control);
      const a = matches[0];
      if (
        matches.length !== 1 ||
        !a ||
        a.factoryLogin !== false ||
        a.passed !== true ||
        a.sourceListed !== control ||
        a.sourceLoaded !== control
      )
        return false;
      const id = harness === "claude" ? a.id : a.thread;
      if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || ids.has(id)) return false;
      ids.add(id);
      return harness === "claude" ? a.observedModel === "claude-haiku-5-5" : a.observedModel === true;
    }),
  );
}

export function verifiedHomeProof(harness: Harness, state: string, executable: string) {
  const dir = join(state, "skill-proofs"),
    path = join(dir, harness + "-s1.json");
  if (!existsSync(path)) return false;
  assertPrivateDir(state, state);
  assertPrivateDir(dir, state);
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid!() || stat.mode & 0o077) throw new Error("unsafe private proof receipt");
  const receipt = JSON.parse(readRegularFile(path, 256 * 1024).toString());
  const version = Bun.spawnSync([executable, "--version"], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 5000,
    stderr: "ignore",
    cwd: dir,
  });
  return (
    version.exitCode === 0 && version.stdout.toString().trim() === pinnedVersions[harness] && qualifiesHomeProof(harness, receipt)
  );
}
