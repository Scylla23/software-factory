#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../factory.config";
import { costReport, dimensions, statusReport, type Dimension } from "../usage/report";
import { run } from "./run";

const [command, arg, ...rest] = process.argv.slice(2);
if (command === "run" && arg && !rest.length) {
  const task = await run(arg);
  console.log(JSON.stringify({ id: task.id, state: task.state, pr: task.pr, head: task.head, reason: task.reason }));
  if (["failed", "escalated"].includes(task.state)) process.exitCode = 1;
} else if ((command === "status" && arg === undefined) ||
    (command === "cost" && arg === "--by" && rest.length === 1 && dimensions.includes(rest[0] as Dimension))) {
  const path = join(config.stateRoot, "factory.sqlite");
  const db = existsSync(path) ? new Database(path, { readonly: true }) : null;
  try {
    const report = () => command === "status" ? statusReport(db) : costReport(db, rest[0] as Dimension);
    console.log(JSON.stringify(db ? db.transaction(report)() : report(), null, 2));
  } finally {
    db?.close();
  }
} else {
  console.error("usage: factory run <issue-url> | factory status | factory cost --by task|project|model|stage");
  process.exitCode = 2;
}
