import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withStore } from "./testing.js";

test("withStore gives an isolated, empty store", async () => {
  let seenHome = "";
  await withStore((store, home) => {
    seenHome = home;
    assert.equal(store.all().length, 0, "a fresh store must be empty");
    store.create({ kind: "episode", title: "hello", body: "world" });
    assert.equal(store.all().length, 1);
    assert.ok(existsSync(home), "home exists while the callback runs");
  });
  assert.ok(!existsSync(seenHome), "home is removed afterward");
});

test("withStore cleans up even when the callback throws", async () => {
  let seenHome = "";
  await assert.rejects(
    withStore((_store, home) => {
      seenHome = home;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(!existsSync(seenHome), "home is removed after a throw");
});

// The whole test process must be isolated, not just the tests that remember to
// ask for it. consolidate.test.ts calls pure functions with no Store, so nothing
// set LETHE_HOME and its log lines went to the user's real ~/.lethe/lethe.log --
// 61 fake "rejected" entries that made `lethe metrics` report the distiller as
// failing more often than it succeeded.
test("the test process is isolated from the real store", () => {
  const home = process.env.LETHE_HOME;
  assert.ok(home, "LETHE_HOME must be set for the whole run; see the test script");
  assert.ok(
    !home.startsWith(join(homedir(), ".lethe")),
    `tests must not point at the real store, got ${home}`,
  );
});
