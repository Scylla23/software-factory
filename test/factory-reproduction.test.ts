import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { junitReproduction } from "../src/factory/checks";

test("Bun JUnit requires one named assertion failure on base and one passing asserted case on head", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-junit-"));
  try {
    for (const [body, base, head] of [
      ['test("AC-1 stock", () => expect(0).toBe(1));', true, false],
      ['test("AC-1 stock", () => expect(0).toBe(0));', false, true],
      ['test("AC-1 stock", () => { throw Error("fixture"); });', false, false],
      ['test("AC-1 stock", () => {});', false, false],
      ['test("AC-10 stock", () => expect(0).toBe(1));', false, false],
      ['test("AC-1 stock", () => expect(0).toBe(1)); test("another", () => {});', false, false],
    ] as const) {
      writeFileSync(join(dir, "repro-issue-23.test.ts"), 'import {test,expect} from "bun:test";' + body);
      Bun.spawnSync([process.execPath, "test", "--reporter=junit", "--reporter-outfile=proof.xml", "./repro-issue-23.test.ts"], { cwd: dir });
      const xml = readFileSync(join(dir, "proof.xml"), "utf8");
      expect(junitReproduction(xml, true, "repro-issue-23.test.ts")).toBe(base);
      expect(junitReproduction(xml, base, "repro.test.ts")).toBe(false);
      if (base) expect(junitReproduction(xml.replace("</testsuites>", " ".repeat(65_537) + "</testsuites>"), true, "repro-issue-23.test.ts")).toBe(false);
      expect(junitReproduction(xml, false, "repro-issue-23.test.ts")).toBe(head);
    }
    for (const invalid of ["", "(fail) AC-1\nerror: expect(", "<testsuites>", "<!DOCTYPE testsuites>"])
      expect(junitReproduction(invalid, true, "repro-issue-23.test.ts")).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
