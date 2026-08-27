import { test } from "node:test";
import assert from "node:assert/strict";
import { withStore } from "./testing.js";

test("search finds a memory by a word in its body", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "container setup",
      body: "you must run docker compose up before the suite" });
    store.create({ kind: "claim", title: "noise", body: "unrelated jwt token business" });
    const hits = store.search("docker", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.title, "container setup");
  });
});

test("IDF and length normalisation stop a long body winning on bulk", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "the answer", body: "kafka rebalance storm" });
    store.create({ kind: "claim", title: "padding",
      body: "filler ".repeat(400) + " kafka " + "more filler ".repeat(400) });
    const hits = store.search("kafka rebalance", 5);
    assert.equal(hits[0]!.title, "the answer",
      "the short, precise memory must rank above the long one");
  });
});

test("substring matches no longer count: auth must not match author", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "book", body: "the author wrote a chapter" });
    assert.equal(store.search("auth", 5).length, 0, "'auth' must not match inside 'author'");
  });
});

test("a query with no usable terms returns nothing rather than throwing", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "x", body: "y" });
    assert.deepEqual(store.search("a an of", 5), []);
  });
});

test("natural language with punctuation does not throw", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "x", body: "docker compose up" });
    for (const q of ["why is docker: failing?", "tests -broken", "C++ error", '"unclosed']) {
      assert.doesNotThrow(() => store.search(q, 5), `threw on: ${q}`);
    }
  });
});

test("searchNaive still works, so the eval can compare mechanisms", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "container setup", body: "run docker compose up" });
    assert.equal(store.searchNaive("docker", 5).length, 1);
  });
});

test("a superseded episode surfaces as the claim that replaced it", async () => {
  await withStore(async (store) => {
    const claim = store.create({ kind: "claim", title: "the lesson",
      body: "guard shared instance state across awaits" });
    const ep = store.create({ kind: "episode", title: "the session",
      body: "spent an hour on a zookeeper session timeout" });
    ep.supersededBy = claim.id;
    store.write(ep);
    const hits = store.search("zookeeper", 5);
    assert.equal(hits.length, 1, "the cold trace must still be a route");
    assert.equal(hits[0]!.title, "the lesson", "must return the claim, not the trace");
  });
});

test("claims outrank episodes on an equal match", async () => {
  await withStore(async (store) => {
    store.create({ kind: "episode", title: "raw", body: "terraform state lock" });
    store.create({ kind: "claim", title: "distilled", body: "terraform state lock" });
    const hits = store.search("terraform state lock", 5);
    assert.equal(hits[0]!.title, "distilled");
  });
});

test("paths in front of you promote memories about them", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "elsewhere", body: "consul service mesh timeout" });
    store.create({ kind: "claim", title: "right here", body: "consul service mesh timeout",
      files: ["src/store.ts"] });
    const hits = store.search("consul timeout", 5, ["src/store.ts"]);
    assert.equal(hits[0]!.title, "right here");
  });
});
