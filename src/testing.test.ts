import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
