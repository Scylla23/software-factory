#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../factory.config";
import { run } from "./run";

const [command, arg, ...rest] = process.argv.slice(2);
if (command === "run" && arg && !rest.length) {
  const task = await run(arg);
  console.log(JSON.stringify({ id: task.id, state: task.state, pr: task.pr, head: task.head, reason: task.reason }));
  if (["failed", "escalated"].includes(task.state)) process.exitCode = 1;
} else if (command === "status" && !arg) {
  const path = join(config.stateRoot, "factory.sqlite");
  const db = existsSync(path) ? new Database(path, { readonly: true }) : null;
  try {
    console.log(
      JSON.stringify(db?.query("SELECT id,state,visit,pr,spec,head,reason FROM tasks ORDER BY id").all() ?? [], null, 2),
    );
  } finally {
    db?.close();
  }
} else {
  console.error("usage: factory run <issue-url> | factory status");
  process.exitCode = 2;
}
