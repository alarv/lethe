import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedUpdate, newer, refreshUpdate, updateNotice } from "./update.js";

const saved = { ...process.env };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lethe-update-"));
  process.env.LETHE_HOME = home;
  delete process.env.CI;
  delete process.env.LETHE_NO_UPDATE_CHECK;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

test("newer compares numbers, not strings", () => {
  assert.ok(newer("0.10.0", "0.9.9"));
  assert.ok(newer("1.0.0", "0.99.99"));
  assert.ok(!newer("0.3.2", "0.3.2"));
  assert.ok(!newer("0.3.1", "0.3.2"));
  assert.ok(newer("0.4.0", "0.4.0-beta.1"), "a release beats its own prerelease");
  assert.ok(!newer("0.4.0-beta.1", "0.4.0"));
});

test("a notice comes only from the cached answer and only when it is newer", () => {
  assert.equal(updateNotice("0.3.2", null), null);
  assert.equal(updateNotice("0.3.2", { checkedAt: Date.now(), latest: "0.3.2" }), null);
  assert.equal(updateNotice("0.3.2", { checkedAt: Date.now(), latest: "0.3.1" }), null);
  assert.match(
    updateNotice("0.3.0", { checkedAt: Date.now(), latest: "0.3.2" })!,
    /0\.3\.2.*runs 0\.3\.0/,
  );
});

test("the cached answer is read from the lethe home, and a broken one is ignored", () => {
  writeFileSync(join(home, "update.json"), JSON.stringify({ checkedAt: 123, latest: "9.9.9" }));
  assert.deepEqual(cachedUpdate(), { checkedAt: 123, latest: "9.9.9" });
  assert.match(updateNotice("0.3.2")!, /9\.9\.9/);

  writeFileSync(join(home, "update.json"), "{not json");
  assert.equal(cachedUpdate(), null);
  assert.equal(updateNotice("0.3.2"), null);
});

test("the check can be switched off without losing the cached answer", async () => {
  writeFileSync(join(home, "update.json"), JSON.stringify({ checkedAt: 1, latest: "0.3.2" }));
  process.env.LETHE_NO_UPDATE_CHECK = "1";
  assert.deepEqual(await refreshUpdate(true), { checkedAt: 1, latest: "0.3.2" });
});
