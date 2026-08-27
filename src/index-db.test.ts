import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withStore } from "./testing.js";
import { MemoryIndex } from "./index-db.js";

/**
 * Whether node:sqlite exists here. MemoryIndex.open returns null rather than
 * throwing when it does not, so asking it directly is both the honest probe and
 * a test of the fallback contract.
 */
const available = (() => {
  const probe = MemoryIndex.open(join(tmpdir(), `lethe-probe-${process.pid}.db`));
  if (!probe) return false;
  probe.close();
  return true;
})();

function indexIn(home: string): MemoryIndex {
  const ix = MemoryIndex.open(join(home, "index.db"));
  assert.ok(ix, "expected an index");
  return ix;
}

test("syncs memories and finds them by word", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    store.create({ kind: "claim", title: "tests need containers",
      body: "you must run docker compose up first or the suite fails" });
    store.create({ kind: "claim", title: "unrelated", body: "something about jwt tokens" });
    const ix = indexIn(home);
    ix.sync(store.all());
    const hits = ix.search("docker", 5);
    assert.equal(hits.length, 1);
    const expected = store.all().find((m) => m.title.includes("containers"))!;
    assert.equal(hits[0]!.id, expected.id);
    assert.ok(hits[0]!.relevance > 0, "relevance must be positive after negating bm25");
    ix.close();
  });
});

test("finds an exact command as a phrase, which is why detail='full' is used", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    store.create({ kind: "claim", title: "setup", body: "run docker compose up before the suite" });
    store.create({ kind: "claim", title: "other", body: "compose a docker image up somewhere" });
    const ix = indexIn(home);
    ix.sync(store.all());
    assert.equal(ix.searchPhrase("docker compose up", 5).length, 1,
      "only the adjacent phrase should match");
    ix.close();
  });
});

test("a query with no usable terms returns nothing and does not throw", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    store.create({ kind: "claim", title: "x", body: "y" });
    const ix = indexIn(home);
    ix.sync(store.all());
    assert.deepEqual(ix.search("a an of", 5), []);
    ix.close();
  });
});

test("rewriting a memory does not leave the old terms searchable", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    const m = store.create({ kind: "claim", title: "old", body: "kubernetes ingress trouble" });
    const ix = indexIn(home);
    ix.sync(store.all());
    assert.equal(ix.search("kubernetes", 5).length, 1);
    m.body = "postgres connection pooling";
    store.write(m);
    ix.sync(store.all());
    assert.equal(ix.search("kubernetes", 5).length, 0, "stale term still searchable");
    assert.equal(ix.search("postgres", 5).length, 1);
    ix.close();
  });
});

test("deleted memories leave the index", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    const m = store.create({ kind: "claim", title: "temp", body: "rabbitmq queue depth" });
    const ix = indexIn(home);
    ix.sync(store.all());
    assert.equal(ix.search("rabbitmq", 5).length, 1);
    store.remove(m.id);
    ix.sync(store.all());
    assert.equal(ix.search("rabbitmq", 5).length, 0);
    ix.close();
  });
});

test("a corrupt index rebuilds instead of crashing", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    store.create({ kind: "claim", title: "x", body: "elasticsearch shard allocation" });
    writeFileSync(join(home, "index.db"), "this is not a database at all");
    const ix = MemoryIndex.open(join(home, "index.db"));
    assert.ok(ix, "a corrupt index must not prevent opening");
    ix.sync(store.all());
    assert.equal(ix.search("elasticsearch", 5).length, 1);
    ix.close();
  });
});

test("carries supersededBy through so the ranker can resolve forward", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    const claim = store.create({ kind: "claim", title: "claim", body: "guard shared state" });
    const ep = store.create({ kind: "episode", title: "episode", body: "memcached eviction storm" });
    ep.supersededBy = claim.id;
    store.write(ep);
    const ix = indexIn(home);
    ix.sync(store.all());
    const hits = ix.search("memcached", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.supersededBy, claim.id);
    ix.close();
  });
});

test("reports its size on disk", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    for (let i = 0; i < 20; i++) {
      store.create({ kind: "claim", title: `m${i}`, body: `body number ${i} about caching` });
    }
    const ix = indexIn(home);
    ix.sync(store.all());
    assert.ok(ix.bytes() > 0, "an index with rows must have a size");
    ix.close();
  });
});
