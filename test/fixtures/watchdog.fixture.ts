/**
 * Fixtures for test/watchdog.test.ts, inert unless it sets WATCHDOG_FIXTURE.
 * `wedge` reproduces the Bun 1.2.10 runner wedge: a test ends while other work in the process waits in Bun.spawnSync,
 * and the afterEach hook waits for that work. `leave` leaves a detached process in the run's state directory.
 */
import { afterEach, test } from "bun:test";

const mode = process.env.WATCHDOG_FIXTURE;
let pending: Promise<unknown>[] = [];
afterEach(async () => {
  await Promise.allSettled(pending);
  pending = [];
});

test.if(mode === "wedge")("ends while background work waits in Bun.spawnSync", async () => {
  pending.push(
    (async () => {
      await Bun.sleep(5);
      for (let i = 0; i < 3; i++) Bun.spawnSync(["/bin/sleep", "0.3"]);
    })(),
  );
  await Bun.sleep(50);
});

test.if(mode === "leave")("leaves a detached process behind", async () => {
  const sh = Bun.spawn(["/bin/sh", "-c", "/bin/sleep 120 > /dev/null 2>&1 &"], { cwd: process.env.FACTORY_TEST_STATE! });
  await sh.exited;
});

test.if(mode === "pass")("passes", () => {});
