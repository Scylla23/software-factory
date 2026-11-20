import { existsSync, lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CODEX_HERMETIC_CONFIG } from "./codex";
import locations from "./disabled-home-locations.json";
import { claudeHomeSettings, codexHomeSettings } from "./home-settings";
import { isRecord } from "./jsonl";
import { readRegularFile } from "./regular-file";
import type { Harness } from "./types";

const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const pathPattern = (source: string) => new RegExp("^(" + source + ")$");
const claudeFiles = [
  /^(\.claude\.json|\.last-cleanup|settings\.json)$/,
  /^backups\/\.claude\.json\.backup\.\d+$/,
  pathPattern("cache/model-catalog/" + uuid + "-[0-9a-f]+-cc\\.json"),
  pathPattern("projects/[^/]+/" + uuid + "\\.jsonl"),
  pathPattern("projects/[^/]+/" + uuid + "/subagents/agent-[0-9a-f]+\\.(?:meta\\.json|jsonl)"),
];
const claudeDirs = [
  /^(\.cc-writes|backups|cache|cache\/model-catalog|daemon|dev-mods|file-history|projects|seed-admin|session-env|sessions|shell-snapshots)$/,
  pathPattern("projects/[^/]+(?:/memory|/" + uuid + "(?:/subagents)?)?"),
  pathPattern("session-env/" + uuid),
];
const codexFiles = [
  /^(config\.toml|\.sandbox_migration|\.sqlite-maintenance\.lock|auth\.json(?:\.lock)?|auth\.lock|installation_id|models_cache\.json)$/,
  /^(goals_1|logs_2|memories_1|queue_1|state_5|thread_history_1)\.sqlite(?:-shm|-wal)?$/,
  /^cache\/codex_apps_(tools|server_info)\/[0-9a-f]{40}\.json$/,
  /^(log\/codex-login\.log|thread-writer-locks\/\.coordination\.lock)$/,
  pathPattern("sessions/\\d{4}/\\d{2}/\\d{2}/rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-" + uuid + "\\.jsonl"),
  pathPattern("thread-writer-locks/" + uuid + "\\.lock"),
  /^tmp\/arg0-macos\/codex-arg0[A-Za-z0-9]{6}\/\.lock$/,
  pathPattern("shell_snapshots/" + uuid + "\\.[0-9a-f]+\\.sh"),
];
const codexDirs = [
  /^tmp\/arg0-macos\/codex-arg0[A-Za-z0-9]{6}$/,
  /^(cache|cache\/codex_apps_(tools|server_info)|log|sessions(?:\/\d{4}(?:\/\d{2}(?:\/\d{2})?)?)?|shell_snapshots|thread-writer-locks|tmp|tmp\/arg0-macos)$/,
];
const accountKeys = new Set(
  (
    "additionalModelCostsCache additionalModelOptionsAnsweredAt additionalModelOptionsCache autoCompactWindowsCache cachedExperimentData " +
    "cachedExperimentFeatures cachedExtraUsageDisabledReason cachedFeatureFlags cachedFeatureFlagsAt cachedGrowthBookFeatures cachedGrowthBookFeaturesAt " +
    "claudeAiMcpEverConnected claudeCodeFirstTokenDate clientDataCacheSlots firstStartTime firstStartVersion groveChoiceSeenAt groveConfigCache " +
    "hasResetAutoModeOptInForDefaultOffer machineID migrationVersion modelAccessCache oauthAccount opusProMigrationComplete orgModelDefaultCache " +
    "passesEligibilityCache pluginUsage seenNotifications skillUsage userID"
  ).split(" "),
);

/** Only the factory parses settings. Credential files and cached skill contents are never opened. */
function checkConfig(path: string, name: string) {
  const bytes = readRegularFile(path, 8 * 1024 * 1024);
  try {
    if (name === "config.toml") {
      if (isDeepStrictEqual(Bun.TOML.parse(bytes.toString()), codexHomeSettings)) return;
    } else {
      const value: unknown = JSON.parse(bytes.toString());
      if (name === "settings.json" && isDeepStrictEqual(value, claudeHomeSettings)) return;
      if (name === ".claude.json" && isRecord(value) && Object.keys(value).every((k) => accountKeys.has(k))) return;
    }
  } catch {
    /* Do not expose settings or account values in errors. */
  }
  throw new Error("unexpected factory home configuration in " + name);
}

export interface HomeInventory {
  locations: Set<string>;
  names: Set<string>;
  executable?: string;
}

