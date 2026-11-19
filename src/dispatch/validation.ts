import { lstatSync, realpathSync } from "node:fs";

export const sessionUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function money(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function safeSessionFile(path: string) {
  const st = lstatSync(path);
  return st.isFile() && st.nlink === 1 && realpathSync(path) === path;
}
