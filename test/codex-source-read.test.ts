import { expect, test } from "bun:test";
import { sourceRead } from "../scripts/codex-source-read";
test("only a matched native read of the marked source qualifies a lazy load", () => {
  const text = "---\nname: sample\n---\nfixture\n";
  const source = ".agents/skills/sample/SKILL.md";
  const score = sourceRead("/checkout", source, text);
  const call = {
    type: "custom_tool_call",
    name: "exec",
    call_id: "one",
    input:
      'const r = await tools.exec_command({cmd:"cat ' + source + '",workdir:"/checkout",max_output_tokens:4000});\ntext(r.output);',
  };
  const result = { type: "custom_tool_call_output", call_id: "one", output: [{ type: "input_text", text }] };
  expect(score(result)).toBe(false);
  expect(score({ ...call, input: call.input.replace("/checkout", "/outside") })).toBe(false);
  expect(score(result)).toBe(false);
  expect(score(call)).toBe(false);
  expect(score({ ...result, call_id: "other" })).toBe(false);
  expect(score(result)).toBe(true);
  expect(score(result)).toBe(false);
  score(call);
  expect(score({ ...result, output: [{ type: "input_text", text: "unrelated" }] })).toBe(false);
});