export function inspectHarnessHome(harness: Harness, home: string, executable?: string): HomeInventory {
  if (realpathSync(home) !== home) throw new Error("factory home is linked");
  const accountFile = join(home, ".claude.json");
  let account = "";
  if (harness === "claude" && existsSync(accountFile)) {
    checkConfig(accountFile, ".claude.json");
    const identity = JSON.parse(readRegularFile(accountFile, 8 * 1024 * 1024).toString()).oauthAccount;
    if (
      isRecord(identity) &&
      [identity.organizationUuid, identity.accountUuid].every((id) => typeof id === "string" && pathPattern(uuid).test(id))
    )
      account = identity.organizationUuid + "_" + identity.accountUuid;
  }
  const table: Record<string, readonly string[]> = locations[harness];
  const result: HomeInventory = { locations: new Set(), names: new Set(), executable };
  const visit = (parent: string) => {
    for (const entry of readdirSync(join(home, parent), { withFileTypes: true })) {
      const path = join(parent, entry.name);
      const full = join(home, path);
      const stat = lstatSync(full);
      const dir = stat.isDirectory();
      if (
        harness === "codex" &&
        executable &&
        stat.isSymbolicLink() &&
        stat.uid === process.getuid!() &&
        /^tmp\/arg0-macos\/codex-arg0[A-Za-z0-9]{6}\/apply_?patch$/.test(path) &&
        readlinkSync(full) === executable
      )
        continue;
      if (!dir && (!stat.isFile() || stat.nlink !== 1)) throw new Error("unexpected link or special file in factory home: " + path);
      if (/^(skills|plugins)(\/|$)/.test(path)) {
        const normalized = account ? path.replace(account, "{account}") : path;
        if (parent ? !table[dirname(normalized)]?.includes(basename(normalized) + (dir ? "/" : "")) : !dir)
          throw new Error("unrecognized disabled source location in factory home: " + path);
        result.locations.add(path);
        if (entry.name === "SKILL.md") result.names.add(basename(parent));
        if (entry.name === "plugin.json" && parent.endsWith("/.codex-plugin")) result.names.add(path.split("/")[3]!);
        if (parent === "plugins/store") result.names.add(entry.name.split("_builtin-")[0]!);
      } else {
        const patterns = harness === "claude" ? (dir ? claudeDirs : claudeFiles) : dir ? codexDirs : codexFiles;
        if (!patterns.some((re) => re.test(path))) throw new Error("unexpected factory home location: " + path);
        if ([".claude.json", "config.toml", "settings.json"].includes(path)) checkConfig(full, path);
      }
      if (dir) visit(path);
    }
  };
  visit("");
  return result;
}

/** Check the effective arguments, stopping at the user prompt boundary. */
export function checkHomeFlags(harness: Harness, args: readonly string[], broker?: string) {
  if (!args.includes("--")) throw new Error("missing harness argument boundary");
  const head = args.slice(0, args.indexOf("--"));
  const values = (flag: string) => head.flatMap((v, i) => (v === flag ? [head[i + 1]] : []));
  if (harness === "claude") {
    const settings = values("--settings");
    const mcp = values("--mcp-config");
    if (
      settings.length === 1 &&
      ["--restricted", "--strict-mcp-config", "--disable-slash-commands"].every((f) => head.includes(f)) &&
      !head.some((v) => /^--[^=]+=|^--(?:plugin-(?:dir|url)|setting-sources|settings-sources)$/.test(v)) &&
      isDeepStrictEqual(mcp, broker ? [broker] : [])
    ) {
      const effective = JSON.parse(settings[0]!);
      if (
        isRecord(effective) &&
        Object.keys(effective).every((key) => key === "permissions" || key === "sandbox" || Object.hasOwn(claudeHomeSettings, key)) &&
        Object.entries(claudeHomeSettings).every(([key, value]) => isDeepStrictEqual(effective[key], value))
      )
        return;
    }
  } else {
    const config = values("-c");
    const allowedKeys = new Set([
      ...CODEX_HERMETIC_CONFIG.map((v) => v.split("=")[0]),
      "permissions",
      "default_permissions",
      "model_reasoning_effort",
      "shell_environment_policy.inherit",
      "allow_login_shell",
      "project_doc_max_bytes",
      "developer_instructions",
    ]);
    if (
      config.every((v) => typeof v === "string" && allowedKeys.has(v.split("=")[0])) &&
      ["--ignore-user-config", "--ignore-rules"].every((f) => head.includes(f)) &&
      !head.some((v) => /^(?:--enable|--profile|-p|--config)(?:=|$)|^-c.+/.test(v)) &&
      [...CODEX_HERMETIC_CONFIG, "project_doc_max_bytes=0"].every((expected) => {
        const key = expected.split("=")[0];
        return isDeepStrictEqual(
          config.filter((v) => v?.split("=")[0] === key),
          [expected],
        );
      })
    )
      return;
  }
  throw new Error("factory home source classes are not disabled on this launch");
}
