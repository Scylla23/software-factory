import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findCodexSessionFile } from "./codex";
import { checkHomeFlags, inspectHarnessHome, type HomeInventory } from "./home-inventory";
import { isRecord, readJsonl } from "./jsonl";
import type { Harness } from "./types";

/** Read directory entries only. A symlink at a skill or agent name also counts as a candidate. */
export function personalSourceNames(account: string) {
  const names = new Set<string>();
  const scan = (dir: string, kind: string) => {
    if (!existsSync(dir) || realpathSync(dir) !== dir) return;
    for (const entry of readdirSync(dir, {withFileTypes:true})) {
      if (entry.name.startsWith(".")) continue;
      if (kind === "agents" && /\.(?:md|toml)$/.test(entry.name)) names.add(entry.name.replace(/\.(md|toml)$/, ""));
      if (kind === "skills" && (entry.isDirectory() || entry.isSymbolicLink())) names.add(entry.name);
    }
  };
  for (const root of [".claude",".codex",".agents"]) {
    for (const kind of ["agents","skills"]) scan(join(account, root, kind), kind);
  }
  for (const root of [".claude", ".codex"]) {
    for (const source of ["skills","plugins/cache","plugins/marketplaces","plugins/synced"]) {
      const dir = join(account,root,source);
      if (!existsSync(dir) || realpathSync(dir) !== dir) continue;
      for (const pattern of ["**/SKILL.md","**/agents/*.md","**/agents/*.toml"]) for (const entry of new Bun.Glob(pattern).scanSync({cwd:dir,followSymlinks:false,dot:true})) {
        names.add(basename(entry) === "SKILL.md" ? basename(dirname(entry)) : basename(entry).replace(/\.(md|toml)$/,""));
      }
    }
  }
  return names;
}

function checkInstruction(text: string, forbidden: Set<string>) {
  if (/<skills_instructions>|^### Available skills\s*$|^### Skill roots\s*$/im.test(text))
    throw new Error("unexpected skill catalog in model instructions");
  for (const line of text.split("\n")) {
    const item = /^\s*-\s+([a-zA-Z0-9_.:-]+)\s*[:(]/.exec(line)?.[1];
    const frontmatter = /^\s*name:\s*["']?([\w.-]+)["']?\s*$/.exec(line)?.[1];
    const file = /\/([\w.-]+)\/SKILL\.md\b/.exec(line)?.[1];
    const agent = /\/agents\/([\w.-]+)\.(?:md|toml)\b/.exec(line)?.[1];
    if ([item, frontmatter, file, agent].some(n => n && forbidden.has(n)))
      throw new Error("disabled source in model instructions");
  }
}
function checkParts(parts: unknown, forbidden: Set<string>) {
  if (typeof parts === "string") { checkInstruction(parts, forbidden); return; }
  if (!Array.isArray(parts)) throw new Error("missing model instruction text");
  for (const block of parts) if (isRecord(block) && typeof block.text === "string") checkInstruction(block.text, forbidden);
}

async function checkClaude(home: string, id: string, stdout: string, forbidden: Set<string>, broker: boolean) {
  let init = 0;
  for await (const line of readJsonl(stdout)) {
    if (line.kind !== "record") throw new Error("invalid Claude source listing");
    const e = line.value;
    if (e.type !== "system" || e.subtype !== "init") continue;
    init++;
    if (e.session_id !== id) throw new Error("Claude source listing session mismatch");
    for (const k of ["skills","slash_commands","plugins"]) {
      if (!Array.isArray(e[k]) || e[k].length) throw new Error("unexpected or missing Claude init " + k);
    }
    if (!Array.isArray(e.agents) || e.agents.some(n => typeof n !== "string" || forbidden.has(n))) throw new Error("unexpected Claude agent source");
    if (!Array.isArray(e.mcp_servers) || e.mcp_servers.length !== Number(broker) ||
        e.mcp_servers.some(s => !isRecord(s) || s.name !== "factory" || s.status !== "connected")) throw new Error("unexpected Claude MCP listing");
  }
  if (init !== 1) throw new Error("missing or ambiguous Claude source listing");
  const projects = join(home,"projects");
  const parents = [...new Bun.Glob("*/" + id + ".jsonl").scanSync(projects)];
  if (parents.length !== 1) throw new Error("missing or ambiguous Claude source transcript");
  const children = [...new Bun.Glob("*/" + id + "/subagents/agent-*.jsonl").scanSync(projects)];
  for (const path of [...parents,...children]) {
    let shapes = 0;
    for await (const line of readJsonl(join(projects,path))) {
      if (line.kind !== "record") throw new Error("invalid Claude source transcript");
      const e = line.value;
      if (e.type === "api-request-shape") {
        if (!isRecord(e.shape)) throw new Error("missing Claude request shape");
        checkParts(e.shape.system, forbidden);
        shapes++;
      }
      if (e.type === "user" && e.isMeta === true && isRecord(e.message)) checkParts(e.message.content,forbidden);
    }
    if (!shapes) throw new Error("missing Claude model instructions");
  }
}

async function checkCodex(home: string, id: string, stdout: string, forbidden: Set<string>) {
  let starts = 0;
  for await (const line of readJsonl(stdout)) {
    if (line.kind !== "record") throw new Error("invalid Codex session stream");
    if (line.value.type === "thread.started") {
      starts++;
      if (line.value.thread_id !== id) throw new Error("Codex source listing session mismatch");
    }
  }
  if (starts !== 1) throw new Error("ambiguous Codex session identity");
  const file = await findCodexSessionFile(join(home,"sessions"),id);
  if (!file || realpathSync(file) !== file || lstatSync(file).nlink !== 1) throw new Error("missing or unsafe Codex source transcript");
  let sessions = 0, developer = 0;
  for await (const line of readJsonl(file)) {
    if (line.kind !== "record") throw new Error("invalid Codex source transcript");
    const {type,payload} = line.value;
    if (!isRecord(payload)) continue;
    if (type === "session_meta") {
      if (payload.id !== id || !isRecord(payload.base_instructions)) throw new Error("Codex source transcript identity mismatch");
      checkParts(payload.base_instructions.text, forbidden);
      sessions++;
    }
    if (type === "response_item" && payload.type === "message" && ["developer","user"].includes(String(payload.role))) {
      checkParts(payload.content,forbidden);
      if (payload.role === "developer") developer++;
    }
  }
  if (sessions !== 1 || !developer) throw new Error("missing Codex model instructions");
}

export function beforeHomeLaunch(harness: Harness, home: string, args: readonly string[], broker?: string, executable?: string) {
  checkHomeFlags(harness,args,broker);
  return inspectHarnessHome(harness,home,executable);
}

/** Failure quarantines the attempt even when the harness returned success and valid usage. */
export async function afterHomeLaunch(harness: Harness, home: string, before: HomeInventory, stdout: string, session: string | null,
  options: { personal?: Set<string>; broker?: boolean } = {}) {
  const after = inspectHarnessHome(harness,home,before.executable);
  if ([...after.locations].some(path => !before.locations.has(path))) throw new Error("disabled source location appeared during dispatch");
  if (!session || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session)) throw new Error("missing source audit session identity");
  const forbidden = new Set([...before.names,...after.names,...(options.personal ?? [])]);
  if (harness === "claude") await checkClaude(home,session,stdout,forbidden,!!options.broker);
  else await checkCodex(home,session,stdout,forbidden);
}
