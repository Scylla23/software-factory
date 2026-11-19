import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plantPilot } from "../scripts/eval-pilot";
import { runGit } from "../src/dispatch/git";

test("the private pilot exhibits the sort bug and includes the agreed database, sign-in and retention preconditions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "batch-pilot-")));
  const git = "/usr/bin/git";
  const db = new Database(":memory:");
  try {
    const upstream = join(root, "pilot"),
      factory = join(root, "factory"),
      project = join(root, "source");
    for (const dir of [upstream, factory, project]) mkdirSync(dir);
    cpSync(join(import.meta.dir, "../skills/_shared/evals/tasklist/base"), join(factory, "skills/_shared/evals/tasklist/base"), {
      recursive: true,
    });
    writeFileSync(join(upstream, "server.ts"), "const handleRequest = () => new Response(); Bun.serve({fetch: handleRequest});");
    writeFileSync(join(upstream, "README.md"), "Pilot\n");
    for (const dir of [upstream, factory]) {
      runGit(git, dir, ["init", "-q", "--template="]);
      runGit(git, dir, ["add", "."]);
      runGit(git, dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Project"]);
    }
    const pin = runGit(git, factory, ["rev-parse", "HEAD"]).toString().trim();
    const refs = plantPilot(git, factory, pin, project, upstream);
    expect(refs.base).toBe(refs.head);
    expect(runGit(git, project, ["status", "--porcelain"]).length).toBe(0);
    expect(existsSync(join(upstream, "migrations"))).toBe(false);
    db.exec(readFileSync(join(project, "migrations/001_create_tasks.sql"), "utf8"));
    const { createTask, listTasks } = await import(join(project, "src/api/tasks.ts"));
    createTask(db, 1, "early", "2026-11-02");
    createTask(db, 1, "late", "2026-11-10");
    createTask(db, 2, "another", null);
    const rows = await listTasks(db, 1).json();
    expect(rows.map((r: { title: string }) => r.title)).toEqual(["early", "late"]);
    const { renderDueColumn } = await import(join(project, "src/task-list/view.ts"));
    expect(renderDueColumn(rows)[0].due).toBe("2026-11-10");
    const { startSession, sessionUser } = await import(join(project, "src/auth/sign-in.ts"));
    const token = /sid=([^;]+)/.exec(startSession(db, 3, 0).headers.get("Set-Cookie"))![1]!;
    expect(sessionUser(db, token, 0)).toEqual({ user_id: 3 });
    expect(sessionUser(db, token, 8 * 3600)).toBeNull();
    const { taskRoutes } = await import(join(project, "src/routes.ts"));
    const live = new Database(":memory:");
    try {
      const handle = taskRoutes(live);
      const url = "https://example.invalid/sign-in";
      expect(await (await handle(new Request(url))).text()).toContain('name="password"');
      await live.run("INSERT INTO users VALUES(1,?,?)", ["person", await Bun.password.hash("fixture-only")]);
      createTask(live, 1, "Task", "2026-11-10");
      const login = await handle(
        new Request(url, { method: "POST", body: new URLSearchParams({ username: "person", password: "fixture-only" }) }),
      );
      const cookie = login.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(await (await handle(new Request(new URL("/tasks", url).href, { headers: { cookie } }))).text()).toContain("2026-11-10");
    } finally {
      live.close();
    }
    expect(readFileSync(join(project, "docs/decisions/retention.md"), "utf8")).toContain("seven years");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
