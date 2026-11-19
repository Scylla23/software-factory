import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateDir, type DispatchConfig } from "../src/dispatch/config";
import { homeSources, pinnedVersions, qualifiesHomeProof, verifiedHomeProof } from "../src/dispatch/home-proof";
import type { Harness } from "../src/dispatch/types";

/** Pass no subscription-home option to either runner. Each arm owns its disposable home. */
export function runHomeProofs(harness: Harness, config: DispatchConfig) {
  if (verifiedHomeProof(harness, config.stateRoot, config.executables[harness])) return { harness, verified: true, reused: true };
  const dir = join(config.stateRoot, "skill-proofs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir, config.stateRoot);
  const version = Bun.spawnSync([config.executables[harness], "--version"], { timeout: 5000 }).stdout.toString().trim();
  if (version !== pinnedVersions[harness]) throw new Error("pinned proof binary changed: " + harness);
  const script = join(import.meta.dir, harness === "claude" ? "probe-claude-step-04b.ts" : "probe-step-04b.ts");
  const arms: unknown[] = [],
    failures: string[] = [];
  for (const source of homeSources) {
    const proof = Bun.spawnSync([process.execPath, script, source], {
      cwd: import.meta.dir,
      // The inner supervisors bound each arm and own its credential teardown.
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const line of proof.stdout.toString().trim().split("\n").filter(Boolean)) arms.push(JSON.parse(line));
    if (proof.exitCode !== 0) {
      const missing = harness + " proof credential not provisioned";
      if (proof.stderr.toString().trim() === missing) {
        failures.push(missing);
        break;
      }
      failures.push(source + " incomplete");
    }
  }
  const receipt = { harness, version, arms, failures };
  const verified = !failures.length && qualifiesHomeProof(harness, receipt);
  const result = join(dir, crypto.randomUUID() + ".json");
  writeFileSync(result, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  if (verified) renameSync(result, join(dir, harness + "-s1.json"));
  return { harness, verified, failures, arms: arms.length };
}
