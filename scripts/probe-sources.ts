import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A source is chosen by the runner. No proof may plant into a persistent user or harness home. */
export function proofSource(test: string, roots: {
  home: string; harnessHome: string; project: string; added?: string; shared: boolean; harness: "claude" | "codex";
}) {
  const { home, harnessHome, project, harness } = roots;
  const homeSource = test.startsWith("S1-") || test.startsWith("S8-") || test === "S7";
  if (homeSource && roots.shared) throw new Error("home-source discovery requires a disposable proof credential");
  const sources: Record<string, string> = {
    "S1-config": join(harnessHome, "skills"), "S1-home-claude": join(home, ".claude/skills"), "S1-home-agents": join(home, ".agents/skills"),
    "S2-project-claude": join(project, ".claude/skills"), "S2-project-agents": join(project, ".agents/skills"),
    "S8-config": join(harnessHome, "agents"), "S8-home-claude": join(home, ".claude/agents"),
    S7: join(home, ".agents/skills"),
  };
  const add = /^S4-(skills|task|out|scratch)-(skill|command|agent)$/.exec(test);
  const kind = add?.[2];
  if (add && !roots.added) throw new Error("missing disposable added directory");
  const dir = add ? join(roots.added!, ".claude", kind === "agent" ? "agents" : kind === "command" ? "commands" : "skills") : sources[test];
  if (!dir) return;
  const name = "factory-probe-" + crypto.randomUUID().slice(0, 8);
  const description = "Source control " + crypto.randomUUID();
  const marker = "BEECH-" + crypto.randomUUID();
  const agent = test.startsWith("S8") || kind === "agent";
  const text = `---\nname: ${name}\ndescription: ${description}\n${agent ? "tools: Read\nmodel: haiku\n" : ""}---\nAnswer with the word ${marker}.\n`;
  const toml = agent && harness === "codex";
  const path = kind === "command" ? join(dir, name + ".md") : agent ? join(dir, name + (toml ? ".toml" : ".md")) : join(dir, name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, toml ? `name="${name}"\ndescription="${description}"\nmodel="gpt-6-luna"\nmodel_reasoning_effort="low"\ndeveloper_instructions="Return ${marker}."\n` : kind === "command" ? `---\ndescription: ${description}\n---\nReply with ${marker}.\n` : text, {flag: "wx", mode: 0o400});
  return { name, path, description, marker, agent, command: kind === "command" };
}

/** A source-specific arm still needs the paired positive control on the harness's real directory. */
export function expectedSource(harness: "claude" | "codex", test: string, control: boolean) {
  if (test === "S2-project-claude") return control && harness === "claude";
  if (test === "S2-project-agents") return control && harness === "codex";
  return control;
}
