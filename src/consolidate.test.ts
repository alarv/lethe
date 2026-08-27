import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate, parseClaims, MAX_REPLAY } from "./consolidate.js";
import type { Memory } from "./store.js";

function ep(over: Partial<Memory> & { id: string; body: string }): Memory {
  return {
    kind: "episode", scope: "local", title: over.id, tags: [], files: [],
    salience: 0.5, strength: 1, decayedAt: "2026-01-01T00:00:00Z", accessCount: 0,
    created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
    lastAccessed: null, provenance: [], supersededBy: null, author: "a",
    confirmedBy: [], ...over,
  } as Memory;
}

test("parses one claim", () => {
  const [c] = parseClaims("CLAIM\nsources: 1, 3\ntitle: Containers first\nbody: Run `x`.\nEND");
  assert.deepEqual(c!.sources, [1, 3]);
  assert.equal(c!.title, "Containers first");
  assert.equal(c!.body, "Run `x`.");
});

test("parses several claims", () => {
  const cs = parseClaims(
    "CLAIM\nsources: 1\ntitle: A\nbody: a\nEND\nCLAIM\nsources: 2, 3\ntitle: B\nbody: b\nEND",
  );
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[1]!.sources, [2, 3]);
});

// CLI models narrate; the parser must survive it rather than discard the claim.
test("tolerates a preamble, odd case and whitespace", () => {
  const cs = parseClaims("Sure, here are the claims:\n\n  claim  \n Sources : [1]\n Title : A\n Body : a\n  end  ");
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0]!.sources, [1]);
  assert.equal(cs[0]!.title, "A");
});

test("keeps a multi-line body", () => {
  const [c] = parseClaims("CLAIM\nsources: 1\ntitle: A\nbody: line one\nline two\nEND");
  assert.match(c!.body, /line one/);
  assert.match(c!.body, /line two/);
});

test("skips a block with no usable sources", () => {
  assert.deepEqual(parseClaims("CLAIM\nsources: none\ntitle: A\nbody: a\nEND"), []);
});

test("skips a block with no title", () => {
  assert.deepEqual(parseClaims("CLAIM\nsources: 1\nbody: a\nEND"), []);
});

test("returns nothing for prose with no blocks", () => {
  assert.deepEqual(parseClaims("I think these episodes are all unrelated."), []);
});

const EPISODES = [
  ep({ id: "e1", title: "suite failed", body: "fixed by running `docker compose up -d`" }),
  ep({ id: "e2", title: "suite failed again", body: "again `docker compose up -d` fixed it" }),
  ep({ id: "e3", title: "npm leak", body: "`npm pack --dry-run` showed docs/lethe.md shipping" }),
];

test("groups what the model groups, and leaves the rest alone", async () => {
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsources: 1, 2\ntitle: Containers first\nbody: Run `docker compose up -d` before the suite.\nEND");
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.accepted[0]!.sources.map((m) => m.id), ["e1", "e2"]);
  assert.deepEqual(r.untouched.map((m) => m.id), ["e3"],
    "an episode the model did not cite stays raw and searchable");
});

test("produces several claims from one pass", async () => {
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsources: 1, 2\ntitle: Containers\nbody: Run `docker compose up -d`.\nEND\n" +
    "CLAIM\nsources: 3\ntitle: Packaging\nbody: `npm pack --dry-run` shows docs/lethe.md shipping.\nEND");
  assert.equal(r.accepted.length, 2);
  assert.equal(r.untouched.length, 0);
});

// The failure this whole redesign exists to prevent.
test("rejects a claim that dropped a source's evidence", async () => {
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsources: 1, 2, 3\ntitle: Various things\nbody: Several problems came up in this repo.\nEND");
  assert.equal(r.accepted.length, 0, "a five-way fusion must not be written");
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0]!.missing.length > 0);
  assert.equal(r.untouched.length, 3, "rejected episodes stay live and searchable");
});

test("an episode cited twice is consumed once", async () => {
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsources: 1\ntitle: A\nbody: Run `docker compose up -d`.\nEND\n" +
    "CLAIM\nsources: 1\ntitle: B\nbody: Run `docker compose up -d`.\nEND");
  const consumedIds = r.accepted.flatMap((a) => a.sources.map((m) => m.id));
  assert.deepEqual(consumedIds, ["e1"], "double-consumption would orphan a claim's provenance");
});

test("a model failure leaves every episode alone", async () => {
  const r = await consolidate(EPISODES, async () => { throw new Error("no model"); });
  assert.equal(r.accepted.length, 0);
  assert.equal(r.untouched.length, 3);
});

test("an unparseable reply leaves every episode alone", async () => {
  const r = await consolidate(EPISODES, async () => "I could not decide.");
  assert.equal(r.accepted.length, 0);
  assert.equal(r.untouched.length, 3);
});

test("replay is capped, most salient first", async () => {
  const many = Array.from({ length: MAX_REPLAY + 10 }, (_, i) =>
    ep({ id: `m${i}`, body: "x", salience: i / 100 }));
  let sent = "";
  await consolidate(many, async (p) => { sent = p; return ""; });
  const numbered = [...sent.matchAll(/^\d+\. /gm)].length;
  assert.equal(numbered, MAX_REPLAY, `sent ${numbered} episodes, cap is ${MAX_REPLAY}`);
  assert.match(sent, new RegExp(`m${MAX_REPLAY + 9}`), "the most salient must be included");
  assert.doesNotMatch(sent, /\bm0\b/, "the least salient must be dropped");
});

test("the prompt tells the model not to fuse unrelated episodes", async () => {
  let sent = "";
  await consolidate(EPISODES, async (p) => { sent = p; return ""; });
  assert.match(sent, /Group by problem/);
  assert.match(sent, /npm packaging/, "the actual failure is named as the example");
});
