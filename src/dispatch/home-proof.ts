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

export function qualifiesTeamModelProof(raw: unknown) {
  if (
    !isRecord(raw) ||
    raw.version !== pinnedVersions.claude ||
    raw.harness !== "claude" ||
    !Array.isArray(raw.arms) ||
    raw.arms.length !== 2
  )
    return false;
  if (!Array.isArray(raw.failures) || raw.failures.length) return false;
  const ids = new Set();
  const arms = raw.arms;
  return [true, false].every((control) => {
    const rows = arms.filter((a: unknown) => isRecord(a) && a.control === control);
    const a = rows[0];
    if (
      rows.length !== 1 ||
      !a ||
      a.test !== "D3-distinct" ||
      a.homeAudit !== true ||
      a.factoryLogin !== true ||
      a.passed !== true ||
      typeof a.id !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(a.id) ||
      ids.has(a.id) ||
      a.observedModel !== "claude-haiku-5-5" ||
      a.parentEffort !== "low" ||
      !Array.isArray(a.types) ||
      !a.types.includes("probe-member") ||
      !Array.isArray(a.children) ||
      !Array.isArray(a.starts)
    )
      return false;
    ids.add(a.id);
    if (control) return !a.children.length && !a.starts.length;
    const child = a.children[0],
      start = a.starts[0];
    return (
      a.children.length === 1 &&
      a.starts.length === 1 &&
      isRecord(child) &&
      isRecord(start) &&
      start.role === "probe-member" &&
      typeof start.id === "string" &&
      start.id === child.agent &&
      child.bodyInSystem === true &&
      child.briefInSystem === true &&
      child.model === "claude-sonnet-5-5" &&
      child.effort === "medium"
    );
  });
}

export function verifiedPersonalProbe(harness: Harness, state: string, executable: string) {
  return verifiedReceipt(harness, state, executable, "personal-negative", r => isRecord(r) &&
    r.test === "personal-negative" && r.harness === harness && r.version === pinnedVersions[harness] &&
    r.model === (harness === "claude" ? "claude-haiku-5-5" : "gpt-6-luna") && r.effort === "low" &&
    typeof r.candidates === "number" && r.candidates > 0 && r.scope === "installed-sources" && typeof r.session === "string" && r.passed === true &&
    Array.isArray(r.failures) && r.failures.length === 0);
}
export function verifiedHomeProof(harness: Harness, state: string, executable: string) {
  return verifiedReceipt(harness, state, executable, "s1", (r) => qualifiesHomeProof(harness, r));
}
export function verifiedTeamModelProof(state: string, executable: string) {
  return verifiedReceipt("claude", state, executable, "d3-distinct", qualifiesTeamModelProof);
}
function verifiedReceipt(harness: Harness, state: string, executable: string, kind: string, accepts: (raw: unknown) => boolean) {
  const dir = join(state, "skill-proofs"),
    path = join(dir, harness + "-" + kind + ".json");
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
  return version.exitCode === 0 && version.stdout.toString().trim() === pinnedVersions[harness] && accepts(receipt);
}
