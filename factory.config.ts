import { userInfo } from "node:os";
import { join } from "node:path";
import { REGISTRY_HOSTS } from "./src/verify/proxy";

const home = userInfo().homedir;
export const config = {
  ownerId: 89606989,
  workspaceRoot: join(home, "orca/workspaces"),
  stateRoot: join(home, ".software-factory"),
  agents: {
    triage: { harness: "claude", model: "claude-sonnet-5-5", effort: "low", timeoutMs: 900_000 },
    spec: { harness: "claude", model: "claude-opus-5-5", effort: "high", timeoutMs: 900_000 },
    builder: { harness: "codex", model: "gpt-6.2-sol", effort: "high", timeoutMs: 900_000 },
    reviewer: { harness: "claude", model: "claude-opus-5-5", effort: "high", timeoutMs: 900_000 },
  },
  specTeam: {
    architect: { model: "claude-opus-5-5", effort: "high" },
    infra: { model: "claude-sonnet-5-5", effort: "high" },
    frontend: { model: "claude-sonnet-5-5", effort: "high" },
    "threat-modeler": { model: "claude-sonnet-5-5", effort: "high" },
  },
  pilot: {
    owner: "Scylla23",
    repo: "factory-pilot",
    repoId: 1463084565,
    base: "main",
    path: join(home, "orca/projects/factory-pilot"),
    stack: "bun",
    toolDirs: [join(home, ".bun/bin"), join(home, ".nvm/versions/node/v24.22.1/bin")],
    commands: {
      setup: [["bun", "install", "--frozen-lockfile", "--ignore-scripts"]],
      egress: REGISTRY_HOSTS.npm,
      preview: ["bun", "server.ts"],
      readyPath: "/health",
      portRange: [4100, 4199],
      test: ["bun", "test"],
      lint: ["node", "--run", "lint"],
      typecheck: ["node", "--run", "typecheck"],
    },
    fixtures: {
      inventory: {
        issue: 4,
        path: "/",
        api: "/api/inventory",
        rows: [
          { name: "Bench vises", count: 4, before: "4", after: "4" },
          { name: "Measuring tapes", count: 0, before: "Uncounted", after: "0" },
          { name: "Tool chests", count: null, before: "Uncounted", after: "Uncounted" },
        ],
      },
    },
  },
} as const;

export const headingPilot = {
  issues: [6, 7, 9, 11],
  // Paid rehearsal receipts live in its disposable store, outside the production task query.
  rehearsalClaudeMicros: 12_503 + 12_167 + 11_944,
  base: "factory/pilot-4b-heading-base",
  seed: "9739f1f7912605144c17693602080e93ca6f3247",
  heading: { before: "Price", after: "Stock count" },
} as const;

export function pilotBase(issue: number) {
  return headingPilot.issues.some(n => n === issue) ? headingPilot.base : config.pilot.base;
}

export function inventoryFixture(issue: number) {
  const inventory = config.pilot.fixtures.inventory;
  return pilotBase(issue) === headingPilot.base
    ? { ...inventory, issue, heading: headingPilot.heading, rows: inventory.rows.map(row => ({ ...row, before: row.after })) }
    : { ...inventory, heading: undefined };
}
