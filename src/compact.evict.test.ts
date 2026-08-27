import { test } from "node:test";
import assert from "node:assert/strict";
import { withStore } from "./testing.js";
import { compact } from "./compact.js";

test("compaction evicts down to the budget, cheapest loss first", async () => {
  await withStore(async (store) => {
    const claim = store.create({ kind: "claim", title: "the lesson", body: "guard shared state" });
    for (let i = 0; i < 5; i++) {
      const ep = store.create({ kind: "episode", title: `cold ${i}`, body: `trace ${i}` });
      ep.supersededBy = claim.id;
      store.write(ep);
    }
    const live = store.create({ kind: "episode", title: "live", body: "not consolidated" });

    const report = await compact(store, { budget: 3 });
    assert.ok(report.purged > 0, "expected evictions");

    const left = store.all();
    assert.equal(left.length, 3);
    assert.ok(left.some((m) => m.id === claim.id), "the claim must survive");
    assert.ok(left.some((m) => m.id === live.id), "a live episode outranks cold traces");
  });
});

test("a dry run reports what it would evict and deletes nothing", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) store.create({ kind: "episode", title: `e${i}`, body: "x" });
    const report = await compact(store, { budget: 2, dryRun: true });
    assert.ok(report.purged > 0, "must report what it would do");
    assert.equal(store.all().length, 5, "must not actually delete");
  });
});

test("episodes now participate in decay", async () => {
  const { readFileSync, writeFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("./store.js");

  await withStore(async (store, home, workspace) => {
    const ep = store.create({ kind: "episode", title: "old", body: "x" });

    // Age the stored record rather than writing a backdated one through
    // saveDynamics: the merge now correctly rejects a decayedAt older than
    // disk, since that is what a stale process would write.
    const projects = join(home, "projects");
    const key = readdirSync(projects)[0]!;
    const sidecar = join(projects, key, "dynamics.json");
    const data = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, { decayedAt: string }>;
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    for (const rec of Object.values(data)) rec.decayedAt = old;
    writeFileSync(sidecar, JSON.stringify(data));

    // Fresh Store so the aged sidecar is what gets loaded.
    const aged = new Store(workspace);
    assert.equal(aged.all().find((m) => m.id === ep.id)!.decayedAt, old, "ageing failed");

    await compact(aged, {});
    const after = new Store(workspace).all().find((m) => m.id === ep.id);
    assert.ok(after, "decay must not delete it outright");
    assert.ok(after!.strength < 1,
      `episodes were exempt from decay entirely; strength is ${after!.strength}`);
  });
});

test("a decay is not discarded by the merge on write", async () => {
  await withStore(async (store) => {
    const m = store.create({ kind: "claim", title: "c", body: "b" });
    // Simulate what the decay pass does: lower strength, advance the epoch.
    m.strength = 0.3;
    m.decayedAt = new Date(Date.now() + 1000).toISOString();
    store.saveDynamics(m);
    const after = store.all().find((x) => x.id === m.id);
    assert.equal(after!.strength, 0.3,
      "Math.max on strength silently discarded every decay before this");
  });
});

test("nothing is evicted when the store is under budget", async () => {
  await withStore(async (store) => {
    store.create({ kind: "episode", title: "a", body: "x" });
    const report = await compact(store, {});
    assert.equal(report.purged, 0);
    assert.equal(store.all().length, 1);
  });
});
