import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Pinned harness discovery sources. A path below a discovery directory is protected at every depth.
const directories = [".claude", ".agents", ".codex"];
const files = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"];
const names = [...directories, ...files];

export function isDiscoveryPath(path: string) {
  return path.split("/").some((segment) => names.some((name) => name.toLowerCase() === segment.toLowerCase()));
}

// The default macOS volume is case-insensitive. Both harnesses must also protect alternate spellings.
const folded = (name: string) => name.replace(/[a-z]/gi, (c) => "[" + c.toLowerCase() + c.toUpperCase() + "]");
export const discoveryGlobs = [
  ...names.map((name) => "**/" + folded(name)),
  ...directories.map((name) => "**/" + folded(name) + "/**"),
];

// Seatbelt regex rules apply at the time of the syscall, including directories created after launch.
export const discoveryRegex = "/(" + names.map((name) => folded(name).replaceAll(".", "[.]")).join("|") + ")(/|$)";

// A path rule cannot protect bytes shared with an independently writable filename.
export function checkDiscoverySources(root: string) {
  const visit = (dir: string, protectedDir: boolean) => {
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      if (!protectedDir && entry.name.toLowerCase() === ".git") continue;
      const path = join(dir,entry.name);
      const protectedPath = protectedDir || isDiscoveryPath(entry.name);
      if (entry.isDirectory()) visit(path,protectedPath);
      else if (protectedPath && (!entry.isFile() || lstatSync(path).nlink !== 1)) throw new Error("discovery source has an unsafe alias: "+path);
    }
  };
  visit(root,false);
}
