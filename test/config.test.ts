import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateDir, assertTrustedExecutable, managedSettingsProblems, planRunFiles, reserveRunFiles, tempRoots, trustedAgentPath } from "../src/dispatch/config";
import { makeSandbox, openFileDescriptors, type Sandbox } from "./helpers";

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

describe("trustedAgentPath", () => {
  test("canonical harness bin dirs first, then the system dirs, deduplicated", () => {
    const bin = realpathSync(sb.bin);
    expect(trustedAgentPath([sb.bin, bin, "/usr/bin"], [sb.stateRoot])).toBe(`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(trustedAgentPath([], [])).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("refuses a group or world writable dir and one under an agent-writable root", () => {
    const dir = join(sb.stateRoot, "shared-bin");
    mkdirSync(dir);
    chmodSync(dir, 0o775);
    expect(() => trustedAgentPath([dir], [])).toThrow("group or world writable");
    chmodSync(dir, 0o755);
    expect(() => trustedAgentPath([dir], [sb.stateRoot])).toThrow("agent-writable");
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

  test("any existing source refuses, whatever it holds: a file, even empty, or a directory, even empty", () => {
    const [file, dir] = sb.config.managedSettingsPaths as [string, string];
    writeFileSync(file, "");
    expect(managedSettingsProblems(sb.config)).toEqual([`${file}: exists`]);
    rmSync(file);
    mkdirSync(dir);
    expect(managedSettingsProblems(sb.config)).toEqual([`${dir}: exists`]);
  });

  test("a location that cannot be checked counts as existing", () => {
    const blocked = join(sb.stateRoot, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    try {
      expect(managedSettingsProblems({ ...sb.config, managedSettingsPaths: [join(blocked, "managed-settings.json")] })).toEqual([expect.stringContaining("cannot check")]);
    } finally {
      chmodSync(blocked, 0o700);
    }
  });
});

describe("planRunFiles and reserveRunFiles", () => {
  test("creates private, exclusive log files under the state root", () => {
    const files = planRunFiles(sb.config, sb.logDir, RUN, [sb.worktree, ...tempRoots()]);
    expect(files.stdoutPath).toBe(join(sb.logDir, `${RUN}.stdout.jsonl`));
    const logs = reserveRunFiles(files, "text");
    closeSync(logs.stdoutFd);
    closeSync(logs.stderrFd);
    expect((Bun.file(logs.stdoutPath) as any).size).toBe(0);
    expect(readFileSync(files.instructionsPath, "utf8")).toBe("text");
    expect(statSync(files.instructionsPath).mode & 0o777).toBe(0o600);
  });

  test("rejects a log dir outside the state root", () => {
    expect(() => planRunFiles(sb.config, sb.worktree, RUN, [])).toThrow("not under the state root");
  });

  test("rejects a log dir inside an agent write root, even within the state root", () => {
    expect(() => planRunFiles(sb.config, sb.logDir, RUN, [sb.stateRoot])).toThrow("agent-writable");
  });

  test("rejects a log dir that is a symlink out of the state root", () => {
    const link = join(sb.stateRoot, "escape");
    symlinkSync(sb.worktree, link);
    expect(() => planRunFiles(sb.config, link, RUN, [sb.worktree])).toThrow("not under the state root");
  });

  test("rejects reusing an attempt id, and a symlink planted at any of its paths", () => {
    const logs = reserveRunFiles(planRunFiles(sb.config, sb.logDir, RUN, []), null);
    closeSync(logs.stdoutFd);
    closeSync(logs.stderrFd);
    expect(() => planRunFiles(sb.config, sb.logDir, RUN, [])).toThrow("attempt ids are single-use");
    const other = "99999999-2222-4333-8444-555555555555";
    symlinkSync(join(sb.worktree, "x"), join(sb.logDir, `${other}.instructions.md`));
    expect(() => planRunFiles(sb.config, sb.logDir, other, [])).toThrow("single-use");
  });

  test("a reservation that fails part way closes and removes what it created", () => {
    const files = planRunFiles(sb.config, sb.logDir, RUN, []);
    symlinkSync(join(sb.worktree, "x"), files.instructionsPath); // planted after the plan
    const before = openFileDescriptors();
    expect(() => reserveRunFiles(files, "text")).toThrow("single-use");
    expect([...openFileDescriptors()].filter(fd => !before.has(fd))).toEqual([]);
    expect(existsSync(files.stdoutPath) || existsSync(files.stderrPath)).toBe(false);
    unlinkSync(files.instructionsPath);
    const logs = reserveRunFiles(planRunFiles(sb.config, sb.logDir, RUN, []), "text");
    closeSync(logs.stdoutFd);
    closeSync(logs.stderrFd);
  });
});
