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
