import { test } from "node:test";
import assert from "node:assert/strict";
import { withStore } from "./testing.js";
import { compact } from "./compact.js";

/** A distiller that always produces a well-formed claim keeping the command. */
const good = async (prompt: string) => {
  // Assert the singleton path uses the singleton prompt, since asking for what
  // is "INVARIANT across them" about one episode produced SKIP.
  if (prompt.includes("Below is one episode")) {
    return "Start the containers first\n\nRun `docker compose up -d` before the suite.";
  }
  return "Start the containers first\n\nRun `docker compose up -d` before the suite.";
};

test("a lone episode nobody has used is left alone", async () => {
  await withStore(async (store) => {
    store.create({ kind: "episode", title: "one off",
      body: "ran `docker compose up -d` once", salience: 0.5 });
    const report = await compact(store, { distil: good });
    assert.equal(report.claimsWritten, 0,
      "an unremarkable single episode is not yet a lesson");
  });
});

test("a lone episode recorded as significant is distilled", async () => {
  await withStore(async (store) => {
    store.create({ kind: "episode", title: "the trap",
      body: "you must run `docker compose up -d` or the suite fails", salience: 0.9 });
    const report = await compact(store, { distil: good });
    assert.equal(report.claimsWritten, 1, "high salience must earn a claim alone");
    const claim = store.all().find((m) => m.kind === "claim");
    assert.ok(claim, "a claim must exist");
    assert.ok(claim!.body.includes("docker compose up -d"), "evidence must survive");
  });
});

test("a lone episode retrieved repeatedly is distilled", async () => {
  await withStore(async (store) => {
    const ep = store.create({ kind: "episode", title: "keeps coming up",
      body: "the fix is `docker compose up -d`", salience: 0.4 });
    store.touch(ep);
    store.touch(ep);
    const report = await compact(store, { distil: good });
    assert.equal(report.claimsWritten, 1, "repeated retrieval must earn a claim alone");
  });
});

test("distilling a singleton makes its episode cold, not deleted", async () => {
  await withStore(async (store) => {
    store.create({ kind: "episode", title: "the trap",
      body: "you must run `docker compose up -d` first", salience: 0.9 });
    await compact(store, { distil: good });
    const episode = store.all().find((m) => m.kind === "episode");
    assert.ok(episode, "the episode must still exist as a route");
    assert.ok(episode!.supersededBy, "and must point at the claim it became");
  });
});

test("the singleton path uses the singleton prompt", async () => {
  await withStore(async (store) => {
    let sawSingleton = false;
    store.create({ kind: "episode", title: "the trap",
      body: "run `docker compose up -d` first", salience: 0.9 });
    await compact(store, {
      distil: async (prompt) => {
        sawSingleton = prompt.includes("Below is one episode");
        return "Containers first\n\nRun `docker compose up -d`.";
      },
    });
    assert.ok(sawSingleton,
      "asking what is INVARIANT across one episode is incoherent and yields SKIP");
  });
});

test("clustering still handles genuinely related episodes together", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 2; i++) {
      store.create({ kind: "episode", title: `suite failed ${i}`,
        body: "the test suite failed until I ran `docker compose up -d` in the repo root",
        files: ["docker-compose.yml"], tags: ["testing"], salience: 0.4 });
    }
    const report = await compact(store, { distil: good });
    assert.equal(report.claimsWritten, 1, "two similar episodes make one claim");
    assert.equal(report.episodesConsumed, 2, "both must be consumed, not one");
  });
});
