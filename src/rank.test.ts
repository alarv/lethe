import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, dynamicsMultiplier } from "./rank.js";
import type { Memory } from "./store.js";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    kind: "claim", scope: "local", title: over.id, body: "b", tags: [], files: [],
    salience: 0.5, strength: 1, decayedAt: "2026-01-01T00:00:00Z", accessCount: 0,
    created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
    lastAccessed: null, provenance: [], supersededBy: null, author: "a",
    confirmedBy: [], ...over,
  } as Memory;
}

test("claims and patterns outrank episodes at equal relevance", () => {
  assert.ok(
    dynamicsMultiplier(mem({ id: "c", kind: "claim" }), []) >
      dynamicsMultiplier(mem({ id: "e", kind: "episode" }), []),
  );
});

test("path overlap doubles the multiplier", () => {
  const m = mem({ id: "m", files: ["src/store.ts"] });
  assert.equal(dynamicsMultiplier(m, ["src/store.ts"]), dynamicsMultiplier(m, []) * 2);
});

test("strength scales the multiplier", () => {
  assert.ok(
    dynamicsMultiplier(mem({ id: "a", strength: 2 }), []) >
      dynamicsMultiplier(mem({ id: "b", strength: 0.5 }), []),
  );
});

test("memories from another project are discounted", () => {
  assert.ok(
    dynamicsMultiplier(mem({ id: "a" }), []) >
      dynamicsMultiplier(mem({ id: "b", fromProject: "/other/repo" }), []),
  );
});

test("a superseded episode resolves forward to its claim", () => {
  const claim = mem({ id: "claim-1", title: "the claim" });
  const episode = mem({ id: "ep-1", kind: "episode", supersededBy: "claim-1" });
  const byId = new Map([[claim.id, claim], [episode.id, episode]]);
  const out = rank([{ id: "ep-1", relevance: 5, supersededBy: "claim-1" }], byId, [], 5);
  assert.deepEqual(out.map((m) => m.id), ["claim-1"]);
});

test("a claim matched both directly and through its trace appears once", () => {
  const claim = mem({ id: "claim-1" });
  const episode = mem({ id: "ep-1", kind: "episode", supersededBy: "claim-1" });
  const byId = new Map([[claim.id, claim], [episode.id, episode]]);
  const out = rank(
    [
      { id: "claim-1", relevance: 3, supersededBy: null },
      { id: "ep-1", relevance: 9, supersededBy: "claim-1" },
    ],
    byId, [], 5,
  );
  assert.equal(out.length, 1, "must not return the claim twice");
  assert.equal(out[0]!.id, "claim-1");
});

test("an episode whose claim is missing is dropped rather than returned raw", () => {
  const episode = mem({ id: "ep-1", kind: "episode", supersededBy: "gone" });
  const byId = new Map([[episode.id, episode]]);
  assert.deepEqual(rank([{ id: "ep-1", relevance: 5, supersededBy: "gone" }], byId, [], 5), []);
});

test("ties break on title so ranking reproduces across machines", () => {
  const a = mem({ id: "a", title: "bbb" });
  const b = mem({ id: "b", title: "aaa" });
  const byId = new Map([[a.id, a], [b.id, b]]);
  const out = rank(
    [{ id: "a", relevance: 1, supersededBy: null }, { id: "b", relevance: 1, supersededBy: null }],
    byId, [], 5,
  );
  assert.deepEqual(out.map((m) => m.title), ["aaa", "bbb"]);
});

test("respects the limit", () => {
  const byId = new Map<string, Memory>();
  const hits = [];
  for (let i = 0; i < 10; i++) {
    const m = mem({ id: `m${i}`, title: `t${i}` });
    byId.set(m.id, m);
    hits.push({ id: m.id, relevance: 10 - i, supersededBy: null });
  }
  assert.equal(rank(hits, byId, [], 3).length, 3);
});
