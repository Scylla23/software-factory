import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editHistory, observedScratchTest } from "../scripts/eval-codex-checks";

test("the security audit requires the existing suite in the private scratch checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-audit-"));
  const file = join(root, "events.jsonl");
  const observed = async (command: string, cwd: string, exit_code = 0) => {
    const item = { type: "CommandExecution", command: ["/bin/zsh", "-c", command], cwd, exit_code, aggregated_output: "(pass) existing test" };
    writeFileSync(file, JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item } }) + "\n");
    return observedScratchTest(file, root);
  };
  try {
    expect(await observed("bun test", "file://" + root)).toBe(true);
    expect(await observed("cd '" + root + "' && bun test", "/tmp")).toBe(true);
    expect(await observed("bun test", root + "/sibling")).toBe(false);
    expect(await observed("echo bun test", root)).toBe(false);
    expect(await observed("bun test", root, 1)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
