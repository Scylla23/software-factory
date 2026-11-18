import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertPrivateDir, assertTrustedExecutable, createRunLogs, managedSettingsProblems, tempRoots } from "../src/dispatch/config";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const RUN = "11111111-2222-4333-8444-555555555555";

describe("assertPrivateDir (harness homes)", () => {
  test("accepts a private dir under the root", () => {
    expect(assertPrivateDir(sb.config.harnessHomes.codex, sb.stateRoot)).toBe(sb.config.harnessHomes.codex);
  });

  test("rejects group or world access, a symlink, a dir outside the root, and a missing dir", () => {
    const home = sb.config.harnessHomes.claude;
    chmodSync(home, 0o750);
    expect(() => assertPrivateDir(home, sb.stateRoot)).toThrow("accessible to group or others");
    chmodSync(home, 0o700);
    const link = join(sb.stateRoot, "linked-home");
    symlinkSync(sb.worktree, link);
    expect(() => assertPrivateDir(link, sb.stateRoot)).toThrow("symlink");
    expect(() => assertPrivateDir(realpathSync(sb.worktree), sb.stateRoot)).toThrow("not under");
    expect(() => assertPrivateDir(sb.worktree, sb.stateRoot)).toThrow("not canonical");
    expect(() => assertPrivateDir(join(sb.stateRoot, "missing"), sb.stateRoot)).toThrow("ENOENT");
  });
});

describe("assertTrustedExecutable", () => {
  test("accepts a system binary and returns its canonical path", () => {
    expect(assertTrustedExecutable("/bin/ps", tempRoots())).toBe("/bin/ps");
  });

  test("rejects an executable under an agent-writable root, even through a symlink", () => {
    const fake = join(sb.worktree, "claude");
    copyFileSync("/bin/echo", fake);
    expect(() => assertTrustedExecutable(fake, tempRoots())).toThrow("agent-writable");
    const link = join(sb.stateRoot, "claude-link");
    symlinkSync(fake, link);
    expect(() => assertTrustedExecutable(link, tempRoots())).toThrow("agent-writable");
  });

  test("rejects a group or world writable executable outside the untrusted roots", () => {
    const exe = join(sb.stateRoot, "codex");
    copyFileSync("/bin/echo", exe);
    chmodSync(exe, 0o777);
    expect(() => assertTrustedExecutable(exe, tempRoots())).toThrow("writable");
    chmodSync(exe, 0o755);
    expect(assertTrustedExecutable(exe, tempRoots())).toEndWith("/codex");
  });
});

describe("managedSettingsProblems", () => {
  test("none present: no problems", () => {
    expect(managedSettingsProblems(sb.config)).toEqual([]);
  });

  test("a present managed-settings file fails closed until its exact contents are accepted", () => {
    const file = sb.config.managedSettingsPaths[0]!;
    writeFileSync(file, '{"sandbox":{"network":{"allowedDomains":["*"]}}}');
    expect(managedSettingsProblems(sb.config)).toEqual([expect.stringContaining("present and not accepted")]);
    const digest = createHash("sha256").update('{"sandbox":{"network":{"allowedDomains":["*"]}}}').digest("hex");
    expect(managedSettingsProblems({ ...sb.config, acceptedManagedSettings: { [file]: digest } })).toEqual([]);
    writeFileSync(file, "{}");
    expect(managedSettingsProblems({ ...sb.config, acceptedManagedSettings: { [file]: digest } })).toHaveLength(1);
  });

  test("every file in a managed-settings.d directory is checked", () => {
    const dir = sb.config.managedSettingsPaths[1]!;
    mkdirSync(dir);
    writeFileSync(join(dir, "10-egress.json"), "{}");
    expect(managedSettingsProblems(sb.config)).toEqual([expect.stringContaining("10-egress.json")]);
  });
});

describe("createRunLogs", () => {
  test("creates private, exclusive log files under the state root", () => {
    const logs = createRunLogs(sb.config, sb.logDir, RUN, [sb.worktree, ...tempRoots()]);
    expect(logs.stdoutPath).toBe(join(sb.logDir, `${RUN}.stdout.jsonl`));
    expect((Bun.file(logs.stdoutPath) as any).size).toBe(0);
  });

  test("rejects a log dir outside the state root", () => {
    expect(() => createRunLogs(sb.config, sb.worktree, RUN, [])).toThrow("not under the state root");
  });

  test("rejects a log dir inside an agent write root, even within the state root", () => {
    expect(() => createRunLogs(sb.config, sb.logDir, RUN, [sb.stateRoot])).toThrow("agent-writable");
  });

  test("rejects a log dir that is a symlink out of the state root", () => {
    const link = join(sb.stateRoot, "escape");
    symlinkSync(sb.worktree, link);
    expect(() => createRunLogs(sb.config, link, RUN, [sb.worktree])).toThrow("not under the state root");
  });

  test("rejects reusing an attempt id, and a symlink planted at the log path", () => {
    createRunLogs(sb.config, sb.logDir, RUN, []);
    expect(() => createRunLogs(sb.config, sb.logDir, RUN, [])).toThrow("attempt ids are single-use");
    const other = "99999999-2222-4333-8444-555555555555";
    symlinkSync(join(sb.worktree, "x"), join(sb.logDir, `${other}.stdout.jsonl`));
    expect(() => createRunLogs(sb.config, sb.logDir, other, [])).toThrow("single-use");
  });
});
