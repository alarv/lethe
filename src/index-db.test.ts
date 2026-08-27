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

test("an unchanged store is not reindexed, so a read-only search does no writes", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  const { statSync } = await import("node:fs");
  await withStore(async (store, home) => {
    for (let i = 0; i < 30; i++) {
      store.create({ kind: "claim", title: `m${i}`, body: `body ${i} about consul and vault` });
    }
    const path = join(home, "index.db");
    const ix = indexIn(home);
    ix.sync(store.all());
    ix.close();

    const size = statSync(path).size;
    // Repeated searches must not rewrite the file. Rebuilding on every query
    // left over half the real index as free pages.
    for (let i = 0; i < 10; i++) {
      const again = indexIn(home);
      again.sync(store.all());
      again.search("consul", 5);
      again.close();
    }
    assert.equal(statSync(path).size, size, "repeated searches grew the index");
  });
});

test("a changed store is reindexed", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  await withStore(async (store, home) => {
    store.create({ kind: "claim", title: "first", body: "vault seal status" });
    const ix = indexIn(home);
    ix.sync(store.all());
    assert.equal(ix.search("nomad", 5).length, 0);
    store.create({ kind: "claim", title: "second", body: "nomad job allocation" });
    ix.sync(store.all());
    assert.equal(ix.search("nomad", 5).length, 1, "a new memory must become searchable");
    ix.close();
  });
});

test("deleting many memories shrinks the file rather than leaving free pages", async (t) => {
  if (!available) return t.skip("node:sqlite unavailable");
  const { statSync } = await import("node:fs");
  await windowShrink();

  async function windowShrink() {
    await withStore(async (store, home) => {
      const ids: string[] = [];
      for (let i = 0; i < 300; i++) {
        ids.push(store.create({
          kind: "claim", title: `mem ${i}`,
          body: `a reasonably long body number ${i} mentioning docker compose redis kafka `
            + "and quite a lot of additional filler text to give the index something to hold",
        }).id);
      }
      const ix = indexIn(home);
      ix.sync(store.all());
      const full = ix.bytes();

      for (const id of ids.slice(0, 280)) store.remove(id);
      ix.sync(store.all());
      const shrunk = ix.bytes();
      ix.close();

      assert.ok(shrunk < full,
        `index did not shrink after deleting 280 of 300 memories (${full} -> ${shrunk})`);
    });
  }
});
