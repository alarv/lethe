import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate, parseClaims, MAX_REPLAY, MAX_REVISABLE } from "./consolidate.js";
import type { Memory } from "./store.js";

function ep(over: Partial<Memory> & { id: string; body: string }): Memory {
  return {
    kind: "episode", title: over.id, tags: [], files: [],
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

// ------------------------------------------- revising claims instead of duplicating

function cl(over: Partial<Memory> & { id: string; body: string }): Memory {
  return { ...ep(over), kind: "claim" } as Memory;
}

const EXISTING = [
  cl({ id: "c1", title: "distiller failures are silent",
       body: "compaction fails quietly when the distiller is unavailable; look for `distil failed: no model`" }),
];

test("parses a supersedes line, with or without the C", () => {
  const [a] = parseClaims("CLAIM\nsupersedes: C1, C3\nsources: 1\ntitle: A\nbody: a\nEND");
  assert.deepEqual(a!.supersedes, [1, 3]);
  const [b] = parseClaims("CLAIM\nsupersedes: 2\nsources: 1\ntitle: A\nbody: a\nEND");
  assert.deepEqual(b!.supersedes, [2]);
});

test("a claim with no supersedes line supersedes nothing", () => {
  const [c] = parseClaims("CLAIM\nsources: 1\ntitle: A\nbody: a\nEND");
  assert.deepEqual(c!.supersedes, []);
});

test("existing claims are offered to the model, and the rules for them", async () => {
  let sent = "";
  await consolidate(EPISODES, async (p) => { sent = p; return ""; }, EXISTING);
  assert.match(sent, /^C1\. distiller failures are silent/m, "claims must be numbered separately");
  assert.match(sent, /supersedes: C1/);
  assert.match(sent, /REPLACES the claim it supersedes/);
});

test("nothing about revising is shown when there is nothing to revise", async () => {
  let sent = "";
  await consolidate(EPISODES, async (p) => { sent = p; return ""; });
  // A field the model cannot use is an invitation to hallucinate an index.
  assert.doesNotMatch(sent, /supersedes/i);
  assert.doesNotMatch(sent, /^C1\./m);
});

test("a revision that keeps the old claim's evidence is accepted", async () => {
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsupersedes: C1\nsources: 1\ntitle: Distiller failures are silent\n" +
    "body: `distil failed: no model` in the log; also `docker compose up -d` for the suite\nEND",
    EXISTING);
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.accepted[0]!.revises.map((m) => m.id), ["c1"]);
  assert.deepEqual(r.accepted[0]!.sources.map((m) => m.id), ["e1"]);
});

test("a revision that drops the old claim's evidence is rejected", async () => {
  // The gate that protects episodes, one level up. Without this, "revising" is
  // how a claim's commands quietly disappear.
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsupersedes: C1\nsources: 1\ntitle: Things sometimes fail\n" +
    "body: run `docker compose up -d` and hope\nEND",
    EXISTING);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0]!.missing.some((m) => m.includes("distil failed: no model")),
    `rejection must name what was lost, got ${JSON.stringify(r.rejected[0]!.missing)}`);
});

test("a claim citing no episode is skipped even when it supersedes one", async () => {
  // Consolidation is triggered by new evidence; a rewrite with none behind it is
  // churn, and the evidence gate would have nothing to check it against.
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsupersedes: C1\nsources: none\ntitle: A\nbody: a\nEND", EXISTING);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 0);
});

test("two revisions of one claim: the first wins", async () => {
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsupersedes: C1\nsources: 1\ntitle: First\nbody: `distil failed: no model` `docker compose up -d`\nEND\n" +
    "CLAIM\nsupersedes: C1\nsources: 3\ntitle: Second\nbody: `npm pack --dry-run` and `distil failed: no model`\nEND",
    EXISTING);
  assert.equal(r.accepted.length, 2);
  assert.deepEqual(r.accepted[0]!.revises.map((m) => m.id), ["c1"]);
  assert.deepEqual(r.accepted[1]!.revises, [],
    "a claim already replaced must not be replaced twice; its successor would be cold");
});

test("an out-of-range or absent claim index is ignored, not fatal", async () => {
  const r = await consolidate(EPISODES, async () =>
    "CLAIM\nsupersedes: C9\nsources: 1\ntitle: A\nbody: `docker compose up -d`\nEND", EXISTING);
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.accepted[0]!.revises, []);
});

test("the claim list is capped, most salient first", async () => {
  const many = Array.from({ length: MAX_REVISABLE + 5 }, (_, i) =>
    cl({ id: `c${i}`, body: "x", salience: i / 100 }));
  let sent = "";
  await consolidate(EPISODES, async (p) => { sent = p; return ""; }, many);
  const listed = [...sent.matchAll(/^C\d+\. /gm)].length;
  assert.equal(listed, MAX_REVISABLE, `offered ${listed}, cap is ${MAX_REVISABLE}`);
  assert.match(sent, new RegExp(`c${MAX_REVISABLE + 4}`), "the most salient must be offered");
  assert.doesNotMatch(sent, /\bc0\b/, "the least salient must be dropped");
});
