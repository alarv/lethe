/**
 * Revising a claim rather than writing a second one beside it.
 *
 * Consolidation used to see only unconsolidated episodes, so the same lesson
 * learned in two sessions was stored twice and nothing could notice. Measured in
 * lethe's own store: "Compaction silently fails when the distiller is
 * unavailable" and "All lethe.log errors are distil failed: no model" are one
 * lesson, written 28 hours apart from different episodes, both live.
 *
 * These tests are at the compact() level because the interesting part is what
 * ends up on disk: the replaced claim has to go cold rather than be deleted, and
 * its id has to keep resolving.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { withStore } from "./testing.js";
import { compact } from "./compact.js";
import type { Store } from "./store.js";

/** The existing claim, and an episode that teaches more about the same thing. */
function seed(store: Store): { claimId: string; episodeId: string } {
  const claim = store.create({
    kind: "claim",
    title: "compaction fails silently without a distiller",
    body: "the log shows `distil failed: no model` and episodes pile up",
    salience: 0.75,
  });
  const episode = store.create({
    kind: "episode",
    title: "it happened again on a fresh machine",
    body: "`lethe doctor` said distiller none, and `distil failed: no model` was in the log",
    salience: 0.9,
  });
  return { claimId: claim.id, episodeId: episode.id };
}

const REVISION =
  "CLAIM\n" +
  "supersedes: C1\n" +
  "sources: 1\n" +
  "title: compaction fails silently without a distiller; check `lethe doctor`\n" +
  "body: the log shows `distil failed: no model`. `lethe doctor` names the distiller.\n" +
  "END";

test("a revised claim goes cold and the new one carries its provenance", async () => {
  await withStore(async (store) => {
    const { claimId, episodeId } = seed(store);

    const r = await compact(store, { distil: async () => REVISION });
    assert.equal(r.claimsRevised, 1, "the existing claim must be replaced, not duplicated");
    assert.equal(r.claimsWritten, 1);

    const live = store.all().filter((m) => m.kind === "claim" && !m.supersededBy);
    assert.equal(live.length, 1, `expected one live claim, got ${live.map((m) => m.title).join(" | ")}`);
    assert.match(live[0]!.title, /lethe doctor/);

    // Cold, not gone. The file stays so a mistaken revision is recoverable and
    // the old wording remains a route to the new claim.
    const old = store.all().find((m) => m.id === claimId);
    assert.ok(old, "the replaced claim must still exist on disk");
    assert.equal(old!.supersededBy, live[0]!.id);

    assert.deepEqual([...live[0]!.provenance].sort(), [episodeId, claimId].sort());
  });
});

test("the replaced claim's id still resolves to what replaced it", async () => {
  await withStore(async (store) => {
    const { claimId } = seed(store);
    await compact(store, { distil: async () => REVISION });

    // An agent holding the old id from an earlier recall must not hit a dead
    // end; that is what provenance is for.
    const resolved = store.get(claimId);
    assert.ok(resolved);
    assert.match(resolved!.title, /lethe doctor/);
  });
});

test("a revision inherits the salience the old claim earned", async () => {
  await withStore(async (store) => {
    store.create({ kind: "claim", title: "old and trusted",
      body: "keep `distil failed: no model`", salience: 1 });
    store.create({ kind: "episode", title: "a minor note",
      body: "saw `distil failed: no model` again", salience: 0.2 });

    await compact(store, { distil: async () =>
      "CLAIM\nsupersedes: C1\nsources: 1\ntitle: old and trusted, refined\n" +
      "body: keep `distil failed: no model`\nEND" });

    const live = store.all().find((m) => m.kind === "claim" && !m.supersededBy)!;
    assert.equal(live.salience, 1, "replacing a claim must not quietly demote what it knew");
  });
});

test("a dry run reports the revision and writes nothing", async () => {
  await withStore(async (store) => {
    const { claimId } = seed(store);
    const r = await compact(store, { distil: async () => REVISION, dryRun: true });
    assert.equal(r.claimsRevised, 1);
    assert.equal(store.all().find((m) => m.id === claimId)!.supersededBy, null,
      "a dry run must leave the store exactly as it was");
    assert.equal(store.all().filter((m) => m.kind === "claim").length, 1);
  });
});

test("patterns are not offered for revision", async () => {
  await withStore(async (store) => {
    store.create({ kind: "pattern", title: "how we do it here",
      body: "always `npm test` before pushing", salience: 1 });
    store.create({ kind: "episode", title: "note", body: "ran `npm test` again" });

    let prompt = "";
    await compact(store, { distil: async (p) => { prompt = p; return ""; } });
    // Patterns are the promoted survivors. Letting an automatic pass demote one
    // is a bigger decision than this is; `correct` still reaches them.
    assert.doesNotMatch(prompt, /^C1\./m);
    assert.doesNotMatch(prompt, /how we do it here/);
  });
});
