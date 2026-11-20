import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editHistory } from "../scripts/eval-codex-checks";

test("the builder control uses a named failing CommandExecution before the first production FileChange", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-order-")),
    file = join(root, "events.jsonl");
  const command = (text: string, output: string, code: number) => ({
    type: "CommandExecution",
    command: ["/bin/zsh", "-c", text],
    aggregated_output: output,
    exit_code: code,
  });
  const patch = (name: string) => ({ type: "FileChange", status: "completed", changes: { [join(root, "src", name)]: { type: "update" } } });
  const red = command("bun test", "(fail) AC-1: sorts dates", 1),
    prod = patch("sort.ts");
  const check = async (items: unknown[]) => {
    writeFileSync(
      file,
      items.map((item) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item } })).join("\n") + "\n",
    );
    return (await editHistory(file, "AC-1: sorts dates", root)).red;
  };
  try {
    expect(await check([patch("sort.test.ts"), red, prod])).toBe(true);
    expect(await check([prod, red])).toBe(false);
    expect(await check([command("bun test", "(fail) unrelated", 1), prod])).toBe(false);
    expect(await check([command("tee src/sort.ts", "", 0), red, prod])).toBe(false);
    expect(await check([command("bun test", "(fail) AC-1: sorts dates", 0), prod])).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
