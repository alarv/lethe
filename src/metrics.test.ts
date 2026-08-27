import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics, formatMetrics } from "./metrics.js";

const line = (ts: string, event: string, rest: string) => `${ts}  ${event.padEnd(8)}  ${rest}`;

test("counts sessions that never touched lethe", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T01:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T02:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T02:01:00Z", "recall", "something  hits=3"),
  ]);
  assert.equal(m.sessions, 3);
  assert.equal(m.sessionsUsing, 1);
  assert.equal(m.sessionsRecalling, 1);
});

test("reports the recall-to-note balance", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "note", "a  id=1"),
    line("2026-01-01T00:02:00Z", "note", "b  id=2"),
    line("2026-01-01T00:03:00Z", "recall", "q  hits=2"),
  ]);
  assert.equal(m.notes, 2);
  assert.equal(m.recalls, 1);
  assert.match(formatMetrics(m), /backwards/,
    "a ratio below 1 must be called out, not just printed");
});

test("separates empty recalls from productive ones", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q1  hits=0"),
    line("2026-01-01T00:02:00Z", "recall", "q2  hits=4"),
    line("2026-01-01T00:03:00Z", "recall", "q3  hits=6"),
  ]);
  assert.equal(m.recalls, 3);
  assert.equal(m.emptyRecalls, 1);
  assert.equal(m.meanHits, 5, "averaged over non-empty recalls only");
});

test("credits a confirm only when a recall in that session returned something", () => {
  const withHit = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=2"),
    line("2026-01-01T00:02:00Z", "confirm", "x  id=1"),
  ]);
  assert.equal(withHit.confirmedAfterRecall, 1);

  const withoutHit = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=0"),
    line("2026-01-01T00:02:00Z", "confirm", "x  id=1"),
  ]);
  assert.equal(withoutHit.confirmedAfterRecall, 0,
    "a confirm after an empty recall is not evidence recall helped");
});

test("flags stale servers when several builds are seen", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=2026-01-01T00:00:00Z"),
    line("2026-01-02T00:00:00Z", "start", "connected  build=2026-01-02T00:00:00Z"),
  ]);
  assert.equal(m.builds.length, 2);
  assert.match(formatMetrics(m), /lethe restart/);
});

test("an empty log says so rather than printing zeroes", () => {
  assert.match(formatMetrics(metrics([])), /No activity recorded/);
});

test("ignores malformed lines instead of throwing", () => {
  assert.doesNotThrow(() => metrics(["", "garbage", "also garbage no timestamp"]));
});

test("meanHits excludes empty recalls, matching its label", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q1  hits=0"),
    line("2026-01-01T00:02:00Z", "recall", "q2  hits=4"),
    line("2026-01-01T00:03:00Z", "recall", "q3  hits=6"),
  ]);
  assert.equal(m.meanHits, 5, "must average 4 and 6, not 0, 4 and 6");
  assert.equal(m.emptyRecalls, 1, "the empty one is reported separately");
});

test("separates hook-driven recalls from model-driven ones", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q1  hits=2 via=hook"),
    line("2026-01-01T00:02:00Z", "recall", "q2  hits=3"),
  ]);
  assert.equal(m.recalls, 2);
  assert.equal(m.recallsViaHook, 1);
  assert.match(formatMetrics(m), /1 via hook, 1 by the model/);
});

test("says so when nothing is driving recall but the model", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=2"),
  ]);
  assert.equal(m.recallsViaHook, 0);
  assert.match(formatMetrics(m), /lethe hook show/);
});

import { composition, formatComposition } from "./metrics.js";

const m2 = (kind: string, supersededBy: string | null = null, salience = 0.5) =>
  ({ kind, supersededBy, salience });

test("composition separates live from cold and counts pressure", () => {
  const c = composition([
    m2("claim"), m2("pattern"),
    m2("episode"), m2("episode"),
    m2("episode", "claim-1"),
  ]);
  assert.equal(c.claims, 1);
  assert.equal(c.patterns, 1);
  assert.equal(c.episodes, 3, "cold episodes are still episodes");
  assert.equal(c.cold, 1);
  assert.equal(c.waiting, 2, "pressure counts only unconsolidated episodes");
  assert.equal(c.pressure, 1.0, "pressure sums salience, not headcount");
});

// The state that went unnoticed for weeks: recall serving raw session
// transcripts because consolidation had produced nothing.
test("says plainly when nothing has been distilled", () => {
  const out = formatComposition(composition([m2("episode"), m2("episode")]));
  assert.match(out, /nothing distilled/);
  assert.match(out, /raw sessions/);
});

test("flags a store that is mostly raw", () => {
  const memories = [m2("claim"), ...Array.from({ length: 20 }, () => m2("episode"))];
  assert.match(formatComposition(composition(memories)), /mostly raw/);
});

test("a healthy ratio is not flagged", () => {
  const memories = [m2("claim"), m2("claim"), m2("episode"), m2("episode")];
  const out = formatComposition(composition(memories));
  assert.doesNotMatch(out, /mostly raw|nothing distilled/);
});

test("compaction outcomes are counted from the log", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "compact", "pressure threshold reached  episodes=12"),
    line("2026-01-01T00:02:00Z", "compact", "done (extractive)  claims=1 consumed=12"),
    line("2026-01-01T00:03:00Z", "compact", "rejected nonconforming reply: blah"),
  ]);
  assert.equal(m.compactions, 1, "one run produced a claim");
  assert.equal(m.compactionsFailed, 1);
  assert.match(formatMetrics(m), /compaction runs/);
});

test("a run producing zero claims is not counted as a success", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:02:00Z", "compact", "done  claims=0 consumed=0"),
  ]);
  assert.equal(m.compactions, 0);
});

test("pressure is reported as salience against the real threshold", () => {
  const out = formatComposition(composition([m2("episode", null, 0.9), m2("episode", null, 0.9)]), 6);
  assert.match(out, /1\.8\/6/, "must show salience, not a count");
  assert.match(out, /2 raw/);
});

test("a high-salience store reaches the threshold with fewer episodes", () => {
  const few = composition(Array.from({ length: 4 }, () => m2("episode", null, 1.0)));
  const many = composition(Array.from({ length: 8 }, () => m2("episode", null, 0.2)));
  assert.ok(few.pressure > many.pressure,
    "4 important notes should outweigh 8 trivial ones");
});
