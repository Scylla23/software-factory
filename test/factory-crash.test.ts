import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/factory/store";

test("restarting after SIGKILL at every walking-skeleton transition adopts every external attempt exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-crash-test-"));
  try {
    let killed = 0;
    for (let run = 0; run < 19; run++) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/factory-crash.fixture.ts"), root], {
        env: { PATH: "/usr/bin:/bin" },
        stdout: "ignore",
        stderr: "pipe",
        stdin: "ignore",
      });
      const deadline = setTimeout(() => child.kill("SIGTERM"), 5000);
      try {
        const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        if (child.signalCode === "SIGKILL") {
          killed++;
          continue;
        }
        expect(error).toBe("");
        expect(exit).toBe(0);
        break;
      } finally {
        clearTimeout(deadline);
      }
    }
    expect(killed).toBe(17);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe("done");
      expect(
        s.db
          .query("SELECT state FROM transitions ORDER BY visit")
          .all()
          .map((r) => (r as { state: string }).state),
      ).toEqual([
        "received",
        "spec_drafting",
        "awaiting_spec_approval",
        "building",
        "checks",
        "code_review",
        "verifying",
        "awaiting_pr_approval",
        "done",
      ]);
      expect(s.db.query("SELECT id FROM attempts WHERE result IS NOT NULL").all()).toHaveLength(8);
      expect(readdirSync(root).filter((n) => n.endsWith(".worker"))).toHaveLength(8);
      expect(s.db.query("SELECT id FROM approvals WHERE accepted=1").all()).toHaveLength(2);
    } finally {
      s.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
