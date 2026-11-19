// Drive the pinned tools with inert writes. The Claude response fixture is local and has no provider credential.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../factory.config";
import { createAttempt } from "../src/dispatch/attempt";
import { claudeArgs } from "../src/dispatch/claude";
import { codexConfigArgs } from "../src/dispatch/codex";
import { loadDispatchConfig } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { skillPolicy } from "../src/dispatch/skill-policy";
import { agentEnv, effectiveDenyRead } from "../src/dispatch/policy";

const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const root = mkdtempSync(join(dispatch.accountHome, ".factory-write-proof-"));
const make = (name: string) => {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  return path;
};
const home = make("account"),
  harnessHome = make("config"),
  state = make("state"),
  project = make("project");
const id = crypto.randomUUID();
try {
  runGit(dispatch.executables.git, project, ["init", "--quiet", "--template="]);
  const dirs = createAttempt({
    role: "builder",
    stage: "build",
    project,
    accountHome: dispatch.accountHome,
    stateRoot: state,
    runRoot: join(root, "runs"),
    attemptId: id,
  });
  const deny = effectiveDenyRead({
    accountHome: dispatch.accountHome,
    stateRoot: dispatch.stateRoot,
    harnessHomes: Object.values(dispatch.harnessHomes),
  });
  const policy = skillPolicy(dirs, deny, [], [], dispatch.executables.git);
  const paths = [
    join(dirs.outDir, "allowed.txt"),
    join(dirs.outDir, ".claude", "skills", "sample.txt"),
    join(dirs.scratchDir, "sub", "CLAUDE.local.md"),
    join(project, ".agents", "skills", "sample.txt"),
    join(project, "sub", ".codex", "agents", "sample.txt"),
    join(project, "sub", "AGENTS.override.md"),
    join(project, "nested", "aGeNtS.md"),
    join(project, "nested", "CLAUDE.md"),
  ];
  // Pre-existing parents separate permission decisions from a tool's directory-creation behavior.
  for (const path of paths) mkdirSync(dirname(path), { recursive: true });
  paths.push(join(dirs.scratchDir, "future", ".agents", "skills", "sample.txt"));
  const permitted = paths[0]!;
  const existing = join(project, "sub", "AGENTS.md");
  writeFileSync(existing, "original");
  const passed = () =>
    existsSync(permitted) &&
    readFileSync(permitted, "utf8") === "fixture" &&
    paths.slice(1).every((p) => !existsSync(p)) &&
    readFileSync(existing, "utf8") === "original";
  for (const harness of ["codex", "claude"] as const) {
    rmSync(permitted, { force: true });
    const exe = dispatch.executables[harness],
      version = Bun.spawnSync([exe, "--version"]).stdout.toString().trim();
    if (version !== (harness === "codex" ? "codex-cli 0.169.0" : "2.1.325 (Claude Code)"))
      throw new Error("unexpected " + harness + " version");
    const env = agentEnv({}, { harness, harnessHome, accountHome: home, trustedPath: "/usr/bin:/bin" });
    if (harness === "codex") {
      const operation =
        'protected=$1; shift; if /bin/mv "$protected" "$protected.saved" || /bin/rm "$protected"; then exit 1; fi; for dest; do /bin/mkdir -p "${dest%/*}" && printf fixture > "$dest"; done; exit 0';
      const proc = Bun.spawnSync(
        [exe, "sandbox", "-P", "factory", ...codexConfigArgs(policy), "--", "/bin/sh", "-c", operation, "proof", existing, ...paths],
        { env, cwd: project, timeout: 10000 },
      );
      if (proc.exitCode !== 0 || !passed()) throw new Error("Codex discovery write control failed");
    } else {
      // Test the actual native Write permission matcher using fixed synthetic Messages API responses.
      let round = 0;
      const results = new Map<string, boolean>();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          if (!new URL(req.url).pathname.endsWith("/messages")) return Response.json({});
          const request = (await req.json()) as {
            messages: { content: { type: string; tool_use_id?: string; is_error?: boolean }[] | string }[];
          };
          for (const msg of request.messages ?? [])
            if (Array.isArray(msg.content))
              for (const c of msg.content)
                if (c.type === "tool_result" && c.tool_use_id) results.set(c.tool_use_id, c.is_error === true);
          round++;
          const blocks =
            round === 1
              ? paths.map((file_path, i) => ({
                  type: "tool_use",
                  id: "toolu_sample" + i,
                  name: "Write",
                  input: { file_path, content: "fixture" },
                }))
              : round === 2
                ? [permitted, existing].map((file_path, i) => ({
                    type: "tool_use",
                    id: "toolu_read" + i,
                    name: "Read",
                    input: { file_path },
                  }))
                : round === 3
                  ? [permitted, existing].map((file_path, i) => ({
                      type: "tool_use",
                      id: "toolu_edit" + i,
                      name: "Edit",
                      input: { file_path, old_string: i ? "original" : "fixture", new_string: i ? "changed" : "edited" },
                    }))
                  : [{ type: "text", text: "Complete" }];
          const message = {
            id: "msg_" + crypto.randomUUID(),
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          const events: object[] = [{ type: "message_start", message }];
          for (const [index, block] of blocks.entries()) {
            events.push({
              type: "content_block_start",
              index,
              content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
            });
            events.push({
              type: "content_block_delta",
              index,
              delta:
                block.type === "tool_use"
                  ? { type: "input_json_delta", partial_json: JSON.stringify("input" in block ? block.input : {}) }
                  : { type: "text_delta", text: "Complete" },
            });
            events.push({ type: "content_block_stop", index });
          }
          events.push(
            {
              type: "message_delta",
              delta: { stop_reason: round <= 3 ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          );
          return new Response(
            events.map((e) => "event: " + (e as { type: string }).type + "\ndata: " + JSON.stringify(e) + "\n\n").join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      });
      try {
        const args = claudeArgs({
          sessionId: id,
          model: "haiku",
          effort: "low",
          prompt: "Exercise the local write fixtures.",
          policy,
          fileToolsOnly: true,
          directories: [dirs.outDir, dirs.scratchDir],
        });
        const localOnly =
          '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:' + server.port + '"))';
        const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", localOnly, exe, ...args], {
          env: {
            ...env,
            ANTHROPIC_API_KEY: "local-fixture",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
          cwd: project,
          stdout: "ignore",
          stderr: "ignore",
        });
        const timer = setTimeout(() => proc.kill("SIGKILL"), 30000);
        let status: number;
        try {
          status = await proc.exited;
        } finally {
          clearTimeout(timer);
        }
        if (
          status !== 0 ||
          readFileSync(permitted, "utf8") !== "edited" ||
          readFileSync(existing, "utf8") !== "original" ||
          paths.slice(1).some((p) => existsSync(p)) ||
          results.get("toolu_edit0") !== false ||
          results.get("toolu_edit1") !== true ||
          results.get("toolu_sample0") !== false ||
          paths.slice(1).some((_, i) => results.get("toolu_sample" + (i + 1)) !== true)
        )
          throw new Error(
            "Claude discovery write control failed: " +
              JSON.stringify({ status, observed: [...results], files: paths.map((p) => existsSync(p)) }),
          );
      } finally {
        server.stop(true);
      }
    }
    console.log(JSON.stringify({ harness, version, ordinaryWrite: true, protectedWrites: paths.length - 1 }));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
