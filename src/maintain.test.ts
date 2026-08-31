/**
 * Home directory housekeeping.
 *
 * The line these tests exist to defend: scaffolding is disposable, markdown is
 * not. A project directory holding no memories can go without being mentioned;
 * one holding memories is never removed automatically, however dead its path
 * looks, because a path that is missing today is as likely to be an unmounted
 * volume or a moved checkout as a deleted repository.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { human, prune, survey } from "./maintain.js";

/** A home with the project directories described, and nothing else. */
function withHome(
  projects: { key: string; source?: string; memories?: number }[],
  fn: (home: string) => void,
): void {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-maintain-"));
  const prev = process.env.LETHE_HOME;
  process.env.LETHE_HOME = home;
  try {
    for (const p of projects) {
      const dir = join(home, "projects", p.key);
      mkdirSync(join(dir, "memory"), { recursive: true });
      if (p.source !== undefined) writeFileSync(join(dir, "source"), p.source + "\n");
      for (let i = 0; i < (p.memories ?? 0); i++) {
        writeFileSync(join(dir, "memory", `m${i}.md`),
          `---\nid: id-${p.key}-${i}\nkind: claim\ntitle: t\n---\n\nbody\n`);
      }
    }
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("a directory with no memories is empty, whatever its path says", () => {
  const gone = join(tmpdir(), "lethe-does-not-exist-ever");
  withHome([{ key: "a", source: gone, memories: 0 }], (home) => {
    const s = survey(home);
    assert.equal(s.empty.length, 1);
    assert.equal(s.orphaned.length, 0, "nothing to orphan when there is nothing in it");
    assert.equal(s.live.length, 0);
  });
});

test("a directory with memories whose path is gone is orphaned, not empty", () => {
  const gone = join(tmpdir(), "lethe-does-not-exist-ever");
  withHome([{ key: "a", source: gone, memories: 3 }], (home) => {
    const s = survey(home);
    assert.equal(s.orphaned.length, 1);
    assert.equal(s.orphaned[0]!.files, 3);
    assert.equal(s.empty.length, 0);
  });
});

test("a directory whose path still exists is live", () => {
  withHome([{ key: "a", source: tmpdir(), memories: 2 }], (home) => {
    const s = survey(home);
    assert.equal(s.live.length, 1);
    assert.equal(s.orphaned.length, 0);
  });
});

test("a directory with no source file is treated as live, never collected", () => {
  // Written by an older layout, so we cannot say whose it is. Guessing wrong
  // here costs memories, and being wrong the other way costs a stale folder.
  withHome([{ key: "a", memories: 2 }], (home) => {
    const s = survey(home);
    assert.equal(s.live.length, 1);
    assert.deepEqual(prune(s), []);
  });
});

test("prune removes the empty directories and leaves the orphans alone", () => {
  const gone = join(tmpdir(), "lethe-does-not-exist-ever");
  withHome([
    { key: "empty-1", source: gone, memories: 0 },
    { key: "empty-2", source: tmpdir(), memories: 0 },
    { key: "has-memories", source: gone, memories: 4 },
    { key: "alive", source: tmpdir(), memories: 1 },
  ], (home) => {
    const s = survey(home);
    const removed = prune(s);
    assert.equal(removed.length, 2);
    assert.equal(existsSync(join(home, "projects", "empty-1")), false);
    assert.equal(existsSync(join(home, "projects", "empty-2")), false);
    assert.ok(existsSync(join(home, "projects", "has-memories")),
      "a dead path is not a reason to delete somebody's memories");
    assert.ok(existsSync(join(home, "projects", "alive")));
  });
});

test("--dead is required to remove a directory that still holds memories", () => {
  const gone = join(tmpdir(), "lethe-does-not-exist-ever");
  withHome([{ key: "dead", source: gone, memories: 2 }], (home) => {
    const s = survey(home);
    assert.equal(prune(s, { dead: true, dryRun: true }).length, 1);
    assert.ok(existsSync(join(home, "projects", "dead")), "a dry run must not delete");
    assert.equal(prune(s, { dead: true }).length, 1);
    assert.equal(existsSync(join(home, "projects", "dead")), false);
  });
});

test("a dry run reports what it would remove and removes nothing", () => {
  withHome([{ key: "empty", source: tmpdir(), memories: 0 }], (home) => {
    const s = survey(home);
    assert.equal(prune(s, { dryRun: true }).length, 1);
    assert.ok(existsSync(join(home, "projects", "empty")));
  });
});

test("survey reports sizes and survives a home that is not there", () => {
  withHome([{ key: "a", source: tmpdir(), memories: 2 }], (home) => {
    const s = survey(home);
    assert.ok(s.totalBytes > 0);
    assert.equal(s.indexBytes, 0, "no index has been built in this home");
  });

  const missing = join(tmpdir(), "lethe-no-such-home-ever");
  const s = survey(missing);
  assert.deepEqual([s.empty, s.orphaned, s.live], [[], [], []]);
  assert.equal(s.totalBytes, 0);
});

test("human sizes read the way a person expects", () => {
  assert.equal(human(512), "512 B");
  assert.equal(human(2048), "2 KB");
  assert.equal(human(5 * 1024 * 1024), "5.0 MB");
});
