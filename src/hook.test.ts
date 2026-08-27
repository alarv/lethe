import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMemories } from "./hook.js";

const mem = (over: Partial<Parameters<typeof renderMemories>[0][0]> = {}) => ({
  id: "abcdef1234567890", kind: "claim", title: "Tests need containers",
  body: "Run `docker compose up -d` before the suite.", ...over,
});

test("renders nothing when there is nothing to say", () => {
  assert.equal(renderMemories([]), "");
});

test("wraps memories in a delimited block with ids", () => {
  const out = renderMemories([mem()]);
  assert.match(out, /^<lethe-memory>/);
  assert.match(out, /<\/lethe-memory>$/);
  assert.match(out, /\[abcdef12\] \(claim\) Tests need containers/);
  assert.match(out, /docker compose up -d/);
});

test("tells the model these are findings, not instructions", () => {
  const out = renderMemories([mem()]);
  assert.match(out, /not instructions/);
  assert.match(out, /correct/, "must say how to fix a wrong memory");
  assert.match(out, /confirm/, "must say how to reinforce a right one");
});

test("marks a memory borrowed from another repository", () => {
  assert.match(renderMemories([mem({ fromProject: "/other/repo" })]), /from \/other\/repo/);
});

test("stays inside a context budget", () => {
  const huge = renderMemories([
    mem({ id: "1".repeat(16), body: "x".repeat(5000) }),
    mem({ id: "2".repeat(16), body: "y".repeat(5000) }),
    mem({ id: "3".repeat(16), body: "z".repeat(5000) }),
  ]);
  assert.ok(huge.length < 2600, `injected ${huge.length} chars, which is too much`);
});

test("truncation is marked rather than silent", () => {
  const out = renderMemories([mem({ body: "line one\n" + "padding line\n".repeat(400) })]);
  assert.match(out, /\[…\]/, "a cut body must show it was cut");
});

test("singular and plural read correctly", () => {
  assert.match(renderMemories([mem()]), /1 memory recalled/);
  assert.match(renderMemories([mem(), mem({ id: "2".repeat(16) })]), /2 memories recalled/);
});

import { relevantEnough, termCoverage } from "./hook.js";

test("counts distinct query terms present in a memory", () => {
  assert.equal(termCoverage("run docker compose up", ["docker", "compose"]), 2);
  assert.equal(termCoverage("run docker compose up", ["docker", "kafka"]), 1);
  assert.equal(termCoverage("run docker compose up", ["nothing", "here"]), 0);
});

test("counts a term once however often it appears", () => {
  assert.equal(termCoverage("docker docker docker", ["docker", "docker"]), 1);
});

// The case that made this necessary: on the real store, "what is the airspeed
// velocity of an unladen swallow" matched a memory about embeddings, because the
// query is an OR of terms and "the" is in almost every memory.
test("rejects a match that rests on one common word", () => {
  const found = [{ title: "Embeddings rejected", body: "the decision was made to reject them" }];
  assert.deepEqual(
    relevantEnough(found, ["what", "the", "airspeed", "velocity", "unladen", "swallow"]),
    [],
    "a single stopword match must not be injected",
  );
});

test("admits a match that shares real terms", () => {
  const found = [{ title: "Tests need containers", body: "run docker compose up first" }];
  assert.equal(relevantEnough(found, ["docker", "compose", "failing"]).length, 1);
});

test("a two-term query needs both terms, not one", () => {
  const found = [{ title: "unrelated", body: "docker is mentioned here" }];
  assert.deepEqual(relevantEnough(found, ["docker", "kafka"]), [],
    "half of a two-word query is not enough");
});

test("one long memory cannot crowd out the others", () => {
  const out = renderMemories([
    mem({ id: "1".repeat(16), title: "first", body: "x".repeat(4000) }),
    mem({ id: "2".repeat(16), title: "second", body: "the second memory" }),
  ]);
  assert.match(out, /second/, "the second memory must still be present");
  assert.match(out, /2 memories recalled/);
});

import { documentFrequency } from "./hook.js";

