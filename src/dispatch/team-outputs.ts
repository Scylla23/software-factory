import { join } from "node:path";
import { claudeChildStarts, claudeWrites } from "./claude-writes";
import { readJsonl } from "./jsonl";
import type { NativeWrite, OutputAuthor } from "./output";
import { readRegularFile } from "./regular-file";
import type { AttemptDirectories } from "./attempt";

export async function authenticateTeam(
  dirs: AttemptDirectories,
  members: readonly string[],
  identity: OutputAuthor & { taskId: string; attemptId: string },
  stateRoot: string,
  home: string,
  stdoutPath: string,
  expected: Map<string, OutputAuthor>,
  writes: NativeWrite[],
) {
  const team = JSON.parse(readRegularFile(join(dirs.skillsDir, "spec-lead/team.json"), 32 * 1024).toString());
  const starts = await claudeChildStarts(stateRoot, home, identity.attemptId);
  expected.set("team-brief.md", identity);
  if (starts.size !== members.length) throw new Error("unexpected specialist session count");
  for (const member of members) {
    const matches = [...starts].filter(([, start]) => start.role === member);
    const file = team.members.find((m: { name: string }) => m.name === member)?.writes;
    if (matches.length !== 1 || typeof file !== "string" || expected.has(file))
      throw new Error("missing or ambiguous specialist author");
    const [sessionId, start] = matches[0]!;
    const principal = { role: member, sessionId };
    expected.set(file, principal);
    writes.push(
      ...(await claudeWrites({ ...identity, ...principal }, stateRoot, home, dirs.outDir, sessionId, {
        startCall: start.startCall,
        events: readJsonl(stdoutPath),
      })),
    );
  }
  for (const record of writes)
    if (expected.get(record.path)?.sessionId !== record.sessionId) throw new Error("output submitted by a different team member");
}
