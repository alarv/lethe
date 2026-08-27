import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForEviction, tier, DEFAULT_BUDGET } from "./evict.js";
import type { Memory } from "./store.js";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    kind: "episode", scope: "local", title: over.id, body: "b", tags: [], files: [],
    salience: 0.5, strength: 1, decayedAt: "2026-01-01T00:00:00Z", accessCount: 0,
    created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
    lastAccessed: null, provenance: [], supersededBy: null, author: "a",
    confirmedBy: [], ...over,
  } as Memory;
}

test("a superseded episode is tier 1 — the claim carries the lesson", () => {
  const claim = mem({ id: "c", kind: "claim" });
  assert.equal(tier(mem({ id: "e", supersededBy: "c" }), new Map([["c", claim]])), 1);
});

test("a trace whose claim is gone is never evicted", () => {
  assert.equal(tier(mem({ id: "e", supersededBy: "missing" }), new Map()), null,
    "the knowledge exists only in this trace");
});

test("unconsolidated episode is tier 2, claim tier 3, pattern never", () => {
  assert.equal(tier(mem({ id: "e" }), new Map()), 2);
  assert.equal(tier(mem({ id: "c", kind: "claim" }), new Map()), 3);
  assert.equal(tier(mem({ id: "p", kind: "pattern" }), new Map()), null);
});

test("nothing is evicted while under budget", () => {
  assert.deepEqual(selectForEviction([mem({ id: "a" }), mem({ id: "b" })], 10), []);
});

test("tier 1 goes before tier 2", () => {
  const claim = mem({ id: "claim", kind: "claim" });
  const cold = mem({ id: "cold", supersededBy: "claim" });
  const live = mem({ id: "live" });
  assert.deepEqual(
    selectForEviction([claim, cold, live], 2).map((e) => e.memory.id), ["cold"],
    "a cold trace is a cheaper loss than a live episode",
  );
});

test("within a tier the weakest goes first, not the oldest", () => {
  const weak = mem({ id: "weak", strength: 0.1, created: "2026-06-01T00:00:00Z" });
  const strong = mem({ id: "strong", strength: 1.9, created: "2026-01-01T00:00:00Z" });
  assert.deepEqual(selectForEviction([weak, strong], 1).map((e) => e.memory.id), ["weak"],
    "FIFO would have evicted 'strong'; salience decides, per brain.md 4");
});

test("evicts only as many as the budget requires", () => {
  const all = Array.from({ length: 10 }, (_, i) => mem({ id: `m${i}`, strength: i / 10 }));
  assert.equal(selectForEviction(all, 7).length, 3);
});

test("patterns survive even if that means staying over budget", () => {
  const all = Array.from({ length: 5 }, (_, i) => mem({ id: `p${i}`, kind: "pattern" }));
  assert.deepEqual(selectForEviction(all, 1), [],
    "promoted survivors are never evicted to meet a budget");
});

test("every eviction reports the tier that chose it", () => {
  const claim = mem({ id: "claim", kind: "claim" });
  const cold = mem({ id: "cold", supersededBy: "claim" });
  const chosen = selectForEviction([claim, cold, mem({ id: "x" })], 2);
  assert.equal(chosen[0]!.tier, 1, "silent deletion is indistinguishable from a bug");
});

test("the default budget keeps the index cheap to build", () => {
  assert.ok(DEFAULT_BUDGET <= 2000,
    "index build and heap scale with this; 2800 memories measured 144ms and 66MB");
});
