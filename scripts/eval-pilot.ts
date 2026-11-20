import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../factory.config";
import { checkoutSnapshot } from "../src/dispatch/attempt";
import { runGit } from "../src/dispatch/git";
import { pinnedFixture } from "./eval-checkout";

/** Plant the requested pilot conditions in a private detached checkout, preserving the shared pilot. */
export function plantPilot(git: string, factory: string, pin: string, project: string, pilot: string = config.pilot.path) {
  const parent = runGit(git, pilot, ["rev-parse", "HEAD"]).toString().trim();
  checkoutSnapshot(git, pilot, parent, project);
  const write = (path: string, bytes: string | Buffer) => {
    const dest = join(project, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes, { flag: "wx" });
  };
  write("src/task-list/sort.ts", pinnedFixture(git, factory, pin, "skills/_shared/evals/tasklist/base/src/task-list/sort.ts.txt"));
  write(
    "src/task-list/sort.test.ts",
    pinnedFixture(git, factory, pin, "skills/_shared/evals/tasklist/base/src/task-list/sort.test.ts.txt"),
  );
  write(
    "migrations/001_create_tasks.sql",
    `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL, due TEXT);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL, action TEXT NOT NULL, recorded_at TEXT NOT NULL);`,
  );
  write(
    "src/api/tasks.ts",
    `import type { Database } from "bun:sqlite";
import type { Task } from "../task-list/sort";
export function taskRows(db: Database, actor: number) {
  return db.query<Task,[number]>("SELECT id, title, due, owner_id AS ownerId FROM tasks WHERE owner_id = ? ORDER BY id").all(actor);
}
export function listTasks(db: Database, actor: number) {
  return Response.json(taskRows(db,actor));
}
export function createTask(db: Database, actor: number, title: string, due: string | null) {
  return db.run("INSERT INTO tasks(owner_id,title,due) VALUES(?,?,?)", [actor,title,due]);
}
`,
  );
  write(
    "src/task-list/view.ts",
    `import { sortTasks, type Task } from "./sort";
export function renderDueColumn(rows: Task[]) {
  return sortTasks(rows, "due", "asc").map(task => ({title: task.title, due: task.due}));
}
`,
  );
  write(
    "src/auth/sign-in.ts",
    `import type {Database} from "bun:sqlite";
import {createHash, randomBytes} from "node:crypto";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export function startSession(db: Database, verifiedUser: number, now: number) {
  const token = randomBytes(32).toString("hex");
  db.run("INSERT INTO sessions(token_digest,user_id,expires_at) VALUES(?,?,?)",[digest(token),verifiedUser,now+8*3600]);
  return new Response(null,{status:204,headers:{"Set-Cookie":"sid="+token+"; Path=/; Secure; HttpOnly; SameSite=Lax"}});
}
export function sessionUser(db: Database, token: string, now: number) {
  return db.query("SELECT user_id FROM sessions WHERE token_digest=? AND expires_at>?").get(digest(token),now);
}
`,
  );
  write(
    "src/audit/export.ts",
    `import type {Database} from "bun:sqlite";
export function auditExport(db: Database) {
  return db.query("SELECT actor_id,action,recorded_at FROM audit_events ORDER BY id").all();
}
`,
  );
  write(
    "docs/decisions/retention.md",
    "# Audit export retention\n\nKeep individually attributable audit export history for seven years.\n",
  );
  write(
    "src/routes.ts",
    `import { Database } from "bun:sqlite";
import { listTasks, taskRows } from "./api/tasks";
import { startSession, sessionUser } from "./auth/sign-in";
import { renderDueColumn } from "./task-list/view";
import {readFileSync} from "node:fs";

export function taskRoutes(db = new Database("tasks.sqlite", {create:true})) {
  db.exec(readFileSync(new URL("../migrations/001_create_tasks.sql",import.meta.url),"utf8"));
  return async function handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    const now = Math.floor(Date.now() / 1000);
    if (path === "/sign-in" && request.method === "GET") {
      return new Response('<form method="post"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>',{headers:{"Content-Type":"text/html; charset=utf-8"}});
    }
    if (path === "/sign-in" && request.method === "POST") {
      const form = await request.formData();
      const user = db.query<{id:number;password_hash:string},[string]>("SELECT id,password_hash FROM users WHERE username=?").get(String(form.get("username")));
      if (!user || !await Bun.password.verify(String(form.get("password")),user.password_hash)) return new Response(null,{status:401});
      return startSession(db,user.id,now);
    }
    if (!["/api/tasks","/tasks"].includes(path) || request.method !== "GET") return undefined;
    const sid = request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith("sid="))?.slice(4);
    const user = sid && sessionUser(db,sid,now) as {user_id:number} | null;
    if (!user) return new Response(null,{status:401});
    if (path === "/api/tasks") return listTasks(db,user.user_id);
    const values = renderDueColumn(taskRows(db,user.user_id));
    const escaped = (value:string) => value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    const rows = values.map(row=>"<tr><td>"+escaped(row.title)+"</td><td>"+escaped(row.due ?? "")+"</td></tr>");
    return new Response('<table><thead><tr><th>Task</th><th><a href="/tasks?sort=due">Due</a></th></tr></thead><tbody>'+rows.join("")+"</tbody></table>",{headers:{"Content-Type":"text/html; charset=utf-8"}});
  };
}
`,
  );
  const serverPath = join(project, "server.ts"),
    server = readFileSync(serverPath, "utf8");
  if (server.split("fetch: handleRequest").length !== 2) throw new Error("pilot server entry point changed");
  writeFileSync(
    serverPath,
    'import { taskRoutes } from "./src/routes";\nconst tasks = taskRoutes();\n' +
      server.replace("fetch: handleRequest", "fetch: async request => (await tasks(request)) ?? handleRequest(request)"),
  );
  runGit(git, project, ["add", "--", "src", "migrations", "server.ts", "docs/decisions/retention.md"]);
  runGit(git, project, [
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "Project revision",
  ]);
  const base = runGit(git, project, ["rev-parse", "HEAD"]).toString().trim();
  return { base, head: base };
}