test("document frequency counts memories containing each term", () => {
  const corpus = [
    { title: "a", body: "docker compose and embeddings" },
    { title: "b", body: "docker again" },
    { title: "c", body: "nothing relevant" },
    { title: "d", body: "docker a third time" },
  ];
  const df = documentFrequency(corpus, ["docker", "embeddings"]);
  assert.equal(df.get("docker"), 3);
  assert.equal(df.get("embedding"), 1, "terms are stemmed before counting");
});

// The case this exists for: two content terms, only one of which matches, but
// the one that matches is rare enough that matching it is not a coincidence.
test("a single rare term is admitted on its own", () => {
  const corpus = [
    { title: "embeddings rejected", body: "no vector search, reasons recorded" },
    ...Array.from({ length: 9 }, (_, i) => ({ title: `other ${i}`, body: "unrelated content" })),
  ];
  const found = [corpus[0]!];
  assert.equal(
    relevantEnough(found, ["decide", "embeddings"], corpus).length, 1,
    "'embeddings' appears in 1 of 10 memories, so it is evidence on its own",
  );
});

test("a single common term is still rejected", () => {
  const corpus = Array.from({ length: 10 }, (_, i) => ({
    title: `memory ${i}`, body: "this one worked fine in the end",
  }));
  assert.deepEqual(
    relevantEnough([corpus[0]!], ["thanks", "worked"], corpus), [],
    "'worked' is in every memory, so matching it means nothing",
  );
});

test("without a corpus it falls back to requiring coverage", () => {
  const found = [{ title: "t", body: "docker only" }];
  assert.deepEqual(relevantEnough(found, ["docker", "kafka"]), [],
    "no document frequency available means no rare-term exemption");
});

import { preferDistilled } from "./hook.js";

test("a single claim beats several episodes", () => {
  const found = [
    { kind: "episode", title: "e1" },
    { kind: "claim", title: "c1" },
    { kind: "episode", title: "e2" },
  ];
  assert.deepEqual(preferDistilled(found).map((m) => m.title), ["c1"],
    "episodes must not fill the budget when a claim exists");
});

test("patterns count as distilled", () => {
  const found = [{ kind: "episode", title: "e" }, { kind: "pattern", title: "p" }];
  assert.deepEqual(preferDistilled(found).map((m) => m.title), ["p"]);
});

// The store is 32 episodes to 3 claims, and this project has none at all.
// Filtering to claims-only would return nothing, so raw traces must survive as
// the fallback rather than being excluded outright.
test("episodes survive when there is nothing distilled", () => {
  const found = [{ kind: "episode", title: "e1" }, { kind: "episode", title: "e2" }];
  assert.equal(preferDistilled(found).length, 2,
    "an all-episode store must still return something");
});

test("an episode body is trimmed far harder than a claim body", () => {
  const long = "x".repeat(3000);
  // Measure the body, not the whole block: the preamble is fixed overhead and
  // counting it hides what the cap actually does.
  const bodyChars = (block: string) =>
    block.split("\n").filter((l) => l.startsWith("  x")).join("").length;
  const asEpisode = renderMemories([mem({ kind: "episode", body: long })]);
  const asClaim = renderMemories([mem({ kind: "claim", body: long })]);
  assert.ok(bodyChars(asEpisode) < bodyChars(asClaim),
    `episode body ${bodyChars(asEpisode)} should be shorter than claim body ${bodyChars(asClaim)}`);
  assert.ok(bodyChars(asEpisode) <= 220, `episode body was ${bodyChars(asEpisode)} chars`);
});

test("excerpted episodes say so, and point at recall by id", () => {
  const out = renderMemories([mem({ kind: "episode", body: "y".repeat(3000) })]);
  assert.match(out, /excerpted/);
  assert.match(out, /recall.*by id/i);
});

test("a claims-only block does not mention excerpting", () => {
  const out = renderMemories([mem({ kind: "claim", body: "short and complete" })]);
  assert.doesNotMatch(out, /excerpted/);
});
