import { join } from "node:path";
import { isRecord } from "../src/dispatch/jsonl";

/** A listed Codex skill can be loaded lazily through a native file read recorded in the rollout. */
export function sourceRead(cwd: string, relative: string, expected: string) {
  const calls = new Set<string>();
  return (payload: Record<string, unknown>) => {
    if (typeof payload.call_id !== "string") return false;
    if (payload.type === "custom_tool_call" && payload.name === "exec" && typeof payload.input === "string") {
      // Match the complete expression without interpreting JavaScript or shell text from the transcript.
      const match =
        /^const (\w+)\s*=\s*await tools\.exec_command\(\{cmd:("(?:[^"\\]|\\.)*"),workdir:("(?:[^"\\]|\\.)*"),max_output_tokens:\d+\}\);\s*text\(\1\.output\);$/.exec(
          payload.input.trim(),
        );
      if (match && JSON.parse(match[3]!) === cwd && ["cat " + relative, "cat " + join(cwd, relative)].includes(JSON.parse(match[2]!)))
        calls.add(payload.call_id);
      return false;
    }
    if (payload.type !== "custom_tool_call_output" || !calls.delete(payload.call_id) || !Array.isArray(payload.output)) return false;
    return payload.output.some(
      (p) => isRecord(p) && p.type === "input_text" && typeof p.text === "string" && p.text.trimEnd() === expected.trimEnd(),
    );
  };
}
