/**
 * Where memories land, which is derived rather than configured.
 *
 * These are the tests the old `scope` enum never had: it was passed in by the
 * caller, so there was nothing to assert beyond "the value came back". Now the
 * path is a function of what the memory is and whether there is a repository,
 * and that function is the whole of the placement decision.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, claimDir, episodeDir, legacyClaimDir } from "./store.js";
import { withStore } from "./testing.js";

const md = (id: string, kind: string, title: string) =>
  `---\nid: ${id}\nkind: ${kind}\ntitle: ${title}\n---\n\nbody\n`;

/** A workspace that is deliberately not a repository. */
async function withoutRepo(fn: (store: Store, home: string, cwd: string) => void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "lethe-test-bare-"));
  const previous = process.env.LETHE_HOME;
  process.env.LETHE_HOME = home;
  try {
    fn(new Store(cwd), home, cwd);
  } finally {
    if (previous === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

const files = (dir: string) =>
  (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".md"));

test("claims go to the repo, episodes to your home directory", async () => {
  await withStore(async (store, _home, workspace) => {
    store.create({ kind: "claim", title: "docker compose first", body: "before the suite" });
    store.create({ kind: "episode", title: "spent an hour on a port clash", body: "raw" });

    assert.deepEqual(files(join(workspace, ".lethe", "memory")).length, 1,
      "the claim belongs beside the code it describes");
    assert.equal(files(episodeDir(workspace)).length, 1,
      "the episode is a private scratchpad and never enters a repository");
  });
});

test("patterns travel with the claims, not with the scratchpad", async () => {
  await withStore(async (store, _home, workspace) => {
    store.create({ kind: "pattern", title: "how we deploy here", body: "steps" });
    assert.equal(files(claimDir(workspace)).length, 1);
    assert.equal(files(episodeDir(workspace)).length, 0);
  });
});

test("the claim path does not depend on whether git ignores it", async () => {
  await withStore(async (_store, _home, workspace) => {
    const before = claimDir(workspace);
    mkdirSync(join(workspace, ".lethe"), { recursive: true });
    writeFileSync(join(workspace, ".lethe", ".gitignore"), "*\n!.gitignore\n# !memory/\n");
    // This is what makes the sharing decision free to change: flipping those
    // lines is the whole of it, and not one file moves.
    assert.equal(claimDir(workspace), before);
  });
});

test("outside a repository everything shares one directory and is returned once", async () => {
  await withoutRepo((store, _home, cwd) => {
    assert.equal(claimDir(cwd), episodeDir(cwd),
      "there is no repo to write claims to, so they fall back to the episode store");
    store.create({ kind: "claim", title: "a claim", body: "x" });
    store.create({ kind: "episode", title: "an episode", body: "y" });

    // all() reads a set of directories. Before deduplication this returned
    // every memory twice here, which would double every count in `lethe
    // status` and every pressure calculation built on them.
    assert.equal(store.all().length, 2);
    assert.deepEqual(store.all().map((m) => m.title).sort(), ["a claim", "an episode"]);
  });
});

test("claims left in ~/.lethe/memory by the old cross-project scope are still read", async () => {
  await withStore(async (store, home) => {
    const legacy = legacyClaimDir();
    assert.equal(legacy, join(home, "memory"));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "abcdef12-old.md"),
      md("abcdef12-0000-0000-0000-000000000000", "claim", "an older cross-project claim"));

    // Nothing writes here any more. Dropping the read would have silently
    // orphaned every claim anyone had recorded under `personal` scope.
    assert.ok(store.all().some((m) => m.title === "an older cross-project claim"));
  });
});

test("episodes an older version wrote into the repo are moved out on open", async () => {
  await withStore(async (_store, _home, workspace) => {
    const inRepo = join(workspace, ".lethe", "memory");
    mkdirSync(inRepo, { recursive: true });
    writeFileSync(join(inRepo, "aaaaaaaa-old.md"),
      md("aaaaaaaa-0000-0000-0000-000000000000", "episode", "a stray episode"));
    writeFileSync(join(inRepo, "bbbbbbbb-keep.md"),
      md("bbbbbbbb-0000-0000-0000-000000000000", "claim", "a claim that stays"));

    new Store(workspace); // relocation happens on construction
    assert.deepEqual(files(inRepo), ["bbbbbbbb-keep.md"],
      "the claim stays; the scratchpad entry does not belong in a repository");
    assert.ok(files(episodeDir(workspace)).includes("aaaaaaaa-old.md"));
  });
});

test("an id resolves to what it means now, through a chain of revisions", async () => {
  await withStore(async (store) => {
    const first = store.create({ kind: "claim", title: "first", body: "a" });
    const second = store.create({ kind: "claim", title: "second", body: "b" });
    const third = store.create({ kind: "claim", title: "third", body: "c" });
    first.supersededBy = second.id;
    store.write(first);
    second.supersededBy = third.id;
    store.write(second);

    // An agent holding an id from an earlier recall must not end up confirming
    // or correcting a memory that has since been replaced.
    assert.equal(store.get(first.id)!.title, "third");
    assert.equal(store.get(second.id)!.title, "third");
    assert.equal(store.get(first.id.slice(0, 8))!.title, "third", "short ids too");
  });
});

test("forget deletes exactly what was named, not its replacement", async () => {
  await withStore(async (store) => {
    const old = store.create({ kind: "claim", title: "the old one", body: "a" });
    const live = store.create({ kind: "claim", title: "the live one", body: "b" });
    old.supersededBy = live.id;
    store.write(old);

    assert.equal(store.remove(old.id), true);
    const left = store.all().map((m) => m.title);
    assert.deepEqual(left, ["the live one"],
      "asked to delete a memory, deleting its replacement is the worst available reading");
  });
});
