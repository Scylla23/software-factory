import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeArgs } from "../src/dispatch/claude";
import { codexArgs } from "../src/dispatch/codex";
import { checkHomeFlags, inspectHarnessHome } from "../src/dispatch/home-inventory";
import { afterHomeLaunch, beforeHomeLaunch, personalSourceNames } from "../src/dispatch/home-session";
import { makeSandbox, type Sandbox } from "./helpers";

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());
const policy = { readable: [], writable: [], denyRead: [], denyWrite: [] };
const write = (path: string, data = "") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
const jsonl = (path: string, rows: unknown[]) => write(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

test("only the pinned disabled locations and ordinary runtime paths are admitted", () => {
  const home = box.codexHome,
    p = join(home, "skills/.system/skill-creator/SKILL.md");
  write(p, "version one");
  expect(inspectHarnessHome("codex", home).names.has("skill-creator")).toBe(true);
  write(p, "version two");
  expect(inspectHarnessHome("codex", home).locations.has("skills/.system/skill-creator/SKILL.md")).toBe(true);
  write(join(home, "skills/.system/skill-creator/hooks.json"));
  expect(() => inspectHarnessHome("codex", home)).toThrow("unrecognized disabled source");
});
test("unexpected config, links and new classes refuse before process creation", () => {
  const home = box.config.harnessHomes.claude;
  write(join(home, ".claude.json"), '{"mcpServers":{}}');
  expect(() => inspectHarnessHome("claude", home)).toThrow("unexpected factory home configuration");
  write(join(home, ".claude.json"), "{}");
  write(join(home, "backups/.claude.json.backup.123"));
  linkSync(join(home, "backups/.claude.json.backup.123"), join(home, ".last-cleanup"));
  expect(() => inspectHarnessHome("claude", home)).toThrow("link");
  write(join(box.codexHome, "commands/new.md"));
  expect(() => inspectHarnessHome("codex", box.codexHome)).toThrow("unexpected factory home location");
});
test("both launches must carry the effective source disabling settings", () => {
  const args = codexArgs({ model: "m", effort: "low", worktreePath: box.worktree, policy, prompt: "x" });
  expect(() => checkHomeFlags("codex", args)).not.toThrow();
  args.splice(args.indexOf("--"), 0, "-c", "features.plugins=true");
  expect(() => checkHomeFlags("codex", args)).toThrow("not disabled");
  const ca = claudeArgs({ model: "m", effort: "low", sessionId: crypto.randomUUID(), policy, prompt: "x" });
  expect(() => checkHomeFlags("claude", ca)).not.toThrow();
  ca.splice(ca.indexOf("--disable-slash-commands"), 1);
  expect(() => checkHomeFlags("claude", ca)).toThrow("not disabled");
});
test("an init skill or private instruction that loads a disabled source quarantines the attempt", async () => {
  const h = box.config.harnessHomes.claude,
    id = crypto.randomUUID(),
    stdout = join(box.logDir, "stream");
  const args = claudeArgs({ model: "m", effort: "low", sessionId: id, policy, prompt: "x" });
  const before = beforeHomeLaunch("claude", h, args);
  const init = {
    type: "system",
    subtype: "init",
    session_id: id,
    skills: [],
    agents: [],
    plugins: [],
    mcp_servers: [],
    slash_commands: [],
  };
  jsonl(stdout, [{ ...init, skills: ["pdf"] }]);
  await expect(afterHomeLaunch("claude", h, before, stdout, id)).rejects.toThrow("init skills");
  jsonl(stdout, [init]);
  const transcript = join(h, "projects/test", id + ".jsonl");
  jsonl(transcript, [{ type: "api-request-shape", shape: { system: [{ type: "text", text: "name: personal-skill" }] } }]);
  await expect(afterHomeLaunch("claude", h, before, stdout, id, { personal: new Set(["personal-skill"]) })).rejects.toThrow(
    "disabled source",
  );
  write(join(h, "CLAUDE.md"));
  await expect(afterHomeLaunch("claude", h, before, stdout, id)).rejects.toThrow("unexpected factory home location");
});
test("a Codex catalog in a private rollout quarantines an otherwise clean session", async () => {
  const h = box.codexHome,
    id = crypto.randomUUID(),
    stdout = join(box.logDir, "stream");
  const before = inspectHarnessHome("codex", h);
  jsonl(stdout, [{ type: "thread.started", thread_id: id }]);
  const path = join(h, "sessions/2026/11/20/rollout-2026-11-20T02-29-00-" + id + ".jsonl");
  const meta = { type: "session_meta", payload: { id, base_instructions: { text: "Codex" } } };
  const record = (text: string) => ({
    type: "response_item",
    payload: { role: "developer", type: "message", content: [{ type: "input_text", text }] },
  });
  jsonl(path, [meta, record("### Available skills\n- example: data")]);
  await expect(afterHomeLaunch("codex", h, before, stdout, id)).rejects.toThrow("skill catalog");
  const catalog = {
    type: "response_item",
    payload: {
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "namespace", name: "functions", tools: [{ name: "exec", description: "### `exec_command`" }] }],
    },
  };
  jsonl(path, [
    meta,
    record("normal context"),
    { ...catalog, payload: { ...catalog.payload, tools: [...catalog.payload.tools, { type: "namespace", name: "personal", tools: [] }] } },
  ]);
  await expect(afterHomeLaunch("codex", h, before, stdout, id)).rejects.toThrow("tool namespace");
  jsonl(path, [meta, record("normal context"), catalog]);
  await afterHomeLaunch("codex", h, before, stdout, id);
  write(join(h, "skills/.system/skill-creator/SKILL.md"));
  await expect(afterHomeLaunch("codex", h, before, stdout, id)).rejects.toThrow("appeared");
});
test("personal discovery enumerates names in installed roots and shared entries without opening skill files", () => {
  write(join(box.home, ".claude/plugins/cache/example/skills/invoice/SKILL.md"), "name: secret-content");
  write(join(box.home, ".codex/agents/audit.toml"), "secret-content");
  expect([...personalSourceNames(box.home)].sort()).toEqual(["audit", "invoice"]);
});

test("temporary Codex command aliases must target exactly the pinned executable", () => {
  const path = join(box.codexHome, "tmp/arg0-macos/codex-arg0abcdef/apply_patch");
  mkdirSync(dirname(path), { recursive: true });
  const pinned = join(box.bin, "fake-cli");
  symlinkSync(pinned, path);
  expect(() => inspectHarnessHome("codex", box.codexHome, pinned)).not.toThrow();
  unlinkSync(path);
  symlinkSync(join(box.bin, "fake-orca"), path);
  expect(() => inspectHarnessHome("codex", box.codexHome, pinned)).toThrow("link");
});