export function specialistProject(git:string,factory:string,pin:string,project:string,role:string,existing:boolean) {
  const command=(...args:string[])=>runGit(git,project,args).toString().trim();
  if (!existing) command("init","-q","--template=");
  else {
    const refs=plantPilot(git,factory,pin,project);
    if (role==="threat-modeler") return refs;
    if (role==="architect") {
      const replace=(path:string,from:string,to:string)=>{
        const p=join(project,path),s=readFileSync(p,"utf8");
        if(!s.includes(from))throw new Error("missing schema or task-list fixture anchor");
        writeFileSync(p,s.replace(from,to));
      };
      replace("migrations/001_create_tasks.sql","title TEXT NOT NULL","assignee TEXT, title TEXT NOT NULL");
      replace("src/api/tasks.ts","title, due, owner_id","title, due, assignee, owner_id");
      replace("src/task-list/sort.ts","title: string;","title: string; assignee?: string | null;");
      replace("src/task-list/view.ts","title: task.title,","title: task.title, assignee: task.assignee,");
      replace("src/routes.ts","escaped(row.title)","escaped(row.title) + \"</td><td>\" + escaped(row.assignee ?? \"\")");
    } else if (role==="infra") {
      mkdirSync(join(project,".github/workflows"),{recursive:true});
      writeFileSync(join(project,".github/workflows/test.yml"),"name: test\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: oven-sh/setup-bun@v2\n      - run: bun install --frozen-lockfile\n      - run: bun test\n",{flag:"wx"});
      writeFileSync(join(project,"app.service"),"[Unit]\nDescription=Task list\n[Service]\nWorkingDirectory=/srv/task-list\nExecStart=/usr/local/bin/bun server.ts\nRestart=on-failure\n",{flag:"wx"});
    }
  }
  command("add","-A");
  command("-c","user.name=Factory","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","--allow-empty","-qm","Project revision");
  const base=command("rev-parse","HEAD");
  return {base,head:base};
}
